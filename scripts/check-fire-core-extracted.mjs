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
// WHAT "DONE" MEANS HERE, in four claims:
//   1. the extracted module exists            (a real, non-empty .mjs FILE)
//   2. commands/hooks.mjs names it            (a module specifier, not prose)
//   3. the behavior lock still passes         (nothing Claude Code sees changed)
//   4. and the module is LOAD-BEARING         (delete it and the lock breaks)
//
// WHY CLAIM 4 EXISTS — the gesture defect
// Claims 1 and 2 used to be satisfiable by a gesture, and this was reproduced
// on a real pre-refactor checkout rather than argued:
//
//   • claim 1 read `readdirSync(dir).filter(f => f.endsWith('.mjs'))`, which
//     never asked whether the entry was a FILE. `mkdir x.mjs` satisfied it.
//     So did a zero-byte file.
//   • claim 2 was `/harness\//.test(hooks)` — a bare substring search over the
//     whole file text, comments included. Appending `//harness/` to an
//     otherwise untouched 1258-line hooks.mjs satisfied it.
//
// Claim 3 then passed for free, because the lock is green on pre-refactor code
// BY DESIGN — that is what makes it a lock. Together: `done`, exit 0, over a
// tree where nothing had been extracted. Today's tree has the sharper version
// of the same hole: `harness/` appears in hooks.mjs exactly twice, once as
// prose (~line 110) and once as the live `loadLib('harness/fire-core.mjs')`
// delegation (~line 119) — so deleting the delegation entirely would have left
// claim 2 satisfied by the comment, and this check reporting `done` over a
// reverted refactor.
//
// The fix is not a cleverer text test. An earlier attempt tried to strip
// comments before matching and rejected the HONEST tree: hooks.mjs contains the
// help-text glob `.maddu/config/**`, whose `/*` opens a phantom block comment
// that swallows ~5,132 bytes including the delegation line. A regex cannot lex
// JavaScript, and a checker that lies in the other direction is no better.
//
// So claim 2 was narrowed to what it can actually prove — the reference is
// SHAPED like a module specifier (quoted, ending .mjs) rather than being any
// occurrence of the seven characters `harness/` anywhere in the file — and the
// real weight moved to claim 4, which asks a causal question instead of a
// textual one: copy the tree, delete lib/harness/, and run the behavior lock
// there. It must FAIL. If the locked behavior survives the module's removal,
// commands/hooks.mjs never needed it — copied, not extracted. A comment cannot
// satisfy that. Neither can a stub, a directory named `x.mjs`, or a spare copy
// sitting beside an untouched hooks.mjs.
//
// Claim 2 was NOT dropped in favour of claim 4, though dropping it was the
// proposal. It is the only claim that can distinguish "module present, lock
// green, hooks.mjs kept its own copy" on a tree where the lock is INJECTED, and
// scripts/test/pr2-check-discriminates.mjs pins exactly that case. Claim 4 is
// additive: neither claim was weakened to strengthen the other.
//
// PROVEN TO DISCRIMINATE
// Until PR2 lands this check can only be observed returning 1, and a check
// only ever seen failing is exactly as unproven as one only ever seen passing.
// `evaluate()` is therefore pure and injectable, and
// scripts/test/pr2-check-discriminates.mjs drives it against synthetic trees to
// prove each of its claims independently decides the verdict — including the
// case where everything is in place and the answer is DONE.
//
// Exit codes: 0 = PR2 is genuinely done, 1 = not done (or regressed).

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The directory PR2 extracts into, and the one claim 4 removes. Written once so
// the claim that it exists and the claim that its absence matters can never
// drift onto two different paths.
const HARNESS = ['template', 'maddu', 'runtime', 'lib', 'harness'];
const LOCK = ['scripts', 'test', 'harness-hook-core.mjs'];

// The runtime closure the behavior lock needs, and nothing else. Copying the
// whole working tree is not an option: .maddu alone is ~131M of this repo's own
// spine and docs/ another ~19M, none of which the lock reads.
//
// This list is not trusted on faith. If it were short by a file, the ablated
// lock would die early for a reason having nothing to do with the missing
// module — a differential that fails for the wrong reason is a false DONE
// waiting to happen. The attribution control in evaluate() (the lock must
// attempt the SAME number of assertions here and there) is what turns that into
// a loud NOT DONE instead of a silent one.
const ABLATION_COPY = [
  ['bin'],
  ['commands'],
  ['template'],
  ['version.json'],
  ['package.json'],
  LOCK,
  ['scripts', 'test', '_hermetic-env.mjs'],
];

// Run the behavior lock in `root`. Injected so the discrimination test can
// supply a verdict without spawning anything.
export function defaultLockRunner(root) {
  const lock = join(root, ...LOCK);
  const r = spawnSync(process.execPath, [lock], { cwd: root, encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

// Minimal recursive copy. Deliberately hand-rolled rather than fs.cpSync, which
// is still flagged experimental on the Node 20 this package supports and would
// print a warning into output this check is parsed from.
function copyTree(src, dst) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dst, name));
  } else if (st.isFile()) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

