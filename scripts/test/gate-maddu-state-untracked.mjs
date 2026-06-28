#!/usr/bin/env node
// gate-maddu-state-untracked — the .maddu git-tracking advisory gate (v1.74.2).
//
// Policy A: the rebuildable/volatile parts of .maddu/ (spine, projections,
// sessions, runtime dirs) should NOT be git-tracked; durable artifacts
// (config/, skills/, plans/, wiki/, lanes/catalog.json, the architecture
// baseline) should. This drives the gate against throwaway git repos: a clean
// (durable-only) tree passes; a tree that tracks runtime state warns with the
// exact `git rm -r --cached` remediation; a non-git dir skips.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import gate from '../../template/maddu/runtime/gates/builtin/maddu-state-untracked.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });

async function seedRepo(files) {
  const dir = await mkdtemp(join(tmpdir(), 'maddu-track-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body);
  }
  git(dir, 'add', '-A', '-f');
  return dir;
}

async function main() {
  ok('gate id + warn severity', gate.id === 'maddu-state-untracked' && gate.severity === 'warn');

  // ── durable-only tree → PASS ──
  const clean = await seedRepo({
    '.maddu/config/triggers.json': '{}',
    '.maddu/lanes/catalog.json': '{"lanes":[]}',
    '.maddu/skills/x.md': '# skill',
    '.maddu/state/architecture/mass-baseline.json': '{}',
  });
  const rClean = await gate.run({ repoRoot: clean });
  ok('durable-only tree passes', rClean.ok === true, rClean.message);

  // ── tracks runtime state → WARN with remediation ──
  const leaky = await seedRepo({
    '.maddu/config/triggers.json': '{}',
    '.maddu/events/000000000001.ndjson': '{"type":"X"}\n',
    '.maddu/state/lanes.json': '{}',
    '.maddu/sessions/ses_1.json': '{}',
  });
  const rLeak = await gate.run({ repoRoot: leaky });
  ok('tracked runtime state warns', rLeak.ok === false, rLeak.message);
  ok('remediation names the leaked top-dirs', rLeak.evidence
    && /git rm -r --cached/.test(rLeak.evidence.untrackCommand)
    && rLeak.evidence.untrackCommand.includes('.maddu/events')
    && rLeak.evidence.untrackCommand.includes('.maddu/state')
    && rLeak.evidence.untrackCommand.includes('.maddu/sessions'), rLeak.evidence?.untrackCommand);
  ok('durable config is NOT named in the remediation', rLeak.evidence && !rLeak.evidence.untrackCommand.includes('.maddu/config'), rLeak.evidence?.untrackCommand);

  // ── non-git dir → skip cleanly ──
  const plain = await mkdtemp(join(tmpdir(), 'maddu-nogit-'));
  const rPlain = await gate.run({ repoRoot: plain });
  ok('non-git dir skips cleanly', rPlain.ok === true && /not a git repo/.test(rPlain.message), rPlain.message);

  await Promise.all([clean, leaky, plain].map((d) => rm(d, { recursive: true, force: true })));
}

try {
  await main();
  console.log('');
  console.log(`gate-maddu-state-untracked: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('gate-maddu-state-untracked OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
