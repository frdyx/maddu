#!/usr/bin/env node
// Upgrade events must preserve spine prev_hash continuity once a repo is chained.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..');
const SRC_BIN = join(SRC_ROOT, 'bin', 'maddu.mjs');

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

const root = await mkdtemp(join(tmpdir(), 'maddu-upgrade-prev-hash-'));
const repo = join(root, 'repo');

try {
  await mkdir(repo, { recursive: true });
  let res = await runMaddu(['init'], { cwd: repo });
  ok('init exits 0', res.code === 0, res.stderr.slice(0, 160));

  res = await runMaddu(['doctor', '--gate', 'install-integrity'], { cwd: repo });
  ok('doctor starts prev_hash chain', res.code === 0, res.stderr.slice(0, 160));

  res = await runMaddu(['upgrade', '--force'], { cwd: repo });
  ok('upgrade --force exits 0', res.code === 0, res.stderr.slice(0, 160));

  res = await runMaddu(['spine', 'verify'], { cwd: repo });
  ok('spine verify exits 0 after upgrade', res.code === 0, res.stderr.slice(0, 160));
  ok('upgrade wrote no chain gaps', !/chain_gap|chain_broken/.test(res.stdout));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('');
console.log(`Upgrade prev_hash: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
