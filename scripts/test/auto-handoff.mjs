#!/usr/bin/env node
// v1.10.0 — auto-handoff at slice-stop.
//
// With `slice-stop:auto-handoff` allowlisted, a slice-stop must emit
// TRIGGER_FIRED + HANDOFF_SET (carrying triggered_by), the body must contain the
// slice summary + next steps, and `orient --json` must surface it. Without the
// allowlist entry, no HANDOFF_SET fires.

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = join(__dirname, '..', '..');
const BIN = join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');

let failed = 0, passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); passed++; }
  else { console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); failed++; }
}

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    ch.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    ch.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    ch.on('close', (code) => resolve({ code, stdout, stderr }));
    ch.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

async function readSpine(repoRoot) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  let segs = [];
  try { segs = (await readdir(eventsDir)).filter((f) => f.endsWith('.ndjson')).sort(); } catch { return []; }
  const out = [];
  for (const s of segs) {
    for (const line of (await readFile(join(eventsDir, s), 'utf8')).split('\n')) { if (line.trim()) try { out.push(JSON.parse(line)); } catch {} }
  }
  return out;
}

async function makeRepo(triggers) {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-handoff-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'state'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'config'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'config', 'triggers.json'), JSON.stringify({ allowed: triggers }) + '\n');
  return tmp;
}

async function scenarioEnabled() {
  const tmp = await makeRepo(['slice-stop:auto-handoff']);
  const res = await runCli(['slice-stop', 'SLICE STOP: wired the auth module', '--next', 'add tests;write docs'], { cwd: tmp, env: { MADDU_SESSION_ID: 'ses_handofftest' } });
  ok('enabled: slice-stop exit 0', res.code === 0, `exit=${res.code} ${res.stderr.slice(0, 150)}`);

  const events = await readSpine(tmp);
  const set = events.filter((e) => e.type === 'HANDOFF_SET');
  const fired = events.filter((e) => e.type === 'TRIGGER_FIRED' && e.data?.triggerId === 'slice-stop:auto-handoff');
  ok('enabled: 1 HANDOFF_SET emitted', set.length === 1, `got=${set.length}`);
  ok('enabled: TRIGGER_FIRED with provenance', fired.length === 1 && !!fired[0]?.data?.triggered_by);
  ok('enabled: HANDOFF_SET marked auto + triggered_by', set[0]?.data?.auto === true && !!set[0]?.data?.triggered_by);
  ok('enabled: body has the summary', /wired the auth module/.test(set[0]?.data?.body || ''));
  ok('enabled: body has next steps', /add tests/.test(set[0]?.data?.body || '') && /write docs/.test(set[0]?.data?.body || ''));

  const orient = await runCli(['orient', '--json', '--no-verify'], { cwd: tmp });
  let parsed = {};
  try { parsed = JSON.parse(orient.stdout); } catch {}
  ok('enabled: orient --json surfaces handoff body', /wired the auth module/.test(parsed?.handoff?.body || ''));
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioDisabled() {
  const tmp = await makeRepo(['slice-stop:skill-candidate']); // auto-handoff NOT allowlisted
  const res = await runCli(['slice-stop', 'SLICE STOP: did a thing'], { cwd: tmp, env: { MADDU_SESSION_ID: 'ses_handofftest' } });
  ok('disabled: slice-stop exit 0', res.code === 0, `exit=${res.code}`);
  const events = await readSpine(tmp);
  ok('disabled: no HANDOFF_SET', events.filter((e) => e.type === 'HANDOFF_SET').length === 0);
  await rm(tmp, { recursive: true, force: true });
}

await scenarioEnabled();
await scenarioDisabled();

console.log('');
if (failed) { console.log(`AUTO-HANDOFF FAIL — ${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`AUTO-HANDOFF OK — ${passed} assertions passed`);
