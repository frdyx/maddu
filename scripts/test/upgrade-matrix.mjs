#!/usr/bin/env node
// Upgrade-path matrix — v0.19 Phase 6.
//
// Exercises 4 source-version → v0.19.x upgrade scenarios:
//   1. Fresh install (no prior .maddu/)
//   2. v0.16.0 baseline
//   3. v0.17.1 baseline
//   4. v0.18.0 baseline
//
// For each prior-version scenario the matrix:
//   a. checks out the tagged framework source into a tmp dir via `git worktree add`
//   b. runs that tag's `bin/maddu.mjs init` into a fresh consumer tmp dir
//   c. runs the CURRENT source's `bin/maddu.mjs upgrade --force` from
//      inside the consumer dir, bumping it to v0.19.x
//   d. runs the consumer's own `maddu doctor` and asserts 0 FAIL
//
// Each scenario writes an upgrade-matrix.<scenario>.json report.

import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..');
const SRC_BIN = join(SRC_ROOT, 'bin', 'maddu.mjs');

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const reportDir = value('report-dir') || join(SRC_ROOT, '.maddu', 'state', 'upgrade-matrix-reports');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  const tag = cond ? '[PASS]' : '[FAIL]';
  console.log(`  ${tag} ${name}${extra ? ` — ${extra}` : ''}`);
  if (cond) passed++; else failed++;
  return cond;
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], shell: opts.shell || false });
    let stdout = '', stderr = '';
    ch.stdout.on('data', (b) => stdout += b.toString());
    ch.stderr.on('data', (b) => stderr += b.toString());
    ch.on('close', (code) => resolve({ code, stdout, stderr }));
    ch.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

async function checkoutTag(tag) {
  const tmp = await mkdtemp(join(tmpdir(), `maddu-tag-${tag.replace(/[/\\]/g, '_')}-`));
  const wt = await run('git', ['worktree', 'add', '--detach', tmp, tag], { cwd: SRC_ROOT });
  if (wt.code !== 0) {
    return { tmp: null, error: `git worktree add ${tag} failed: ${wt.stderr || wt.stdout}` };
  }
  return { tmp, cleanup: async () => {
    try { await run('git', ['worktree', 'remove', '--force', tmp], { cwd: SRC_ROOT }); } catch {}
    try { await rm(tmp, { recursive: true, force: true }); } catch {}
  } };
}

async function doctorReport(consumerDir) {
  const bin = join(consumerDir, 'maddu', 'bin', 'maddu.mjs');
  const res = await run(process.execPath, [bin, 'doctor'], { cwd: consumerDir });
  const summary = /(\d+)\s+pass.*?(\d+)\s+warn.*?(\d+)\s+fail/i.exec(res.stdout);
  return {
    code: res.code,
    pass: summary ? Number(summary[1]) : 0,
    warn: summary ? Number(summary[2]) : 0,
    fail: summary ? Number(summary[3]) : 0,
    raw: res.stdout,
    stderr: res.stderr,
  };
}

async function writeReport(scenario, body) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, `upgrade-matrix.${scenario}.json`),
    JSON.stringify({ scenario, timestamp: new Date().toISOString(), ...body }, null, 2) + '\n');
}

async function scenarioFreshInstall() {
  const name = 'fresh-install';
  const consumer = await mkdtemp(join(tmpdir(), 'maddu-up-fresh-'));
  try {
    const init = await run(process.execPath, [SRC_BIN, 'init'], { cwd: consumer });
    ok(`${name}: init exits 0`, init.code === 0, `stderr=${init.stderr.slice(0, 200)}`);
    const doctor = await doctorReport(consumer);
    ok(`${name}: doctor exits 0`, doctor.code === 0);
    ok(`${name}: 0 doctor fails`, doctor.fail === 0, `fail=${doctor.fail}`);
    ok(`${name}: >= 25 doctor passes`, doctor.pass >= 25, `pass=${doctor.pass}`);
    await writeReport(name, { ok: doctor.fail === 0, pass: doctor.pass, warn: doctor.warn, fail: doctor.fail });
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

async function scenarioFromTag(tag, expectMinPass) {
  const name = `from-${tag}`;
  const wt = await checkoutTag(tag);
  if (!wt.tmp) { ok(`${name}: worktree checkout`, false, wt.error); return; }
  const consumer = await mkdtemp(join(tmpdir(), `maddu-up-${tag.replace(/[/\\]/g, '_')}-`));
  try {
    const oldBin = join(wt.tmp, 'bin', 'maddu.mjs');
    if (!(await exists(oldBin))) {
      ok(`${name}: old bin present`, false);
      await writeReport(name, { ok: false, reason: 'old bin missing' });
      return;
    }
    const init = await run(process.execPath, [oldBin, 'init'], { cwd: consumer });
    if (init.code !== 0) {
      ok(`${name}: old-tag init exits 0`, false, `stderr=${init.stderr.slice(0, 200)}`);
      await writeReport(name, { ok: false, reason: 'old init failed', stderr: init.stderr.slice(0, 200) });
      return;
    }
    ok(`${name}: old-tag init exits 0`, true);
    const upgrade = await run(process.execPath, [SRC_BIN, 'upgrade', '--force'], { cwd: consumer });
    ok(`${name}: upgrade --force exits 0`, upgrade.code === 0, `stderr=${upgrade.stderr.slice(0, 200)}`);
    const doctor = await doctorReport(consumer);
    ok(`${name}: doctor exits 0 after upgrade`, doctor.code === 0);
    ok(`${name}: 0 doctor fails`, doctor.fail === 0, `fail=${doctor.fail}`);
    ok(`${name}: >= ${expectMinPass} doctor passes`, doctor.pass >= expectMinPass, `pass=${doctor.pass}`);
    await writeReport(name, { ok: doctor.fail === 0, pass: doctor.pass, warn: doctor.warn, fail: doctor.fail });
  } finally {
    await rm(consumer, { recursive: true, force: true });
    if (wt.cleanup) await wt.cleanup();
  }
}

const TARGETS = [
  ['fresh-install', scenarioFreshInstall],
  ['from-v0.16.0', () => scenarioFromTag('v0.16.0', 18)],
  ['from-v0.17.1', () => scenarioFromTag('v0.17.1', 22)],
  ['from-v0.18.0', () => scenarioFromTag('v0.18.0', 25)],
];

const start = Date.now();
const onlyScenario = value('scenario');
for (const [name, fn] of TARGETS) {
  if (onlyScenario && name !== onlyScenario) continue;
  await fn();
}
const totalMs = Date.now() - start;

const lastRunPath = join(SRC_ROOT, '.maddu', 'state', 'upgrade-matrix-last-run.json');
try {
  await mkdir(dirname(lastRunPath), { recursive: true });
  await writeFile(lastRunPath, JSON.stringify({
    ts: new Date().toISOString(),
    aggregateMs: totalMs,
    passed, failed,
  }, null, 2) + '\n');
} catch {}

console.log('');
console.log(`Upgrade matrix: ${passed} pass · ${failed} fail · ${totalMs}ms`);
if (failed > 0) { console.log('UPGRADE MATRIX FAIL'); process.exit(1); }
console.log('UPGRADE MATRIX OK');
