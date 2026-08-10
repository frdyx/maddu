// acceptance-core — phase 1a of the acceptance proof: identity, refusals,
// pattern compilation, containment-checked expansion, and raw-byte digests.
// Split out of acceptance.mjs (which remains the single public entry and holds
// the full contract documentation — read its header before touching anything
// here; every law in it binds this module). The helpers exported below
// (refuse, requireWorkRoot, isPlainRecord, short) are INTERNAL to the
// acceptance-* family — callers outside it import from acceptance.mjs only.

import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { globToRegExp } from './architecture.mjs';
import { commandDigest } from './acceptance-digest.mjs';

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
export function refuse(reason, refusalClass, detail, { pattern = null, patternIndex = null, path = null } = {}) {
  return { ok: false, reason, refusalClass, detail, pattern, patternIndex, path };
}

// A bare root is the exact bug the roots pair exists to prevent, so it is
// refused loudly rather than coerced into `{workRoot: root}`.
export function requireWorkRoot(roots) {
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

export function isPlainRecord(v) {
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

export function short(e) {
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

