#!/usr/bin/env node
// acceptance-core — adversarial suite for lib/acceptance.mjs (PR-2 phase 1a).
//
// WRITTEN BY THE SUPERVISOR, NOT THE IMPLEMENTER. The implementation was
// produced by a spawned worker; this suite is deliberately authored by a
// different actor so the thing being judged and the judge do not share an
// author. Same-actor impl+tests is what produced three vacuous assertions in
// the PR-1 round.
//
// Every case here targets an invariant whose violation is SILENT — the module
// would still import, still return a digest, still look green. Cases that
// merely re-state the implementation are deliberately absent.
//
// exit 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
};

let A;
try {
  A = await import('../../template/maddu/runtime/lib/acceptance.mjs');
} catch (err) {
  console.error(`[harness] import failed: ${err.message}`);
  process.exit(2);
}

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

// A refusal and a throw are both "did not succeed"; normalise so a case can
// assert "was not accepted" without depending on which channel the module uses.
async function attempt(fn) {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && r.ok === false) return { accepted: false, via: 'refusal', r };
    return { accepted: true, via: 'value', r };
  } catch (err) {
    return { accepted: false, via: 'throw', r: err };
  }
}

const baseDecl = {
  command: 'npm test',
  cwd: '/repo',
  declEventId: 'evt_1',
  scopeNonce: null,
  oraclePatterns: ['test/**'],
  implPatterns: ['src/**'],
  tierPolicy: 'worktree',
  schemaVersion: 1,
};
const id = (over = {}) => A.acceptanceIdFor({ ...baseDecl, ...over });

// ---------------------------------------------------------------------------
// 1. acceptanceId is UNNORMALIZED. Whitespace collapsing would create an
//    equivalence class no normalizer knows how to bound.
// ---------------------------------------------------------------------------
ok('command whitespace is NOT normalized (npm test vs npm  test)',
  id({ command: 'npm test' }) !== id({ command: 'npm  test' }));

ok('trailing whitespace changes the identity',
  id({ command: 'npm test' }) !== id({ command: 'npm test ' }));

// The CRLF trap that bit this design twice via sha256Normalized.
ok('a CR in the command is not collapsed',
  id({ command: `npm test${CR}` }) !== id({ command: 'npm test' }));

// (b) of the sha256Normalized disqualification: a digit zero must not take a
// different branch. Both must simply be distinct, stable identities.
ok('a command containing a digit zero is handled normally',
  id({ command: 'npm test -- --grep x0' }) !== id({ command: 'npm test -- --grep xO' }));

// ---------------------------------------------------------------------------
// 2. Identity binds the WHOLE declaration, not just the command. Each of these
//    would let two genuinely different acceptances share one id and cross-pair.
// ---------------------------------------------------------------------------
ok('oraclePatterns participate in the identity',
  id({ oraclePatterns: ['test/**'] }) !== id({ oraclePatterns: ['spec/**'] }));
ok('implPatterns participate in the identity',
  id({ implPatterns: ['src/**'] }) !== id({ implPatterns: ['lib/**'] }));
ok('cwd participates in the identity',
  id({ cwd: '/repo' }) !== id({ cwd: '/other' }));
ok('tierPolicy participates in the identity',
  id({ tierPolicy: 'worktree' }) !== id({ tierPolicy: 'committed' }));
ok('schemaVersion participates in the identity',
  id({ schemaVersion: 1 }) !== id({ schemaVersion: 2 }));
ok('declEventId participates in the identity',
  id({ declEventId: 'evt_1' }) !== id({ declEventId: 'evt_2' }));

// Canonicalization COLLAPSES an exact duplicate. Adjudicated in review: two
// identical patterns expand to an identical file set, so they are the same
// acceptance; treating them as different would force a needless re-proof. This
// asserts the chosen contract so a later silent change to it is caught.
ok('an exact duplicate pattern is canonicalized away (same id)',
  id({ oraclePatterns: ['test/**', 'test/**'] }) === id({ oraclePatterns: ['test/**'] }));

// The dedup above must NOT extend to distinct patterns that happen to overlap —
// that would erase a real declaration difference.
ok('DISTINCT overlapping patterns are still distinct declarations',
  id({ oraclePatterns: ['test/**'] }) !== id({ oraclePatterns: ['test/**', 'test/a.js'] }));

// Sorting is canonicalization, so re-ordering the SAME set must NOT change it.
ok('pattern order is canonicalized (same set → same id)',
  id({ oraclePatterns: ['a/**', 'b/**'] }) === id({ oraclePatterns: ['b/**', 'a/**'] }));

