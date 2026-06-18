#!/usr/bin/env node
// Regression coverage for the unified source self-test runner.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOURCE_ONLY_MESSAGE,
  buildSelfTestPlan,
  listJson,
  resultJson,
  runSelfTest,
} from './_self-test-runner.mjs';
import selfTestRecentGate from '../../template/maddu/runtime/gates/builtin/self-test-recent.mjs';

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
  const root = await mkdtemp(join(tmpdir(), 'maddu-self-test-'));
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
  const root = await mkdtemp(join(tmpdir(), 'maddu-self-test-consumer-'));
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
    await rm(root, { recursive: true, force: true });
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

    const noReportGate = await selfTestRecentGate.run({ repoRoot: root });
    ok('self-test-recent warns before report exists', noReportGate.ok === false && /no self-test/.test(noReportGate.message));

    await runSelfTest({ frameworkRoot: root, profile: 'smoke', report: true });
    const smokeGate = await selfTestRecentGate.run({ repoRoot: root });
    ok('self-test-recent warns on smoke-only success', smokeGate.ok === false && /smoke-only/.test(smokeGate.message));

    await runSelfTest({ frameworkRoot: root, profile: 'quick', only: ['fail'], report: true });
    const failGate = await selfTestRecentGate.run({ repoRoot: root });
    ok('self-test-recent warns after failed run', failGate.ok === false && /failure/.test(failGate.message));

    const passRun = await runSelfTest({ frameworkRoot: root, profile: 'quick', only: ['pass'], report: true });
    ok('passing selection exits 0', passRun.exitCode === 0 && passRun.counts.pass === 1);
    const lastRun = JSON.parse(await readFile(join(root, '.maddu', 'state', 'self-test-last-run.json'), 'utf8'));
    ok('report writes last-run JSON', lastRun.profile === 'quick' && lastRun.counts.pass === 1);
    ok('result JSON is parseable', JSON.parse(resultJson(passRun)).ok === true);
    const passGate = await selfTestRecentGate.run({ repoRoot: root });
    ok('self-test-recent passes after quick success', passGate.ok === true, passGate.message);

    const failRun = await runSelfTest({ frameworkRoot: root, profile: 'quick', only: ['fail'], report: false });
    ok('failing selection exits 1', failRun.exitCode === 1 && failRun.counts.fail === 1);

    const bailRun = await runSelfTest({ frameworkRoot: root, profile: 'quick', only: ['fail', 'pass'], bail: true, report: false });
    ok('--bail stops after first failure', bailRun.counts.bailed === true && bailRun.results.length === 1 && bailRun.results[0].id === 'fail');
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log('');
  console.log(`Self-test runner: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
});
