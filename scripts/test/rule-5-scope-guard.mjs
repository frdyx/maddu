// audit P4 (C5/C5b) — rule-5-no-provider-sdks scope + efficacy + pattern guard.
//
// The gate used to scan a nonexistent path and pass having read zero files
// (green-because-wrong-scope). These checks lock the fix: the exported matcher
// catches dynamic/side-effect/scoped forms without false-positiving near-names;
// the gate FAILs a recognized-but-empty layout and a missing subtree sentinel;
// and an end-to-end scan of a temp tree containing a banned import goes red.
//
// Banned specifiers are assembled from FRAGMENTS so this fixture never contains
// a literal provider import (belt-and-suspenders: scripts/ is out of the gate's
// scan scope today, but a future scope change must not trip on this file).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gate, { bannedImportHit } from '../../template/maddu/runtime/gates/builtin/rule-5-no-provider-sdks.mjs';

let failures = 0;
const ok = (name, cond) => { if (!cond) { failures++; console.log(`  [FAIL] ${name}`); } else { console.log(`  [ok] ${name}`); } };

const Q = "'";
const OAI = 'open' + 'ai';                 // avoid a literal provider token
const ANTH = '@anthropic' + '-ai/sdk';
const banned = {
  dynamic: `await imp` + `ort(${Q}${OAI}${Q})`,
  sideEffect: `imp` + `ort ${Q}${OAI}${Q}`,
  staticFrom: `imp` + `ort x from ${Q}${OAI}${Q}`,
  scopedRequire: `req` + `uire(${Q}${ANTH}${Q})`,
  backtick: `imp` + 'ort(`' + OAI + '`)',
};

