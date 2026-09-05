#!/usr/bin/env node
// pr2-oracle-sentinel — the PR2 success condition must not be satisfiable by a
// sentinel.
//
// WHY THIS EXISTS
// scripts/check-fire-core-extracted.mjs decides whether the fire-core
// extraction HAPPENED. Its claim 4 asks a causal question — copy the tree,
// delete lib/harness/, run the behavior lock, and require the lock to break —
// on the reasoning that a comment cannot satisfy a differential.
//
// A comment cannot. A sentinel can, and this was reproduced rather than argued:
//
//     PR2 fire-core extraction: done (1 module(s) in lib/harness/,
//     hooks.mjs delegates, behavior lock green, and red without the module)
//
// printed over a tree where commands/hooks.mjs holds the ENTIRE fire core
// inline and lib/harness/ holds one module that exports a single unused
// constant. Claims 1-3 pass on their face. Claim 4 passes because hooks.mjs
// loads the sentinel before its inline dispatch, so deleting lib/harness/ does
// break the lock — with the same assertion count, so the attribution control
// is satisfied too. Nothing was extracted; the oracle said done; exit 0.
//
// WHAT CLAIM 4 ACTUALLY MEASURES, and the reason this is not a small bug: it
// measures COUPLING, not RELOCATION. "Removing this module breaks the locked
// behavior" is true of any module hooks.mjs depends on for anything at all,
// including depending on it for nothing but its own existence. The question the
// oracle means to ask — is the behavior IN the module — is a different one.
//
// WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT
// Asserted: the oracle, spawned exactly as the goal spawns it, must exit
// non-zero and print NOT DONE over the counterexample tree; the real repo must
// still read DONE; and the reason given must not be one of the three that mean
// "this fixture stopped being a counterexample". Nothing about HOW the oracle
// should tell the difference appears below.
//
// ONCE "NOT asserted", ASSERTED SINCE b64b397 — corrected in round 4, which
// caught the drift. This paragraph used to say that no textual property of
// commands/hooks.mjs was asserted here at all: a size threshold or a
// "must not contain the factory" grep would pass this fixture and then die the
// first time someone legitimately trimmed the file, and a regex cannot lex
// JavaScript here anyway (the help-text glob `.maddu/config/**` opens a phantom
// block comment that swallows ~5,132 bytes). A proxy was not wanted.
//
// b64b397 changed the shape of the bound, the suite followed it, and this
// paragraph did not. The suite now parses the ceiling out of the verdict and
// asserts on it three times: that the ceiling is readable from the verdict at
// all, that added comment lines cannot flip DONE to NOT DONE, and the residual
// below. The objection that produced the old text still stands and is still
// honoured — a RAW-TEXT proxy is not used. The bound counts CODE lines, so
// trimming or adding commentary moves nothing, which is precisely the failure
// this paragraph was written to prevent.
//
// A PREDICATE THAT WOULD WORK, MEASURED
// Ablate by CONTENT rather than by PRESENCE: keep the file names, replace each
// .mjs under lib/harness/ with a valid but inert module, and run the lock.
//
//   counterexample tree, sentinel -> `export {};`     lock GREEN (17 attempted)
//   genuine extraction, fire-core -> `export {};`     lock RED   (17 attempted)
//   genuine extraction, intact                        lock GREEN
//
// Assertion counts match in every case, so the existing attribution control
// still holds. This stops measuring presence and starts measuring whether the
// module's EXPORTS carry the locked behavior, which is the question the oracle
// means to ask.
//
// AND WHAT IT STILL WOULD NOT CATCH, stated because it is the honest half: a
// tree whose hooks.mjs CALLS something on the sentinel (`sentinel.assertPresent()`)
// breaks under an inert stand-in too, and reads DONE again. Generating the
// stand-in from the real module's export names as inert no-ops pushes that one
// out; a cheat that compares a VALUE (`if (SENTINEL !== true) throw`) survives
// even that. There is no fixed point: any local predicate measures coupling,
// and coupling is forgeable. The unforgeable claim is about commands/hooks.mjs
// itself, and deciding that needs a parser, not a checker. Content ablation is
// a strict improvement, not a proof, and the residual belongs in the oracle's
// header where the next reader will find it.
//
// ANTI-VACUITY, FIRST
// The counterexample is worthless if it is merely a broken tree — a NOT DONE
// over a fixture that no longer satisfies claims 1-3 proves nothing about the
// blind spot. So:
//   • the fake tree's behavior lock is RUN and required to be GREEN, which is
//     claims 1-3 measured rather than assumed.
//   • the fake's hooks.mjs is required to hold the factory definition itself,
//     and lib/harness/ to hold exactly one module that is not the fire core.
//   • the reason the oracle gives, once it starts saying NOT DONE, must not be
//     "the lock is red" / "the directory does not exist" / "hooks.mjs does not
//     reference lib/harness/" — the three ways this fixture could rot into
//     passing for the wrong reason.
//   • the real repository is required to read DONE, so a checker that has
//     simply been broken into always-refusing fails here instead of passing.
//
// THE SURGERY, and why it needs no git history
// The counterexample is built from files already in the tree: the fire core's
// own source is spliced back into commands/hooks.mjs (its two node: imports
// stripped and re-bound, its `export` keyword dropped), fire-core.mjs is
// deleted, and a sentinel takes its place. That reconstructs "nothing was
// extracted" without depending on a commit being reachable, which a shallow
// clone would not guarantee. Both anchors are checked before use, so a future
// refactor that moves them fails loudly here rather than silently producing a
// tree that is not a counterexample.
//
// WINDOWS
// The working tree is CRLF while the index is LF, so both files are read and
// EOL-normalized before any anchor match — a `\n` anchor does not match `\r\n`
// on disk, and the first version of this fixture failed exactly that way.
//
// CLAIM 5 (the section at the end)
// The counterexample above is the LOAD-ONLY sentinel, and content ablation
// already catches it: an inert stand-in still loads, nothing breaks, claim 4
// correctly refuses. The forgery the reviewer actually built does one thing
// more — it BRANCHES on a value the sentinel exports — and that single line
// flips claim 4 from refusing to certifying, because an inert stand-in exports
// no such value, the branch throws, and the lock goes red exactly as a real
// extraction's would. Measured here rather than asserted in prose: claim 4's own
// experiment is called on that tree and shown returning red with matching
// attribution counts. Claims 1 through 4 all pass over a tree where nothing was
// extracted, and only the mass bound refuses it.
//
// The verdict is read IN PROCESS (evaluate()) rather than off stdout, because
// the question is WHICH claim refused. A NOT DONE for an incidental cause is the
// inert-fixture trap, and this project has paid for it five times.
//
// THE RESIDUAL WAS RED DELIBERATELY, AND b64b397 TURNED IT GREEN. Recorded
// here rather than left to be rediscovered, because the text this replaced went
// on announcing a red row the suite no longer has — and a suite that advertises
// a known failure teaches its readers to skim the failure list.
//
// The bound used to count RAW lines, and the cheapest lever against raw text is
// deleting comments: mechanical, behavior-preserving, no skill required, and
// spelled out by the refusal itself, which prints both numbers. A
// comment-stripped re-inline squeaked under the raw bound and read DONE.
// b64b397 moved the count to CODE lines, leaving an adversary no lever but
// deleting logic — which claim 3 already catches. Review commentary, which is
// what has actually moved this file, now costs no headroom at all.
//
// So the residual passes: the forgery's code-line count stands well clear of
// the ceiling, where against the old raw bound it had barely cleared it. The
// live figures are deliberately NOT restated here. Hard-coding them is how this
// block went stale — it named a 900-raw-line ceiling that had become 550 code
// lines, and guessed at "~500" two paragraphs later. The ceiling is defined
// once, as HOOKS_CEILING in check-fire-core-extracted.mjs, and the verdict
// prints both numbers at the moment they are measured. Read them there.
//
// No line number, on purpose. The correction that wrote this paragraph cited
// ":352" — already wrong when written (it was :343), and moved again by the
// round-5 classifier hardening. A commit whose whole thesis was that
// hard-coding measured values into prose is what makes it decay hard-coded a
// line number in the same breath. A symbol name survives an edit; a line
// number is a measured value wearing a disguise.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticEnv, SCRUBBED_VARS } from './_hermetic-env.mjs';
import { evaluate, defaultAblationRunner } from '../check-fire-core-extracted.mjs';

