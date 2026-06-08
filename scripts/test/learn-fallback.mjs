#!/usr/bin/env node
// v1.9.0 failure-learning — no-provider fallback test.
//
// `maddu learn digest` must mine the fixtures, write a review digest, emit
// LEARN_DIGEST_WRITTEN, and NEVER spawn a worker or emit LEARN_JUDGED.

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = join(__dirname, '..', '..');
const BIN = join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'transcripts');

let failed = 0, passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); passed++; }
  else { console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); failed++; }
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
    const text = await readFile(join(eventsDir, s), 'utf8');
    for (const line of text.split('\n')) { if (line.trim()) try { out.push(JSON.parse(line)); } catch {} }
  }
  return out;
}

async function makeTmpInstall() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-learn-fb-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'state'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  return tmp;
}

async function main() {
  const tmp = await makeTmpInstall();
  const res = await runCli(['learn', 'digest', '--root', FIXTURE_ROOT], { cwd: tmp });
  ok('digest: exit 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);

  const events = await readSpine(tmp);
  ok('digest: 1 LEARN_MINED', events.filter((e) => e.type === 'LEARN_MINED').length === 1);
  ok('digest: 1 LEARN_DIGEST_WRITTEN', events.filter((e) => e.type === 'LEARN_DIGEST_WRITTEN').length === 1);
  ok('digest: NO LEARN_JUDGED (no provider spawned)', events.filter((e) => e.type === 'LEARN_JUDGED').length === 0);
  ok('digest: NO corrections written', events.filter((e) => e.type === 'LEARN_CORRECTION_WRITTEN').length === 0);

  const mined = events.find((e) => e.type === 'LEARN_MINED');
  ok('digest: LEARN_MINED reports 5 candidates', mined?.data?.candidates === 5, `got=${mined?.data?.candidates}`);

  // The digest file exists and lists categories.
  const learnDir = join(tmp, '.maddu', 'state', 'learn');
  let mdFiles = [];
  try { mdFiles = (await readdir(learnDir)).filter((f) => f.endsWith('.md')); } catch {}
  ok('digest: a .md digest was written', mdFiles.length === 1, `files=${mdFiles.length}`);
  if (mdFiles.length) {
    const body = await readFile(join(learnDir, mdFiles[0]), 'utf8');
    ok('digest: md mentions file-path category', body.includes('file-path'));
  }

  await rm(tmp, { recursive: true, force: true });
  console.log('');
  if (failed) { console.log(`LEARN-FALLBACK FAIL — ${failed} failed, ${passed} passed`); process.exit(1); }
  console.log(`LEARN-FALLBACK OK — ${passed} assertions passed`);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
