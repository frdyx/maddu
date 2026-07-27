// atlas-source — discovery, containment, bounded reads, cache (contract §3, slice A2).
//
// The bottom of the atlas module stack (template/maddu/runtime/lib/atlas-*.mjs):
// atlas-normalize.mjs and atlas-domains.mjs sit above this and call into it; this
// module itself imports nothing from the repo except bridge-bootstrap's
// detectFrameworkLayout(). Node stdlib only, no dependencies.
//
// Three jobs, in order of how a request touches them:
//  1. Availability — is there a readable atlas corpus at all (§3, exhaustive
//     `reason` enum)?
//  2. Bounded reads — every byte this module reads is measured as it arrives,
//     never trusted from corpus-controlled metadata (§3.1).
//  3. Artifact containment — the preview allowlist is validated once, at
//     index-build time, and looked up by exact match only (§3.4).
//
// Never writes anything. No cache file, no report, no projection — the cache
// (§3.2) is a single in-memory slot, keyed by atlasRoot + a content fingerprint.

import { existsSync } from 'node:fs';
import { open, stat, lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve, isAbsolute, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { detectFrameworkLayout } from './bridge-bootstrap.mjs';

// ── size guard constants (§3.1) ──────────────────────────────────────────────
// v1 trusted atlas-index.json's own `totalBytes`, which [measured] excludes
// several of the largest files in the real corpus. Every guard below measures
// bytes actually read through an open handle, never index-declared metadata.
export const MAX_SINGLE_FILE = 32 * 1024 * 1024;
export const MAX_TOTAL_INDEXED = 96 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;          // readNdjson: a line over this aborts the file
const CHUNK_SIZE = 64 * 1024;                // bounded chunked reads through one open handle

// Small, fixed caps for git metadata (§3.2 HEAD resolution). HEAD, a loose
// ref, and a `gitdir:`/`commondir` redirect file are normally tens of bytes;
// a few KiB is already generous. packed-refs can legitimately be larger (one
// line per ref/tag), so it gets its own byte cap plus an explicit line-count
// cap — bytes alone bound memory, but an adversarial file packed with millions
// of short lines is still bounded CPU work worth capping explicitly.
const GIT_SMALL_FILE_MAX = 4096;
const PACKED_REFS_MAX_BYTES = 4 * 1024 * 1024;
const PACKED_REFS_MAX_LINES = 200_000;

// ── artifact preview (§3.4) ──────────────────────────────────────────────────
const PREVIEW_MAX_BYTES = 200_000;
const PREVIEW_MAX_LINES = 2000;
const MAX_ARTIFACT_PATH_LENGTH = 512;
const PREVIEWABLE_EXTENSIONS = new Set(['json', 'ndjson', 'mmd', 'md']);

// ── exhaustive `reason` enum (§3, resolves #17) — any other value is a bug ──
export const AVAILABILITY_REASONS = Object.freeze([
  'not_source_layout', 'no_atlas_root', 'no_manifest', 'no_index',
  'unreadable', 'too_large', 'corrupt_index',
]);

// ── error classes ─────────────────────────────────────────────────────────────
// Thrown (never returned as a discriminated value) by the two functions whose
// job is a single artifact fetch — readArtifactPreview and the bounded-read
// helpers it shares with it. `code` carries the enum the route layer maps to
// an HTTP status; readNdjson/readJsonSafe stay non-throwing (§3.3) because
// they exist to keep building a partial, honest result under corpus defects.
//
// AtlasPathError — containment/shape problems discovered without needing to
// read file content: bad path strings, escaping the root, wrong file type,
// blocked-by-extension. Maps to 403 in the route layer.
// AtlasReadError — I/O-level failures encountered while actually reading
// bytes: missing file, parse failure, size exceeded mid-read. Maps to 500
// (or, for the pre-read size check, folds into the same 403 family — see
// readArtifactPreview).
export class AtlasPathError extends Error {
  constructor(code, message) { super(message || code); this.name = 'AtlasPathError'; this.code = code; }
}
export class AtlasReadError extends Error {
  constructor(code, message) { super(message || code); this.name = 'AtlasReadError'; this.code = code; }
}

// ── §3 resolveAtlasRoot ───────────────────────────────────────────────────────
// Pure, synchronous, no I/O. The atlas always lives at this fixed nested path
// under the repo root — exercised for real by the fixture, which is nested at
// the same depth precisely so this join is never bypassed.
export function resolveAtlasRoot(repoRoot) {
  return join(repoRoot, 'docs', 'audit', 'architecture-atlas');
}

// ── artifact path validation (§3.4 control 1 — index-build time) ────────────
// Rejected: absolute paths, drive-letter prefixes, a leading `/` or `\`, any
// `..` segment, any NUL or C0 byte, any `%`, length > 512. Returns a reason
// string for the warnings channel, never throws.
function validateArtifactPath(path) {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, reason: 'invalid' };
  if (path.length > MAX_ARTIFACT_PATH_LENGTH) return { ok: false, reason: 'too_long' };
  // eslint-disable-next-line no-control-regex -- NUL/C0 detection is the point
  if (/[\x00-\x1f]/.test(path)) return { ok: false, reason: 'control_byte' };
  if (path.includes('%')) return { ok: false, reason: 'percent' };
  if (/^[A-Za-z]:/.test(path)) return { ok: false, reason: 'drive_letter' };
  if (path.startsWith('/') || path.startsWith('\\')) return { ok: false, reason: 'rooted' };
  if (isAbsolute(path)) return { ok: false, reason: 'absolute' };
  if (path.split(/[\\/]+/).includes('..')) return { ok: false, reason: 'dot_dot' };
  return { ok: true, reason: null };
}

