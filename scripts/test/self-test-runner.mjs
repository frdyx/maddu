#!/usr/bin/env node
// Regression coverage for the unified source self-test runner.

import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupFixtures, cli, events, jsonFile, marker, selfTestArgs, selfTestSource, tmp } from './_pr1-fixtures.mjs';
import { EVENT_SCHEMA } from '../../template/maddu/runtime/lib/event-schema.mjs';
import schemaGate from '../../template/maddu/runtime/gates/builtin/event-schema-complete.mjs';
import {
  SOURCE_ONLY_MESSAGE,
  buildSelfTestPlan,
  listJson,
  resultJson,
  runSelfTest,
} from './_self-test-runner.mjs';

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  const tag = cond ? '[PASS]' : '[FAIL]';
  console.log(`  ${tag} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++;
  else failed++;
}

async function writeExecutable(path, body) {
  await writeFile(path, body);
}

async function makeFakeSource() {
  const root = await tmp('maddu-self-test-', tmpdir());
  await mkdir(join(root, 'scripts', 'test'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, '.maddu', 'state'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'maddu', type: 'module' }, null, 2) + '\n');
  await writeExecutable(join(root, 'bin', 'maddu.mjs'), 'console.log("fake smoke");\n');
  await writeExecutable(join(root, 'scripts', 'test', 'pass.mjs'), 'console.log("pass fixture");\n');
  await writeExecutable(join(root, 'scripts', 'test', 'fail.mjs'), 'console.error("fail fixture"); process.exit(1);\n');
  await writeExecutable(join(root, 'scripts', 'test', 'stress-harness.mjs'), 'console.log("stress fixture");\n');
  await writeExecutable(join(root, 'scripts', 'test', 'upgrade-matrix.mjs'), 'console.log("upgrade fixture");\n');
  await writeExecutable(join(root, 'scripts', 'test', 'run-all.mjs'), 'console.log("runner entrypoint should be excluded");\n');
  await writeExecutable(join(root, 'scripts', 'test', '_helper.mjs'), 'console.log("helper should be excluded");\n');
  return root;
}

async function expectSourceOnlyRefusal() {
  const root = await tmp('maddu-self-test-consumer-', tmpdir());
  try {
    let threw = false;
    try {
      await buildSelfTestPlan({ frameworkRoot: root, profile: 'quick' });
    } catch (err) {
      threw = true;
      ok('source-only path refuses without scripts/test', err.message === SOURCE_ONLY_MESSAGE, err.message);
    }
    ok('source-only path throws a config error', threw);
  } finally {
    await cleanupFixtures();
  }
}

async function main() {
  await expectSourceOnlyRefusal();
  const root = await makeFakeSource();
  try {
    const smoke = await buildSelfTestPlan({ frameworkRoot: root, profile: 'smoke' });
    ok('smoke profile has 3 smoke checks', smoke.tasks.map((t) => t.id).join(',') === 'audit-generated,audit,spine-verify');

    const quick = await buildSelfTestPlan({ frameworkRoot: root, profile: 'quick' });
    const quickIds = quick.tasks.map((t) => t.id);
    ok('quick includes focused scripts', quickIds.includes('pass') && quickIds.includes('fail'));
    ok('quick excludes stress and upgrade', !quickIds.includes('stress-harness') && !quickIds.includes('upgrade-matrix'));
    ok('quick excludes runner/internal files', !quickIds.includes('run-all') && !quickIds.includes('_helper'));

    const full = await buildSelfTestPlan({ frameworkRoot: root, profile: 'full' });
    const fullIds = full.tasks.map((t) => t.id);
    ok('full includes stress and upgrade', fullIds.includes('stress-harness') && fullIds.includes('upgrade-matrix'));

    const only = await buildSelfTestPlan({ frameworkRoot: root, profile: 'quick', only: ['pass'] });
    ok('--only selects exactly one id', only.tasks.length === 1 && only.tasks[0].id === 'pass');

    const skipped = await buildSelfTestPlan({ frameworkRoot: root, profile: 'quick', skip: ['fail'] });
    ok('--skip removes an id', !skipped.tasks.some((t) => t.id === 'fail'));

    const listDoc = JSON.parse(listJson(only));
    ok('list JSON is parseable', listDoc.profile === 'quick' && listDoc.tests[0].id === 'pass');

    // audit P3 — self-test-recent now reads VERIFIED spine receipts, not this
    // last-run.json (the direct runSelfTest path here doesn't emit one). The gate's
    // spine-receipt logic is covered in p3-verification-guard (pure) and
    // completion-claim-gate (real receipts); the runner assertions below verify the
    // report + counts + complete flag the receipt is built from.
    const passRun = await runSelfTest({ frameworkRoot: root, profile: 'quick', only: ['pass'], report: true });
    ok('passing selection exits 0', passRun.exitCode === 0 && passRun.counts.pass === 1);
    ok('narrowed (--only) run is marked incomplete for recency', passRun.complete === false);
    const lastRun = JSON.parse(await readFile(join(root, '.maddu', 'state', 'self-test-last-run.json'), 'utf8'));
    ok('report writes last-run JSON', lastRun.profile === 'quick' && lastRun.counts.pass === 1);
    ok('result JSON is parseable', JSON.parse(resultJson(passRun)).ok === true);

    const fullRun = await runSelfTest({ frameworkRoot: root, profile: 'quick', report: false });
    ok('un-narrowed run is complete for recency', fullRun.complete === true);

    const failRun = await runSelfTest({ frameworkRoot: root, profile: 'quick', only: ['fail'], report: false });
    ok('failing selection exits 1', failRun.exitCode === 1 && failRun.counts.fail === 1);

    const bailRun = await runSelfTest({ frameworkRoot: root, profile: 'quick', only: ['fail', 'pass'], bail: true, report: false });
    ok('--bail stops after first failure', bailRun.counts.bailed === true && bailRun.results.length === 1 && bailRun.results[0].id === 'fail');
  } finally {
    // Fixture roots are tracked; cleanupFixtures() removes them at the end.
  }

  {
    const source = await selfTestSource();
    // Deliberately differs from the framework root and contains a space:
    // provenance must describe the CLI process, not the task runner's cwd.
    const cwd = join(source, 'invocation cwd');
    await mkdir(cwd);
    const before = (await events(source, 'VERIFICATION_RAN')).length;
    const r = cli(cwd, ['self-test', ...selfTestArgs], {}, join(source, 'bin', 'maddu.mjs'));
    const state = join(source, '.maddu', 'state');
    const last = await jsonFile(join(state, 'self-test-last-run.json'));
    const reportsDir = join(state, 'self-test-reports');
    let detailNames = [];
    try { detailNames = (await readdir(reportsDir)).filter((n) => /^self-test\.\d+\.quick\.json$/.test(n)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const detail = detailNames.length === 1 ? await jsonFile(join(reportsDir, detailNames[0])) : null;
    const added = (await events(source, 'VERIFICATION_RAN')).slice(before);
    const receipt = added.length === 1 ? added[0].data : null;
    const exact = (doc) => doc && JSON.stringify(doc.argv) === JSON.stringify(selfTestArgs)
      && doc.cwd === cwd && Number.isInteger(doc.pid) && doc.pid === r.pid;
    const detailFor = (doc) => `exit=${r.status} argv=${JSON.stringify(doc?.argv)} cwd=${JSON.stringify(doc?.cwd)} pid=${doc?.pid} expectedPid=${r.pid}`;
    ok('PR1 ST1: last-run report carries exact invocation argv, cwd and pid',
      r.status === 0 && last?.counts?.pass === 1 && exact(last), detailFor(last));
    ok('PR1 ST2: timestamped report carries exact invocation argv, cwd and pid',
      r.status === 0 && detailNames.length === 1 && detail?.counts?.pass === 1 && exact(detail), detailFor(detail));
    ok('PR1 ST3: VERIFICATION_RAN carries exact invocation argv, cwd and pid',
      r.status === 0 && added.length === 1 && receipt?.kind === 'self-test'
      && receipt?.counts?.pass === 1 && exact(receipt), `delta=${added.length} ${detailFor(receipt)}`);
  }
  {
    const fixture = await marker('maddu-pr1-provenance-schema-');
    const gate = await schemaGate.run({ repoRoot: fixture });
    const data = EVENT_SCHEMA.VERIFICATION_RAN?.data;
    const declared = Object.entries({ argv: 'array', cwd: 'string', pid: 'number' })
      .every(([key, type]) => typeof data?.[key] === 'string' && data[key].replace(/\?$/, '') === type);
    // Parity alone is insufficient: at base neither registry declares these
    // fields, so event-schema-complete alone can still be green.
    ok('PR1 ST4: verification provenance fields are declared and event-schema-complete passes',
      declared && gate.ok === true,
      `argv=${data?.argv} cwd=${data?.cwd} pid=${data?.pid} gate=${gate.ok}: ${gate.message}`);
  }

  await cleanupFixtures();
  console.log('');
  console.log(`self-test-runner: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
});