async function main() {
  // ── matcher: positives ────────────────────────────────────────────────────
  for (const [k, s] of Object.entries(banned)) ok(`matcher hits ${k}`, !!bannedImportHit(s));

  // ── matcher: negatives (near-names, comments, string literals) ────────────
  const neg = {
    wrapperSuffix: `imp` + `ort x from ${Q}${OAI}-wrapper${Q}`,
    toolsScope: `req` + `uire(${Q}@anthropic-ai-tools/x${Q})`,
    bareToken: `const s = ${Q}${OAI}${Q}.length`,
    nodeBuiltin: `imp` + `ort ${Q}node:fs${Q}`,
    localPath: `imp` + `ort x from ${Q}./${OAI}${Q}`,   // relative path, not a package
    lineComment: `// imp` + `ort ${Q}${OAI}${Q} — an example in a comment`,
    blockComment: `/* imp` + `ort x from ${Q}${OAI}${Q} */ const y = 1;`,
  };
  for (const [k, s] of Object.entries(neg)) ok(`matcher ignores ${k}`, !bannedImportHit(s));

  // ── comment-in-the-middle must NOT hide a real import (stripped, then caught) ─
  ok('matcher still catches import with a comment before the specifier',
    !!bannedImportHit(`imp` + `ort x from /* c */ ${Q}${OAI}${Q}`));
  ok('matcher still catches dynamic import with a comment before the paren',
    !!bannedImportHit(`imp` + `ort /* c */ (${Q}${OAI}${Q})`));

  // ── lexical correctness: comment markers INSIDE strings must not corrupt a
  //    real import on the same line (no false negative), and an import-looking
  //    substring inside a string is data (no false positive). ────────────────
  ok('a "//" string literal does not swallow a following real import',
    !!bannedImportHit(`const marker = ${Q}//${Q}; imp` + `ort ${Q}${OAI}${Q};`));
  ok('a "/*" string literal does not swallow a following real import',
    !!bannedImportHit(`const a = ${Q}/*${Q}; imp` + `ort ${Q}${OAI}${Q}; const b = ${Q}*/${Q};`));
  ok('an import-looking STRING VALUE is data, not an import (no false pos)',
    !bannedImportHit('const code = `imp' + `ort ${Q}${OAI}${Q}\`;`));
  ok('a string whose value is require(pkg) is data (no false pos)',
    !bannedImportHit(`const s = ${Q}require(${OAI})${Q};`));

  // ── regex literals: quotes / slashes / `from '…'` inside a regex are neither a
  //    false positive nor a swallowed real import. ─────────────────────────────
  const BS = String.fromCharCode(92);
  ok('regex with quotes then a real import is caught',
    !!bannedImportHit(`const r=/[${Q}"]/; imp` + `ort(${Q}${OAI}${Q})`));
  ok('regex with escaped slashes then a real import is caught',
    !!bannedImportHit(`const r=/https?:${BS}/${BS}//; imp` + `ort(${Q}${OAI}${Q})`));
  ok('a regex whose body reads "from pkg" is not a false positive',
    !bannedImportHit(`const r=/from ${Q}${OAI}${Q}/;`));
  ok('division (a / b) is not treated as a regex',
    !bannedImportHit(`const q = a / b; const s = ${Q}${OAI}${Q};`));

  // ── template interpolation is CODE: a real import inside ${…} is caught, but a
  //    template that merely contains import-looking TEXT is data. ──────────────
  ok('a real import inside ${…} template interpolation is caught',
    !!bannedImportHit('const x = `p ${ await imp' + `ort(${Q}${OAI}${Q}) } s\`;`));
  ok('import-looking TEXT in a template body is data (no false pos)',
    !bannedImportHit('const t = `says imp' + `ort ${Q}${OAI}${Q} as text\`;`));

  // ── arbitrary spacing between keyword and specifier is still caught ──────────
  ok('wide whitespace between import( and specifier is caught',
    !!bannedImportHit(`imp` + `ort(${' '.repeat(60)}${Q}${OAI}${Q})`));

  // ── documented residual (out of scope): text scan can't see through obfuscation ─
  ok('KNOWN residual: string concatenation is not caught (documented scope)',
    !bannedImportHit(`imp` + `ort(${Q}open${Q} + ${Q}ai${Q})`));

  // ── end-to-end gate over a temp INSTALLED-layout tree ─────────────────────
  const base = await mkdtemp(join(tmpdir(), 'maddu-rule5-'));
  try {
    const mkInstalled = async (root) => {
      for (const sub of ['bin', 'commands', 'runtime']) await mkdir(join(root, 'maddu', sub), { recursive: true });
      await writeFile(join(root, 'maddu', 'bin', 'maddu.mjs'), '// bin sentinel\n');
      await writeFile(join(root, 'maddu', 'commands', 'x.mjs'), 'export const clean = 1;\n');
    };

    // (a) clean tree → ok
    const cleanRoot = join(base, 'clean');
    await mkInstalled(cleanRoot);
    await writeFile(join(cleanRoot, 'maddu', 'runtime', 'a.mjs'), 'export const y = 2;\n');
    let r = await gate.run({ repoRoot: cleanRoot });
    ok('clean installed tree passes', r.ok === true);

    // (b) banned import in a runtime file → red
    const dirtyRoot = join(base, 'dirty');
    await mkInstalled(dirtyRoot);
    await writeFile(join(dirtyRoot, 'maddu', 'runtime', 'bad.mjs'), `${banned.dynamic};\nexport const z = 3;\n`);
    r = await gate.run({ repoRoot: dirtyRoot });
    ok('banned dynamic import in tree fails the gate', r.ok === false && /bad\.mjs/.test(r.message));

    // (c) installed layout is detected by <repoRoot>/maddu/bin/maddu.mjs — which
    // is itself a scannable file, so a recognized installed payload can never be
    // zero-file. Confirm the sentinel install scans >0 (efficacy guaranteed by
    // construction; the scanned===0 backstop in the gate is defence-in-depth).
    const minRoot = join(base, 'min');
    for (const sub of ['bin', 'commands', 'runtime']) await mkdir(join(minRoot, 'maddu', sub), { recursive: true });
    await writeFile(join(minRoot, 'maddu', 'bin', 'maddu.mjs'), '// bin\n');
    r = await gate.run({ repoRoot: minRoot });
    ok('minimal installed layout scans >0 (efficacy by construction)', r.ok === true && / [1-9]\d* file/.test(r.message));

    // (d) missing sentinel subtree → FAIL even with nonzero files elsewhere
    const partialRoot = join(base, 'partial');
    await mkdir(join(partialRoot, 'maddu', 'bin'), { recursive: true });
    await mkdir(join(partialRoot, 'maddu', 'runtime'), { recursive: true });
    await writeFile(join(partialRoot, 'maddu', 'bin', 'maddu.mjs'), '// bin\n');
    await writeFile(join(partialRoot, 'maddu', 'runtime', 'lots.mjs'), 'export const k = 4;\n');
    // no maddu/commands → sentinel missing
    r = await gate.run({ repoRoot: partialRoot });
    ok('missing commands sentinel fails despite nonzero files', r.ok === false && /commands/.test(r.message));

    // (e) a repoRoot with no maddu/ install falls back to the DEV layout, which
    // is anchored on the gate file's own __dirname — so when run from the real
    // source checkout it scans the real framework trees and passes. (The
    // "not located" skip is only reachable for a gate file detached from any
    // framework, which cannot happen when running the suite from the repo.)
    const foreignRoot = join(base, 'foreign');
    await mkdir(foreignRoot, { recursive: true });
    r = await gate.run({ repoRoot: foreignRoot });
    ok('no-install repoRoot falls back to the real dev tree (not a false fail)', r.ok === true && /scanned \d+ file/.test(r.message));
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nrule-5-scope-guard: all checks passed' : `\nrule-5-scope-guard: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