// artifactIdFor(path) -> string — URL CONSTRUCTION ONLY. Percent-encodes
// `path` (via encodeURIComponent, which also encodes `/`) so a caller (e.g.
// listArtifacts, built by a later slice) can embed it as a `?path=` query
// value. Its output is NEVER a lookup key and must never be fed back into
// resolveArtifact/readArtifactPreview: the HTTP layer's `url.searchParams.get
// ('path')` already decodes once, so the round trip is
// `artifactIdFor(p)` (encode) -> URL parsing (decode once) -> `p` again — the
// lookup functions take that already-decoded raw path directly.
// `resolveArtifact(index, artifactIdFor(p))` is a DOUBLE decode-then-encode
// mismatch and is asserted (in the test file) to miss, on purpose: it pins
// the asymmetry so a future refactor cannot "fix" it into a second decode,
// which contract §3.4 control 2 forbids (it would also throw `URIError` on
// malformed input for real percent-encoded ids like `%252e%252e%252f`).
export function artifactIdFor(path) {
  return encodeURIComponent(path);
}

// resolveArtifact(index, rawRelPath) -> artifact record | null. Exact
// Map.get, nothing else — no decode, no encode, no path join, no
// normalization. `rawRelPath` is the raw relative path exactly as it appears
// in the allowlist (== `artifacts[].path` in inventory/atlas-index.json) —
// i.e. what `url.searchParams.get('path')` already gives the route layer,
// NOT the output of `artifactIdFor`. Anything that never was a valid
// allowlist entry — a hostile string, a rejected-at-build-time path, an
// encoded id, an unrelated string — simply misses.
export function resolveArtifact(index, rawRelPath) {
  if (!index || !index.artifacts || typeof rawRelPath !== 'string') return null;
  return index.artifacts.get(rawRelPath) || null;
}

// ── shared read budget (§3.1 aggregate cap) ──────────────────────────────────
// A stat-sum can never enforce "bound the bytes actually read" — it only
// bounds bytes DECLARED. createReadBudget() makes a debitable counter that
// every bounded read below can opt into sharing, by passing `{ budget }`.
// Debited per chunk, as bytes actually arrive — never from fstat.
//
// Deliberately opt-in, never applied automatically: `buildAtlasIndex` spends
// a budget on its own two reads and exposes the (already-spent) object as
// `index.readBudget`, but that object is a per-BUILD artifact, not a
// per-request one — on a cache hit `index` is the same long-lived object
// reused across every future request until the corpus fingerprint changes
// (§3.2), so a budget wired to keep debiting into it across the cache's
// whole lifetime would eventually and permanently trip for a corpus far
// under the cap, simply from cumulative traffic. A caller that wants a
// guaranteed-fresh aggregate ceiling across a batch of reads it is about to
// perform together (e.g. atlas-view assembling one endpoint's response from
// several indexed files) should call `createReadBudget()` itself, once per
// batch — never reuse `index.readBudget` as if it reset per call.
export function createReadBudget(maxTotalBytes = MAX_TOTAL_INDEXED) {
  return { maxTotalBytes, spentBytes: 0 };
}

function debitBudget(budget, n, label) {
  if (!budget) return;
  budget.spentBytes += n;
  if (budget.spentBytes > budget.maxTotalBytes) {
    throw new AtlasReadError('too_large',
      `aggregate read budget exceeded${label ? ` (${label})` : ''}: ${budget.spentBytes} > ${budget.maxTotalBytes}`);
  }
}