// Claim 4's experiment: the same tree, minus the extracted module, judged by the
// same lock. Returns `{ ran: false, why }` when the experiment itself could not
// be set up — never a verdict it did not earn.
//
// The lock here is NOT the injected one. A differential decided by a constant is
// not a differential: an injected always-green runner would report the locked
// behavior surviving the module's removal on every tree, and an injected
// always-red one would report it broken on every tree. This run has to be real
// or it proves nothing, so it calls defaultLockRunner directly.
export function defaultAblationRunner(root) {
  let sandbox = null;
  try {
    sandbox = mkdtempSync(join(tmpdir(), 'maddu-pr2-ablate-'));
    for (const parts of ABLATION_COPY) {
      const src = join(root, ...parts);
      if (!existsSync(src)) return { ran: false, why: `the tree has no ${parts.join('/')} to copy` };
      copyTree(src, join(sandbox, ...parts));
    }
    const target = join(sandbox, ...HARNESS);
    rmSync(target, { recursive: true, force: true });
    if (existsSync(target)) return { ran: false, why: 'lib/harness/ survived removal from the sandbox copy' };
    const r = defaultLockRunner(sandbox);
    return { ran: true, status: r.status, output: r.output };
  } catch (err) {
    return { ran: false, why: `the sandbox copy failed — ${err?.message || err}` };
  } finally {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  }
}

// A reference SHAPED like a module specifier: quoted, naming something under
// harness/, ending in .mjs, with the same quote character closing it. It matches
// both spellings the delegation can take — a static
// `from '.../lib/harness/hook-core.mjs'` and a runtime
// `loadLib('harness/fire-core.mjs')` — and cannot span lines, so a prose
// sentence mentioning the path satisfies nothing.
//
// This is a narrowing, not a proof: a quoted specifier in dead code would still
// match. That is why claim 4 exists. What this claim uniquely buys is the case
// claim 4 cannot see — a module sitting beside a hooks.mjs that never names it.
const DELEGATION = /(['"`])[^'"`\n]*harness\/[^'"`\n]*\.mjs\1/;

// How many assertions a lock run actually attempted. Used to prove the ablated
// run is comparable to the real one; couples to the same `[PASS]`/`[FAIL]`
// markers the failure summary below already reads.
const attemptedIn = (output) => (output || '')
  .split('\n')
  .filter((l) => l.includes('[PASS]') || l.includes('[FAIL]'))
  .length;

// Pure: filesystem in, verdict out. Every failure carries the reason it failed,
// so a case cannot pass for an unrelated one.
export function evaluate(root, runLock = defaultLockRunner, runAblation = defaultAblationRunner) {
  const reasons = [];
  const harnessDir = join(root, ...HARNESS);
  const hooksCmd = join(root, 'commands', 'hooks.mjs');

  // 1. the extracted module exists — as a non-empty FILE.
  // `.endsWith('.mjs')` on a bare readdir entry is a claim about a NAME, and a
  // name is something you can mkdir. statSync answers the question actually
  // being asked, and follows a symlink to a real module rather than rejecting
  // it for being spelled indirectly.
  let modules = [];
  if (!existsSync(harnessDir)) {
    reasons.push('template/maddu/runtime/lib/harness/ does not exist — the fire core has not been extracted');
  } else {
    const named = readdirSync(harnessDir).filter((f) => f.endsWith('.mjs'));
    const sized = named.map((name) => {
      try { const st = statSync(join(harnessDir, name)); return { name, file: st.isFile(), size: st.size }; }
      catch { return { name, file: false, size: 0 }; }
    });
    const files = sized.filter((e) => e.file);
    modules = files.filter((e) => e.size > 0).map((e) => e.name);
    if (!named.length) {
      reasons.push('template/maddu/runtime/lib/harness/ exists but holds no .mjs module');
    } else if (!files.length) {
      reasons.push(`template/maddu/runtime/lib/harness/ holds no .mjs FILE — ${named.join(', ')} is not a file`);
    } else if (!modules.length) {
      reasons.push(`template/maddu/runtime/lib/harness/ holds only empty .mjs file(s) — ${files.map((e) => e.name).join(', ')} is a placeholder, not the fire core`);
    }
  }

  // 2. the CLI names it, rather than keeping its own copy
  if (modules.length) {
    let hooks = null;
    try { hooks = readFileSync(hooksCmd, 'utf8'); }
    catch { reasons.push('commands/hooks.mjs is unreadable — cannot confirm delegation'); }
    if (hooks !== null && !DELEGATION.test(hooks)) {
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

  // 4. and the module is load-bearing: remove it, and that behavior stops.
  //
  // Attempted only when everything above already says DONE. The verdict is a
  // conjunction, so skipping a claim that cannot change an already-NOT-DONE
  // answer costs nothing and saves a tree copy plus a lock run on every red
  // path. Skipped too when the tree holds no lock to ablate against — under the
  // real runner that state cannot coexist with a green claim 3 (spawning a
  // missing script exits non-zero), so this only ever fires where the lock is
  // injected and the experiment would be meaningless.
  if (reasons.length === 0 && existsSync(join(root, ...LOCK))) {
    const ablated = runAblation(root);
    const here = attemptedIn(lock.output);
    const there = attemptedIn(ablated.output);
    if (!ablated.ran) {
      reasons.push(`the removal experiment could not run, so delegation is unproven — ${ablated.why}`);
    } else if (ablated.status === 0) {
      reasons.push('the behavior lock still passes with template/maddu/runtime/lib/harness/ removed — nothing the lock covers depends on the module, so the core was copied, not extracted');
    } else if (!here || there !== here) {
      reasons.push(`the removal experiment is not attributable — the lock attempted ${here} assertion(s) in the repo but ${there} without lib/harness/, so its failure may be the copy rather than the missing module`);
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
  console.log(`PR2 fire-core extraction: done (${modules.length} module(s) in lib/harness/, hooks.mjs delegates, behavior lock green, and red without the module)`);
}