// ---------------------------------------------------------------------------
// 3. scopeNonce: bound ONLY for ad-hoc, and never confusable with declEventId.
//    Omitting it lets two unrelated ad-hoc loops cross-pair — the exact hole
//    the plan says the first revision shipped.
// ---------------------------------------------------------------------------
const adhoc = (nonce) => id({ declEventId: null, scopeNonce: nonce });
ok('AD-HOC: two loops with different nonces get DIFFERENT ids',
  adhoc('nonce_a') !== adhoc('nonce_b'));
ok('AD-HOC: the same nonce is stable',
  adhoc('nonce_a') === adhoc('nonce_a'));

// When a declaration event exists the nonce must not be bound, or two runs of
// one declared loop would never pair and no proof could ever form. The module
// REFUSES the ambiguous combination rather than silently ignoring the field —
// adjudicated in review as the better of the two readings, because a silently
// dropped argument is indistinguishable from one that was honoured.
const rBoth = await attempt(() => id({ declEventId: 'evt_1', scopeNonce: 'n1' }));
ok('DECLARED + nonce is REFUSED, not silently ignored', !rBoth.accepted, `via=${rBoth.via}`);

// Tagged, not positional: 'x' as a declEventId and 'x' as a nonce must differ.
ok('declEventId "x" and scopeNonce "x" do not collide',
  id({ declEventId: 'x', scopeNonce: null }) !== adhoc('x'));

// ---------------------------------------------------------------------------
// 4. Domain separation between the two digest roles. Identical pattern sets
//    must not produce interchangeable digests, or a receipt could present an
//    impl digest where an oracle digest belongs and still verify.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'maddu-acc-core-'));
const roots = { workRoot: dir, stateRoot: dir };
mkdirSync(join(dir, 'test'), { recursive: true });
writeFileSync(join(dir, 'test', 'a.txt'), 'hello');

const oRes = await A.oracleDigest(roots, ['test/**']);
const iRes = await A.implDigest(roots, ['test/**']);
ok('oracleDigest and implDigest are domain-separated on identical input',
  oRes?.ok && iRes?.ok && oRes.digest !== iRes.digest,
  `oracle=${oRes?.digest?.slice(0, 12)} impl=${iRes?.digest?.slice(0, 12)}`);

// ---------------------------------------------------------------------------
// 5. THE RAW-BYTE CLAUSE. sha256Normalized collapses CRLF→LF, so a CRLF script
//    whose shebang carries a \r (and therefore FAILS) would hash identically to
//    the passing LF version — a fully manufactured proof. This is the single
//    highest-value case in the file.
// ---------------------------------------------------------------------------
const eolDir = mkdtempSync(join(tmpdir(), 'maddu-acc-eol-'));
mkdirSync(join(eolDir, 'test'), { recursive: true });
writeFileSync(join(eolDir, 'test', 'run.sh'), `#!/bin/sh${LF}echo hi${LF}`);
const lfDigest = await A.oracleDigest({ workRoot: eolDir, stateRoot: eolDir }, ['test/**']);
writeFileSync(join(eolDir, 'test', 'run.sh'), `#!/bin/sh${CR}${LF}echo hi${CR}${LF}`);
const crlfDigest = await A.oracleDigest({ workRoot: eolDir, stateRoot: eolDir }, ['test/**']);
ok('RAW-BYTE: CRLF and LF versions of one file digest DIFFERENTLY',
  lfDigest?.ok && crlfDigest?.ok && lfDigest.digest !== crlfDigest.digest,
  'a normalizing hash would make these equal and manufacture a proof');

// ---------------------------------------------------------------------------
// 6. Directory entries are bound. Counterexample from the plan's neutral round:
//    a test keyed on whether an empty test/enable/ directory exists can be
//    flipped between RED and GREEN while the FILE set stays byte-identical.
// ---------------------------------------------------------------------------
const dirDir = mkdtempSync(join(tmpdir(), 'maddu-acc-dir-'));
mkdirSync(join(dirDir, 'test'), { recursive: true });
writeFileSync(join(dirDir, 'test', 'a.txt'), 'x');
const beforeDir = await A.oracleDigest({ workRoot: dirDir, stateRoot: dirDir }, ['test/**']);
mkdirSync(join(dirDir, 'test', 'enable'), { recursive: true });
const afterDir = await A.oracleDigest({ workRoot: dirDir, stateRoot: dirDir }, ['test/**']);
ok('an added EMPTY DIRECTORY changes the digest (filesystem shape is bound)',
  beforeDir?.ok && afterDir?.ok && beforeDir.digest !== afterDir.digest,
  'a regular-file-only digest would miss this and let behaviour flip invisibly');