// ── bounded, open-once reads (§3.1) ──────────────────────────────────────────
// Open the path exactly once, fstat the OPEN HANDLE (not the path — a stat()
// then a separate readFile() is two resolutions of the same name and can
// observe a symlink swapped in between), then read through that same handle
// in fixed-size chunks, counting bytes as they arrive. The fstat gives a cheap
// early rejection; the running count is what actually enforces the bound,
// because a writer can append to the already-open inode after fstat(). When a
// `budget` is supplied, every chunk debits it too, so the AGGREGATE cap is
// enforced on bytes actually read across a whole build, not on file-size
// metadata summed up front.
async function boundedReadFile(absPath, { maxBytes = MAX_SINGLE_FILE, budget = null } = {}) {
  let fh;
  try {
    fh = await open(absPath, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new AtlasReadError('enoent', `not found: ${absPath}`);
    throw new AtlasReadError('io', `cannot open ${absPath}: ${err && err.message}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new AtlasPathError('not_a_file', `not a regular file: ${absPath}`);
    if (st.size > maxBytes) throw new AtlasReadError('too_large', `exceeds size guard (fstat): ${absPath}`);

    const chunks = [];
    let total = 0;
    const chunkBuf = Buffer.alloc(CHUNK_SIZE);
    for (;;) {
      const { bytesRead } = await fh.read(chunkBuf, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      // Bound enforced on bytes actually read, not on the fstat result — a
      // writer can grow the file after fstat() and this is what catches it.
      if (total > maxBytes) throw new AtlasReadError('too_large', `exceeded size guard while reading: ${absPath}`);
      debitBudget(budget, bytesRead, absPath);
      chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
    }
    return { buffer: Buffer.concat(chunks), bytesRead: total };
  } finally {
    await fh.close();
  }
}

function classifyReadError(err) {
  if (err instanceof AtlasReadError || err instanceof AtlasPathError) return err.code;
  if (err && err.code === 'ENOENT') return 'enoent';
  return 'io';
}

// readJsonSafe(absPath, opts) -> {ok:true,value} | {ok:false,error,message}.
// Bounded, open-once, never throws — a corrupt or oversized file is a fact to
// report, not a crash. `opts.budget` (from createReadBudget()) is optional —
// pass `index.readBudget` to have this read count against the same build's
// aggregate cap.
export async function readJsonSafe(absPath, opts = {}) {
  let result;
  try {
    result = await boundedReadFile(absPath, { budget: opts.budget });
  } catch (err) {
    return { ok: false, error: classifyReadError(err), message: err && err.message };
  }
  let value;
  try {
    value = JSON.parse(result.buffer.toString('utf8'));
  } catch (err) {
    return { ok: false, error: 'parse', message: err.message };
  }
  return { ok: true, value };
}

// Split a full file's text into physical lines the way node:readline does:
// no trailing empty "line" when the file ends in a newline, but a real final
// line when it does not. Verified against the fixture's own entities NDJSON
// (which ends with a trailing newline) to reproduce readline's line count
// exactly — a naive `.split('\n')` without the pop() overcounts by one.
function splitPhysicalLines(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// readNdjson(absPath, onRecord, opts) -> { parsed, malformed, malformedLines,
// blankLines, bytesRead, error }. Streams (logically — the whole bounded file
// is read once, then scanned line by line) and continues past malformed
// lines: `onRecord` fires for every line that parses, including every record
// AFTER a malformed one. Blank lines are skipped and never counted as
// malformed. A single line over MAX_LINE_BYTES aborts the file with
// error:'line_too_long', reporting counts gathered up to that point.
// `opts.budget` — see readJsonSafe.
export async function readNdjson(absPath, onRecord, opts = {}) {
  let result;
  try {
    result = await boundedReadFile(absPath, { budget: opts.budget });
  } catch (err) {
    return { parsed: 0, malformed: 0, malformedLines: [], blankLines: 0, bytesRead: 0, error: classifyReadError(err) };
  }
  const lines = splitPhysicalLines(result.buffer.toString('utf8'));
  let parsed = 0, malformed = 0, blankLines = 0;
  const malformedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (line.trim() === '') { blankLines++; continue; }
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      return {
        parsed, malformed: malformed + 1, malformedLines: [...malformedLines, lineNo],
        blankLines, bytesRead: result.bytesRead, error: 'line_too_long',
      };
    }
    let obj;
    try { obj = JSON.parse(line); }
    catch { malformed++; malformedLines.push(lineNo); continue; }
    parsed++;
    onRecord(obj, lineNo);
  }
  return { parsed, malformed, malformedLines, blankLines, bytesRead: result.bytesRead, error: null };
}

// ── artifact containment core (§3.4 controls 3 & 4) ──────────────────────────
// Shared by readArtifactPreview (throws, truncates for a human preview) and
// readIndexedJson (never throws, returns the full parsed content) — ONE
// containment implementation, two consumers, so the escape-hatch checks can
// never drift apart between "preview a file" and "a sibling module reads an
// indexed file fully". Never joins a caller string to the filesystem — the
// path always comes from a resolveArtifact() hit on the validated allowlist.
//
// Returns one of:
//   { kind: 'not_found' }
//   { kind: 'error', error, message, artifact?, pathError: boolean }
//   { kind: 'ok', artifact, buffer }
// `pathError` distinguishes a containment/shape rejection (403 family — no
// bytes were read, or the size was known to be bad before reading) from an
// I/O failure encountered while actually reading (500 family) — the two
// callers map that to AtlasPathError vs AtlasReadError differently.
async function openContainedArtifact(index, rawRelPath, { budget = null } = {}) {
  const artifact = resolveArtifact(index, rawRelPath);
  if (!artifact) return { kind: 'not_found' };

  // Control 3 — post-join containment. Index-build validation (control 1)
  // already rejects `..` segments and rooted/absolute/drive-letter paths, so
  // this is defense in depth: an artifact record that somehow carries an
  // escaping path still cannot resolve outside atlasRoot.
  const atlasRootAbs = resolve(index.atlasRoot);
  const abs = resolve(atlasRootAbs, artifact.path);
  if (abs !== atlasRootAbs && !abs.startsWith(atlasRootAbs + sep)) {
    return { kind: 'error', error: 'outside_root', message: `escapes atlas root: ${artifact.path}`, artifact, pathError: true };
  }

  let fh;
  try {
    fh = await open(abs, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { kind: 'error', error: 'enoent', message: `artifact missing on disk: ${artifact.path}`, artifact, pathError: false };
    return { kind: 'error', error: 'io', message: `cannot open artifact ${artifact.path}: ${err && err.message}`, artifact, pathError: false };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { kind: 'error', error: 'not_a_file', message: `not a regular file: ${artifact.path}`, artifact, pathError: true };
    if (st.size > MAX_SINGLE_FILE) return { kind: 'error', error: 'too_large', message: `exceeds size guard: ${artifact.path}`, artifact, pathError: true };

    // Control 4 — open-once, then verify the handle. node:fs's FileHandle
    // exposes no realpath (confirmed: `typeof fh.realpath === 'undefined'`),
    // so this re-resolves the PATHNAME, not the handle already open — a
    // concurrent symlink swap between open() and here is not closed by this
    // check, only narrowed. That residual is explicitly out of the threat
    // model (§3.1): the atlas tree is local generator output, and an attacker
    // able to swap symlinks inside it already has local write access, which
    // defeats far more than this route.
    const realAtlasRoot = await realpath(atlasRootAbs).catch(() => atlasRootAbs);
    let real;
    try { real = await realpath(abs); } catch { real = null; }
    if (real && real !== realAtlasRoot && !real.startsWith(realAtlasRoot + sep)) {
      return { kind: 'error', error: 'outside_root', message: `realpath escapes atlas root: ${artifact.path}`, artifact, pathError: true };
    }

    const chunks = [];
    let bytesReadTotal = 0;
    const chunkBuf = Buffer.alloc(CHUNK_SIZE);
    for (;;) {
      const { bytesRead } = await fh.read(chunkBuf, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > MAX_SINGLE_FILE) {
        return { kind: 'error', error: 'too_large', message: `exceeded size guard while reading: ${artifact.path}`, artifact, pathError: false };
      }
      try {
        debitBudget(budget, bytesRead, artifact.path);
      } catch (err) {
        return { kind: 'error', error: 'too_large', message: err.message, artifact, pathError: false };
      }
      chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
    }
    return { kind: 'ok', artifact, buffer: Buffer.concat(chunks) };
  } finally {
    await fh.close();
  }
}

// readIndexedJson(index, rawRelPath, opts) -> {ok:true,value} | {ok:false,error,message}.
// The SAME containment path as readArtifactPreview, but returns the full
// parsed JSON rather than a truncated preview — for callers (atlas-normalize,
// atlas-view) that need an allowlisted file's complete content, not a human
// preview, and must go through containment to get it (a direct
// `readJsonSafe(\`${atlasRoot}/${rel}\`)` bypasses control 3/4 entirely and a
// symlink at an allowlisted path escapes the root). Never throws — every
// failure mode, including a symlink escape or a parse error, collapses to a
// discriminated result, because a caller building a larger composite result
// (e.g. a flow catalog) needs to degrade one bad entry to a warning rather
// than crash the whole build. `opts.budget` — see readJsonSafe.
export async function readIndexedJson(index, rawRelPath, opts = {}) {
  const result = await openContainedArtifact(index, rawRelPath, { budget: opts.budget });
  if (result.kind === 'not_found') return { ok: false, error: 'not_found', message: `not in allowlist: ${rawRelPath}` };
  if (result.kind === 'error') return { ok: false, error: result.error, message: result.message };
  try {
    return { ok: true, value: JSON.parse(result.buffer.toString('utf8')) };
  } catch (err) {
    return { ok: false, error: 'parse', message: err.message };
  }
}

// ── artifact preview (§3.4 controls 3 & 4) ───────────────────────────────────
// readArtifactPreview(index, rawRelPath, opts) -> preview record | null.
// `rawRelPath` has the same contract as resolveArtifact's second argument —
// the raw allowlist path (== `url.searchParams.get('path')`, already decoded
// once by URL parsing), never the output of `artifactIdFor`.
// null means "not in the allowlist" (route maps to 404 artifact_not_found).
// Throws AtlasPathError for containment/shape rejections (403 family) and
// AtlasReadError for I/O failures (500 family) — see the class docstrings.
// `opts.budget` — see readJsonSafe.
export async function readArtifactPreview(index, rawRelPath, opts = {}) {
  const artifact = resolveArtifact(index, rawRelPath);
  if (!artifact) return null;
  if (!artifact.previewable) {
    throw new AtlasPathError(artifact.previewBlockedReason || 'not_previewable', `not previewable: ${artifact.path}`);
  }

  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : PREVIEW_MAX_BYTES;
  const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : PREVIEW_MAX_LINES;

  const result = await openContainedArtifact(index, rawRelPath, { budget: opts.budget });
  if (result.kind === 'not_found') return null; // resolveArtifact already checked above; unreachable in practice
  if (result.kind === 'error') {
    if (result.pathError) throw new AtlasPathError(result.error, result.message);
    throw new AtlasReadError(result.error, result.message);
  }

  {
    const content = result.buffer.toString('utf8');
    const rawLines = splitPhysicalLines(content);
    const totalLines = rawLines.length;
    const totalBytes = result.buffer.length;

    let previewBytes = 0;
    const kept = [];
    let truncated = false;
    for (const raw of rawLines) {
      if (kept.length >= maxLines) { truncated = true; break; }
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for the joining newline
      if (previewBytes + lineBytes > maxBytes) { truncated = true; break; }
      previewBytes += lineBytes;
      kept.push(line);
    }

    return {
      path: artifact.path,
      content: kept.join('\n'),
      truncated,
      totalBytes,
      totalLines,
      previewedBytes: previewBytes,
      previewedLines: kept.length,
    };
  }
}

// ── HEAD resolution (§3.2 — worktrees, packed refs, detached HEAD) ──────────
// HEAD is tracked separately from the corpus fingerprint (checking out a
// different commit changes neither the corpus files nor their mtimes) and is
// recomputed on every loadAtlas() call rather than cached with the corpus
// slot. Not part of this module's public export list — it is an internal
// input to the `head`/`stale` field loadAtlas attaches to the returned index.
// Resolution order: .git (dir, or a `gitdir:` file for a linked worktree) ->
// commondir if present -> HEAD -> loose ref -> packed-refs. A detached HEAD
// is the commit id directly. Any genuine failure yields `commit: null`
// (unknown), never a guessed or stale-false answer.
//
// Every read below goes through boundedReadFile — open-once, fstat, chunked
// reads counted as they arrive — with small explicit caps: HEAD resolves on
// EVERY successful atlas GET (§3.2), so an oversized `.git/HEAD`, ref,
// `gitdir:`/commondir redirect, or packed-refs file would otherwise be a
// request-reachable memory/CPU cost, and it would also be the one read path
// in this module NOT using open-once. A read that hits its cap throws
// AtlasReadError('too_large'|'not_a_file'|...), which every caller here
// already catches (directly or via the outer try/catch in resolveHead) and
// turns into `commit: null` — bounded failure, never a throw out of this
// module, never a fabricated answer.
const SHA_RE = /^[0-9a-f]{40}$/i;

async function readGitTextBounded(path, maxBytes) {
  const result = await boundedReadFile(path, { maxBytes });
  return result.buffer.toString('utf8');
}

async function firstLine(path) {
  return (await readGitTextBounded(path, GIT_SMALL_FILE_MAX)).split(/\r?\n/)[0];
}

async function resolveGitDir(repoRoot) {
  const dotGit = join(repoRoot, '.git');
  let st;
  try { st = await stat(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  let content;
  try { content = await readGitTextBounded(dotGit, GIT_SMALL_FILE_MAX); } catch { return null; }
  const m = /^gitdir:\s*(.+)$/m.exec(content);
  if (!m) return null;
  const target = m[1].trim();
  return isAbsolute(target) ? target : resolve(repoRoot, target);
}

async function resolveCommonDir(gitDir) {
  try {
    const raw = (await firstLine(join(gitDir, 'commondir'))).trim();
    if (!raw) return gitDir;
    return isAbsolute(raw) ? raw : resolve(gitDir, raw);
  } catch {
    return gitDir;
  }
}

async function resolveHead(repoRoot) {
  try {
    const gitDir = await resolveGitDir(repoRoot);
    if (!gitDir) return { commit: null };
    const commonDir = await resolveCommonDir(gitDir);

    let headContent;
    try { headContent = (await firstLine(join(gitDir, 'HEAD'))).trim(); }
    catch { return { commit: null }; }

    if (SHA_RE.test(headContent)) return { commit: headContent.toLowerCase() };

    const m = /^ref:\s*(.+)$/.exec(headContent);
    if (!m) return { commit: null };
    const refPath = m[1].trim();

    // Loose ref — check the worktree-local dir first (HEAD is per-worktree),
    // then the common dir (branch refs are shared across worktrees).
    for (const base of [gitDir, commonDir]) {
      try {
        const refContent = (await firstLine(join(base, refPath))).trim();
        if (SHA_RE.test(refContent)) return { commit: refContent.toLowerCase() };
      } catch { /* try the next base */ }
    }

    // Packed branch — no loose ref file exists for it. Bounded by both bytes
    // (PACKED_REFS_MAX_BYTES, via boundedReadFile) and by how many lines are
    // actually scanned (PACKED_REFS_MAX_LINES) — running out of scan budget
    // before finding a match is a genuine "could not resolve", so it falls
    // through to commit:null like any other resolution failure, never a
    // false claim that the ref doesn't exist.
    try {
      const packed = await readGitTextBounded(join(commonDir, 'packed-refs'), PACKED_REFS_MAX_BYTES);
      const lines = packed.split(/\r?\n/);
      const limit = Math.min(lines.length, PACKED_REFS_MAX_LINES);
      for (let i = 0; i < limit; i++) {
        const line = lines[i];
        if (!line || line.startsWith('#') || line.startsWith('^')) continue;
        const sp = line.indexOf(' ');
        if (sp < 0) continue;
        const sha = line.slice(0, sp);
        const ref = line.slice(sp + 1).trim();
        if (ref === refPath && SHA_RE.test(sha)) return { commit: sha.toLowerCase() };
      }
    } catch { /* no packed-refs, unreadable, or oversized */ }

    return { commit: null };
  } catch {
    return { commit: null };
  }
}

// ── cache fingerprint inputs (§3.2) ──────────────────────────────────────────
// "Every file the index actually reads" — DERIVED, not hand-maintained. A
// hand-maintained name list drifts the moment a module starts reading a new
// file: that is exactly how `diagrams/index.json` went missing here — it was
// added as a direct read in atlas-view.mjs without a matching entry in an
// earlier hand-written list. The corpus's own atlas-index.json already
// declares, in `excludedFromContentAddressing`, exactly which files are
// directly-read canonical/derived data rather than previewable artifacts —
// that, plus the validated artifact allowlist, plus the recursively-walked
// behavior directories, together cover every file any atlas-* module reads.
// Only `manifest.json` and `inventory/atlas-index.json` themselves are
// hardcoded — everything else is derived FROM them, so they can't be.
//
// This deliberately over-includes: every allowlisted preview-only artifact
// outside the four recursed directories (README.md, reports/*.md,
// tools/*.mjs) also lands in the fingerprint, even though nothing parses
// them into derived data. That is the safe direction for a cache-
// invalidation key — over-invalidating costs one extra rebuild; under-
// invalidating serves stale data indefinitely, which is the defect this
// whole mechanism exists to prevent.
const FINGERPRINT_DIRS = ['flows', 'state-machines', 'coverage', 'simulations'];
const FINGERPRINT_MAX_DEPTH = 12; // defense in depth against a symlink cycle in generator output

// Recurse fully, not one level: the view reads every allowlisted JSON under
// these directories regardless of nesting depth (e.g. `flows/nested/x.json`),
// so a fingerprint built from a single-level `readdir` can miss a file the
// view actually reads — editing it would then serve stale cached data
// indefinitely. Symlinked subdirectories are not followed further than
// `withFileTypes` already resolves (readdir reports the entry's own type,
// not its target), bounding pathological cycles by depth regardless.
async function listFilesRecursive(atlasRoot, relDir, depth = 0) {
  const out = [];
  if (depth > FINGERPRINT_MAX_DEPTH) return out;
  let entries;
  try { entries = await readdir(join(atlasRoot, relDir), { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const rel = join(relDir, e.name).split(sep).join('/');
    if (e.isDirectory()) out.push(...await listFilesRecursive(atlasRoot, rel, depth + 1));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// Pure derivation over already-parsed inputs — no I/O beyond the recursive
// directory walk and the final existence filter. `artifacts` MUST be the
// VALIDATED allowlist Map, never raw unvalidated `artifacts[]` entries — an
// unvalidated hostile path like `../escape.json` must never be join()'d
// against atlasRoot and stat'd, which is exactly the containment violation
// §3.4 control 1 exists to prevent. A declared-but-absent path (a ghost
// artifact, or an optional file like `diagrams/index.json` the corpus may
// not emit at all) is silently dropped by the final existence filter — it
// can't be stat'd for a fingerprint, and its absence is its own,
// already-handled failure mode elsewhere (a 500 at preview/read time).
//
// `excludedFromContentAddressing` paths get the SAME validateArtifactPath()
// call the artifacts[] allowlist itself is built with — ONE shared
// validation path for both sources this function unions, not two
// independently-written checks that can drift the way readArtifactPreview
// and readIndexedJson would have if openContainedArtifact hadn't been
// extracted into a shared core. Without this, a hostile corpus declaring
// `{"path":"../../outside-large.bin"}` in excludedFromContentAddressing
// would route stat() calls outside atlasRoot entirely — and if that
// external file exceeds MAX_TOTAL_INDEXED, an outside file makes the whole
// atlas report `too_large`. Rejected entries are dropped and warned, exactly
// like a hostile artifacts[] entry.
//
// Every validated, allowlisted artifact key is added UNCONDITIONALLY,
// regardless of whether its path already falls under one of the
// recursively-walked behavior directories below. An earlier version skipped
// allowlist paths already under a walked dir as "redundant with the walk" —
// but an artifact declared at `flows/link.json` that is a SYMLINK on disk is
// not `e.isFile()` (a Dirent reports the entry's own type, never its
// resolved target), so that optimisation silently dropped it from BOTH
// nets: excluded here as "the walk will get it", excluded from the walk as
// "not a file". `stat()` (not `lstat()`) on its path follows the link, so
// retargeting it still changes size/mtime and still changes the
// fingerprint once it's unconditionally in the set — the walk below is kept
// only to catch files that exist on disk but were NEVER declared in the
// allowlist at all (a generator defect; there is no allowlist entry to
// validate a path for in that case, so containment relies on `join`
// resolving strictly inside `atlasRoot/relDir`, which `readdir` already
// guarantees).
async function deriveFingerprintFileSet(atlasRoot, rawIndexValue, artifacts) {
  const rel = new Set(['manifest.json', 'inventory/atlas-index.json']);
  const warnings = [];

  for (const entry of Array.isArray(rawIndexValue && rawIndexValue.excludedFromContentAddressing)
    ? rawIndexValue.excludedFromContentAddressing : []) {
    const path = entry && entry.path;
    const { ok, reason } = validateArtifactPath(path);
    if (!ok) {
      warnings.push(`excludedFromContentAddressing entry rejected at index-build (${reason}): ${JSON.stringify(path)}`);
      continue;
    }
    rel.add(path);
  }
  for (const path of artifacts.keys()) rel.add(path);
  for (const d of FINGERPRINT_DIRS) {
    for (const p of await listFilesRecursive(atlasRoot, d)) rel.add(p);
  }

  // lstat, never stat/existsSync: both of those FOLLOW a symlink, so an
  // allowlisted path whose on-disk form is a symlink to an external target
  // would otherwise resolve existence (and, worse, size/mtime below) through
  // to that external file — reading metadata outside atlasRoot before
  // openContainedArtifact's realpath containment check ever runs. lstat
  // reports the link's OWN dirent, never the resolved target, closing that
  // without needing a realpath call here at all: the link's own mtime
  // changes whenever it is recreated (retargeted), which is what makes the
  // §3.2 staleness fix (every validated artifact key participates
  // unconditionally) still work — see computeFingerprint's stat loop, which
  // uses the SAME lstat for the same reason.
  const existing = [];
  for (const p of rel) {
    try { await lstat(join(atlasRoot, p)); existing.push(p); } catch { /* absent, not even as a dangling link */ }
  }
  return { files: existing.sort(), warnings };
}

// Self-contained convenience wrapper for callers (loadAtlas's cheap
// cache-fingerprint check, see statFingerprintInputs) that have not already
// parsed atlas-index.json themselves — reads and parses it (cheap: small
// JSON, no NDJSON) and derives from that. buildAtlasIndex, which HAS already
// parsed it, calls deriveFingerprintFileSet directly instead to avoid the
// redundant read. Only the file list is relevant to this cheap path (it
// doesn't build or propagate warnings — buildAtlasIndex's own call is what
// surfaces those in `index.warnings`).
async function listFingerprintInputs(atlasRoot, opts = {}) {
  const indexResult = await readJsonSafe(join(atlasRoot, 'inventory', 'atlas-index.json'), { budget: opts.budget });
  const rawIndex = indexResult.ok ? indexResult.value : null;
  const { artifacts } = buildArtifactAllowlist(rawIndex && rawIndex.artifacts);
  const { files } = await deriveFingerprintFileSet(atlasRoot, rawIndex, artifacts);
  return files;
}

function computeFingerprint(atlasRoot, statted, manifest) {
  const lines = [...statted]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((s) => `${s.path}:${s.size}:${s.mtimeMs}`);
  const commit = (manifest && manifest.repository && manifest.repository.commit) || '';
  const completedAt = (manifest && manifest.completedAt) || '';
  const material = `${atlasRoot}\n${lines.join('\n')}\n${commit}\n${completedAt}`;
  return createHash('sha256').update(material).digest('hex');
}

// ── artifact allowlist (§3.4 control 1) ──────────────────────────────────────
function buildArtifactAllowlist(rawArtifacts) {
  const artifacts = new Map();
  const warnings = [];
  for (const entry of Array.isArray(rawArtifacts) ? rawArtifacts : []) {
    const path = entry && entry.path;
    const { ok, reason } = validateArtifactPath(path);
    if (!ok) {
      warnings.push(`artifact rejected at index-build (${reason}): ${JSON.stringify(path)}`);
      continue;
    }
    // Previewability MUST derive from the PATH, never from corpus-declared
    // `entry.extension` metadata — the allowlist itself is corpus data, so a
    // hostile or malformed index entry declaring {path:"tools/evil.mjs",
    // extension:"md"} would otherwise make an executable file previewable,
    // defeating the "every .mjs artifact is blocked" rule from a single
    // metadata lie rather than an actual path escape. Same untrusted-metadata
    // principle as the §3.1 byte guard: the real value always governs, and
    // disagreement is recorded, never silently trusted.
    const pathExtension = extname(path).replace(/^\./, '').toLowerCase();
    const declaredExtension = typeof entry.extension === 'string' ? entry.extension.toLowerCase() : '';
    if (declaredExtension && declaredExtension !== pathExtension) {
      warnings.push(`artifact extension mismatch (path governs): ${JSON.stringify(path)} declared "${entry.extension}", path implies "${pathExtension || '(none)'}"`);
    }
    const previewable = PREVIEWABLE_EXTENSIONS.has(pathExtension);
    artifacts.set(path, {
      path,
      declaredBytes: typeof entry.bytes === 'number' ? entry.bytes : null,
      declaredSha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
      class: entry.class ?? null,
      extension: entry.extension ?? null,
      previewable,
      previewBlockedReason: previewable ? null : 'executable',
    });
  }
  return { artifacts, warnings };
}

// ── §3 buildAtlasIndex — test seam, no cache ─────────────────────────────────
// Assumes manifest.json and inventory/atlas-index.json are present and parse
// (loadAtlas/probeAtlas establish that before ever calling this); a race
// between the probe and this call is defensively surfaced as a thrown
// AtlasReadError rather than silently producing an empty-but-successful atlas
// (prime directive #1 — never fabricate).
export async function buildAtlasIndex(atlasRoot) {
  // One read budget spent on THIS build's own two reads (manifest.json +
  // atlas-index.json) — debited per chunk as bytes actually arrive (§3.1),
  // which is the real enforcement mechanism here, not the stat-sum pre-flight
  // check below. Exposed on the returned index as `readBudget`, mainly for
  // introspection: it is a historical record of what THIS build spent, not a
  // reusable per-request budget (see createReadBudget's docstring) — a
  // caller wanting its OWN aggregate ceiling across a batch of further reads
  // should call createReadBudget() again, not reuse this one indefinitely.
  const readBudget = createReadBudget();

  const manifestResult = await readJsonSafe(join(atlasRoot, 'manifest.json'), { budget: readBudget });
  if (!manifestResult.ok) {
    throw new AtlasReadError(manifestResult.error === 'too_large' ? 'too_large' : 'io',
      `cannot read manifest.json: ${manifestResult.message}`);
  }
  const indexResult = await readJsonSafe(join(atlasRoot, 'inventory', 'atlas-index.json'), { budget: readBudget });
  if (!indexResult.ok) {
    throw new AtlasReadError(indexResult.error === 'too_large' ? 'too_large' : 'io',
      `cannot read atlas-index.json: ${indexResult.message}`);
  }

  const manifest = manifestResult.value;
  const { artifacts, warnings: allowlistWarnings } = buildArtifactAllowlist(indexResult.value && indexResult.value.artifacts);

  // Cheap early pre-flight over the fingerprint file set (lstat only, mirrors
  // the fstat early-rejection pattern for the per-file cap) — NOT the
  // aggregate enforcement mechanism. These files are stat'd for the
  // fingerprint but not read here; the actual bound on bytes read lives in
  // `readBudget` above and in every bounded read that chooses to share it.
  // Derives directly from what was already parsed above (indexResult.value,
  // artifacts) rather than calling listFingerprintInputs, which would
  // re-read and re-parse atlas-index.json a second time for no reason.
  //
  // lstat, deliberately not stat: stat FOLLOWS a symlink, so an allowlisted
  // path whose on-disk form is a symlink to an external target would feed
  // that external file's size into `aggregateStattedBytes` (a large enough
  // external file could trip too_large from outside the root entirely) and
  // its size/mtime into the fingerprint hash — before openContainedArtifact
  // ever gets a chance to reject it via realpath containment. lstat reports
  // the link's own dirent only, never reads or measures anything the link
  // points at, and still changes whenever the link is recreated
  // (retargeted), which is what keeps the fingerprint sensitive to a
  // retargeted symlink without ever following it.
  const { files: fingerprintInputs, warnings: fingerprintWarnings } =
    await deriveFingerprintFileSet(atlasRoot, indexResult.value, artifacts);
  const warnings = [...allowlistWarnings, ...fingerprintWarnings];
  const statted = [];
  let aggregateStattedBytes = 0;
  for (const rel of fingerprintInputs) {
    let st;
    try { st = await lstat(join(atlasRoot, rel)); } catch { continue; }
    aggregateStattedBytes += st.size;
    statted.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
  }
  if (aggregateStattedBytes > MAX_TOTAL_INDEXED) {
    throw new AtlasReadError('too_large', `aggregate indexed bytes (${aggregateStattedBytes}) exceed MAX_TOTAL_INDEXED`);
  }

  const fingerprint = computeFingerprint(atlasRoot, statted, manifest);

  return { atlasRoot, manifest, fingerprint, artifacts, warnings, readBudget };
}

// probeAtlas/loadAtlas must NEVER throw — both are declared to return a
// discriminated result, and a function with two error channels (a returned
// `{available:false,reason}` AND an undocumented throw) is precisely the
// shape of an "unexpected 500": callers write a handler for the documented
// channel and get blindsided by the other. `detectFrameworkLayout`/
// `resolveAtlasRoot` both call `path.join(repoRoot, ...)`, which throws a
// synchronous TypeError for a non-string `repoRoot` — this guard rejects
// that (and an empty string, and a NUL/C0 byte, which trips fs syscalls
// downstream) BEFORE either is ever called, mapping it to the existing
// 'unreadable' reason rather than inventing a new enum value.
function isUsableRepoRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return false;
  // eslint-disable-next-line no-control-regex -- NUL/C0 detection is the point
  if (/[\x00-\x1f]/.test(repoRoot)) return false;
  return true;
}

// ── §3 probeAtlas ─────────────────────────────────────────────────────────────
export async function probeAtlas(repoRoot) {
  try {
    if (!isUsableRepoRoot(repoRoot)) {
      return { available: false, reason: 'unreadable', atlasRoot: null, layout: 'unknown' };
    }
    const layout = detectFrameworkLayout(repoRoot);
    const atlasRoot = resolveAtlasRoot(repoRoot);

    if (layout !== 'source') return { available: false, reason: 'not_source_layout', atlasRoot, layout };
    if (!existsSync(atlasRoot)) return { available: false, reason: 'no_atlas_root', atlasRoot, layout };

    let rootStat;
    try { rootStat = await stat(atlasRoot); } catch { return { available: false, reason: 'no_atlas_root', atlasRoot, layout }; }
    if (!rootStat.isDirectory()) return { available: false, reason: 'no_atlas_root', atlasRoot, layout };

    const manifestResult = await readJsonSafe(join(atlasRoot, 'manifest.json'));
    if (!manifestResult.ok) {
      if (manifestResult.error === 'too_large') return { available: false, reason: 'too_large', atlasRoot, layout };
      return { available: false, reason: 'no_manifest', atlasRoot, layout };
    }

    const indexResult = await readJsonSafe(join(atlasRoot, 'inventory', 'atlas-index.json'));
    if (!indexResult.ok) {
      if (indexResult.error === 'enoent') return { available: false, reason: 'no_index', atlasRoot, layout };
      if (indexResult.error === 'too_large') return { available: false, reason: 'too_large', atlasRoot, layout };
      return { available: false, reason: 'corrupt_index', atlasRoot, layout };
    }

    return { available: true, reason: null, atlasRoot, layout };
  } catch {
    // Defensive backstop for any OTHER unexpected internal throw not
    // anticipated above (e.g. an OS-specific invalid-path rejection this
    // guard didn't name) — still never propagates past this function.
    return { available: false, reason: 'unreadable', atlasRoot: null, layout: 'unknown' };
  }
}

// ── §3.2 cache — single slot, memory only ────────────────────────────────────
let cache = null; // { atlasRoot, fingerprint, index }

export function clearAtlasCache() {
  cache = null;
}

// ── §3 loadAtlas ─────────────────────────────────────────────────────────────
// AtlasIndex | { available:false, reason }. On success also carries
// `available:true, reason:null` so callers can discriminate uniformly with
// the same field on both branches (probeAtlas already does this). Never
// throws — see probeAtlas's docstring; the whole body is additionally
// wrapped as a defensive backstop, even though every call it makes to
// probeAtlas/buildAtlasIndex/resolveHead is itself already non-throwing or
// individually caught, so a future refactor that adds a new raw-repoRoot
// touch before the probe still can't turn into an escaped throw.
export async function loadAtlas(repoRoot) {
  try {
    const probe = await probeAtlas(repoRoot);
    if (!probe.available) return { available: false, reason: probe.reason };

    const { atlasRoot } = probe;
    let fingerprint;
    try {
      fingerprint = computeFingerprint(atlasRoot, await statFingerprintInputs(atlasRoot), await readManifestForFingerprint(atlasRoot));
    } catch {
      return { available: false, reason: 'unreadable' };
    }

    let index;
    if (cache && cache.atlasRoot === atlasRoot && cache.fingerprint === fingerprint) {
      index = cache.index;
    } else {
      try {
        index = await buildAtlasIndex(atlasRoot);
      } catch (err) {
        return { available: false, reason: err instanceof AtlasReadError && err.code === 'too_large' ? 'too_large' : 'unreadable' };
      }
      cache = { atlasRoot, fingerprint, index };
    }

    const head = await resolveHead(repoRoot);
    const manifestCommit = index.manifest && index.manifest.repository && index.manifest.repository.commit;
    const stale = head.commit && manifestCommit ? head.commit !== String(manifestCommit).toLowerCase() : null;

    return { ...index, available: true, reason: null, head: { commit: head.commit, stale } };
  } catch {
    return { available: false, reason: 'unreadable' };
  }
}

// Small helpers so loadAtlas can compute a fingerprint to check against the
// cache WITHOUT re-parsing atlas-index.json's artifacts on every call — only
// buildAtlasIndex (on an actual cache miss) does the full artifact-allowlist
// pass. Both read the same two small files buildAtlasIndex reads.
async function readManifestForFingerprint(atlasRoot) {
  const r = await readJsonSafe(join(atlasRoot, 'manifest.json'));
  if (!r.ok) throw new AtlasReadError('io', 'manifest unreadable during fingerprint check');
  return r.value;
}
async function statFingerprintInputs(atlasRoot) {
  const rels = await listFingerprintInputs(atlasRoot);
  const statted = [];
  // lstat here too, for two reasons: the same containment reason as
  // buildAtlasIndex's own stat loop (never follow an allowlisted symlink to
  // an external target), and because this cheap path's fingerprint MUST
  // match buildAtlasIndex's exactly — using stat here while buildAtlasIndex
  // uses lstat would make loadAtlas's cache-hit check permanently disagree
  // with the fingerprint an actual build computes for the same corpus state,
  // rebuilding on every call.
  for (const rel of rels) {
    try { statted.push({ path: rel, ...(await lstat(join(atlasRoot, rel))) }); } catch { /* skip */ }
  }
  // Normalize to the {path,size,mtimeMs} shape computeFingerprint expects.
  return statted.map((s) => ({ path: s.path, size: s.size, mtimeMs: s.mtimeMs }));
}
