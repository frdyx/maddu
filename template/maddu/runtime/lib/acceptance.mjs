// acceptance — the pure core of the acceptance proof (RED → GREEN against a
// FROZEN oracle). This module is phase 1a: identity, refusals, expansion and
// digests. Observation, derivation, the observation lock and the gate are
// deliberately NOT here — they are later phases and every one of them is a
// CALLER of this file.
//
// WHAT AN ACCEPTANCE PROOF CLAIMS
// That one declared command exited NONZERO and later exited ZERO while the
// declared ORACLE bytes stayed identical and the declared IMPLEMENTATION bytes
// moved. That is a process-level statement, never an assertion-level one: a
// missing module, a bad config or an unresolvable interpreter all exit nonzero
// too. Every readout says "exited nonzero", never "failed a test". The full
// list lives in ACCEPTANCE_HONEST_LIMITS at the bottom of this file — it is
// exported so no surface can render a proof without the limits beside it.
//
// THE TWO LAWS INHERITED FROM acceptance-digest.mjs, both learned the hard way:
//
//   1. NEVER REUSE content-pins.mjs HERE — not `sha256Normalized`, not
//      `expandPins`. `sha256Normalized` collapses CRLF→LF, so a CRLF shell
//      script whose shebang carries a `\r` (and therefore FAILS) has the same
//      digest as the passing LF script: the oracle looks frozen across a
//      genuine behaviour change. Its `buf.includes(0)` binary probe searches
//      for the CHARACTER "0" when handed a string, and its latin1 round-trip
//      is lossy for non-ASCII. `expandPins` is a drift-reporting walker: it
//      yields only `e.isFile()` (symlinks vanish silently), elides SKIP_DIRS
//      (`vendor/`, `target/`, `.venv/`), and never checks containment.
//
//   2. A FALSE DIFFERENCE IS SAFE; A FALSE MATCH IS NOT. Every choice below
//      that could go either way goes toward "these two are different, re-prove
//      it". Nothing here normalizes, and every ambiguity is a REFUSAL rather
//      than a best guess. A silent omission is the one outcome this module
//      exists to make impossible: a set that quietly skipped a file would read
//      as frozen while the skipped bytes moved underneath it.
//
// ROOTS ARE ALWAYS A PAIR. `resolveRepoRoot()` returns the STATE root, which
// inside an attached lane worktree is redirected to the PRIMARY repo. A
// single-root API would hash the primary checkout while the operator edits a
// worktree, then record digests describing the wrong tree. So every API here
// takes `roots = { workRoot, stateRoot }` from `resolveWorkAndStateRoots()`,
// and everything in this file hashes and expands against `workRoot` only.
// Passing a bare root string is a hard TypeError, not a coercion.
//
// ERRORS VS REFUSALS — the split is deliberate and load-bearing:
//   - A violated API contract (bad `roots`, a non-record declaration, an
//     unencodable identity term) THROWS. Caller bugs must be loud, and the
//     acceptance-digest precedent is that an unencodable input yields NO
//     identity rather than a shared one.
//   - Anything derivable from OPERATOR INPUT (a pattern that escapes the repo,
//     a symlinked test directory, a glob matching nothing) returns a typed
//     refusal `{ok:false, reason, refusalClass, …}`. Those must be recordable
//     on a receipt as `refusal_reason`, not thrown into a crash.
// The digest functions return the SAME union. That is not stylistic: if a
// refusal returned a bare object with `digest` undefined, two unrelated
// refusals would compare `undefined === undefined` and satisfy "the oracle did
// not move" — a false match manufactured out of an error path.
//
// REFUSAL DETAIL IS RAW, UNREDACTED, CALLER-AUTHORED TEXT. Declared patterns
// can carry anything an operator typed. This module deliberately does NOT
// redact: redaction belongs at the receipt/stdout boundary (`redactText` from
// secret-scan.mjs), where the consumer knows whether the value is being
// persisted, and where nobody has to treat a redacted string as proof the
// plaintext was safe to store.
//
// Node stdlib only (hard rule 4). No spine, no process state, no writes — the
// only I/O is reading the working tree.

import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { globToRegExp } from './architecture.mjs';
import { commandDigest } from './acceptance-digest.mjs';
// deriveProofs reuses the U2 pairing invariants rather than restating them.
// `pairVerifications` already owns exactly-one-STARTED, no-reused-id, global
// refcount === 1, ordering and profile match — all tested. A second copy here
// would be two implementations of one rule, and the FIRST time they drifted the
// gate and `orient` would disagree about the same receipts. The cost is that
// this module's import graph now reaches `success-eval.mjs` (which imports
// `spawnSync`); nothing in that graph runs at import time, and this file still
// spawns nothing, writes nothing and reads no spine.
import { pairVerifications } from './verification-recency.mjs';
import { isStaleTs } from './success-eval.mjs';

// ── domain tags ────────────────────────────────────────────────────────────

const ACCEPTANCE_ID_TAG = 'maddu.acceptance-id.v1';

// The one algorithm that ships. O7 ("same digestAlgo") is a forward guard so a
// future second algorithm can never be cross-compared; this string is what it
// compares.
const DIGEST_ALGO = 'sha256-raw';

// DELIBERATE DEVIATION FROM THE PLAN, stated so it can be reverted knowingly:
// the plan specifies the aggregate as sha256 over the sorted records alone.
// This prepends one domain line so a future record format cannot collide with
// this one even if `digestAlgo` is compared loosely somewhere. It can only
// ever create a false DIFFERENCE (v1 vs v2 digests differ), never a false
// match, so it is safe in the direction this module cares about.
const SET_DIGEST_PREFIX = 'maddu.acceptance-set.sha256-raw.v1\n';

// Mirrors acceptance-digest.mjs's private `sha256Json`. Deliberately a second
// copy rather than an export widening of that module: both are
// `sha256(utf8(JSON.stringify(v)))`, and because every call site here carries
// its OWN domain tag, drift between the copies could only ever produce a false
// difference. JSON.stringify — not Buffer.from(str) — because `Buffer.from`
// maps an unpaired surrogate and U+FFFD to the same three bytes, while JSON
// escapes them distinctly and restores injectivity.
function sha256Json(value) {
  return createHash('sha256').update(Buffer.from(JSON.stringify(value), 'utf8')).digest('hex');
}

// ── budgets (bounded by construction, never by hope) ───────────────────────

const MAX_PATTERNS = 256;
const MAX_PATTERN_LEN = 1024;
const MAX_SEGMENTS = 64;        // segments in one pattern
const MAX_DEPTH = 64;           // directory depth walked
const MAX_MATCHED_ENTRIES = 20000;
const MAX_VISITED_ENTRIES = 500000;
const READ_CHUNK = 65536;

// ── shared shapes ──────────────────────────────────────────────────────────

// One refusal shape for every refusal in this module, with the same key set
// every time — a caller must never have to test which fields exist.
// `refusalClass` is the vocabulary the receipt records: `expander-refused` for
// "the filesystem or the pattern is not admissible", `set-invalid` for "the
// declared set cannot support a proof".
function refuse(reason, refusalClass, detail, { pattern = null, patternIndex = null, path = null } = {}) {
  return { ok: false, reason, refusalClass, detail, pattern, patternIndex, path };
}

// A bare root is the exact bug the roots pair exists to prevent, so it is
// refused loudly rather than coerced into `{workRoot: root}`.
function requireWorkRoot(roots) {
  if (typeof roots === 'string') {
    throw new TypeError('acceptance APIs take roots = { workRoot, stateRoot } — a bare root string would hash the primary checkout while a lane worktree is being edited');
  }
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
    throw new TypeError('acceptance APIs take roots = { workRoot, stateRoot }');
  }
  const { workRoot } = roots;
  if (typeof workRoot !== 'string' || !workRoot.trim()) {
    throw new TypeError('roots.workRoot must be a non-blank path — expansion and hashing always run against the WORK root, never the state root');
  }
  if (roots.stateRoot !== undefined && typeof roots.stateRoot !== 'string') {
    throw new TypeError('roots.stateRoot, when present, must be a string');
  }
  return workRoot;
}

// ── refuseBlankCommand ─────────────────────────────────────────────────────

// verify-replay.mjs:216 in spirit: a blank command is a shell no-op that exits
// 0, so accepting one manufactures a passing receipt for a verifier that never
// verified anything.
//
// SCOPE, stated so nobody reads more into it: this refuses BLANKNESS only. It
// is not the no-op denylist (`true`, `:`, `exit 0`), which the plan ships
// separately and labels hygiene, and it cannot catch `node -e
// "process.exit(0)"`, a wrapper script or a custom executable. No syntactic
// check can. The real closure is O4's requirement of a genuine nonzero RED.
export function refuseBlankCommand(command) {
  if (typeof command !== 'string') {
    return refuse('command-not-a-string', 'set-invalid', `the declared command must be a string, got ${command === null ? 'null' : typeof command}`);
  }
  // `trim()` removes every Unicode whitespace and line terminator, so a
  // command of NBSPs or a lone `\r` is blank too — all of them are shell
  // no-ops that would exit 0.
  if (!command.trim()) {
    return refuse('command-blank', 'set-invalid', 'the declared command is blank — a blank string is a shell no-op that would manufacture a passing receipt');
  }
  return { ok: true, command };
}

