#!/usr/bin/env node
// pr2-check-discriminates — prove the PR2 success condition can say DONE.
//
// WHY
// scripts/check-fire-core-extracted.mjs decides whether Track A PR2 is
// finished. Until PR2 actually lands it can only ever be observed returning
// NOT DONE, and a check only ever seen failing is exactly as unproven as one
// only ever seen passing: if its delegation match were wrong, or its module
// discovery missed, a genuinely-complete PR2 would still read as unstarted —
// blocking correct work and teaching the next actor that the gate is noise.
//
// So this drives `evaluate()` against synthetic trees and asserts that each of
// its three claims INDEPENDENTLY decides the verdict, including the one state
// nobody can observe in this repo yet: everything in place, answer DONE.
//
// Each negative case also asserts WHICH reason fired. Without that a case could
// pass for an unrelated failure and the test would still look green — the
// difference between "it said no" and "it said no for the right reason".
//
// No subprocess: the behavior lock is injected, so this costs milliseconds and
// never touches the real repo.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hermeticEnv } from './_hermetic-env.mjs';

const { evaluate, ROOT } = await import('../check-fire-core-extracted.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const lockGreen = () => ({ status: 0, output: '' });
const lockRed = () => ({ status: 1, output: '  [FAIL] a throw at the handler seam is contained\nharness-hook-core FAILED' });

// Build a tree in the shape evaluate() reads. `opts` removes exactly one
// ingredient at a time, so every case differs from DONE by one fact.
async function tree(base, name, opts = {}) {
  const root = join(base, name);
  await mkdir(join(root, 'commands'), { recursive: true });
  const harness = join(root, 'template', 'maddu', 'runtime', 'lib', 'harness');
  if (opts.harnessDir !== false) {
    await mkdir(harness, { recursive: true });
    if (opts.module !== false) {
      await writeFile(join(harness, 'hook-core.mjs'), 'export function fire() {}\n');
    }
  }
  if (opts.hooksFile !== false) {
    const body = opts.delegates === false
      ? "import { something } from './_libroot.mjs';\nexport default async function hooks() {}\n"
      : "import { fire } from '../template/maddu/runtime/lib/harness/hook-core.mjs';\nexport default async function hooks() {}\n";
    await writeFile(join(root, 'commands', 'hooks.mjs'), body);
  }
  return root;
}

const saidBecause = (r, fragment) => r.reasons.some((x) => x.includes(fragment));

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'maddu-pr2check-'));
  try {
    // ── the state nobody can observe in this repo yet ────────────────────────
    const done = await tree(base, 'done');
    const rDone = evaluate(done, lockGreen);
    ok('a complete extraction reads DONE', rDone.ok === true, rDone.reasons.join(' | '));
    ok('DONE reports the module it found', rDone.modules.includes('hook-core.mjs'), rDone.modules.join(','));

    // ── claim 1: the module exists ───────────────────────────────────────────
    const noDir = await tree(base, 'no-dir', { harnessDir: false });
    const rNoDir = evaluate(noDir, lockGreen);
    ok('no lib/harness/ reads NOT DONE', rNoDir.ok === false);
    ok('  …and says the directory is missing', saidBecause(rNoDir, 'does not exist'), rNoDir.reasons[0]);

    const emptyDir = await tree(base, 'empty-dir', { module: false });
    const rEmpty = evaluate(emptyDir, lockGreen);
    ok('an EMPTY lib/harness/ reads NOT DONE', rEmpty.ok === false);
    ok('  …and says it holds no module', saidBecause(rEmpty, 'holds no .mjs module'), rEmpty.reasons[0]);

    // ── claim 2: the CLI delegates — the copied-not-moved case ───────────────
    // This is the one that stops an empty gesture from passing: module present,
    // lock green, and still not done because hooks.mjs kept its own copy.
    const copied = await tree(base, 'copied', { delegates: false });
    const rCopied = evaluate(copied, lockGreen);
    ok('module present + lock green but NO delegation reads NOT DONE', rCopied.ok === false);
    ok('  …and says it was copied, not extracted',
      saidBecause(rCopied, 'copied, not extracted'), rCopied.reasons[0]);

    const noHooks = await tree(base, 'no-hooks', { hooksFile: false });
    const rNoHooks = evaluate(noHooks, lockGreen);
    ok('an unreadable commands/hooks.mjs reads NOT DONE', rNoHooks.ok === false);
    ok('  …and says delegation could not be confirmed',
      saidBecause(rNoHooks, 'cannot confirm delegation'), rNoHooks.reasons[0]);

    // ── claim 3: behavior held ───────────────────────────────────────────────
    const regressed = evaluate(done, lockRed);
    ok('a complete extraction with a RED lock reads NOT DONE', regressed.ok === false);
    ok('  …and says the lock is red', saidBecause(regressed, 'behavior lock is red'), regressed.reasons[0]);
    ok('  …and carries the failing assertion through',
      saidBecause(regressed, 'a throw at the handler seam'), regressed.reasons.slice(1).join(' | '));

    // ── the discrimination claim itself ──────────────────────────────────────
    // Same tree, same code, opposite answers — decided only by the lock verdict.
    ok('the verdict is not constant: one tree, two answers',
      evaluate(done, lockGreen).ok === true && evaluate(done, lockRed).ok === false);

    // ── the CLI guard actually fires ─────────────────────────────────────────
    // Everything above tests evaluate(). None of it would notice if the
    // direct-invocation guard stopped recognizing a direct run: the script
    // would import cleanly, print nothing, and exit 0 — reporting PR2 DONE by
    // saying nothing. That is the failure mode this file exists to prevent, so
    // it is spawned the way the goal actually invokes it: relative path, from
    // the repo root.
    const spawned = spawnSync(process.execPath, ['scripts/check-fire-core-extracted.mjs'], {
      cwd: ROOT, encoding: 'utf8', env: hermeticEnv(),
    });
    const said = `${spawned.stdout || ''}${spawned.stderr || ''}`;
    // This assertion used to pin the verdict (`status === 1 && 'NOT DONE'`),
    // which made the suite passable ONLY while PR2 was unstarted — and unlike
    // check-fire-core-extracted.mjs, kept out of scripts/test/ for exactly that
    // reason, this file IS swept by the self-test runner, so the moment the
    // work it judges succeeded, CI went red.
    //
    // What replaces it must not swing the other way. Relating the exit code
    // only to the CLI's own printed string is satisfiable in both tree states
    // but accepts a CLI that reports `done (0 module(s) in lib/harness/)` on a
    // tree where that directory does not exist — the silent-false-green family
    // this section exists to prevent, in its louder form. So the verdict is
    // anchored to the TRUTH as well: the CLI must print exactly one
    // recognizable answer, that answer must match what evaluate() sees, and the
    // exit code must agree with both.
    //
    // Not circular: the fourteen asserts above already pin evaluate() against
    // synthetic trees, so what is under test here is only the CLI wiring —
    // direct-invocation guard, root resolution, branch, exit codes.
    const truth = evaluate(ROOT);
    const saidDone = /PR2 fire-core extraction: done\b/.test(said);
    const saidNotDone = said.includes('PR2 fire-core extraction: NOT DONE');
    ok('invoked as the goal invokes it, the CLI runs and reports',
      saidDone !== saidNotDone
        && saidDone === truth.ok
        && spawned.status === (truth.ok ? 0 : 1),
      `exit ${spawned.status} / ${said.split('\n')[0]}`);
    ok('a silent exit 0 is not how it answers', said.trim().length > 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  console.log(`\npr2-check-discriminates: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('pr2-check-discriminates FAILED'); process.exit(1); }
  console.log('pr2-check-discriminates OK');
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
