// spine-append-core.mjs — stdlib-only append mechanics shared by the full spine
// (spine.mjs) and the standalone token-usage wrapper (runtimes/_wrapper-common.mjs).
// Roadmap #12c phase 1.
//
// SCOPE: this module owns ONLY the sync-mode partitioned append — writing into
// `.maddu/events/by-replica/<replicaId>/` under the per-partition append funnel
// with a strictly-valid `prev_hash` chain computed INSIDE the lock. The DEFAULT
// single-machine append path stays in spine.mjs / _wrapper-common.mjs and is
// untouched by this module — sync mode is opt-in (replica.json present).
//
// It imports ONLY Node stdlib + append-lock.mjs (also stdlib-only). It pulls in NO
// catalog/defaults logic, so the worker-subprocess token wrapper can import it
// without breaking its standalone contract (see _wrapper-common.mjs header).

import { appendFile, mkdir, open, readFile, readdir, stat, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withAppendLock } from './append-lock.mjs';

const ROLL_BYTES = 10 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Canonical tamper-evidence hash of a stored NDJSON line (trailing CR stripped so a
// CRLF-normalized copy verifies identically). Single source of truth — spine.mjs
// re-exports this so the verifier and every writer can never drift.
export function hashLine(line) {
  return createHash('sha256').update(String(line).replace(/\r$/, ''), 'utf8').digest('hex');
}

export function configReplicaPath(repoRoot) {
  return join(repoRoot, '.maddu', 'config', 'replica.json');
}

// A replicaId is a path segment (partition dir name), so it must be a safe token
// with no path separators or traversal — a minted id is `makeId('rep')`, but we
// validate the CHARSET (not the exact shape) to also reject a hand-edited
// `../escaped` before it is ever joined into a filesystem path.
export function isValidReplicaId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
}

