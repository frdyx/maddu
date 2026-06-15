#!/usr/bin/env node
// Lane release idempotency and verifier classification regression.

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..');
const SRC_BIN = join(SRC_ROOT, 'bin', 'maddu.mjs');
const SPINE_LIB = join(SRC_ROOT, 'template', 'maddu', 'runtime', 'lib', 'spine.mjs');

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  const tag = cond ? '[PASS]' : '[FAIL]';
  console.log(`  ${tag} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++;
  else failed++;
}

function runMaddu(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SRC_BIN, ...args], {
      cwd: opts.cwd || SRC_ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

async function eventsText(repo) {
  return readFile(join(repo, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
}

async function appendDuplicateRelease(repo, sessionId) {
  const spine = await import(pathToFileURL(SPINE_LIB).href);
  await spine.append(repo, {
    type: spine.EVENT_TYPES.LANE_RELEASED,
    actor: sessionId,
    lane: 'frontend',
    data: { source: 'test-duplicate' },
  });
}

const root = await mkdtemp(join(tmpdir(), 'maddu-lane-release-'));
const repo = join(root, 'repo');
const sessionId = 'ses_20260615141500_aaaaaa';
const strangerId = 'ses_20260615141500_bbbbbb';

try {
  await mkdir(repo, { recursive: true });
  let res = await runMaddu(['init'], { cwd: repo });
  ok('init exits 0', res.code === 0, res.stderr.slice(0, 160));

  const beforeNoop = await eventsText(repo);
  res = await runMaddu(['lane', 'release', 'frontend', '--session', sessionId], { cwd: repo });
  const afterNoop = await eventsText(repo);
  ok('release with no active claim exits 0', res.code === 0, res.stderr.slice(0, 160));
  ok('release with no active claim writes no event', beforeNoop === afterNoop);

  res = await runMaddu(['lane', 'claim', 'frontend', '--session', sessionId], { cwd: repo });
  ok('lane claim exits 0', res.code === 0, res.stderr.slice(0, 160));
  res = await runMaddu(['lane', 'release', 'frontend', '--session', strangerId], { cwd: repo });
  ok('release by non-holder is refused', res.code === 3 && /cannot release/.test(res.stderr), res.stderr.slice(0, 160));
  res = await runMaddu(['lane', 'release', 'frontend', '--session', sessionId], { cwd: repo });
  ok('release by holder exits 0', res.code === 0, res.stderr.slice(0, 160));

  await appendDuplicateRelease(repo, sessionId);
  res = await runMaddu(['spine', 'verify'], { cwd: repo });
  ok('duplicate historical release is warn-only', res.code === 0 && /duplicate_lane_release/.test(res.stdout) && !/orphan_lane_release/.test(res.stdout));
  res = await runMaddu(['doctor', '--gate', 'spine-integrity'], { cwd: repo });
  ok('spine-integrity gate surfaces verifier warnings', res.code === 0 && /WARN\s+spine integrity/.test(stripAnsi(res.stdout)) && /1 warn/.test(stripAnsi(res.stdout)));

  const orphanRepo = join(root, 'orphan-repo');
  await mkdir(orphanRepo, { recursive: true });
  res = await runMaddu(['init'], { cwd: orphanRepo });
  ok('orphan repo init exits 0', res.code === 0, res.stderr.slice(0, 160));
  const spine = await import(pathToFileURL(SPINE_LIB).href);
  await spine.append(orphanRepo, {
    type: spine.EVENT_TYPES.LANE_RELEASED,
    actor: sessionId,
    lane: 'frontend',
    data: { source: 'test-orphan' },
  });
  res = await runMaddu(['spine', 'verify'], { cwd: orphanRepo });
  ok('never-claimed release still fails', res.code !== 0 && /orphan_lane_release/.test(res.stdout));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('');
console.log(`Lane release idempotency: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
