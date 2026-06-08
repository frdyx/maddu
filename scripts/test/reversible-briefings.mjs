#!/usr/bin/env node
// v1.9.0 — reversible briefings (CCR / retrieve-on-demand).
//
// Lib: curate() over-budget truncates but persists the byte-exact original;
// retrieve() returns it unchanged; under-budget is a pass-through.
// CLI: `maddu orient --curate` with a long handoff emits BRIEFING_CURATED, and
// `maddu learn retrieve <id>` prints the byte-identical full original.

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = join(__dirname, '..', '..');
const BIN = join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');

let failed = 0, passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); passed++; }
  else { console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); failed++; }
}

async function loadLib(file, repoRoot) {
  const installed = join(repoRoot, 'maddu', 'runtime', 'lib', file);
  const sourceLib = join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib', file);
  for (const p of [installed, sourceLib]) {
    try { await readFile(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd || process.cwd(), env: { ...process.env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function makeTmpInstall() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-brief-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'state'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  return tmp;
}

async function libScenario() {
  const tmp = await makeTmpInstall();
  const briefings = await loadLib('briefings.mjs', tmp);
  ok('lib: briefings.mjs loads', !!briefings);
  if (briefings) {
    const long = 'X'.repeat(2000);
    const r = await briefings.curate(tmp, { kind: 'orient', full: long, budget: 500 });
    ok('lib: over-budget marked dropped', r.dropped === true);
    ok('lib: curated shorter than original', r.curated.length < long.length);
    ok('lib: curated mentions retrieve pointer', r.curated.includes(`maddu learn retrieve ${r.briefingId}`));
    const rec = await briefings.retrieve(tmp, r.briefingId);
    ok('lib: retrieve returns byte-identical original', rec && rec.full === long);

    const short = 'short briefing';
    const r2 = await briefings.curate(tmp, { kind: 'orient', full: short, budget: 500 });
    ok('lib: under-budget pass-through (not dropped)', r2.dropped === false && r2.curated === short);
  }
  await rm(tmp, { recursive: true, force: true });
}

async function cliScenario() {
  const tmp = await makeTmpInstall();
  const longHandoff = '▶ RESUME HERE: ' + Array.from({ length: 60 }, (_, i) => `step ${i} do the thing carefully and verify it`).join('. ') + '.';
  let r = await runCli(['handoff', 'set', longHandoff], { cwd: tmp });
  ok('cli: handoff set exit 0', r.code === 0, `exit=${r.code} ${r.stderr.slice(0, 120)}`);

  r = await runCli(['orient', '--curate', '--no-verify', '--curate-budget', '300'], { cwd: tmp });
  ok('cli: orient --curate exit 0', r.code === 0, `exit=${r.code} ${r.stderr.slice(0, 150)}`);
  ok('cli: orient output shows retrieve pointer', /maddu learn retrieve brf_/.test(r.stdout));

  const events = await readSpine(tmp);
  const curated = events.filter((e) => e.type === 'BRIEFING_CURATED');
  ok('cli: 1 BRIEFING_CURATED emitted', curated.length === 1, `got=${curated.length}`);
  ok('cli: BRIEFING_CURATED marks dropped', curated[0]?.data?.dropped === true);

  const id = curated[0]?.data?.briefingId;
  if (id) {
    const ret = await runCli(['learn', 'retrieve', id], { cwd: tmp });
    ok('cli: learn retrieve exit 0', ret.code === 0, `exit=${ret.code}`);
    ok('cli: retrieved full original matches', ret.stdout.trim() === longHandoff);
  } else {
    ok('cli: briefingId present', false);
  }
  await rm(tmp, { recursive: true, force: true });
}

await libScenario();
await cliScenario();

console.log('');
if (failed) { console.log(`REVERSIBLE-BRIEFINGS FAIL — ${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`REVERSIBLE-BRIEFINGS OK — ${passed} assertions passed`);