// The replicaId of THIS checkout, or null when sync mode is not initialised
// (no replica.json → default single-machine mode). FAILS CLOSED on a replica.json
// that is present but malformed/unsafe: rather than silently reverting to the flat
// path (which would fork a synced spine), it throws so the operator fixes the
// config. Only a genuinely ABSENT file (ENOENT) means "default mode".
export async function readReplicaId(repoRoot) {
  const p = configReplicaPath(repoRoot);
  let txt;
  try {
    txt = await readFile(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null; // default mode — sync not initialised
    throw e; // present but unreadable (perms, etc.) — surface it, don't fail open
  }
  let obj;
  try {
    obj = JSON.parse(txt);
  } catch {
    throw new Error(`replica.json is malformed JSON at ${p} — fix or remove it (remove = default single-machine mode)`);
  }
  // Validate the RAW stored value — do NOT trim first, or a whitespace-padded id
  // (" repA", "\nrepA") would be silently normalized instead of failing closed.
  const id = obj && typeof obj.replicaId === 'string' ? obj.replicaId : '';
  if (!id) throw new Error(`replica.json has no replicaId at ${p} — fix or remove it`);
  if (!isValidReplicaId(id)) {
    throw new Error(`replica.json replicaId ${JSON.stringify(id)} is not a valid partition id (allowed: alnum, _, -; no whitespace or path separators) at ${p}`);
  }
  return id;
}

export function partitionDir(repoRoot, replicaId) {
  return join(repoRoot, '.maddu', 'events', 'by-replica', replicaId);
}

// The pending-migration marker (written by `spine sync init` while it migrates the
// legacy segments into a partition, before replica.json exists). It names the target
// replicaId so an in-flight append routes to that partition and blocks on its funnel
// lock — which the migration holds — instead of writing a soon-orphaned flat segment.
export function pendingReplicaPath(repoRoot) {
  return join(repoRoot, '.maddu', 'config', 'replica.pending.json');
}
async function readPendingReplicaId(repoRoot) {
  try {
    const id = JSON.parse(await readFile(pendingReplicaPath(repoRoot), 'utf8'))?.replicaId;
    return typeof id === 'string' && isValidReplicaId(id) ? id : null;
  } catch { return null; }
}

// The replicaId a READ should use right now: the committed replica.json id if
// present, else a pending-migration target, else null (default flat mode). READS may
// safely include an in-progress partition (readAllPartitioned merges partition +
// residual flat), so a migration is transparent to readers. Throws only if
// replica.json is present-but-malformed (same as readReplicaId).
export async function readActiveReplicaId(repoRoot) {
  try {
    const committed = await readReplicaId(repoRoot);
    if (committed) return committed;
  } catch (e) {
    // A malformed committed config is transient ONLY while a migration is publishing
    // (a partial write that atomic-rename normally prevents; belt-and-suspenders). If
    // the marker is present, treat as the in-progress partition; else it's genuinely
    // broken — surface it.
    if (await pendingReplicaExists(repoRoot)) return readPendingReplicaId(repoRoot);
    throw e;
  }
  return readPendingReplicaId(repoRoot);
}

async function pendingReplicaExists(repoRoot) {
  try { await access(pendingReplicaPath(repoRoot)); return true; } catch { return false; }
}

// readReplicaId, but a malformed committed config is swallowed to null WHILE a
// pending marker exists (a transient partial write during publish). After the marker
// is gone, malformed still throws (genuinely broken) — the caller passes that through.
async function readCommittedTolerant(repoRoot) {
  try { return await readReplicaId(repoRoot); }
  catch (e) {
    if (await pendingReplicaExists(repoRoot)) return null; // transient — keep waiting
    throw e;
  }
}

// Resolve the replicaId a WRITE should use — and here the rule is STRICTER than for
// reads: an append must NEVER write into a partition whose migration hasn't committed
// (replica.json written last), or it could chain onto a partial partition and fork
// the chain against the still-migrating segments. So:
//   { id }         — commit present: append to this partition (under its funnel lock)
//   { flat:true }  — no replica.json AND no pending migration: default flat write
//   { pending:true}— a migration is in progress but did not commit within timeoutMs;
//                    the caller MUST NOT write (retry later) — never corrupts.
// Waiting only happens while a marker exists (a brief, in-progress `spine sync init`);
// a default repo returns {flat} immediately with no wait.
export async function resolveWriteReplica(repoRoot, { timeoutMs = 5000, pollMs = 25 } = {}) {
  const committed = await readCommittedTolerant(repoRoot);
  if (committed) return { id: committed };
  if (!(await pendingReplicaExists(repoRoot))) return { flat: true };
  // A migration is publishing — wait for it to commit replica.json, then use it. A
  // partial replica.json mid-publish reads as null here (tolerant) → keep waiting.
  let waited = 0;
  for (;;) {
    const id = await readCommittedTolerant(repoRoot);
    if (id) return { id };
    if (!(await pendingReplicaExists(repoRoot))) {
      // Marker gone: the commit is final now, so a malformed config is genuinely
      // broken — let readReplicaId throw (or return the id / flat).
      const id2 = await readReplicaId(repoRoot);
      return id2 ? { id: id2 } : { flat: true };
    }
    if (waited >= timeoutMs) return { pending: true };
    await sleep(pollMs);
    waited += pollMs;
  }
}

// Numeric-segment filter — identical to spine.mjs#listSegments, applied per
// partition dir. Dotfiles (`.append.lock`) and replica.json are excluded by it.
async function listSegmentsInDir(dir) {
  try {
    const files = await readdir(dir);
    return files.filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  } catch {
    return [];
  }
}

async function currentSegmentInDir(dir) {
  const segs = await listSegmentsInDir(dir);
  if (segs.length === 0) {
    const name = '000000000001.ndjson';
    await writeFile(join(dir, name), '');
    return name;
  }
  const last = segs[segs.length - 1];
  const st = await stat(join(dir, last));
  if (st.size < ROLL_BYTES) return last;
  const next = String(parseInt(last.split('.')[0], 10) + 1).padStart(12, '0') + '.ndjson';
  await writeFile(join(dir, next), '');
  return next;
}

// Tail-read (≤64 KB) the exact stored text of the last non-empty event line in
// this partition, or null if empty. Dir-scoped mirror of spine.mjs#lastEventLine.
async function lastEventLineInDir(dir) {
  const segs = await listSegmentsInDir(dir);
  for (let i = segs.length - 1; i >= 0; i--) {
    const p = join(dir, segs[i]);
    let st;
    try { st = await stat(p); } catch { continue; }
    if (st.size === 0) continue;
    const readLen = Math.min(st.size, 65536);
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, st.size - readLen);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
      if (lines.length) return lines[lines.length - 1];
    } finally { await fh.close(); }
    // Pathological single line > 64 KB — full read fallback.
    const lines = (await readFile(p, 'utf8')).split('\n').filter((l) => l.trim());
    if (lines.length) return lines[lines.length - 1];
  }
  return null;
}

function onWaitStderr(dir) {
  return ({ waitedMs, holder }) => {
    if (waitedMs > 0) {
      const who = holder && holder.pid ? ` (held by pid ${holder.pid}@${holder.host})` : '';
      process.stderr.write(
        `maddu spine: waiting ${Math.round(waitedMs / 1000)}s for partition append lock in ${dir}${who}\n`
      );
    }
  };
}

// ── Sync-mode read: deterministic k-way merge (#12c §B) ──
//
// Read order is NOT a flat sort on (ts, replicaId, seq). Each partition is an
// ordered stream (append order = line seq) and is consumed in seq order ALWAYS —
// so a backward clock step inside a partition can never reorder its own events (it
// would contradict that partition's prev_hash chain). `ts` (tie-break replicaId)
// only decides the CROSS-partition interleave: which stream's head goes next.

// Parse the numeric segments directly under `dir` (non-recursive) into an ordered
// event array (seq = segment index + line position). Mirrors spine.mjs#readAll's
// bad-line tolerance so a torn line never aborts the whole read.
async function readStreamEvents(dir) {
  const segs = await listSegmentsInDir(dir);
  const out = [];
  for (const seg of segs) {
    let text;
    try { text = await readFile(join(dir, seg), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); }
      catch (err) { console.error(`spine: bad line in ${seg}:`, err.message); }
    }
  }
  return out;
}

