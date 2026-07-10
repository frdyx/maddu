#!/usr/bin/env node
// Regression coverage for adaptive project-facing `maddu test` profiles.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProjectTestConfigError,
  buildProjectTestPlan,
  listJson,
  resultJson,
  runProjectTest,
  runProjectTestCli,
} from '../../commands/_project-test-runner.mjs';
import projectTestRecentGate from '../../template/maddu/runtime/gates/builtin/project-test-recent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frameworkRoot = resolve(__dirname, '..', '..');
const madduBin = join(frameworkRoot, 'bin', 'maddu.mjs');

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  const tag = cond ? '[PASS]' : '[FAIL]';
  console.log(`  ${tag} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++;
  else failed++;
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

async function makeRepo({ withConfig = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maddu-project-test-'));
  await mkdir(join(root, '.maddu', 'config'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'scripts', 'pass.mjs'), 'console.log("pass fixture");\n');
  await writeFile(join(root, 'scripts', 'fail.mjs'), 'console.error("fail fixture"); process.exit(1);\n');
  await writeFile(join(root, 'src', 'app.js'), 'export const app = true;\n');
  await writeJson(join(root, 'package.json'), {
    type: 'module',
    scripts: {
      test: 'node scripts/pass.mjs',
      'test:unit': 'node scripts/pass.mjs',
      'test:e2e': 'node scripts/pass.mjs',
      'test:watch': 'vitest --watch',
    },
    devDependencies: { vitest: '^1.0.0' },
  });
  if (withConfig) {
    await writeJson(join(root, '.maddu', 'config', 'test-harness.json'), {
      schemaVersion: 1,
      tests: [
        { id: 'unit', profiles: ['smoke', 'quick', 'full'], runner: process.execPath, args: ['scripts/pass.mjs'], cwd: '.' },
        { id: 'fail', profiles: ['quick', 'full'], runner: process.execPath, args: ['scripts/fail.mjs'], cwd: '.' },
        { id: 'slow', profiles: ['full'], runner: process.execPath, args: ['scripts/pass.mjs'], cwd: '.' },
        { id: 'npm-test', profiles: ['quick', 'full'], runner: process.execPath, args: ['scripts/pass.mjs'], cwd: '.' },
      ],
      changed: [
        { paths: ['src/**', '*.md'], tests: ['unit'] },
        { paths: ['slow/**'], tests: ['slow'] },
      ],
    });
  }
  return root;
}

async function makeSourceRepo() {
  const root = await mkdtemp(join(tmpdir(), 'maddu-project-test-source-'));
  await mkdir(join(root, '.maddu', 'state'), { recursive: true });
  await mkdir(join(root, 'template', 'maddu'), { recursive: true });
  await mkdir(join(root, 'commands'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'maddu', type: 'module' });
  return root;
}

function cli(args, cwd) {
  return new Promise((resolveCli) => {
    const child = spawn(process.execPath, [madduBin, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => resolveCli({ code: -1, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolveCli({ code, stdout, stderr }));
  });
}

async function readEventTypes(repoRoot) {
  const dir = join(repoRoot, '.maddu', 'events');
  let files = [];
  try { files = await readdir(dir); } catch { return []; }
  const types = [];
  for (const file of files.filter((f) => f.endsWith('.ndjson')).sort()) {
    const body = await readFile(join(dir, file), 'utf8');
    for (const line of body.split(/\r?\n/).filter(Boolean)) {
      try { types.push(JSON.parse(line).type); } catch {}
    }
  }
  return types;
}

async function expectConfigError(name, fn, pattern) {
  let threw = false;
  try { await fn(); }
  catch (err) {
    threw = true;
    ok(name, err instanceof ProjectTestConfigError && pattern.test(err.message), err.message);
  }
  if (!threw) ok(name, false, 'no error thrown');
}

async function main() {
  const root = await makeRepo();
  try {
    const smoke = await buildProjectTestPlan({ repoRoot: root, profile: 'smoke' });
    const smokeIds = smoke.tasks.map((t) => t.id);
    ok('smoke profile selects explicit smoke/unit tasks', smokeIds.includes('unit') && smokeIds.includes('npm-test-unit') && !smokeIds.includes('fail') && !smokeIds.includes('slow'));

    const quick = await buildProjectTestPlan({ repoRoot: root, profile: 'quick' });
    const quickIds = quick.tasks.map((t) => t.id);
    ok('quick includes config and overridden package test tasks', quickIds.includes('unit') && quickIds.includes('npm-test') && quickIds.includes('fail'));
    ok('quick excludes slow/full task', !quickIds.includes('slow'));
    ok('config overrides discovered npm-test command', quick.tasks.find((t) => t.id === 'npm-test')?.runner === process.execPath);

    const full = await buildProjectTestPlan({ repoRoot: root, profile: 'full' });
    ok('full includes slow task', full.tasks.some((t) => t.id === 'slow'));

    const only = await buildProjectTestPlan({ repoRoot: root, profile: 'quick', only: ['unit'] });
    ok('--only selects exactly one id', only.tasks.length === 1 && only.tasks[0].id === 'unit');

    const skipped = await buildProjectTestPlan({ repoRoot: root, profile: 'quick', skip: ['fail'] });
    ok('--skip removes an id', !skipped.tasks.some((t) => t.id === 'fail'));

    const changed = await buildProjectTestPlan({ repoRoot: root, profile: 'quick', changed: true, changedFiles: ['src/app.js'] });
    ok('--changed maps src path to unit test', changed.tasks.length === 1 && changed.tasks[0].id === 'unit');

    await expectConfigError('--changed with no matching mapping exits config-error', async () => {
      await buildProjectTestPlan({ repoRoot: root, profile: 'quick', changed: true, changedFiles: ['docs/other.txt'] });
    }, /no runnable tests selected/);

    await expectConfigError('unknown --only id is a config error', async () => {
      await buildProjectTestPlan({ repoRoot: root, profile: 'quick', only: ['missing'] });
    }, /unknown --only/);

    const listDoc = JSON.parse(listJson(only));
    ok('list JSON is parseable', listDoc.profile === 'quick' && listDoc.tests[0].id === 'unit');

    // audit P3 — project-test-recent now reads VERIFIED spine receipts, not this
    // last-run.json (which the direct runProjectTest path here doesn't emit). The
    // gate's spine-receipt logic is covered adversarially in p3-verification-guard
    // (pure) and completion-claim-gate (real receipts); the runner assertions below
    // still verify the report + counts + complete flag the receipt is built from.
    const passRun = await runProjectTest({ repoRoot: root, profile: 'quick', only: ['unit'], report: true });
    ok('passing adaptive run exits 0', passRun.exitCode === 0 && passRun.counts.pass === 1);
    ok('narrowed (--only) run is marked incomplete for recency', passRun.complete === false);
    const lastRun = JSON.parse(await readFile(join(root, '.maddu', 'state', 'project-test-last-run.json'), 'utf8'));
    ok('adaptive run writes last-run report', lastRun.profile === 'quick' && lastRun.counts.pass === 1);
    ok('result JSON is parseable', JSON.parse(resultJson(passRun)).ok === true);

    const fullRun = await runProjectTest({ repoRoot: root, profile: 'quick', report: false });
    ok('un-narrowed run is complete for recency', fullRun.complete === true);

    const failRun = await runProjectTest({ repoRoot: root, profile: 'quick', only: ['fail'], report: true });
    ok('failing adaptive run exits 1', failRun.exitCode === 1 && failRun.counts.fail === 1);

    const bailRun = await runProjectTest({ repoRoot: root, profile: 'quick', only: ['fail', 'unit'], bail: true, report: false });
    ok('--bail stops after first failure', bailRun.counts.bailed === true && bailRun.results.length === 1 && bailRun.results[0].id === 'fail');

    const originalError = console.error;
    console.error = () => {};
    const conflictCode = await runProjectTestCli(['--profile', 'quick', '--command', 'node'], { repoRoot: root });
    console.error = originalError;
    ok('adaptive --command conflict exits 2', conflictCode === 2);

    const adaptiveCli = await cli(['test', '--profile', 'quick', '--only', 'unit', '--no-report'], root);
    ok('CLI adaptive profile runs selected test', adaptiveCli.code === 0 && /unit/.test(adaptiveCli.stdout), `code=${adaptiveCli.code}`);
    const eventTypes = await readEventTypes(root);
    ok('CLI adaptive profile emits TOOL events', eventTypes.includes('TOOL_INVOKED') && eventTypes.includes('TOOL_COMPLETED'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const noConfigRoot = await makeRepo({ withConfig: false });
  try {
    const noConfigChanged = await buildProjectTestPlan({ repoRoot: noConfigRoot, profile: 'quick', changed: true, changedFiles: ['src/app.js'] });
    ok('--changed without mappings keeps profile tasks with warning', noConfigChanged.tasks.length > 0 && noConfigChanged.discoveryWarnings.some((w) => /without/.test(w)));
  } finally {
    await rm(noConfigRoot, { recursive: true, force: true });
  }

  const sourceRoot = await makeSourceRepo();
  try {
    const sourceGate = await projectTestRecentGate.run({ repoRoot: sourceRoot });
    ok('project-test-recent skips framework source repo', sourceGate.ok === true && /skipped/.test(sourceGate.message), sourceGate.message);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }

  const legacyRoot = await makeRepo({ withConfig: false });
  try {
    const legacy = await cli(['test', '--command', process.execPath, '--runner-arg', 'scripts/pass.mjs'], legacyRoot);
    ok('plain maddu test still uses legacy --command path', legacy.code === 0 && /ok/.test(legacy.stdout), `code=${legacy.code}`);
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
  }

  const noDetectorRoot = await mkdtemp(join(tmpdir(), 'maddu-project-test-nodetector-'));
  try {
    await mkdir(join(noDetectorRoot, '.maddu'), { recursive: true });
    const noDetector = await cli(['test'], noDetectorRoot);
    ok('plain maddu test keeps legacy no-detector refusal', noDetector.code === 2 && /no-detector/.test(noDetector.stderr + noDetector.stdout), `code=${noDetector.code}`);
  } finally {
    await rm(noDetectorRoot, { recursive: true, force: true });
  }

  console.log('');
  console.log(`Project test harness: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
});
