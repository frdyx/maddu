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
// NOT asserted: any textual property of commands/hooks.mjs. A size threshold, a
// line count, or a "hooks.mjs must not contain the factory" grep would all pass
// this fixture and die the first time someone legitimately trims the file, and
// the oracle's own header already records why a regex cannot lex JavaScript
// here (the help-text glob `.maddu/config/**` opens a phantom block comment
// that swallows ~5,132 bytes). A proxy is not wanted.
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
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticEnv } from './_hermetic-env.mjs';

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

async function buildCounterexample(base) {
  const tree = join(base, 'nothing-extracted');
  for (const parts of COPY) {
    await mkdir(dirname(join(tree, ...parts)), { recursive: true });
    await cp(join(ROOT, ...parts), join(tree, ...parts), { recursive: true });
  }

  // Splice the core back into the CLI file it came out of.
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
    hooks.replace(ANCHOR, [
      // The gesture: a module loaded for its existence and nothing else.
      "  await loadLib('harness/sentinel.mjs');",
      '  _fireCore = createHookFireCore({',
    ].join('\n')),
    '',
    '// ── the fire core, never extracted ─────────────────────────────────────',
    inlined,
  ].join('\n'));

  await rm(join(tree, HARNESS, 'fire-core.mjs'), { force: true });
  await writeFile(join(tree, HARNESS, 'sentinel.mjs'), SENTINEL);
  return tree;
}

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
