#!/usr/bin/env node
// D2 (v1.13.0) — slice-scope honesty via git cross-check.
//
// The slice-scope gate is only as honest as the touched paths it is handed.
// Self-reported --targets/--paths can under-report. slice-stop now unions in
// the ACTUAL working-tree changes from git, so an out-of-scope edit the agent
// did NOT declare is still caught. This drives the real refusal path:
//   - edit a file OUTSIDE declared scope, report NOTHING → slice-stop refused.
//   - edit a file INSIDE declared scope, report nothing → slice-stop allowed.
// Máddu's own .maddu/ state churn must NOT trip the gate.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');
const LIB = path.join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib');

function fail(msg) { console.error(`SLICE-SCOPE-GITDIFF FAILED: ${msg}`); process.exit(1); }

function git(cwd, args) { execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }); }

async function setupRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-scope-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(path.join(tmp, 'allowed'), { recursive: true });
  await mkdir(path.join(tmp, 'forbidden'), { recursive: true });
  await writeFile(path.join(tmp, 'allowed', 'a.txt'), 'base\n');
  await writeFile(path.join(tmp, 'forbidden', 'b.txt'), 'base\n');
  git(tmp, ['init']);
  git(tmp, ['config', 'user.email', 't@t.t']);
  git(tmp, ['config', 'user.name', 't']);
  git(tmp, ['add', 'allowed/a.txt', 'forbidden/b.txt']);
  git(tmp, ['commit', '-m', 'base']);
  // Seed a session + a declared scope of `allowed/`.
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const sid = 'ses_scopefixture_0001';
  await spine.append(tmp, { type: 'SESSION_REGISTERED', actor: sid, data: { role: 'implementer' } });
  await spine.append(tmp, { type: 'SLICE_SCOPE_DECLARED', data: { sliceId: 'sl1', scope: ['allowed/'] } });
  return { tmp, sid };
}

function runSliceStop(cwd, sid) {
  const r = spawnSync(process.execPath, [BIN, 'slice-stop', '--session', sid, '--slice-id', 'sl1', 'SLICE STOP: test'],
    { cwd, encoding: 'utf8', env: { ...process.env, MADDU_SESSION_ID: sid } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function main() {
  // ── Case 1: unreported edit OUTSIDE scope → refused (git catches it). ──
  {
    const { tmp, sid } = await setupRepo();
    try {
      await writeFile(path.join(tmp, 'forbidden', 'b.txt'), 'EDITED OUT OF SCOPE\n');
      const r = runSliceStop(tmp, sid);
      if (r.code === 0) fail(`out-of-scope edit was NOT refused (exit 0)\n${r.out}`);
      if (!/slice-scope/i.test(r.out) || !/forbidden\/b\.txt/.test(r.out)) {
        fail(`refusal did not cite the out-of-scope file\n${r.out}`);
      }
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── Case 2: edit INSIDE scope, report nothing → allowed. ──
  {
    const { tmp, sid } = await setupRepo();
    try {
      await writeFile(path.join(tmp, 'allowed', 'a.txt'), 'EDITED IN SCOPE\n');
      const r = runSliceStop(tmp, sid);
      if (r.code !== 0) fail(`in-scope edit was wrongly refused (exit ${r.code})\n${r.out}`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  console.log('SLICE-SCOPE-GITDIFF OK (unreported out-of-scope edit refused via git cross-check; in-scope allowed)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