// The claim-5 cases call evaluate() IN PROCESS rather than spawning the oracle,
// because the reason a verdict gives is a structured field there and a line of
// prose on stdout. Its runners then spawn the behavior lock with THIS process's
// environment — which, under the self-test runner, carries the developer's live
// MADDU_SESSION_ID. That is the identity leak _hermetic-env exists for, so the
// suite's own env is scrubbed once, here, and every in-process call inherits it.
for (const k of SCRUBBED_VARS) delete process.env[k];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORACLE = join('scripts', 'check-fire-core-extracted.mjs');
const LOCK = join('scripts', 'test', 'harness-hook-core.mjs');
const HARNESS = join('template', 'maddu', 'runtime', 'lib', 'harness');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
  return cond;
}
const note = (text) => console.log(`        ${text}`);

const SENTINEL = [
  '// Fixture module: nonempty, and a real .mjs FILE. It exports one constant',
  '// that nothing reads. Its whole job is to be missed when it is deleted.',
  'export const SENTINEL = true;',
  '',
].join('\n');

// The three reasons that would mean this fixture stopped being a counterexample
// rather than the oracle getting sharper.
const FIXTURE_ROT = [
  'behavior lock is red',
  'does not exist',
  'holds no .mjs',
  'does not reference',
  'is unreadable',
];

