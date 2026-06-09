#!/usr/bin/env node
// v1.10.0 — auto-review after slice-stop (gated, safe no-op default).
//
// (a) auto-review allowlisted but NO reviewer configured → slice-stop runs
//     clean, no SLICE_REVIEWED, no error (graceful no-op).
// (b) a fake kind:'reviewer' runtime configured → slice-stop auto-fires it →
//     SLICE_REVIEWED + FOLLOWUP_OPENED land with triggered_by.
// (c) an immediate second slice-stop respects the cooldown (no double review).

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
    const ch = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd, env: { ...process.env, MADDU_SESSION_ID: 'ses_reviewtest', ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function makeRepo() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-autorev-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'state'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'config'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'runtimes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'config', 'triggers.json'), JSON.stringify({ allowed: ['slice-stop:auto-review'] }) + '\n');
  return tmp;
}

async function configureFakeReviewer(tmp) {
  const script = join(tmp, 'fake-reviewer.mjs');
  await writeFile(script, 'process.stdout.write(JSON.stringify({verdict:"P2",findings:[{severity:"P2",location:"src/auth.ts:10",message:"missing null check"}]}));\n');
  await writeFile(join(tmp, '.maddu', 'runtimes', 'fakereviewer.json'), JSON.stringify({
    schemaVersion: 1, name: 'fakereviewer', kind: 'reviewer', binary: process.execPath, args: [script, '${SLICE_EVENT_ID}'],
  }, null, 2) + '\n');
  await writeFile(join(tmp, '.maddu', 'config', 'review-policy.json'), JSON.stringify({ defaultReviewer: 'fakereviewer' }, null, 2) + '\n');
}

async function scenarioNoReviewer() {
  const tmp = await makeRepo();
  const res = await runCli(['slice-stop', 'SLICE STOP: did work'], { cwd: tmp });
  ok('no-reviewer: slice-stop exit 0', res.code === 0, `exit=${res.code} ${res.stderr.slice(0, 150)}`);
  const events = await readSpine(tmp);
  ok('no-reviewer: no SLICE_REVIEWED (graceful no-op)', events.filter((e) => e.type === 'SLICE_REVIEWED').length === 0);
  ok('no-reviewer: no auto-review TRIGGER_FIRED', events.filter((e) => e.type === 'TRIGGER_FIRED' && e.data?.triggerId === 'slice-stop:auto-review').length === 0);
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioWithReviewer() {
  const tmp = await makeRepo();
  await configureFakeReviewer(tmp);

  let res = await runCli(['slice-stop', 'SLICE STOP: changed auth'], { cwd: tmp });
  ok('reviewer: slice-stop exit 0', res.code === 0, `exit=${res.code} ${res.stderr.slice(0, 150)}`);
  let events = await readSpine(tmp);
  const reviewed = events.filter((e) => e.type === 'SLICE_REVIEWED');
  ok('reviewer: 1 SLICE_REVIEWED', reviewed.length === 1, `got=${reviewed.length}`);
  ok('reviewer: verdict P2 + triggered_by', reviewed[0]?.data?.verdict === 'P2' && !!reviewed[0]?.triggered_by);
  ok('reviewer: FOLLOWUP_OPENED (P2)', events.filter((e) => e.type === 'FOLLOWUP_OPENED').length === 1);
  ok('reviewer: TRIGGER_FIRED anchor', events.filter((e) => e.type === 'TRIGGER_FIRED' && e.data?.triggerId === 'slice-stop:auto-review').length === 1);

  // (c) immediate second slice-stop → cooldown → no new review.
  res = await runCli(['slice-stop', 'SLICE STOP: another quick change'], { cwd: tmp });
  ok('cooldown: second slice-stop exit 0', res.code === 0);
  events = await readSpine(tmp);
  ok('cooldown: still only 1 SLICE_REVIEWED', events.filter((e) => e.type === 'SLICE_REVIEWED').length === 1, `got=${events.filter((e) => e.type === 'SLICE_REVIEWED').length}`);
  await rm(tmp, { recursive: true, force: true });
}

await scenarioNoReviewer();
await scenarioWithReviewer();

console.log('');
if (failed) { console.log(`AUTO-REVIEW FAIL — ${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`AUTO-REVIEW OK — ${passed} assertions passed`);