// ── acceptanceIdFor ────────────────────────────────────────────────────────

// Encode one identity term with its TYPE, so `1` and `'1'` can never collide.
function taggedScalar(kind, value) {
  return [kind, value];
}

function isPlainRecord(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Canonical form of a declared pattern ARRAY for identity purposes: sorted by
// UTF-16 code unit (NOT localeCompare — that is locale- and ICU-dependent, so
// the same declaration could fingerprint differently on two machines) and
// de-duplicated.
//
// De-duplication is a TRUE match, not a normalization: duplicate patterns
// expand to exactly the same set, contribute the same digest and the same
// per-pattern zero-match verdict, so `['test/**','test/**']` and `['test/**']`
// are the same declaration in every way this module can observe. What is NOT
// normalized is the pattern text itself: `test/` and `test/**` expand alike but
// fingerprint differently, which is a false difference — "re-prove it" — and
// therefore the safe direction.
function canonicalPatterns(list, label) {
  if (!Array.isArray(list)) throw new TypeError(`${label} must be an array of pattern strings`);
  if (list.length > MAX_PATTERNS) throw new TypeError(`${label} exceeds the pattern budget (${MAX_PATTERNS})`);
  const out = [];
  for (const p of list) {
    if (typeof p !== 'string') throw new TypeError(`${label} must contain only strings`);
    if (!p.trim()) throw new TypeError(`${label} must not contain a blank pattern`);
    if (p.length > MAX_PATTERN_LEN) throw new TypeError(`${label} exceeds the pattern length budget (${MAX_PATTERN_LEN})`);
    out.push(p);
  }
  return [...new Set(out)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// The declaration's identity. This is the value O2 freezes and the value that
// decides which RED may pair with which GREEN — so everything that could make
// two observations mean different things has to be INSIDE the digest, never
// merely recorded alongside it.
//
// WHY THE WHOLE DECLARATION AND NOT JUST THE COMMAND: binding only
// {command, cwd, declEventId} breaks for ad-hoc (`--verify`) acceptances, where
// `declEventId` is null. Run the same command with `--impl src/a` for the RED
// and `--impl src/b` for the GREEN and, if those pre-existing sets differ, O3
// passes although no implementation file changed — and both observations share
// an id, so they pair across two unrelated loops. Hence the canonical sorted
// pattern arrays, the tier policy and the schema version are all terms.
//
// `scopeNonce` IS AN INPUT, NOT A NOTE ON THE RECEIPT. For ad-hoc acceptances
// it is the only thing separating loop A's RED from loop B's GREEN. Recording
// `loopId` beside the digest does not achieve that; only hashing it does.
// It is REQUIRED when `declEventId === null` and REFUSED otherwise: a
// goal-declared acceptance must pair its `orient` baseline with a later loop
// iteration, and a per-loop nonce in the digest would make that impossible.
//
// UNNORMALIZED, DELIBERATELY. No whitespace collapsing anywhere: `npm test` and
// `npm  test` are different strings to the shell, and no normalizer knows where
// to stop (`npm test` ≢ `npm test -- --grep x`). `cwd` is bound RAW for the
// same reason — canonicalizing separators would merge two spellings to buy
// nothing, since both observations of one acceptance take `cwd` from the same
// code path anyway.
//
// THE KEY SET IS CLOSED. An unknown key throws instead of being ignored,
// because an ignored field is a false match waiting for the next phase to add
// one: whoever adds `declSource` to the declaration must decide, in this file,
// whether it changes identity.
export function acceptanceIdFor(decl) {
  if (!isPlainRecord(decl)) {
    throw new TypeError('acceptanceIdFor takes a plain declaration record');
  }
  const KNOWN = new Set(['command', 'cwd', 'declEventId', 'scopeNonce', 'oraclePatterns', 'implPatterns', 'tierPolicy', 'schemaVersion']);
  const unknown = Object.keys(decl).filter((k) => !KNOWN.has(k));
  if (unknown.length) {
    throw new TypeError(`unknown declaration key(s): ${unknown.join(', ')} — the identity domain is closed, so a new field must be added here deliberately rather than silently ignored`);
  }

  const { command, cwd, declEventId, scopeNonce, oraclePatterns, implPatterns, tierPolicy, schemaVersion } = decl;

  if (typeof command !== 'string') {
    throw new TypeError('command must be a string — commandDigest returns null for a non-string, and a null term would merge every malformed declaration into one identity');
  }
  // NOT `refuseBlankCommand` here: blankness is refused at DECLARATION, and an
  // id can be computed for any string. Throwing here would move a declaration
  // -time refusal into an identity computation that no longer has anywhere to
  // report it.
  if (typeof cwd !== 'string') throw new TypeError('cwd must be a string');
  if (typeof tierPolicy !== 'string' || !tierPolicy.trim()) throw new TypeError('tierPolicy must be a non-blank string');

  // AMBIGUITY IN THE PLAN, resolved conservatively: the plan says the identity
  // binds "the declaration schema version" without stating its type. Both a
  // number (1) and a dotted string ('1.17.0') are plausible, so both are
  // accepted and TYPE-TAGGED — 1 and '1' produce different digests. Anything
  // else throws rather than being coerced.
  let versionTerm;
  if (typeof schemaVersion === 'string') {
    if (!schemaVersion.trim()) throw new TypeError('schemaVersion must not be blank');
    versionTerm = taggedScalar('s', schemaVersion);
  } else if (typeof schemaVersion === 'number' && Number.isSafeInteger(schemaVersion) && schemaVersion >= 0) {
    // Object.is(-0) cannot arise here (negative values are refused), so String()
    // is lossless for this domain.
    versionTerm = taggedScalar('n', String(schemaVersion));
  } else {
    throw new TypeError('schemaVersion must be a non-blank string or a non-negative safe integer');
  }

  // The scope term. The two arms are structurally distinct, so a declared id
  // and an ad-hoc id can never collide even if a nonce happened to equal an
  // event id.
  let scopeTerm;
  if (declEventId === null) {
    if (typeof scopeNonce !== 'string' || !scopeNonce.trim()) {
      throw new TypeError('an ad-hoc acceptance (declEventId === null) requires a non-blank scopeNonce — without it two unrelated ad-hoc loops share an acceptanceId and cross-pair one loop\'s RED with another loop\'s GREEN');
    }
    scopeTerm = ['adhoc', scopeNonce];
  } else if (typeof declEventId === 'string' && declEventId.trim()) {
    if (scopeNonce !== null && scopeNonce !== undefined) {
      throw new TypeError('scopeNonce must be null for a goal-declared acceptance — binding a per-loop nonce would stop an orient baseline pairing with a later loop iteration');
    }
    scopeTerm = ['declared', declEventId];
  } else {
    throw new TypeError('declEventId must be a non-blank string (goal-declared) or exactly null (ad-hoc)');
  }

  return sha256Json([
    ACCEPTANCE_ID_TAG,
    {
      command: commandDigest(command),
      cwd,
      scope: scopeTerm,
      oracle: canonicalPatterns(oraclePatterns, 'oraclePatterns'),
      impl: canonicalPatterns(implPatterns, 'implPatterns'),
      tierPolicy,
      schemaVersion: versionTerm,
    },
  ]);
}

// ── pattern compilation (the containment half of the security boundary) ────

// A control character in a pattern or a path is refused because the aggregate
// digest is a NEWLINE-delimited, NUL-separated record stream: a path containing
// `\n` could forge a record boundary, and one containing `\0` could forge a
// field boundary. Refusing keeps the stream self-delimiting — which is what
// makes the aggregate injective — without abandoning the plan's record format.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const DRIVE_PREFIX = /^[A-Za-z]:/;

// Compile one declared pattern.
//
// Every rejection here is a REFUSAL, never a silent drop. A pattern that is
// quietly ignored produces a smaller set that still digests cleanly — exactly
// the "green because the check ran over nothing" failure this whole feature is
// built against.
function compileOne(raw, index) {
  if (typeof raw !== 'string') {
    return refuse('pattern-invalid', 'set-invalid', 'a declared pattern must be a string', { patternIndex: index });
  }
  if (!raw.trim()) {
    return refuse('pattern-invalid', 'set-invalid', 'a declared pattern must not be blank', { pattern: raw, patternIndex: index });
  }
  if (raw.length > MAX_PATTERN_LEN) {
    return refuse('pattern-invalid', 'set-invalid', `pattern exceeds the length budget (${MAX_PATTERN_LEN})`, { pattern: raw, patternIndex: index });
  }
  if (CONTROL_CHARS.test(raw)) {
    return refuse('pattern-invalid', 'set-invalid', 'pattern contains a control character', { pattern: raw, patternIndex: index });
  }
  // Absoluteness is checked on BOTH spellings on purpose: `isAbsolute` knows
  // `C:\x` only on Windows, and the explicit drive/leading-slash tests catch
  // `C:/x` and `//host/share` on POSIX, where `isAbsolute` would say no.
  if (isAbsolute(raw)) {
    return refuse('pattern-absolute', 'expander-refused', 'an absolute pattern is refused — declared sets are repo-relative so a proof can never be anchored to a file outside the repository', { pattern: raw, patternIndex: index });
  }

  // Backslash → slash FIRST, and then every later check runs on the converted
  // string, because `globToRegExp` converts too: validating one spelling while
  // matching another is how a containment check ends up guarding a string
  // nobody matches against.
  const slashed = raw.split('\\').join('/');
  if (slashed.startsWith('/') || DRIVE_PREFIX.test(slashed)) {
    return refuse('pattern-absolute', 'expander-refused', 'an absolute pattern is refused — declared sets are repo-relative', { pattern: raw, patternIndex: index });
  }

  // One or more trailing slashes mean "everything under here": `test/` would
  // otherwise compile to a regex matching only the literal directory entry.
  const trimmed = slashed.replace(/\/+$/, '');
  const norm = trimmed === slashed ? slashed : `${trimmed}/**`;
  if (!norm) {
    return refuse('pattern-invalid', 'set-invalid', 'pattern reduces to nothing', { pattern: raw, patternIndex: index });
  }

  const segs = norm.split('/');
  if (segs.length > MAX_SEGMENTS) {
    return refuse('pattern-invalid', 'set-invalid', `pattern exceeds the segment budget (${MAX_SEGMENTS})`, { pattern: raw, patternIndex: index });
  }
  for (const s of segs) {
    if (!s) {
      return refuse('pattern-invalid', 'set-invalid', 'pattern contains an empty path segment', { pattern: raw, patternIndex: index });
    }
    if (s === '.' || s === '..') {
      return refuse('pattern-escapes-root', 'expander-refused', 'pattern contains a "." or ".." segment — relative traversal is refused outright (a `..` literal would let an out-of-repo file satisfy the implementation-moved clause)', { pattern: raw, patternIndex: index });
    }
    // `**` MUST be a whole segment. `a**b` compiles (via globToRegExp) to a
    // regex whose `.*` crosses `/`, so `a**b/x` matches `a/q/b/x` — while the
    // segment-wise descend predicate below would prune `a/` and never look.
    // That disagreement is a SILENT OMISSION, so the shape that causes it is
    // refused instead of half-supported.
    if (s.includes('**') && s !== '**') {
      return refuse('pattern-invalid', 'set-invalid', 'a "**" must be a whole path segment (write "src/**/x", never "a**b") — an embedded "**" crosses directory boundaries in the matcher but not in the traversal predicate, which would silently omit files', { pattern: raw, patternIndex: index });
    }
  }

  return {
    ok: true,
    raw,
    norm,
    segs,
    // The full-path matcher — the same `globToRegExp` the architecture gates
    // already trust, so glob semantics cannot drift between them.
    re: globToRegExp(norm),
    // Per-segment matchers for the descend predicate. `**` never gets one; it
    // short-circuits.
    segRes: segs.map((s) => (s === '**' ? null : globToRegExp(s))),
    count: 0,
  };
}

function compilePatterns(patterns) {
  if (!Array.isArray(patterns)) {
    return refuse('patterns-not-an-array', 'set-invalid', 'declared patterns must be an array of strings');
  }
  if (patterns.length === 0) {
    // "An empty config greening over nothing is the same failure mode as a gate
    // scanning zero files and reporting success" (tracked-source-drift.mjs).
    return refuse('no-patterns', 'set-invalid', 'no patterns declared — an undeclared set can never read as proven');
  }
  if (patterns.length > MAX_PATTERNS) {
    return refuse('pattern-invalid', 'set-invalid', `too many declared patterns (max ${MAX_PATTERNS})`);
  }
  const compiled = [];
  for (let i = 0; i < patterns.length; i++) {
    const c = compileOne(patterns[i], i);
    if (c.ok !== true) return c;
    compiled.push(c);
  }
  return { ok: true, patterns: compiled };
}

// ── traversal predicates ───────────────────────────────────────────────────

function matchesAny(pats, rel) {
  for (const p of pats) if (p.re.test(rel)) return true;
  return false;
}

// Could this pattern match anything STRICTLY BELOW the directory `rel`?
//
// This predicate does two jobs at once, and that is the point: it decides where
// the walk descends AND whether a symlinked or submodule directory is relevant
// enough to refuse over. If it ever answered "no" while a match existed, the
// expander would silently omit files — so it is conservative by construction
// (`**` returns true immediately) and the one shape that could fool it (a `**`
// embedded in a larger segment) is refused at compile time rather than
// approximated here.
function mayDescend(pat, rsegs) {
  for (let i = 0; i < rsegs.length; i++) {
    const seg = pat.segs[i];
    if (seg === undefined) return false;       // the pattern ran out above this depth
    if (seg === '**') return true;             // `**` swallows every depth below
    if (!pat.segRes[i].test(rsegs[i])) return false;
  }
  return pat.segs.length > rsegs.length;       // at least one segment left to match below
}

function mayDescendAny(pats, rsegs) {
  for (const p of pats) if (mayDescend(p, rsegs)) return true;
  return false;
}

// ── raw-byte hashing ───────────────────────────────────────────────────────

// Hash a regular file's RAW bytes, streamed in fixed chunks so a large declared
// file cannot blow the heap.
//
// The open handle is the authority for what was hashed: `fstat` describes the
// object actually read, so mode comes from there rather than from the earlier
// `lstat`. The dev/ino comparison catches a path swapped between the lstat and
// the open (a symlink substituted for a regular file, say). Where the platform
// reports ino 0 the comparison is simply UNAVAILABLE — recorded as such by
// doing nothing, never by claiming it passed. Zero is not an answer.
async function hashFileRaw(abs, lst) {
  let fh = null;
  try {
    fh = await open(abs, 'r');
  } catch (e) {
    return { ok: false, err: e };
  }
  try {
    const fst = await fh.stat({ bigint: true });
    if (!fst.isFile()) {
      return { ok: false, changed: true, err: new Error('entry stopped being a regular file between stat and open') };
    }
    if (lst.ino !== 0n && fst.ino !== 0n && (fst.ino !== lst.ino || fst.dev !== lst.dev)) {
      return { ok: false, changed: true, err: new Error('entry was replaced between stat and open') };
    }
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK, null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
    }
    return { ok: true, sha: h.digest('hex'), mode: fst.mode };
  } catch (e) {
    return { ok: false, err: e };
  } finally {
    try { await fh.close(); } catch { /* close failure cannot change what was hashed */ }
  }
}

function modeOctal(mode) {
  // Permission bits only — the file-type bits would duplicate the `type` field
  // and are spelled differently across platforms.
  return (mode & 0o7777n).toString(8).padStart(4, '0');
}

function short(e) {
  return String((e && e.message) || e).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ── expandAcceptance ───────────────────────────────────────────────────────

// A nested repository boundary. A git submodule is a GITLINK in the tree and a
// separate checkout on disk: its bytes are not this repository's content, and
// hashing them would bind a proof to a tree nothing here controls. Checked only
// for directories the declaration actually reaches, so an unrelated nested repo
// elsewhere in the tree costs nothing. The repository root itself is never
// tested — it is not nested in anything.
async function isNestedRepo(abs) {
  try {
    await lstat(join(abs, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function walkDir(absDir, relDir, ctx, depth) {
  if (depth > MAX_DEPTH) {
    return refuse('depth-exceeded', 'expander-refused', `directory depth exceeds the budget (${MAX_DEPTH})`, { path: relDir });
  }
  let dirents;
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch (e) {
    // NOT swallowed. `expandPins` returns quietly here because a drift walker
    // can afford to miss a directory; a security boundary cannot — an
    // unreadable directory that a pattern reaches must refuse, not shrink the
    // set.
    return refuse('walk-failed', 'expander-refused', `could not read directory: ${short(e)}`, { path: relDir || '.' });
  }
  // Deterministic order so a refusal reports the same first offender on every
  // run — two observations must not disagree about WHY they were refused.
  const names = dirents.map((d) => d.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const name of names) {
    if (++ctx.visited > MAX_VISITED_ENTRIES) {
      return refuse('walk-too-large', 'expander-refused', `the declared patterns reach more than ${MAX_VISITED_ENTRIES} filesystem entries — narrow the globs`, { path: relDir || '.' });
    }
    const rel = relDir ? `${relDir}/${name}` : name;
    const rsegs = rel.split('/');

    // Relevance gates everything below, including the refusals. A symlink in
    // node_modules must not refuse a `test/**` declaration — it is not part of
    // the declared set and cannot hide anything from it. The SAME predicate
    // decides relevance and pruning, so nothing can be skipped as irrelevant
    // and then turn out to contain a match.
    const isMatch = matchesAny(ctx.pats, rel);
    const isBelow = mayDescendAny(ctx.pats, rsegs);
    if (!isMatch && !isBelow) continue;

    if (CONTROL_CHARS.test(name)) {
      return refuse('path-unencodable', 'expander-refused', 'a matched path contains a control character — the aggregate digest is a NUL-separated, newline-delimited record stream, and such a path could forge a record boundary', { path: rel });
    }

    // `lstat` is the single authority for an entry's type. The dirent's own
    // type is deliberately not used: two sources for one fact is how a
    // symlink ends up classified as a file on one filesystem and a link on
    // another, and readdir reports UNKNOWN on some filesystems.
    let st;
    try {
      st = await lstat(join(absDir, name), { bigint: true });
    } catch (e) {
      return refuse('stat-failed', 'expander-refused', `could not stat a declared entry: ${short(e)}`, { path: rel });
    }

    if (st.isSymbolicLink()) {
      // REFUSED, never omitted — the whole reason `expandPins` is unusable
      // here. A symlinked test directory would otherwise vanish from the
      // expansion and leave a smaller set digesting perfectly cleanly.
      return refuse('symlink-refused', 'expander-refused', isMatch
        ? 'a declared entry is a symlink — symlinks are refused, never silently skipped, because the bytes a proof binds must live inside this repository'
        : 'a symlink sits on the path a declared pattern would traverse — refused rather than skipped, since it may hide declared files', { path: rel });
    }

    if (st.isDirectory()) {
      if (await isNestedRepo(join(absDir, name))) {
        return refuse('gitlink-refused', 'expander-refused', 'a declared pattern reaches into a nested git repository (submodule / gitlink) — its bytes are not this repository\'s content and are refused rather than skipped', { path: rel });
      }
      if (isMatch) {
        // Directory entries are part of the digest. A regular-file-only digest
        // does not bind filesystem SHAPE: an empty `test/enable/` directory
        // created between the RED and the GREEN can flip behaviour while the
        // expanded file set stays byte-identical, and a proof would still form.
        const rec = pushEntry(ctx, { path: rel, type: 'dir', mode: modeOctal(st.mode), sha: '' });
        if (rec) return rec;
      }
      if (isBelow) {
        const r = await walkDir(join(absDir, name), rel, ctx, depth + 1);
        if (r) return r;
      }
      continue;
    }

    if (st.isFile()) {
      if (!isMatch) continue;
      const h = await hashFileRaw(join(absDir, name), st);
      if (!h.ok) {
        return refuse(h.changed ? 'entry-unstable' : 'read-failed', 'expander-refused', `could not hash a declared file: ${short(h.err)}`, { path: rel });
      }
      const rec = pushEntry(ctx, { path: rel, type: 'file', mode: modeOctal(h.mode), sha: h.sha });
      if (rec) return rec;
      continue;
    }

    // A fifo, socket or device that a pattern matched. There is no honest raw
    // -byte digest for it, so it is refused rather than recorded with an empty
    // hash that would read as "bound".
    if (isMatch) {
      return refuse('entry-type-refused', 'expander-refused', 'a declared entry is neither a regular file nor a directory (fifo, socket or device) — it has no raw-byte content to bind', { path: rel });
    }
  }
  return null;
}

function pushEntry(ctx, entry) {
  ctx.entries.push(entry);
  if (ctx.entries.length > MAX_MATCHED_ENTRIES) {
    return refuse('set-too-large', 'set-invalid', `the declared patterns match more than ${MAX_MATCHED_ENTRIES} entries — narrow the globs rather than caching the check`, { path: entry.path });
  }
  for (const p of ctx.pats) if (p.re.test(entry.path)) p.count++;
  return null;
}

// Expand declared patterns against the WORK root into a sorted, typed entry
// list — the security boundary the digests are taken over.
//
// It is NOT `expandPins`, and the differences are all load-bearing:
//   - symlinks and nested-repo boundaries REFUSE instead of vanishing;
//   - nothing is elided (no SKIP_DIRS): eliding `vendor/`, `target/` or
//     `.venv/` would let a declared pattern silently cover fewer files than it
//     names;
//   - absolute and `..`-bearing patterns are refused, so no out-of-repo file
//     can ever satisfy a clause;
//   - a pattern matching ZERO entries refuses: nothing-declared must never read
//     as proven-clean;
//   - directories are matched and returned, not just files.
//
// Traversal is pruned by `mayDescend`, the same predicate that decides
// relevance — so pruning can only skip subtrees in which no declared pattern
// could match. A leading `**` pattern therefore walks (and is refused by) the
// whole tree, including `node_modules` and `.git`. That is the honest cost of
// refusing to elide; the lever is a narrower glob, never a quieter check.
//
// Returns { ok:true, entries, paths, fileCount, dirCount } or a typed refusal.
export async function expandAcceptance(roots, patterns) {
  const workRoot = requireWorkRoot(roots);
  const compiled = compilePatterns(patterns);
  if (compiled.ok !== true) return compiled;

  const ctx = { pats: compiled.patterns, entries: [], visited: 0 };
  const refusal = await walkDir(workRoot, '', ctx, 0);
  if (refusal) return refusal;

  for (const p of ctx.pats) {
    if (p.count === 0) {
      return refuse('zero-match', 'set-invalid', `pattern "${p.raw}" matched nothing — a zero-file declared set is refused, because a digest over nothing is stable for the wrong reason`, { pattern: p.raw, patternIndex: ctx.pats.indexOf(p) });
    }
  }

  ctx.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    ok: true,
    entries: ctx.entries,
    paths: ctx.entries.map((e) => e.path),
    fileCount: ctx.entries.filter((e) => e.type === 'file').length,
    dirCount: ctx.entries.filter((e) => e.type === 'dir').length,
  };
}

// ── digests ────────────────────────────────────────────────────────────────

// The aggregate is sha256 over the domain line followed by the sorted records
//
//     path \0 mode \0 type \0 rawFileSha256 \n
//
// RAW bytes, never EOL-normalized (law 1 at the top of this file). Path, mode
// and type are in the record so a chmod, a file→directory swap or a rename
// cannot pass unnoticed, and directory entries carry an empty content field so
// filesystem SHAPE is bound too. The stream is self-delimiting because paths
// containing `\0` are impossible and paths containing `\n` are refused by the
// expander — without that refusal a crafted filename could forge a record.
//
// The ROLE IS IN THE DIGEST DOMAIN. The implementation originally shared one
// domain across both roles, reasoning that they are never cross-compared (O1 is
// oracle-to-oracle, O3 impl-to-impl) so a role tag manufactures a meaningless
// difference. That reasoning is correct only while O8's disjointness holds —
// and O8 is enforced in a DIFFERENT module, not here. A primitive whose safety
// depends on an invariant it cannot see is bounded by promise; domain-tagging
// costs one string and makes a cross-role false EQUALITY structurally
// impossible instead. The failure it forecloses (an impl digest accepted where
// an oracle digest belongs, both verifying) is silent, which is what settles it.
// `role` also rides the RESULT, for readers.
async function setDigest(roots, patterns, role) {
  const expanded = await expandAcceptance(roots, patterns);
  if (expanded.ok !== true) return expanded;
  const h = createHash('sha256');
  h.update(Buffer.from(`${SET_DIGEST_PREFIX}${role}\n`, 'utf8'));
  for (const e of expanded.entries) {
    h.update(Buffer.from(`${e.path}\u0000${e.mode}\u0000${e.type}\u0000${e.sha}\n`, 'utf8'));
  }
  return {
    ok: true,
    role,
    digest: h.digest('hex'),
    digestAlgo: DIGEST_ALGO,
    fileCount: expanded.fileCount,
    dirCount: expanded.dirCount,
    paths: expanded.paths,
    entries: expanded.entries,
  };
}

// O1 evidence: equal across the RED and the GREEN, or there is no proof.
// Re-expands and re-hashes the live filesystem on every call by design — a
// cached expansion cannot see a file created or deleted between two
// observations, and the honest lever when this is slow is a narrower glob, not
// a cached check.
export async function oracleDigest(roots, patterns) {
  return setDigest(roots, patterns, 'oracle');
}

// O3 evidence: the PRE-EXECUTION digests must differ across the RED and the
// GREEN. Same shape, same algorithm, same refusals as oracleDigest.
export async function implDigest(roots, patterns) {
  return setDigest(roots, patterns, 'impl');
}

// ── deriveProofs — the read-time verdict ───────────────────────────────────
//
// There is no proof EVENT and no re-baseline verb. A proof is derived from two
// observation receipts every time somebody looks, the way `recencyFromSpine`
// and `resolveSuccessView` already derive their verdicts. Changing a test
// DESTROYS its proof; the only route back is to observe the new test exit
// nonzero and then exit zero.
//
// PURE, AND THAT IS LOAD-BEARING. This function reads no filesystem, takes no
// lock and calls no clock — `nowMs` and the CURRENT digests all arrive as
// arguments. A derivation that re-expanded the tree itself would be a SECOND
// expander running beside the observer's, and two expanders disagreeing about
// one declaration is exactly the two-surfaces-disagreeing failure this feature
// exists to prevent. One expander runs at OBSERVATION time; derivation only
// ever compares strings it was handed.
//
// THE RETURN IS A DISCRIMINATED UNION, NEVER A BARE MAP:
//
//   { ok:true,  proofs, suppressed, integrity, mode, unattributed }
//   { ok:false, unsupported:'team-sync' }
//
// "this mode cannot support proofs", "the chain is broken" and "nothing has
// been observed" must never render alike, and a caller must never have to guess
// whether to call `.get`, print "none", or print "unsupported". `suppressed`
// carries the third of those on the ok:true arm rather than adding an arm, so
// the discriminant stays exactly `ok`.
//
// A MAP MISS MEANS "no acceptance observation exists for this id" — render it
// as *"this command has never been observed to exit nonzero"*, never as a
// failure. Declared-but-never-observed acceptances are deliberately NOT
// synthesized here: this function's evidence is the spine, and inventing an
// entry for an id it has seen no receipt for would be inventing evidence.
//
// WHAT IS DELIBERATELY NOT HERE: `observeAcceptance`, the observation lock,
// `captureSubject` and the gate. Every one of them is a CALLER of this.
const DAY_MS = 86400000;

// Bounds the pair search per acceptanceId. The scan is O(greens × reds), so an
// id with thousands of observations would otherwise turn a read into a stall.
// Truncation can only LOSE a qualifying older pair — the safe direction — and
// it is reported on the view as `scanTruncated` rather than silently narrowing
// coverage while the readout still says "no proof".
const MAX_PAIR_SCAN = 512;

// The closed state vocabulary, exported so no gate or readout can invent a
// fourth positive-sounding word. `live` is the ONLY positive verdict:
//   live                 a qualifying O1–O8 pair anchors the LATEST observation
//                        and every liveness condition holds.
//   historically-proven  a qualifying pair anchors the latest observation but
//                        at least one liveness condition fails. NOT green.
//   regressed            proven at some earlier point; the latest observation
//                        is an eligible process-fail. NOT green.
//   indeterminate        the latest observation is infra-fail, void, a dangling
//                        STARTED, or a corrupt receipt. NOT green. First-class,
//                        never a silent fallthrough.
//   unproven             no qualifying pair anchors the latest observation.
//                        `previouslyProven` says whether one ever existed.
export const ACCEPTANCE_PROOF_STATES = Object.freeze([
  'live', 'historically-proven', 'regressed', 'indeterminate', 'unproven',
]);

// The closed liveness-failure vocabulary, in the order they are TESTED. The
// order is normative: without it two implementations would report different
// reasons for the same proof, and an operator comparing two surfaces would see
// a disagreement where none exists.
export const ACCEPTANCE_STALE_REASONS = Object.freeze([
  'policy-invalid',      // maddu.json acceptance.maxProofAge is malformed — fail closed
  'no-ts',               // the GREEN carries no parseable timestamp
  'future-ts',           // the GREEN is materially future-dated
  'redeclared',          // a GOAL_DECLARED superseded the declaration behind the GREEN
  'undeclared',          // this acceptanceId is no longer declared
  'oracle-unavailable',  // declared, but the current oracle digest could not be computed
  'oracle-changed',      // the test moved — the proof died with it
  'impl-unavailable',    // the current implementation digest could not be computed
  'impl-moved',          // boundToCurrent:false — the GREEN never ran these bytes
  'expired',             // older than the operator's configured maxProofAge
]);

// maddu.json → acceptance.maxProofAge, normalized. Accepts the `readMaxAnchorAge`
// RESULT shape ({set,invalid,days}) or the raw "<n>d" config string, and nothing
// else — a bare number is REFUSED rather than guessed at, because days-vs-
// milliseconds is precisely the ambiguity that silently expires every proof or
// none. Malformed is fail-closed (`policy-invalid`, so nothing reads live), never
// "no policy": a consume gate must never guess its own policy.
function normalizeMaxProofAge(policy) {
  if (policy === null || policy === undefined) return { set: false, invalid: false, ttlMs: null };
  if (typeof policy === 'string') {
    // Bounded by construction (≤ 5 digits ≈ 273 years): an unbounded digit run
    // parses to Infinity and makes every age comparison false — a policy that
    // can never fire is worse than none.
    if (!/^\d{1,5}d$/.test(policy) || parseInt(policy, 10) < 1) return { set: true, invalid: true, ttlMs: null };
    return { set: true, invalid: false, ttlMs: parseInt(policy, 10) * DAY_MS };
  }
  if (isPlainRecord(policy)) {
    if (policy.set === false) return { set: false, invalid: false, ttlMs: null };
    if (policy.invalid === true) return { set: true, invalid: true, ttlMs: null };
    const d = policy.days;
    if (!Number.isSafeInteger(d) || d < 1 || d > 99999) return { set: true, invalid: true, ttlMs: null };
    return { set: true, invalid: false, ttlMs: d * DAY_MS };
  }
  return { set: true, invalid: true, ttlMs: null };
}

// A current-digest lookup: `null` (nothing available at all), a Map, a plain
// object, or a function of acceptanceId.
//
// THE KEY SET IS THE CURRENT DECLARATION. A MISS means "this acceptanceId is
// not declared any more" (`undeclared`), which is how the liveness clause
// "acceptanceId unchanged" is enforced without this file recomputing an id it
// has no cwd/tierPolicy/schemaVersion for: a redeclaration that changes the
// identity simply produces an id the caller's lookup does not carry. A present
// key whose value is `null` means "declared, but the digest could not be
// computed" — a REFUSED expansion, which must not read the same as a match.
// Both are non-live; they are distinguished because the remedies differ.
const LOOKUP_MISS = { known: false, unavailable: false, digest: null };

function coerceDigest(v, label) {
  if (v === undefined) return LOOKUP_MISS;
  if (v === null) return { known: true, unavailable: true, digest: null };
  if (typeof v === 'string' && v.trim()) return { known: true, unavailable: false, digest: v };
  // A caller contract violation, not operator input: a lookup returning a
  // number or a record would compare unequal to every recorded digest and
  // silently mark every proof stale for the wrong reason.
  throw new TypeError(`${label} must yield a non-blank digest string, null (unavailable) or undefined (not declared)`);
}

function makeDigestLookup(src, label) {
  if (src === null || src === undefined) {
    return () => ({ known: true, unavailable: true, digest: null });
  }
  if (src instanceof Map) return (id) => (src.has(id) ? coerceDigest(src.get(id), label) : LOOKUP_MISS);
  if (typeof src === 'function') return (id) => coerceDigest(src(id), label);
  if (isPlainRecord(src)) return (id) => (Object.hasOwn(src, id) ? coerceDigest(src[id], label) : LOOKUP_MISS);
  throw new TypeError(`${label} must be null, a Map, a plain object or a function of acceptanceId`);
}

// One declared set as recorded on a receipt. Every field is validated to its
// exact type: a missing or wrong-typed field becomes `null`/`false`, never a
// truthy default. `stable` is strictly `=== true` — the string "true", 1 and a
// missing key all mean NOT stable, so a receipt that never recorded its
// endpoints can never satisfy O6 by omission.
//
// `patterns` is all-or-nothing on purpose: filtering out a non-string element
// would SHRINK the declared set while the record still digested cleanly, which
// is the silent-omission failure this whole module is built against.
function setView(raw) {
  const r = isPlainRecord(raw) ? raw : {};
  let patterns = null;
  if (Array.isArray(r.patterns) && r.patterns.length && r.patterns.every((p) => typeof p === 'string')) {
    patterns = r.patterns;
  }
  return {
    patterns,
    fileCount: Number.isSafeInteger(r.fileCount) && r.fileCount >= 0 ? r.fileCount : null,
    digest: typeof r.digest === 'string' && r.digest.trim() ? r.digest : null,
    digestAfter: typeof r.digestAfter === 'string' && r.digestAfter.trim() ? r.digestAfter : null,
    stable: r.stable === true,
    digestAlgo: typeof r.digestAlgo === 'string' && r.digestAlgo.trim() ? r.digestAlgo : null,
  };
}

// Canonical key for a pattern array — the same sort/dedupe `acceptanceIdFor`
// binds, so two receipts of ONE declaration compare equal even if the caller
// handed the patterns in a different order. Comparing the literal arrays
// instead would manufacture a false difference; comparing nothing would let two
// different declarations pair.
function patternKey(list) {
  if (!Array.isArray(list)) return null;
  return [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\u0000');
}

const OUTCOME_OF = { 'process-pass': 'pass', 'process-fail': 'fail', 'infra-fail': 'infra' };

// Normalize one acceptance receipt into the shape derivation reasons over.
// UNKNOWN `outcome_class` MAPS TO `infra`: an unrecognised value must never be
// readable as a GREEN and must never be a valid RED (O4), and mapping it to the
// third class also makes it supersede as `indeterminate` — all three at once.
// `observation_status` is likewise strictly `'eligible'`; anything else, absent
// included, is `void`.
function observationFrom(ev, index, forcedVoid = null) {
  const d = isPlainRecord(ev.data) ? ev.data : {};
  const eligible = forcedVoid === null && d.observation_status === 'eligible';
  const outcome = OUTCOME_OF[d.outcome_class] || 'infra';
  return {
    index,
    eventId: typeof ev.id === 'string' ? ev.id : null,
    startedId: typeof d.startedId === 'string' ? d.startedId : null,
    ts: typeof ev.ts === 'string' ? ev.ts : null,
    actor: typeof ev.actor === 'string' ? ev.actor : null,
    acceptanceId: typeof d.acceptanceId === 'string' && d.acceptanceId.trim() ? d.acceptanceId : null,
    commandSha256: typeof d.commandSha256 === 'string' && d.commandSha256.trim() ? d.commandSha256 : null,
    scopeNonce: typeof d.scopeNonce === 'string' && d.scopeNonce.trim() ? d.scopeNonce : null,
    declEventId: typeof d.declEventId === 'string' && d.declEventId.trim() ? d.declEventId : null,
    declSource: typeof d.declSource === 'string' ? d.declSource : null,
    phase: typeof d.phase === 'string' ? d.phase : null,
    loopId: typeof d.loopId === 'string' ? d.loopId : null,
    command: typeof d.command === 'string' ? d.command : null,
    exit: Number.isInteger(d.exit) ? d.exit : null,
    signal: typeof d.signal === 'string' ? d.signal : null,
    timedOut: d.timed_out === true,
    spawnError: d.spawn_error === true,
    durationMs: Number.isSafeInteger(d.duration_ms) ? d.duration_ms : null,
    outcome,
    eligible,
    refusalReason: forcedVoid || (typeof d.refusal_reason === 'string' ? short(d.refusal_reason) : null),
    tier: isPlainRecord(d.subject) && typeof d.subject.tier === 'string' ? d.subject.tier : null,
    oracle: setView(d.oracle),
    impl: setView(d.impl),
    role: forcedVoid !== null ? 'void' : (!eligible ? 'void' : (outcome === 'pass' ? 'green' : outcome === 'fail' ? 'red' : 'infra')),
  };
}

// A dangling STARTED — a run that began and never recorded a result. It anchors
// nothing and, per the supersession table, yields `indeterminate` when it is
// the latest observation. It carries the identity fields precisely so a crashed
// run is attributable to ITS acceptance rather than invalidating all of them or
// none.
function danglingFrom(ev, index) {
  const o = observationFrom(ev, index, 'dangling-started');
  o.role = 'dangling';
  return o;
}

// O1–O8 for one candidate pair. Returns a clause record plus `all`.
//
// Three of the eight are only PARTIALLY derivable here, and saying so is the
// point — a clause reported `true` on evidence that does not exist is worse
// than one reported `null`:
//   - O5's "one replica" half is discharged globally, by refusing every mode
//     that is not exactly `flat` before any of this runs.
//   - O8's DISJOINTNESS half is checked on the *expanded* sets at observation
//     time and rides here only as `observation_status:'eligible'`; the receipt
//     records `patterns` and `fileCount`, not paths, so this file can add only
//     the one-directional pattern check (a pattern string appearing in BOTH
//     declared sets certainly overlaps; distinct patterns do NOT imply
//     disjoint).
//   - O6's endpoint equality is the observer's own `stable` flag. Where the
//     receipt also carries `digestAfter` this compares it directly, which
//     catches an observer that computed `stable` wrongly — internal
//     consistency, NOT independent evidence.
// The same caveat applies to the identity terms folded into O2
// (`commandSha256`, the pattern arrays): both sides come from the spine, so
// they catch an inconsistent producer, never a determined forger.
function evaluateClauses(red, green) {
  const algos = [red.oracle.digestAlgo, red.impl.digestAlgo, green.oracle.digestAlgo, green.impl.digestAlgo];

  const O1 = red.oracle.digest !== null && red.oracle.digest === green.oracle.digest;

  const O2 = red.acceptanceId !== null
    && red.acceptanceId === green.acceptanceId
    && red.commandSha256 !== null && red.commandSha256 === green.commandSha256
    && (red.scopeNonce ?? null) === (green.scopeNonce ?? null)
    && (red.declEventId ?? null) === (green.declEventId ?? null)
    && patternKey(red.oracle.patterns) !== null && patternKey(red.oracle.patterns) === patternKey(green.oracle.patterns)
    && patternKey(red.impl.patterns) !== null && patternKey(red.impl.patterns) === patternKey(green.impl.patterns);

  // The PRE-execution digests, never `digestAfter`. Comparing post-execution
  // digests would let a command that writes into its own declared
  // implementation set satisfy O3 by its own side effects.
  const O3 = red.impl.digest !== null && green.impl.digest !== null && red.impl.digest !== green.impl.digest;

  const O4 = red.eligible && green.eligible && red.outcome === 'fail' && green.outcome === 'pass';

  const O5 = red.index < green.index;

  const endpointsHeld = (o) => o.oracle.stable && o.impl.stable
    && (o.oracle.digestAfter === null || o.oracle.digestAfter === o.oracle.digest)
    && (o.impl.digestAfter === null || o.impl.digestAfter === o.impl.digest);
  const O6 = endpointsHeld(red) && endpointsHeld(green);

  // One algorithm across all four digests, and one tier across both
  // observations. The tier half is the same class of forward guard as the
  // algorithm half: only `worktree` ships today, so requiring equality costs
  // nothing now and forecloses a cross-tier comparison the moment a second
  // tier lands.
  const O7 = algos.every((a) => a !== null) && new Set(algos).size === 1
    && red.tier !== null && red.tier === green.tier;

  const nonEmpty = (o) => o.oracle.fileCount !== null && o.oracle.fileCount > 0
    && o.impl.fileCount !== null && o.impl.fileCount > 0;
  const sharesPattern = (o) => {
    if (!o.oracle.patterns || !o.impl.patterns) return true;   // unusable → refuse, never assume disjoint
    const oset = new Set(o.oracle.patterns);
    return o.impl.patterns.some((p) => oset.has(p));
  };
  const O8 = nonEmpty(red) && nonEmpty(green) && !sharesPattern(red) && !sharesPattern(green);

  const clauses = { O1, O2, O3, O4, O5, O6, O7, O8 };
  clauses.all = O1 && O2 && O3 && O4 && O5 && O6 && O7 && O8;
  return clauses;
}

// The nearest PRECEDING qualifying RED for one GREEN. Nearest-first, by spine
// INDEX — never by iteration order, which two concurrent loops would make
// nondeterministic. Returns the pair, or the nearest candidate it rejected so a
// readout can say WHICH clause failed instead of only "no proof".
function pairFor(green, reds) {
  let nearestRejected = null;
  let scanned = 0;
  for (let i = reds.length - 1; i >= 0; i--) {
    const r = reds[i];
    if (r.index >= green.index) continue;
    if (++scanned > MAX_PAIR_SCAN) return { red: null, clauses: nearestRejected, truncated: true };
    const clauses = evaluateClauses(r, green);
    if (clauses.all) return { red: r, clauses, truncated: false };
    if (nearestRejected === null) nearestRejected = clauses;
  }
  return { red: null, clauses: nearestRejected, truncated: false };
}

// Did a qualifying pair EVER exist at or before `beforeIndex`? Latest-first, so
// the common case (proven recently, then regressed) stops on its first green.
function everProven(greens, reds, beforeIndex) {
  let scanned = 0;
  for (let i = greens.length - 1; i >= 0; i--) {
    const g = greens[i];
    if (g.index >= beforeIndex) continue;
    if (++scanned > MAX_PAIR_SCAN) return { proven: false, truncated: true };
    const p = pairFor(g, reds);
    if (p.red) return { proven: true, truncated: false, red: p.red, green: g, clauses: p.clauses };
    if (p.truncated) return { proven: false, truncated: true };
  }
  return { proven: false, truncated: false };
}

// A compact, immutable-by-construction reference to one observation. The raw
// event is deliberately NOT handed out: a readout holding a live reference
// could mutate the caller's verified list.
function refOf(o) {
  if (!o) return null;
  return {
    // `role` disambiguates what `outcomeClass` cannot: a dangling STARTED
    // carries no outcome at all, and defaulting it to `infra-fail` for the
    // fail-closed classification must not read as "the process reported an
    // infra failure" on a receipt that never reported anything.
    role: o.role,
    eventId: o.eventId,
    startedId: o.startedId,
    index: o.index,
    ts: o.ts,
    actor: o.actor,
    phase: o.phase,
    loopId: o.loopId,
    declSource: o.declSource,
    declEventId: o.declEventId,
    command: o.command,
    outcomeClass: o.outcome === 'pass' ? 'process-pass' : o.outcome === 'fail' ? 'process-fail' : 'infra-fail',
    observationStatus: o.eligible ? 'eligible' : 'void',
    refusalReason: o.refusalReason,
    exit: o.exit,
    signal: o.signal,
    timedOut: o.timedOut,
    spawnError: o.spawnError,
    durationMs: o.durationMs,
    tier: o.tier,
    digestAlgo: o.oracle.digestAlgo,
    oracleDigest: o.oracle.digest,
    oracleFileCount: o.oracle.fileCount,
    implDigest: o.impl.digest,
    implFileCount: o.impl.fileCount,
  };
}

// Liveness — the proof is perishable by construction, and this is the COMPLETE
// list. Every condition is tested in the ACCEPTANCE_STALE_REASONS order so two
// surfaces always name the same reason for the same proof.
//
// `boundToCurrent` is a LIVENESS CONDITION, not a label (the plan's own first
// revision listed it as report-only while simultaneously calling it "visibly
// distinct from live" — an implementer following the report-only reading keeps
// the gate green for code that never produced the recorded GREEN). It is
// computed independently of which reason fires, so it is always meaningful when
// derivable: `null` means "could not be determined", which is NOT live either.
//
// Comparing digests subsumes the plan's "implementation PATH SET and digest"
// wording: paths, permission bits and entry types are all inside the digest
// preimage, so digest equality is the strictly stronger check — and the receipt
// records no path list to compare against anyway.
function livenessOf(green, ctx) {
  const cur = ctx.oracleLookup(green.acceptanceId);
  const curImpl = ctx.implLookup(green.acceptanceId);

  let boundToCurrent = null;
  if (curImpl.known && !curImpl.unavailable && green.impl.digest !== null) {
    boundToCurrent = curImpl.digest === green.impl.digest;
  }

  const redeclared = green.declEventId !== null
    && ((ctx.goalDeclEventId !== null && ctx.goalDeclEventId !== green.declEventId)
      || ctx.lastGoalDeclaredIndex > green.index);

  let staleReason = null;
  if (ctx.policy.invalid) staleReason = 'policy-invalid';
  else {
    const tsReason = isStaleTs(green.ts, ctx.nowMs, {});
    if (tsReason !== null) staleReason = tsReason;              // 'no-ts' | 'future-ts'
    else if (redeclared) staleReason = 'redeclared';
    else if (!cur.known) staleReason = 'undeclared';
    else if (cur.unavailable) staleReason = 'oracle-unavailable';
    else if (green.oracle.digest === null || cur.digest !== green.oracle.digest) staleReason = 'oracle-changed';
    else if (!curImpl.known) staleReason = 'undeclared';
    else if (curImpl.unavailable || boundToCurrent === null) staleReason = 'impl-unavailable';
    else if (boundToCurrent === false) staleReason = 'impl-moved';
    else if (ctx.policy.ttlMs !== null && isStaleTs(green.ts, ctx.nowMs, { ttlMs: ctx.policy.ttlMs }) === 'expired') staleReason = 'expired';
  }

  return {
    live: staleReason === null,
    staleReason,
    boundToCurrent,
    oracleCurrent: !cur.known ? 'undeclared'
      : cur.unavailable ? 'unavailable'
        : (green.oracle.digest !== null && cur.digest === green.oracle.digest) ? 'equal' : 'changed',
  };
}

// Derive at most one proof per acceptanceId from a VERIFIED read.
//
//   deriveProofs({ events, integrity, mode }, { goal, nowMs, currentOracleDigest,
//                                               currentImplDigest, maxProofAge })
//
// The first argument is the COMPLETE result of the verified read, forwarded
// whole and never hand-assembled. `mode` and `integrity` are therefore
// REQUIRED, and their absence throws rather than defaulting: a caller that
// passed only `events` is the exact defect the mode predicate exists to close
// (a fresh synced clone has partition segments and no active replica config, so
// an implementation that never saw `mode` would derive over a timestamp-sorted
// cross-replica list and form proofs whose RED never preceded their GREEN).
//
// FAIL-CLOSED ORDER: mode → integrity → derivation.
//   - `mode` is anything but exactly `'flat'` (including `'unknown'`, which the
//     verified read emits when it cannot tell) → { ok:false, unsupported }.
//     Refusal suppresses PROOFS, never EXECUTION; the caller still runs its
//     commands and still evaluates success conditions.
//   - `integrity` is anything but exactly `'ok'` → all proof state is
//     suppressed. Not "rendered as broken": enumerating acceptanceIds out of a
//     chain that failed verification would already be using untrusted data.
//     EVERY caller that renders proof state honours this, not only the gate —
//     `orient` reading raw events while the gate reads verified ones is two
//     surfaces disagreeing about the same receipts.
//
// ⚠ `currentImplDigest` IS REQUIRED FOR ANY PROOF TO READ `live`. The plan's
// signature line named only `currentOracleDigest`, but its own selection
// section makes `boundToCurrent` — "the GREEN's implementation digest still
// equals the current expansion" — a LIVENESS CONDITION, and there is no way to
// evaluate that from an oracle digest. So the parameter is added here, and a
// caller that omits it gets `state:'historically-proven'`,
// `staleReason:'impl-unavailable'`, `boundToCurrent:null` on EVERY proof.
// That is deliberate and fail-closed: an omitted input must not read as a
// satisfied condition, because "the gate stays green for code that never
// produced the recorded GREEN" is precisely the defect the condition exists to
// prevent. Both lookups are keyed by the CURRENT declaration's acceptanceIds.
export function deriveProofs(read, opts = {}) {
  if (!isPlainRecord(read)) {
    throw new TypeError('deriveProofs takes the verified read result { events, integrity, mode } — pass it whole, never a hand-assembled subset');
  }
  const { events, integrity, mode } = read;
  if (!Array.isArray(events)) throw new TypeError('read.events must be an array of spine events');
  if (typeof integrity !== 'string') {
    throw new TypeError('read.integrity is required — a derivation with no integrity signal would render a broken chain as proof');
  }
  if (typeof mode !== 'string') {
    throw new TypeError("read.mode is required and must be 'flat' | 'partitioned' | 'unknown' — derivation cannot know it must refuse without it");
  }
  if (!isPlainRecord(opts)) throw new TypeError('deriveProofs options must be a plain record');

  const { goal = null, nowMs, currentOracleDigest = null, currentImplDigest = null, maxProofAge = null } = opts;
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('nowMs must be a finite epoch-milliseconds number — this function never calls the clock itself, so a caller omitting it would silently disable every age check');
  }
  if (goal !== null && !isPlainRecord(goal)) throw new TypeError('goal must be a plain record or null');

  // Mode first: in a partitioned spine the ORDERING O5 rests on does not exist,
  // so nothing below is meaningful. This is checked before integrity because it
  // is the more specific and more actionable statement.
  if (mode !== 'flat') return { ok: false, unsupported: 'team-sync' };

  const oracleLookup = makeDigestLookup(currentOracleDigest, 'currentOracleDigest');
  const implLookup = makeDigestLookup(currentImplDigest, 'currentImplDigest');
  const policy = normalizeMaxProofAge(maxProofAge);

  if (integrity !== 'ok') {
    return { ok: true, proofs: new Map(), suppressed: 'integrity', integrity, mode, unattributed: 0 };
  }

  // Spine index by event IDENTITY, not by id: two events sharing an id is
  // exactly the corruption `pairVerifications` fails closed on, and looking up
  // by id would silently pick one of them.
  const indexOf = new Map();
  let lastGoalDeclaredIndex = -1;
  events.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    indexOf.set(e, i);
    if (e.type === 'GOAL_DECLARED') lastGoalDeclaredIndex = i;
  });

  const startedById = new Map();
  for (const e of events) {
    if (e && e.type === 'VERIFICATION_STARTED' && typeof e.id === 'string' && !startedById.has(e.id)) {
      startedById.set(e.id, e);
    }
  }

  const { valid, dangling } = pairVerifications(events, 'acceptance');

  const byId = new Map();          // acceptanceId -> observations (unsorted)
  let unattributed = 0;
  const add = (o) => {
    if (o.acceptanceId === null) { unattributed++; return; }
    const list = byId.get(o.acceptanceId);
    if (list) list.push(o); else byId.set(o.acceptanceId, [o]);
  };

  // Acceptance pairing needs MORE than `pairVerifications` supplies: the shared
  // recorder correlates STARTED→RAN on kind/profile alone, so with several
  // acceptances in flight a RAN could reference a STARTED belonging to a
  // different one. Identity must agree on both events.
  //
  // A disagreement poisons BOTH candidate ids as `void`, not just one: one of
  // the two events is lying about what ran, and there is no way to tell which,
  // so the safe reading is that neither acceptance has a trustworthy latest
  // observation. It supersedes; it anchors nothing.
  for (const ev of valid) {
    const index = indexOf.get(ev);
    if (index === undefined) continue;
    const o = observationFrom(ev, index);
    const s = o.startedId ? startedById.get(o.startedId) : null;
    const sd = s && isPlainRecord(s.data) ? s.data : null;
    const agrees = sd !== null
      && (sd.acceptanceId ?? null) === o.acceptanceId
      && (sd.scopeNonce ?? null) === o.scopeNonce
      && (sd.commandSha256 ?? null) === o.commandSha256;
    if (agrees) { add(o); continue; }
    const mismatched = observationFrom(ev, index, 'identity-mismatch');
    add(mismatched);
    const sid = sd && typeof sd.acceptanceId === 'string' && sd.acceptanceId.trim() ? sd.acceptanceId : null;
    if (sid !== null && sid !== o.acceptanceId) {
      add({ ...mismatched, acceptanceId: sid });
    }
  }

  // A RAN that `pairVerifications` DROPPED — orphan, duplicate-referenced, or
  // not preceded by its STARTED. `recencyFromSpine` treats those as
  // non-existent; acceptance cannot afford to. An honest crash that produces an
  // unpaired RAN would otherwise leave a stale proof rendering green while the
  // run it describes actually failed — the two-surfaces-disagreeing failure
  // again. So it anchors nothing and supersedes as `void`.
  const validSet = new Set(valid);
  events.forEach((e, i) => {
    if (!e || e.type !== 'VERIFICATION_RAN') return;
    if (!isPlainRecord(e.data) || e.data.kind !== 'acceptance') return;
    if (validSet.has(e)) return;
    add(observationFrom(e, i, 'unpaired-ran'));
  });

  for (const s of dangling) {
    if (!isPlainRecord(s.data) || s.data.kind !== 'acceptance') continue;
    const index = indexOf.get(s);
    if (index === undefined) continue;
    add(danglingFrom(s, index));
  }

  const goalDeclEventId = goal && typeof goal.declEventId === 'string' && goal.declEventId.trim() ? goal.declEventId : null;
  const ctx = { oracleLookup, implLookup, policy, nowMs, goalDeclEventId, lastGoalDeclaredIndex };

  const proofs = new Map();
  // Deterministic key order by acceptanceId (UTF-16 code unit, never
  // `localeCompare` — that is locale- and ICU-dependent, so two machines would
  // render the same spine in different orders).
  const ids = [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const acceptanceId of ids) {
    const obs = byId.get(acceptanceId).sort((a, b) => a.index - b.index);
    const greens = obs.filter((o) => o.role === 'green');
    const reds = obs.filter((o) => o.role === 'red');
    const last = obs[obs.length - 1];

    const base = {
      acceptanceId,
      state: 'unproven',
      live: false,
      reason: null,
      staleReason: null,
      tier: last.tier,
      digestAlgo: last.oracle.digestAlgo,
      red: null,
      green: null,
      boundToCurrent: null,
      oracleCurrent: 'unknown',
      previouslyProven: false,
      supersededBy: null,
      clauses: null,
      scanTruncated: false,
      observations: obs.length,
      latest: refOf(last),
      // DESCRIPTIVE ONLY — gates nothing, and must never be rendered as though
      // it did. A Máddu actor is an unauthenticated session id from
      // MADDU_SESSION_ID; "declarer ≠ greener" is content-free as a control.
      // O3+O5 (the impl digest moved, and the RED precedes the GREEN) are the
      // content-bound replacement.
      independence: null,
      // Not derivable from these inputs. Anchor state comes from the OTS
      // commitment ladder and an operator's ASSURANCE_ASSESSED record, neither
      // of which is an input here. `null` rather than a guess: rendering
      // `unanchored` for "I did not look" would be a claim this file cannot
      // support.
      anchorState: null,
    };

    if (last.role === 'green') {
      const p = pairFor(last, reds);
      base.scanTruncated = p.truncated;
      base.clauses = p.clauses;
      if (p.red) {
        const liveness = livenessOf(last, ctx);
        base.red = refOf(p.red);
        base.green = refOf(last);
        base.previouslyProven = true;
        base.boundToCurrent = liveness.boundToCurrent;
        base.oracleCurrent = liveness.oracleCurrent;
        base.staleReason = liveness.staleReason;
        base.independence = {
          redActor: p.red.actor, greenActor: last.actor,
          distinct: p.red.actor !== null && last.actor !== null ? p.red.actor !== last.actor : null,
        };
        if (liveness.live) {
          base.state = 'live';
          base.live = true;
          base.reason = 'RED→GREEN against a frozen oracle, still bound to the current bytes';
        } else {
          base.state = 'historically-proven';
          base.reason = `proven once, not live: ${liveness.staleReason}`;
        }
      } else {
        // A pass that cannot re-anchor. NOT a fallback to an older pair: an
        // implementation reverted to the RED's bytes would otherwise be
        // re-greened by a later environment-drift pass, with O3 no longer
        // holding for the observation that actually ran.
        const prior = everProven(greens, reds, last.index);
        base.previouslyProven = prior.proven;
        base.scanTruncated = base.scanTruncated || prior.truncated;
        base.supersededBy = prior.proven ? refOf(last) : null;
        base.reason = reds.length === 0
          ? 'no proof — this command has never been observed to exit nonzero'
          : prior.proven
            ? `proven once, but the latest pass re-anchors nothing (${failedClauses(p.clauses)}) — not re-affirmed`
            : `no qualifying RED for the latest pass (${failedClauses(p.clauses)})`;
      }
    } else if (last.role === 'red') {
      const prior = everProven(greens, reds, last.index);
      base.previouslyProven = prior.proven;
      base.scanTruncated = prior.truncated;
      base.supersededBy = refOf(last);
      if (prior.proven) {
        base.state = 'regressed';
        base.red = refOf(prior.red);
        base.green = refOf(prior.green);
        base.clauses = prior.clauses;
        base.reason = 'proven once, currently exiting nonzero';
      } else {
        base.supersededBy = null;
        base.reason = 'observed to exit nonzero; no passing observation has been paired with it yet';
      }
    } else {
      // infra-fail, void, dangling STARTED, or a corrupt receipt. First-class
      // `indeterminate`, never a silent fallthrough — the environment, not the
      // code, is what is unproven, and a stale proof must not keep rendering
      // green underneath it.
      const prior = everProven(greens, reds, last.index);
      base.state = 'indeterminate';
      base.previouslyProven = prior.proven;
      base.scanTruncated = prior.truncated;
      base.supersededBy = refOf(last);
      base.reason = last.role === 'dangling'
        ? 'a run started and recorded no result'
        : last.role === 'infra'
          ? 'the latest observation did not complete (timeout, signal, spawn error or null exit) — not a valid RED and not a pass'
          : `the latest observation anchors nothing (${last.refusalReason || 'void'})`;
    }

    proofs.set(acceptanceId, base);
  }

  return { ok: true, proofs, suppressed: null, integrity, mode, unattributed };
}

// Which clauses failed, for a readout that must say more than "no proof".
function failedClauses(clauses) {
  if (!clauses) return 'no preceding RED observation';
  const failed = ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8'].filter((k) => clauses[k] === false);
  return failed.length ? `nearest RED fails ${failed.join(', ')}` : 'no preceding RED observation';
}

// ── honest limits ──────────────────────────────────────────────────────────

// REPLAY_SCOPE_LINE precedent: exported so every surface that renders a proof
// renders its limits from the SAME text, and no readout can quietly narrow
// them. Never say "tamper-proof". Never say "failed a test".
export const ACCEPTANCE_HONEST_LIMITS = `acceptance proof — honest limits:
- PROCESS-LEVEL, NOT ASSERTION-LEVEL. A RED means the declared command EXITED NONZERO against the frozen oracle — never that a test assertion failed. A missing module, a bad config, an unresolvable interpreter or an inner signal death surfacing as 128+n all qualify. Say "exited nonzero", never "failed a test".
- A WEAK ORACLE PROVEN RED→GREEN IS STILL A WEAK ORACLE. An assertion checking almost nothing yields an entirely honest proof.
- NO CAUSATION. A moved implementation digest proves co-occurrence only: some declared byte changed between the two observations. Remove a dependency, record the RED, restore it, touch whitespace, record the GREEN — a proof forms without the implementation change having caused the flip.
- THE COMMAND TEXT IS FROZEN, NOT THE PROGRAM IT NAMES. The same string under a different interpreter, PATH, NODE_OPTIONS or platform shell is a different program.
- ENDPOINT EQUALITY, NOT CONTINUOUS IMMUTABILITY. A run that mutates the oracle or the implementation and restores it before the post-hash is NOT detected, and leaves no recorded difference at all.
- ONLY THE DECLARED SETS ARE BOUND. Digests bind the raw bytes, path, permission bits and entry type of what the declaration named — not the environment, not the repository revision, not files nobody declared. Whitespace-only edits satisfy the implementation-moved clause.
- MUTATION FROM OUTSIDE MÁDDU IS UNBOUNDED. Only Máddu's own sanctioned concurrency is serialized.
- SYMLINKS, NESTED REPOSITORIES AND NON-FILE ENTRIES ARE REFUSED, NOT COVERED. The expander stops rather than guessing; a refusal is visible, an omission would not be.
- A RECEIPT IS A COOPERATIVE ACTOR'S ASSERTION THAT IT RAN SOMETHING. The spine chain is an unkeyed SHA-256 with no HMAC and no signature: fabricated receipts carrying a correctly computed prev_hash verify. Deriving a proof rather than storing it removes the minting verb, not the forgery. Anchoring proves bytes existed at a time — existence and continuity, never truth. The only structurally independent execution witness is CI re-observation from a protected base branch, which is not solved here.
- NO COMMIT BINDING. Any recorded subject sha is human context, not evidence; nothing here ties a proof to a reviewable commit.`;