const lf = async (p) => (await readFile(p, 'utf8')).replace(/\r\n/g, '\n');

function runIn(root, script) {
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: hermeticEnv() });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return {
    status: r.status,
    out,
    attempted: out.split('\n').filter((l) => l.includes('[PASS]') || l.includes('[FAIL]')).length,
    summary: (out.split('\n').find((l) => /pass - \d+ fail/.test(l)) || out.trim().split('\n')[0] || '').trim(),
  };
}

// ── the counterexample ───────────────────────────────────────────────────────
// Everything the oracle reads, plus the closure the behavior lock needs. Not
// the whole working tree: .maddu alone is ~131M of this repo's own spine.
const COPY = [
  ['bin'], ['commands'], ['template'], ['version.json'], ['package.json'],
  ORACLE.split(/[\\/]/), LOCK.split(/[\\/]/), ['scripts', 'test', '_hermetic-env.mjs'],
];

// Lines that count as CODE: not blank, not a comment. Deliberately anchored at
// the start of a trimmed line, which is what makes it safe on this corpus — the
// oracle's own header records that a naive strip is defeated by the help-text
// glob `.maddu/config/**`, whose `/*` opens a phantom block comment. That glob
// sits mid-line inside a string literal (commands/hooks.mjs:85), so a
// line-start-anchored rule never sees it.
//
// THE DIRECTION OF ERROR IS DELIBERATE: anything ambiguous is counted as CODE,
// so this OVER-estimates. A residual assertion that fires on an over-estimate is
// reporting a gap that is at least as large as it says. Cross-checked against a
// second, cruder rule (non-blank lines not starting `//`, `*` or `/*`) which
// returns the identical numbers on both files.
// Must mirror the oracle's classifier, including its round-5 hardening: a line
// is comment only when nothing REMAINS after its leading, same-line-closed
// block comments. The old form discarded the whole line on a leading `/*`, so
// `/**/ code` read as a comment and a `/**/` prefix over every line drove the
// count to 0. Line-start anchored, so string contents are never lexed.
function codeLines(text) {
  let n = 0, inBlock = false;
  for (const raw of String(text).split(/\r?\n/)) {
    let l = raw.trim();
    if (inBlock) {
      const end = l.indexOf('*/');
      if (end < 0) continue;
      inBlock = false;
      l = l.slice(end + 2).trim();
    }
    while (l.startsWith('/*')) {
      const end = l.indexOf('*/', 2);
      if (end < 0) { inBlock = true; l = ''; break; }
      l = l.slice(end + 2).trim();
    }
    if (!l || l.startsWith('//')) continue;
    n++;
  }
  return n;
}

