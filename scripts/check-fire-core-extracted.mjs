#!/usr/bin/env node
// check-fire-core-extracted — the success condition for Track A PR2.
//
// WHY THIS IS NOT IN scripts/test/
// Two reasons, both deliberate. It is auto-discovery-exempt (the self-test
// runner sweeps scripts/test/*.mjs), so it can be RED for as long as PR2 is
// unstarted without turning CI red. And it is not a test: it asserts that a
// piece of work HAPPENED, which is a different claim from asserting that
// behavior is correct.
//
// WHY IT EXISTS AT ALL
// PR2's success condition used to be `node scripts/test/harness-hook-core.mjs`
// alone. That suite is a behavior LOCK — written by the supervisor before the
// refactor, against the code shipping today, so that the extraction has
// something to be wrong against. It therefore passes now, with no extraction
// performed. The moment the oracle merged (#315), the goal flipped PR2 to
// "met" and the readout claimed a PR nobody had started.
//
// A green that means something other than what it says, inside the system
// whose entire purpose is not doing that. The condition had silently assumed
// the suite could only exist after the implementation; decoupling them — which
// is exactly what makes the suite trustworthy — broke the assumption.
//
// WHAT "DONE" MEANS HERE, in three claims that are each independently false today:
//   1. the extracted module exists            (the core was moved somewhere)
//   2. commands/hooks.mjs delegates to it     (moved, not copied — one owner)
//   3. the behavior lock still passes         (and nothing Claude Code sees changed)
//
// Claim 2 is what stops a passing 1+3 from being satisfied by an empty
// directory beside an untouched 1258-line hooks.mjs.
//
// Exit codes: 0 = PR2 is genuinely done, 1 = not done (or regressed).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_DIR = join(ROOT, 'template', 'maddu', 'runtime', 'lib', 'harness');
const HOOKS_CMD = join(ROOT, 'commands', 'hooks.mjs');
const LOCK = join(ROOT, 'scripts', 'test', 'harness-hook-core.mjs');

const fail = [];

// 1. the extracted module exists
let modules = [];
if (!existsSync(HARNESS_DIR)) {
  fail.push('template/maddu/runtime/lib/harness/ does not exist — the fire core has not been extracted');
} else {
  modules = readdirSync(HARNESS_DIR).filter((f) => f.endsWith('.mjs'));
  if (!modules.length) fail.push('template/maddu/runtime/lib/harness/ exists but holds no .mjs module');
}

// 2. the CLI delegates to it, rather than keeping its own copy
if (modules.length) {
  const hooks = readFileSync(HOOKS_CMD, 'utf8');
  if (!/harness\//.test(hooks)) {
    fail.push('commands/hooks.mjs does not reference lib/harness/ — the core was copied, not extracted');
  }
}

// 3. and Claude sees exactly what it saw before
const lock = spawnSync(process.execPath, [LOCK], { cwd: ROOT, encoding: 'utf8' });
if (lock.status !== 0) {
  fail.push(`the behavior lock is red — harness-hook-core exited ${lock.status}`);
  const lines = `${lock.stdout || ''}${lock.stderr || ''}`.split('\n').filter((l) => l.includes('[FAIL]'));
  for (const l of lines.slice(0, 6)) fail.push(`    ${l.trim()}`);
}

if (fail.length) {
  console.error('PR2 fire-core extraction: NOT DONE');
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`PR2 fire-core extraction: done (${modules.length} module(s) in lib/harness/, hooks.mjs delegates, behavior lock green)`);
