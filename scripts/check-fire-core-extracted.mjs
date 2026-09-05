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
// WHAT "DONE" MEANS HERE, in five claims:
//   1. the extracted module exists            (a real, non-empty .mjs FILE)
//   2. commands/hooks.mjs names it            (a module specifier, not prose)
//   3. the behavior lock still passes         (nothing Claude Code sees changed)
//   4. and the module is LOAD-BEARING         (delete it and the lock breaks)
//   5. and the machinery actually LEFT        (hooks.mjs is under a code-size ceiling)
//
// Claim 5 was added after a reviewer built the forgery claims 1-4 admit: keep
// the whole core inline, add a `harness/sentinel.mjs`, branch on a value it
// exports. Claims 1-3 pass, and ablating the sentinel breaks the lock with an
// identical assertion count, so claim 4 reads the break as delegation. Claims
// 1-4 all measure COUPLING, and coupling is forgeable; claim 5 measures MASS,
// which that forgery cannot fake, because it has to keep the core's ~539 lines
// of code here. It counts CODE lines for a reason the suite proved rather than
// argued: the first version counted raw lines, and stripping comments brought
// the forgery to 885 against a 900 ceiling. Comments were a lever only the cheat
// could pull; counting what runs removes it.
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
  writeFileSync,
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

// Claim 4's experiment: the same tree with the extracted module NEUTERED, judged
// by the same lock. Returns `{ ran: false, why }` when the experiment itself
// could not be set up — never a verdict it did not earn.
//
// CONTENT ablation, not PRESENCE ablation, and the difference is the whole
// claim. Deleting lib/harness/ only asks "does anything break when this file
// disappears" — which a sentinel answers just as loudly as a real core. Keep a
// tree whose hooks.mjs still holds the entire firing machinery inline, add an
// unused `harness/sentinel.mjs`, and load it for no reason: claims 1-3 pass,
// deletion breaks the load, the lock goes red, and the checker reports an
// extraction that never happened. Replacing each module with a VALID but inert
// one instead asks the question the oracle actually means: does the locked
// behavior depend on what these modules EXPORT? A sentinel exports nothing
// anyone uses, so an inert stand-in changes nothing and the tree is correctly
// refused; the real core's absent exports take the lock red.
//
// KNOWN LIMIT, stated rather than papered over: this measures COUPLING, and
// coupling is forgeable. A tree whose hooks.mjs *calls* into the sentinel
// (`sentinel.assertPresent()`) breaks under an inert stand-in too and reads DONE
// again. Generating the stand-in from the real export names as no-ops pushes
// that case out; a cheat comparing a VALUE survives even that. There is no fixed
// point here — the unforgeable claim is that the dispatch is no longer IN
// hooks.mjs, and deciding that needs a parser, not a checker. What this rules
// out is the accident and the lazy fake, not a determined adversary.
//
// The lock here is NOT the injected one. A differential decided by a constant is
// not a differential: an injected always-green runner would report the locked
// behavior surviving on every tree, and an injected always-red one would report
// it broken on every tree. This run has to be real or it proves nothing, so it
// calls defaultLockRunner directly.
const INERT_MODULE = 'export {};\n';
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
    if (!existsSync(target)) return { ran: false, why: 'lib/harness/ did not survive the sandbox copy' };
    // RECURSIVE. A non-recursive readdir neuters only the immediate children, so
    // a later extraction that nests the core (lib/harness/fire/fire-core.mjs)
    // beside a top-level adapter would leave the real core intact during the
    // experiment, the lock would stay green, and an honest tree would be
    // reported NOT DONE. The claim says "every module under lib/harness/", so
    // the walk has to mean it.
    const neutered = [];
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(abs, r);
        else if (e.isFile() && e.name.endsWith('.mjs')) { writeFileSync(abs, INERT_MODULE); neutered.push(r); }
      }
    };
    walk(target, '');
    if (!neutered.length) return { ran: false, why: 'the sandbox copy of lib/harness/ holds no .mjs file to neuter' };
    const r = defaultLockRunner(sandbox);
    return { ran: true, status: r.status, output: r.output, neutered };
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
  // 5. and the dispatch is not still sitting in hooks.mjs.
  //
  // Claims 1-4 all measure COUPLING, and the funnel produced the exact forgery
  // the limit note predicted: keep the entire core inline in hooks.mjs, add a
  // `harness/sentinel.mjs`, and branch on a value it exports before running the
  // inline core. Claims 1-3 pass, and ablating the sentinel breaks the lock with
  // an identical assertion count, so claim 4 reads the break as proof of
  // delegation. Every claim is satisfied by a tree where nothing was extracted.
  //
  // This claim is about MASS rather than reference, which is what that forgery
  // cannot fake: it has to keep the firing machinery inside hooks.mjs to still
  // work, and the extraction's entire content is that those lines left. The
  // ceiling is set with real headroom above the delegating file rather than
  // hugging it: a bound that a few added comments can trip is a bound that gets
  // raised on reflex until it means nothing, and then the claim is gone.
  //
  // The superseded RAW-line figures that stood here (1258 before PR2, 434
  // after, a 928-line core, "lands near 1400") are gone rather than refreshed.
  // They described the raw-line bound this file stopped using, sat directly
  // above the code-line paragraph that replaced it, and would have decayed
  // again on the next edit. The live numbers are measured below and printed in
  // the refusal.
  //
  // HONEST ABOUT WHAT IT IS — and round 5 forced this to be blunter than it was.
  //
  // Claim 5 is a MASS HEURISTIC. It is not a parse, not a proof, and NOT A
  // SECURITY BOUNDARY. It is aimed at the accident and the lazy fake, and a
  // deliberate adversary with `sed` defeats it. That is not a worry, it is a
  // measurement, twice:
  //
  //   `/**/ code` counted as a comment. Prefixing every line took a re-inlined
  //   tree from 885 code lines to 0. CLOSED in v1.132.0.
  //
  //   Two inserted lines — a `void` template literal opened, and a line-start
  //   `/*` inside it — make the parser see an unused string while this
  //   line-anchored classifier sees an unclosed block comment. 50 inserted
  //   lines took the same forgery from 885 to 49, `node --check` clean, and
  //   evaluate() returned DONE with no reasons. NOT CLOSED, by decision.
  //
  // The second was left open deliberately. Both levers are the same class —
  // mechanical, behaviour-preserving, no logic edited — and the second was
  // found within hours of the first being closed. Patching members one at a
  // time buys a checker that looks sound and is not; the only sound version of
  // this claim needs a real parser, which this file will not have. So the
  // record says what the check is worth instead of implying more.
  //
  // What it still does, and why it stays: an accidental re-inline, a
  // half-finished revert, and a forgery built without knowing this file exists
  // all trip it. Everything above assumes an adversary who has read this
  // paragraph. If claim 5 is ever cited as evidence that extraction cannot be
  // faked, that citation is wrong.
  // CODE lines, not raw lines, and that distinction is the claim's robustness.
  // A raw-line ceiling was tried first and the oracle's own suite broke it
  // within the hour: re-inline the core, delete the comments, and the forgery
  // came in at 885 raw lines against a 900 ceiling. Comments were a lever the
  // forger could pull and the honest tree could not, because this codebase
  // comments heavily — every line of explanation added to hooks.mjs pushed the
  // honest file toward a bound the cheat could duck under by deleting text that
  // does not run.
  //
  // Counting only lines that DO something takes the lever away from both sides.
  // hooks.mjs is 344 code lines today; the core is 539 on its own, so a
  // re-inlined tree lands near 883 however it is formatted. The ceiling sits at
  // 550: a 206-line margin over the honest file, and 62% of what the cheat needs.
  // Comment freely — ordinary commentary cannot move this number. A comment
  // OPENER with code behind it could, until round 5: `/**/ code` read as a
  // comment, so a one-line sed took a re-inlined tree from 885 to 0. The
  // classifier below now counts what REMAINS after leading closed comments.
  //
  // That closed one lever, not the class — see the heuristic paragraph above
  // for the one that is still open by decision, and do not read this fix as
  // more than it is.
  //
  // Correction, since the commit that made this fix got it wrong: it claimed
  // the remaining lever was "reformatting expressions so continuation lines
  // lead with `*`". That lever does not exist, and the same commit is why —
  // dropping the unconditional `*`-prefix rule means a `*`-leading line outside
  // a block is now COUNTED. Measured: `const x = 1` / `* 1;` reads 1 under the
  // old rule and 2 under this one. A commit naming a residual it had just
  // closed, in a file whose subject is bounds that outlive their justification.
  //
  // The classifier is a heuristic, not a lexer, and the header above explains
  // why a regex must never try to lex JavaScript here. This one only ever DROPS
  // lines, so its error direction is safe: a mis-dropped line makes the count
  // smaller, which can never manufacture a false NOT DONE. It can only make the
  // ceiling slightly more generous, and 206 lines of margin absorb that.
  const HOOKS_CEILING = 550;
  // Round 5 MAJOR 2: the previous rule dropped ANY line whose trimmed text
  // began with `/*`, so `/**/ const x = 1;` — valid JavaScript, and a sed
  // one-liner away — counted as a comment. Prefixing every line of a re-inlined
  // tree took it from 883 to 0 and certified DONE over a tree where nothing was
  // extracted. That is precisely the mechanical, behaviour-preserving lever the
  // move from raw lines to code lines was supposed to remove; it removed one
  // instance of it.
  //
  // So: a line counts as comment only when NOTHING is left after removing its
  // leading, same-line-closed block comments. Still line-start anchored, so it
  // never lexes string contents — the header's standing constraint, and why the
  // `.maddu/config/**` glob cannot open a phantom block. The unconditional
  // `*`-prefix drop is gone with it: a `*` line inside a block comment is
  // already consumed by the inBlock branch, and one OUTSIDE a block is a
  // continuation of a binary expression, i.e. code — so that reformatting is
  // NOT a lever, and this paragraph used to end by claiming it was. The open
  // lever is the template-literal one named in the heuristic paragraph above.
  const codeLines = (src) => {
    let n = 0, inBlock = false;
    for (const raw of src.split(/\r?\n/)) {
      let t = raw.trim();
      if (inBlock) {
        const end = t.indexOf('*/');
        if (end < 0) continue;
        inBlock = false;
        t = t.slice(end + 2).trim();
      }
      while (t.startsWith('/*')) {
        const end = t.indexOf('*/', 2);
        if (end < 0) { inBlock = true; t = ''; break; }
        t = t.slice(end + 2).trim();
      }
      if (!t || t.startsWith('//')) continue;
      n++;
    }
    return n;
  };
  if (reasons.length === 0) {
    try {
      const lines = codeLines(readFileSync(hooksCmd, 'utf8'));
      if (lines > HOOKS_CEILING) {
        reasons.push(`commands/hooks.mjs holds ${lines} lines of code, over the ${HOOKS_CEILING}-line ceiling — the firing machinery this PR moves out is ~539 lines of code, so a file this size is consistent with the core still living here beside a reference to lib/harness/, which every other claim would accept`);
      }
    } catch (err) {
      reasons.push(`commands/hooks.mjs could not be measured — ${err?.message || err}`);
    }
  }

  if (reasons.length === 0 && existsSync(join(root, ...LOCK))) {
    const ablated = runAblation(root);
    const here = attemptedIn(lock.output);
    const there = attemptedIn(ablated.output);
    if (!ablated.ran) {
      reasons.push(`the neutering experiment could not run, so delegation is unproven — ${ablated.why}`);
    } else if (ablated.status === 0) {
      reasons.push('the behavior lock still passes with every module under template/maddu/runtime/lib/harness/ replaced by an inert one — nothing the lock covers depends on what they export, so the core was copied or stubbed, not extracted');
    } else if (!here || there !== here) {
      reasons.push(`the neutering experiment is not attributable — the lock attempted ${here} assertion(s) in the repo but ${there} with lib/harness/ neutered, so its failure may be the copy rather than the inert modules`);
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
  // "with the module inert", not "without the module" — the experiment stopped
  // deleting the directory and started replacing its exports, and a banner that
  // describes the wrong experiment is a small lie in the one place a reader
  // looks to find out what was proven.
  console.log(`PR2 fire-core extraction: done (${modules.length} module(s) in lib/harness/, hooks.mjs delegates, behavior lock green, and red with those modules inert)`);
}