// The file closure both fixture trees are built from.
async function copyClosure(base, name) {
  const tree = join(base, name);
  for (const parts of COPY) {
    await mkdir(dirname(join(tree, ...parts)), { recursive: true });
    await cp(join(ROOT, ...parts), join(tree, ...parts), { recursive: true });
  }
  return tree;
}

// Splice the core back into the CLI file it came out of, and replace the
// delegation with `delegation` — the lines that stand where
// `loadLib('harness/fire-core.mjs')` used to. That parameter is the whole
// difference between the two forgeries below: one merely LOADS the sentinel,
// the other BRANCHES on what it exports, and only the second survives the
// oracle's content ablation.
async function inlineTheCore(tree, delegation) {
  const core = await lf(join(tree, HARNESS, 'fire-core.mjs'));
  const inlined = core
    .replace("import { join, basename } from 'node:path';", '')
    .replace("import { appendFile } from 'node:fs/promises';", '')
    .replace('export function createHookFireCore(deps) {', 'function createHookFireCore(deps) {');
  if (!inlined.includes('function createHookFireCore(deps) {')) {
    throw new Error('fire-core.mjs no longer declares createHookFireCore(deps) — re-aim this fixture');
  }
  if (/^import /m.test(inlined)) {
    throw new Error(`fire-core.mjs grew an import this fixture does not rebind: ${inlined.match(/^import .*$/m)[0]}`);
  }

  const hooks = await lf(join(tree, 'commands', 'hooks.mjs'));
  const ANCHOR = "  const mod = await loadLib('harness/fire-core.mjs');\n  _fireCore = mod.createHookFireCore({";
  if (!hooks.includes(ANCHOR)) {
    throw new Error('commands/hooks.mjs no longer delegates the way this fixture reverses — re-aim it');
  }
  await writeFile(join(tree, 'commands', 'hooks.mjs'), [
    "import { basename as _fixtureBasename } from 'node:path';",
    "import { appendFile as _fixtureAppendFile } from 'node:fs/promises';",
    'const basename = _fixtureBasename, appendFile = _fixtureAppendFile;',
    hooks.replace(ANCHOR, delegation.join('\n')),
    '',
    '// ── the fire core, never extracted ─────────────────────────────────────',
    inlined,
  ].join('\n'));

  await rm(join(tree, HARNESS, 'fire-core.mjs'), { force: true });
  await writeFile(join(tree, HARNESS, 'sentinel.mjs'), SENTINEL);
  return tree;
}

// THE GESTURE: a module loaded for its existence and nothing else. Content
// ablation catches this one — an inert stand-in still loads, so nothing breaks
// and claim 4 correctly refuses the tree.
const LOAD_ONLY = [
  "  await loadLib('harness/sentinel.mjs');",
  '  _fireCore = createHookFireCore({',
];

// THE FORGERY THE REVIEWER BUILT, and the reason claim 5 exists: it does not
// merely load the sentinel, it BRANCHES on a value the sentinel exports. An
// inert stand-in exports no SENTINEL, so the throw fires, the core never
// constructs, and the behavior lock goes red — which is exactly the signal
// claim 4 reads as "the module is load-bearing". Nothing was extracted, and
// claims 1 through 4 are all satisfied.
const VALUE_BRANCH = [
  "  const _sentinel = await loadLib('harness/sentinel.mjs');",
  "  if (_sentinel.SENTINEL !== true) throw new Error('fixture: the sentinel did not answer');",
  '  _fireCore = createHookFireCore({',
];

const buildCounterexample = async (base) =>
  inlineTheCore(await copyClosure(base, 'nothing-extracted'), LOAD_ONLY);