// ---------------------------------------------------------------------------
// 7. The expander is a SECURITY BOUNDARY, not a drift walker. Each of these,
//    if silently tolerated, measures less than it claims to measure.
// ---------------------------------------------------------------------------
const r0 = await attempt(() => A.expandAcceptance(roots, ['nope/**']));
ok('a pattern matching ZERO files is refused (not an empty green)', !r0.accepted, `via=${r0.via}`);

const r1 = await attempt(() => A.expandAcceptance(roots, []));
ok('an EMPTY pattern array is refused', !r1.accepted, `via=${r1.via}`);

const r2 = await attempt(() => A.expandAcceptance(roots, ['../outside/**']));
ok('a PARENT-ESCAPING literal is refused (containment)', !r2.accepted, `via=${r2.via}`);

const r3 = await attempt(() => A.expandAcceptance(roots, ['/etc/passwd']));
ok('an ABSOLUTE path is refused', !r3.accepted, `via=${r3.via}`);

// A bare root string must not be read as a work root — the split-root defect.
const r4 = await attempt(() => A.expandAcceptance(dir, ['test/**']));
ok('a BARE ROOT string is rejected (roots must be {workRoot,stateRoot})',
  !r4.accepted, `via=${r4.via}`);

// Symlinks must be REFUSED, never silently skipped: expandPins skips them, and
// a skipped symlink is oracle content that is not being measured.
const symDir = mkdtempSync(join(tmpdir(), 'maddu-acc-sym-'));
mkdirSync(join(symDir, 'test'), { recursive: true });
writeFileSync(join(symDir, 'real.txt'), 'payload');
let symlinkMade = true;
try {
  symlinkSync(join(symDir, 'real.txt'), join(symDir, 'test', 'link.txt'), 'file');
} catch { symlinkMade = false; }
if (symlinkMade) {
  const rs = await attempt(() => A.expandAcceptance({ workRoot: symDir, stateRoot: symDir }, ['test/**']));
  ok('a SYMLINK in scope is REFUSED, never silently skipped', !rs.accepted, `via=${rs.via}`);
} else {
  // Not an excused skip: an environment that cannot create symlinks cannot test
  // this invariant, and that fact is reported as a distinct, visible outcome.
  console.log('[UNTESTED] symlink refusal — this environment refused symlink creation (needs privilege on win32)');
}

// ---------------------------------------------------------------------------
// 8. Blank-command refusal. A blank verifier can never anchor anything.
// ---------------------------------------------------------------------------
for (const blank of ['', '   ', CR + LF]) {
  const rb = await attempt(() => A.refuseBlankCommand(blank));
  ok(`refuseBlankCommand rejects ${JSON.stringify(blank)}`, !rb.accepted, `via=${rb.via}`);
}
const rgood = await attempt(() => A.refuseBlankCommand('npm test'));
ok('CONTROL: refuseBlankCommand ACCEPTS a real command', rgood.accepted,
  'if this fails the three cases above pass for the wrong reason');

// ---------------------------------------------------------------------------
// 9. HONEST LIMITS must be substantive, not a stub. It is the text an operator
//    reads to learn what the proof does NOT establish.
// ---------------------------------------------------------------------------
ok('ACCEPTANCE_HONEST_LIMITS is a non-trivial string',
  typeof A.ACCEPTANCE_HONEST_LIMITS === 'string' && A.ACCEPTANCE_HONEST_LIMITS.length > 200,
  `len=${A.ACCEPTANCE_HONEST_LIMITS?.length}`);
// NOTE: a naive `!/failed a test/` here is WRONG — the text legitimately
// contains that phrase inside its own PROHIBITION ("Say \"exited nonzero\",
// never \"failed a test\""). Assert the claim it must make and the claim it
// must never make, not a substring that appears in both roles.
const LIM = A.ACCEPTANCE_HONEST_LIMITS || '';
ok('HONEST LIMITS frames a RED as "exited nonzero"', /exited\s+nonzero/i.test(LIM));
ok('HONEST LIMITS explicitly forbids the phrase "failed a test"',
  /never\s+"?failed a test/i.test(LIM));
ok('HONEST LIMITS never claims "tamper-proof"', !/tamper-proof/i.test(LIM));
ok('HONEST LIMITS states the unkeyed-chain / forgery limit',
  /unkeyed|forge|fabricat/i.test(LIM));

for (const d of [dir, eolDir, dirDir, symDir]) {
  try { rmSync(d, { recursive: true, force: true }); }
  catch (e) { console.error(`[FAIL] temp cleanup did not run for ${d}: ${e.message}`); failed++; }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
