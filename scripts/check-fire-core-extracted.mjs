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
// PROVEN TO DISCRIMINATE
// Until PR2 lands this check can only be observed returning 1, and a check
// only ever seen failing is exactly as unproven as one only ever seen passing.
// `evaluate()` is therefore pure and injectable, and
// scripts/test/pr2-check-discriminates.mjs drives it against synthetic trees to
// prove each of the three claims independently decides the verdict — including
// the case where everything is in place and the answer is DONE.
//
// Exit codes: 0 = PR2 is genuinely done, 1 = not done (or regressed).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Run the behavior lock in `root`. Injected so the discrimination test can
// supply a verdict without spawning anything.
export function defaultLockRunner(root) {
  const lock = join(root, 'scripts', 'test', 'harness-hook-core.mjs');
  const r = spawnSync(process.execPath, [lock], { cwd: root, encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

// Pure: filesystem in, verdict out. Every failure carries the reason it failed,
// so a case cannot pass for an unrelated one.
export function evaluate(root, runLock = defaultLockRunner) {
  const reasons = [];
  const harnessDir = join(root, 'template', 'maddu', 'runtime', 'lib', 'harness');
  const hooksCmd = join(root, 'commands', 'hooks.mjs');

  // 1. the extracted module exists
  let modules = [];
  if (!existsSync(harnessDir)) {
    reasons.push('template/maddu/runtime/lib/harness/ does not exist — the fire core has not been extracted');
  } else {
    modules = readdirSync(harnessDir).filter((f) => f.endsWith('.mjs'));
    if (!modules.length) reasons.push('template/maddu/runtime/lib/harness/ exists but holds no .mjs module');
  }

  // 2. the CLI delegates to it, rather than keeping its own copy
  if (modules.length) {
    let hooks = null;
    try { hooks = readFileSync(hooksCmd, 'utf8'); }
    catch { reasons.push('commands/hooks.mjs is unreadable — cannot confirm delegation'); }
    if (hooks !== null && !/harness\//.test(hooks)) {
      reasons.push('commands/hooks.mjs does not reference lib/harness/ — the core was copied, not extracted');
    }
  }

  // 3. and Claude sees exactly what it saw before
  const lock = runLock(root);
  if (lock.status !== 0) {
    reasons.push(`the behavior lock is red — harness-hook-core exited ${lock.status}`);
    for (const l of (lock.output || '').split('\n').filter((x) => x.includes('[FAIL]')).slice(0, 6)) {
      reasons.push(`    ${l.trim()}`);
    }
  }

  return { ok: reasons.length === 0, reasons, modules };
}

// CLI. Skipped when imported, so the discrimination test can load evaluate()
// without this running or exiting.
//
// argv[1] is resolved before comparing, and that is not cosmetic: if this guard
// ever failed to recognize a direct invocation, the script would import cleanly,
// print nothing and exit 0 — reporting PR2 DONE by saying nothing at all. The
// silent-false-green failure mode is the one this whole file exists to prevent,
// so the guard is covered by a spawned assertion in
// scripts/test/pr2-check-discriminates.mjs rather than trusted.
const invokedDirectly = process.argv[1]
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invokedDirectly) {
  const { ok, reasons, modules } = evaluate(ROOT);
  if (!ok) {
    console.error('PR2 fire-core extraction: NOT DONE');
    for (const r of reasons) console.error(`  - ${r}`);
    process.exit(1);
  }
  console.log(`PR2 fire-core extraction: done (${modules.length} module(s) in lib/harness/, hooks.mjs delegates, behavior lock green)`);
}
