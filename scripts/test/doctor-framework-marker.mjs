#!/usr/bin/env node
// A1 (v1.13.0) — framework-source doctor marker is informational, not a FAIL.
//
// `maddu doctor` run in the Máddu framework *source* repo must NOT red-FAIL on
// the absent `maddu.json` install marker — the source repo IS Máddu and was
// never installed into anything. It should emit an explicit INFO line and exit
// 0. But a genuinely broken consumer install (a repo with `.maddu/` but no
// `maddu.json` and none of the framework-source signals) must STILL FAIL, so
// the real install-integrity guarantee is preserved.
//
// Covers both cases via subprocess so the assertion is on real doctor output.

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');

function fail(msg) { console.error(`DOCTOR-FRAMEWORK-MARKER FAILED: ${msg}`); process.exit(1); }

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) { return (s || '').replace(ANSI_RE, ''); }

function runDoctor(cwd) {
  const r = spawnSync(process.execPath, [CLI, 'doctor'], { cwd, encoding: 'utf8' });
  return { code: r.status, out: stripAnsi((r.stdout || '') + (r.stderr || '')) };
}

async function main() {
  // ── Case 1: framework source repo → INFO line, exit 0, no maddu.json FAIL. ──
  const r1 = runDoctor(FRAMEWORK_ROOT);
  if (r1.code !== 0) fail(`framework-source doctor exited ${r1.code} (expected 0)\n${r1.out}`);
  if (!/INFO\s+install marker/.test(r1.out)) fail(`framework-source doctor missing INFO install-marker line\n${r1.out}`);
  if (!/framework source repo/i.test(r1.out)) fail(`framework-source doctor INFO line missing the explanatory message\n${r1.out}`);
  if (/FAIL\s+(?:\[[^\]]+\]\s+)?maddu\.json/.test(r1.out)) fail(`framework-source doctor still red-FAILs on maddu.json\n${r1.out}`);

  // ── Case 2: broken consumer install → FAIL still fires. ──
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-doctor-marker-'));
  try {
    await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
    // A consumer-shaped repo: NOT the framework source. Different package name,
    // no template/maddu/ tree, no commands/ dir — and crucially no maddu.json.
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'some-consumer-app', version: '0.0.1' }, null, 2) + '\n');
    const r2 = runDoctor(tmp);
    if (r2.code !== 1) fail(`broken-consumer doctor exited ${r2.code} (expected 1)\n${r2.out}`);
    if (!/FAIL\s+(?:\[[^\]]+\]\s+)?maddu\.json/.test(r2.out)) fail(`broken-consumer doctor did not FAIL on missing maddu.json\n${r2.out}`);
    if (!/missing/.test(r2.out)) fail(`broken-consumer doctor FAIL lacks "missing" detail\n${r2.out}`);
    if (/INFO\s+install marker/.test(r2.out)) fail(`broken-consumer doctor wrongly treated as framework source\n${r2.out}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('DOCTOR-FRAMEWORK-MARKER OK (source → INFO+exit0; broken consumer → FAIL+exit1)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