// Pure k-way merge of seq-ordered streams. Each `streams[k]` = { replicaId,
// events } already in seq order; events are emitted in that order within a stream,
// interleaved across streams by the smallest (ts, replicaId) at each step.
export function kWayMergeStreams(streams) {
  const cur = streams.map((s) => ({ replicaId: s.replicaId, events: s.events, i: 0 }));
  const out = [];
  for (;;) {
    let best = -1;
    for (let k = 0; k < cur.length; k++) {
      const c = cur[k];
      if (c.i >= c.events.length) continue;
      if (best === -1) { best = k; continue; }
      const a = c.events[c.i];
      const b = cur[best].events[cur[best].i];
      const at = a.ts ?? '', bt = b.ts ?? '';
      if (at < bt || (at === bt && c.replicaId < cur[best].replicaId)) best = k;
    }
    if (best === -1) break;
    const c = cur[best];
    out.push(c.events[c.i++]);
  }
  return out;
}

// True when a non-empty by-replica partition tree exists (this checkout is in
// sync mode, or has imported another replica's partitions). Drives readAll's
// branch — the default single-machine repo (no by-replica dir) never enters here.
export async function hasPartitions(repoRoot) {
  const byReplica = join(repoRoot, '.maddu', 'events', 'by-replica');
  try {
    const ents = await readdir(byReplica, { withFileTypes: true });
    return ents.some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

// Sorted list of partition (replicaId) directory names under by-replica/, or []
// when none exist. Used by the verifier to walk each partition's chain.
export async function listPartitionIds(repoRoot) {
  const byReplica = join(repoRoot, '.maddu', 'events', 'by-replica');
  try {
    return (await readdir(byReplica, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Sync-mode readAll: k-way merge across every partition, plus any residual flat
// legacy stream (pre-migration) as a sentinel partition (replicaId '' sorts first
// on a ts tie). After `spine sync init` migrates legacy into a partition, the flat
// stream is empty and contributes nothing.
export async function readAllPartitioned(repoRoot) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const streams = [];
  const flat = await readStreamEvents(eventsDir);
  if (flat.length) streams.push({ replicaId: '', events: flat });
  const byReplica = join(eventsDir, 'by-replica');
  let dirs = [];
  try {
    dirs = (await readdir(byReplica, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch { /* no partitions */ }
  for (const rid of dirs) {
    const evs = await readStreamEvents(join(byReplica, rid));
    if (evs.length) streams.push({ replicaId: rid, events: evs });
  }

  // Migration read-consistency (#12c): a `spine sync init` renames flat segments
  // into a partition. A readAll racing that rename can capture an event in BOTH the
  // flat-legacy ('') stream (read first) and its byte-identical partition copy. Drop
  // the flat copy when its id already lives in a REAL partition — but never collapse
  // partition-vs-partition ids (a rare probabilistic collision that is legitimately
  // two distinct events, kept by partition-position identity). No cost post-migration
  // (the flat stream is empty then).
  const flatStream = streams.find((s) => s.replicaId === '');
  if (flatStream && streams.some((s) => s.replicaId !== '')) {
    const partitionIds = new Set();
    for (const s of streams) if (s.replicaId !== '') for (const e of s.events) partitionIds.add(e.id);
    flatStream.events = flatStream.events.filter((e) => !partitionIds.has(e.id));
  }

  return kWayMergeStreams(streams);
}

// Append a pre-built event into THIS replica's partition, under the append funnel,
// with `prev_hash` computed INSIDE the lock so the read-then-write cannot fork.
// `ev` must be a complete envelope WITHOUT prev_hash; prev_hash is set here.
// Returns the same `ev` (now carrying prev_hash), matching spine.append()'s return.
// `maxWaitMs` bounds the funnel wait for best-effort callers (see acquireAppendLock);
// strict callers omit it (Infinity) so an event is never dropped.
export async function appendPartitioned(repoRoot, replicaId, ev, { maxWaitMs = Infinity } = {}) {
  if (!isValidReplicaId(replicaId)) {
    throw new Error(`appendPartitioned: invalid replicaId "${replicaId}"`);
  }
  const dir = partitionDir(repoRoot, replicaId);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, '.append.lock');
  return withAppendLock(
    lockPath,
    async () => {
      const prevLine = await lastEventLineInDir(dir);
      ev.prev_hash = prevLine === null ? null : hashLine(prevLine);
      const line = JSON.stringify(ev);
      if (line.includes('\n')) {
        throw new Error('spine-append-core: serialized event contains a raw newline — NDJSON framing invariant violated');
      }
      const seg = await currentSegmentInDir(dir);
      await appendFile(join(dir, seg), line + '\n', { flag: 'a' });
      return ev;
    },
    { onWait: onWaitStderr(dir), maxWaitMs }
  );
}