const buildValueForgery = async (base) =>
  inlineTheCore(await copyClosure(base, 'sentinel-value-branch'), VALUE_BRANCH);

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'maddu-pr2-sentinel-'));
  try {
    const tree = await buildCounterexample(base);

    // ── the fixture is what it claims to be ─────────────────────────────────
    console.log('\n  the counterexample - a tree where nothing was extracted');
    const modules = (await readdir(join(tree, HARNESS))).filter((f) => f.endsWith('.mjs'));
    ok('fixture: lib/harness/ holds one module, and it is not the fire core',
      modules.length === 1 && modules[0] === 'sentinel.mjs', modules.join(', '));

    const fakeHooks = await lf(join(tree, 'commands', 'hooks.mjs'));
    ok('fixture: commands/hooks.mjs holds the fire core itself',
      fakeHooks.includes('function createHookFireCore(deps) {'),
      `${fakeHooks.split('\n').length} lines`);
    ok('fixture: and names a module under harness/, as claim 2 requires',
      /(['"`])[^'"`\n]*harness\/[^'"`\n]*\.mjs\1/.test(fakeHooks));

    // Claims 1-3 MEASURED, not assumed. A NOT DONE over a broken tree would
    // prove nothing about the blind spot, and this is the assertion that fails
    // loudly if the surgery above ever stops producing a working framework.
    const lock = runIn(tree, LOCK);
    note(`behavior lock on the counterexample: exit ${lock.status}, ${lock.attempted} attempted - ${lock.summary}`);
    ok('fixture: the counterexample satisfies the behavior lock',
      lock.status === 0 && lock.attempted > 0,
      lock.status === 0 ? '' : 'the tree is broken, so it is not a counterexample - re-aim the surgery');

    // ── the assertion ───────────────────────────────────────────────────────
    const verdict = runIn(tree, ORACLE);
    note(`oracle on the counterexample: exit ${verdict.status}`);
    note(`  ${verdict.out.trim().split('\n').slice(0, 4).join('\n        ') || '(silence)'}`);

    ok('M6: the success condition refuses a tree where nothing was extracted',
      verdict.status !== 0, `exit ${verdict.status}`);
    ok('M6: and says so rather than reporting done',
      /NOT DONE/.test(verdict.out) && !/extraction: done\b/.test(verdict.out),
      verdict.out.trim().split('\n')[0]);
    // Once it does refuse, the refusal has to be about the sentinel — not about
    // a fixture that rotted into being merely broken.
    const rot = FIXTURE_ROT.find((r) => verdict.out.includes(r));
    ok('M6: for the right reason - not because the fixture stopped being one',
      verdict.status === 0 || !rot, rot ? `refused because "${rot}"` : '');

    // ── control: the verdict is not constant ────────────────────────────────
    // Without this, "NOT DONE over the counterexample" is satisfiable by a
    // checker broken into always refusing, which would report the shipped
    // refactor as unstarted and teach the next actor that the gate is noise.
    console.log('\n  control - the same oracle, on the tree where the work really happened');
    const real = runIn(ROOT, ORACLE);
    note(`oracle on the repository: exit ${real.status} - ${real.out.trim().split('\n')[0]}`);
    ok('control: the real repository still reads DONE',
      real.status === 0 && /extraction: done\b/.test(real.out),
      real.out.trim().split('\n').slice(0, 3).join(' | '));

    // ══ CLAIM 5 ═════════════════════════════════════════════════════════════
    // The section above uses the LOAD-ONLY sentinel, which content ablation
    // already catches. This one uses the forgery the reviewer actually built:
    // the same inline core, but hooks.mjs BRANCHES on a value the sentinel
    // exports. That single line is the difference between a forgery claim 4
    // refuses and one it certifies, so it is the only fixture that can show
    // what claim 5 is for.
    //
    // evaluate() is called IN PROCESS here rather than spawned, because the
    // question is WHICH claim refused — a structured field in the returned
    // object and only prose on stdout. Asserting on the reason is not decoration:
    // a NOT DONE for an incidental cause is the inert-fixture trap this file was
    // written about, and it has cost this project five separate rounds.
    console.log('\n  claim 5 - the forgery claims 1-4 certify, and the mass bound that answers it');
    const forgery = await buildValueForgery(base);
    const fHooks = await lf(join(forgery, 'commands', 'hooks.mjs'));
    const fModules = (await readdir(join(forgery, HARNESS))).filter((f) => f.endsWith('.mjs'));

    ok('fixture: the forgery keeps the entire fire core inline in commands/hooks.mjs',
      fHooks.includes('function createHookFireCore(deps) {'), `${fHooks.split('\n').length} lines`);
    ok('fixture: lib/harness/ holds one real module, and it is not the core',
      fModules.length === 1 && fModules[0] === 'sentinel.mjs', fModules.join(', '));
    ok('fixture: hooks.mjs carries a genuine quoted specifier for it, as claim 2 requires',
      /(['"`])[^'"`\n]*harness\/[^'"`\n]*\.mjs\1/.test(fHooks));
    ok('fixture: and BRANCHES on the value it exports - what makes this survive ablation',
      /_sentinel\.SENTINEL !== true/.test(fHooks));

    // Claims 1-3, measured. A refusal over a tree that no longer works would say
    // nothing about the blind spot.
    const fLock = runIn(forgery, LOCK);
    note(`behavior lock on the forgery: exit ${fLock.status}, ${fLock.attempted} attempted - ${fLock.summary}`);
    ok('fixture: claims 1-3 hold - the forgery is a working framework',
      fLock.status === 0 && fLock.attempted > 0,
      fLock.status === 0 ? '' : 'the tree is broken, so it is not a counterexample - re-aim the surgery');

    // CLAIM 4, RUN RATHER THAN ARGUED. Its own experiment is called directly on
    // the forgery, so "claims 1-4 certify this tree" is a measurement in this
    // file and not a sentence in a header. Without it, a green claim 5 could be
    // stopping a tree that claim 4 would have caught anyway.
    const ablated = defaultAblationRunner(forgery);
    const thereAttempted = (ablated.output || '').split('\n')
      .filter((l) => l.includes('[PASS]') || l.includes('[FAIL]')).length;
    note(`claim 4's own experiment on the forgery: ran=${ablated.ran} exit=${ablated.status} `
      + `attempted ${fLock.attempted} here / ${thereAttempted} inert`);
    ok('claim 5 premise: the forgery DEFEATS claim 4 - inert modules take the lock red',
      ablated.ran === true && ablated.status !== 0,
      ablated.ran ? `exit ${ablated.status}` : `experiment did not run: ${ablated.why}`);
    ok('claim 5 premise: and claim 4\'s attribution control accepts that break',
      fLock.attempted > 0 && thereAttempted === fLock.attempted,
      `${fLock.attempted} vs ${thereAttempted}`);

    const verdict5 = evaluate(forgery);
    note(`evaluate(forgery): ok=${verdict5.ok}, ${verdict5.reasons.length} reason(s)`);
    for (const r of verdict5.reasons) note(`  - ${r.slice(0, 150)}`);
    const ceilingReason = verdict5.reasons.find((r) => /-line ceiling/.test(r));
    ok('claim 5: the oracle refuses a tree where the machinery never left',
      verdict5.ok === false, `ok=${verdict5.ok}`);
    ok('claim 5: and it is claim 5 doing it - the ceiling is the ONLY reason given',
      verdict5.reasons.length === 1 && !!ceilingReason,
      verdict5.reasons.map((r) => r.slice(0, 70)).join(' | ') || '(no reasons)');

    // ── anti-vacuity: claim 5 is not a constant no ──────────────────────────
    // Built by the SAME machinery from the SAME files, minus the surgery. If
    // this read NOT DONE too, everything above would be a checker broken into
    // always refusing rather than a bound that discriminates.
    console.log('\n  claim 5 controls - the bound must not fire on the honest tree');
    const honest = await copyClosure(base, 'genuinely-extracted');
    const hv = evaluate(honest);
    ok('control: the same closure with the core still extracted reads DONE',
      hv.ok === true, hv.reasons.map((r) => r.slice(0, 80)).join(' | '));

    const honestHooks = await lf(join(honest, 'commands', 'hooks.mjs'));
    const honestRaw = honestHooks.split('\n').length;
    const ceiling = Number((/over the (\d+)-line ceiling/.exec(ceilingReason || '') || [])[1]);
    ok('fixture: the ceiling is readable from the verdict, not guessed here',
      Number.isFinite(ceiling) && ceiling > 0, String(ceiling));
    // Headroom is ceiling MINUS CODE LINES. It used to subtract raw lines from
    // a code-line ceiling and print "-62 lines of headroom" on a passing run —
    // program output contradicting the verdict printed beside it.
    note(`honest hooks.mjs: ${honestRaw} raw lines (${codeLines(honestHooks)} code) `
      + `against a ${ceiling}-line code ceiling - ${ceiling - codeLines(honestHooks)} lines of headroom`);

    // The bound must survive ordinary review commentary: hooks.mjs has grown by
    // hundreds of lines across review rounds, almost entirely in comments, so a
    // ceiling that a few of those can trip is one that gets raised on reflex
    // until it means nothing. 120 lines is several rounds' worth at once. (The
    // old text named 434 -> 552 -> 592 here and was wrong by the next commit;
    // the shape of the argument is what matters, not the figures.)
    await writeFile(join(honest, 'commands', 'hooks.mjs'), `${honestHooks}\n${
      Array.from({ length: 120 }, (_, i) => `// fixture: an ordinary review comment, line ${i + 1}`).join('\n')}\n`);
    const hv2 = evaluate(honest);
    ok('claim 5 boundary: 120 added comment lines do not flip DONE to NOT DONE',
      hv2.ok === true, hv2.reasons.map((r) => r.slice(0, 80)).join(' | '));

    // ── THE RESIDUAL, measured ──────────────────────────────────────────────
    // A raw line count is a bound on TEXT, and the adversary's cheapest lever
    // against text is deleting comments — a mechanical transformation that
    // changes no behavior, needs no skill, and is spelled out for them by the
    // refusal itself, which prints both the count and the ceiling.
    //
    // MEASURED RATHER THAN PERFORMED: this asserts the arithmetic instead of
    // running a comment-stripper over the fixture, because a regex strip can
    // corrupt a string literal — the exact hazard the oracle's own header
    // documents (`.maddu/config/**` opening a phantom block comment). codeLines()
    // over-counts by construction, so a red here reports a gap AT LEAST this
    // large.
    //
    // If this is red, the bound is defeated by `strip-comments` and the metric,
    // not the number, is what needs changing.
    //
    // "Counting CODE lines leaves the adversary no lever but deleting logic"
    // stood here and was false. Round 5 found one: `/**/ code` classified as a
    // comment, so prefixing every line drove the count to 0 while the file
    // still parsed. The classifier was hardened; the claim is narrowed to what
    // is actually established — counting code lines removes the
    // delete-the-comments lever, and each further mechanical lever has to be
    // found and closed on its own. The known remaining one is reformatting
    // expressions so continuation lines lead with `*`, which is editing logic.
    const forgeryCode = codeLines(fHooks);
    note(`forgery hooks.mjs: ${fHooks.split('\n').length} raw lines, of which ${forgeryCode} are code`);
    ok('claim 5 residual: the ceiling is not defeated by deleting comments',
      forgeryCode > ceiling,
      `${forgeryCode} code lines against a ${ceiling}-line ceiling - a comment strip lands under it`);
  } finally {
    // Runs on every path out — assertion failure, harness throw (the `finally`
    // precedes main()'s catch), or success. The retries are the Windows hazard:
    // a node child that has just exited can still hold a handle inside the
    // fixture tree.
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }

  console.log(`\npr2-oracle-sentinel: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('pr2-oracle-sentinel FAILED'); process.exit(1); }
  console.log('pr2-oracle-sentinel OK');
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
