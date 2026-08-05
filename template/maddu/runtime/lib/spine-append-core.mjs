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

// audit P1 — the framework version at/after which the flat append path is locked
// (appendFlatChained below). A chain the verifier sees carrying a
// FRAMEWORK_INSTALLED/UPGRADED at/after this version — or a SPINE_CUTOVER anchor —
// is held to strict tamper-FAIL rules. Homed here (with the lock) and imported by
// verify.mjs + spine-sync.mjs so the cutover version can never drift across them.
export const FLAT_LOCK_VERSION = '1.98.0';

// Canonical tamper-detection hash of a stored NDJSON line (trailing CR stripped so a
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

// ── Workspace identity (buzz-steals S2, v1.117.0) ───────────────────────────
// `ws` = the workspace's content-derived identity: `ws_` + 16 hex of the
// GENESIS line's sha256 (exact hashLine semantics — UTF-8 string, trailing CR
// stripped). Never minted, never random: flat mode derives it from the first
// stored line of the lowest segment (immutable in an append-only spine,
// retroactively identical for every existing workspace); sync mode resolves
// it from the in-band WS_IDENTITY_ANCHORED event (position+hash-pinned
// nomination — the merge-first line is NOT stable as partitions join, so the
// anchor freezes it; Codex plan-review r2-F1). Genesis/bootstrap lines are
// deliberately ws-less: an identity cannot be the hash of a line containing
// it (r3-F1).
//
// This section is stdlib-only and lives HERE (not spine.mjs) so the
// standalone token wrapper can stamp `ws` without breaking its import
// contract. `.maddu/events/identity.json` is a CACHE, never authority, never
// committed (worktree-identity.mjs durability discipline: atomic tmp+rename,
// exact read-back, three-state read failing toward "unverifiable, never
// foreign").

export const WS_ID_RE = /^ws_[a-f0-9]{16}$/;

export function wsFromLine(line) {
  return 'ws_' + hashLine(line).slice(0, 16);
}

export function identityCachePath(repoRoot) {
  // Safe filename: every segment enumerator filters /^\d{12}\.ndjson$/, and
  // both gitignore policies leave .maddu/events/* untracked.
  return join(repoRoot, '.maddu', 'events', 'identity.json');
}

// Three-state cache read: {state:'present', spineIdentity, conflict, mode, fp}
// | {state:'absent'} | {state:'unresolvable', error}. Malformed content is
// UNRESOLVABLE (never guessed, never treated as foreign). A CONFLICT cache is
// a first-class present state — {spineIdentity:null, conflict:true} — so the
// freeze survives the cache round-trip and appends refuse with the stable
// WS_IDENTITY_CONFLICT code, never a spurious "unresolvable" (diff-funnel
// r1-F1: an unresolvable conflict cache defeated the S1 drain's ceremony
// recovery exception).
export async function readIdentityCache(repoRoot) {
  let txt;
  try { txt = await readFile(identityCachePath(repoRoot), 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unresolvable', error: e?.message || String(e) };
  }
  try {
    const j = JSON.parse(txt);
    const mode = j?.mode === 'flat' || j?.mode === 'sync' ? j.mode : null;
    const fp = j?.fp && typeof j.fp === 'object' ? j.fp : null;
    if (j && j.conflict === true) {
      return { state: 'present', spineIdentity: null, conflict: true, mode, fp };
    }
    if (j && typeof j.spineIdentity === 'string' && WS_ID_RE.test(j.spineIdentity)) {
      return { state: 'present', spineIdentity: j.spineIdentity, conflict: false, mode, fp };
    }
    return { state: 'unresolvable', error: 'identity.json malformed (no valid spineIdentity)' };
  } catch { return { state: 'unresolvable', error: 'identity.json is not JSON' }; }
}

// Atomic cache write + exact read-back (a torn cache must never survive).
// `mode`/`fp` are the staleness guard (r1-F1): `fp` is the authority-relevant
// file fingerprint captured BEFORE the scan that produced this identity, so
// bytes that arrive during/after the scan always land in the next append's
// delta window (over-scan, never under-scan). Writers that resolve without a
// pre-scan fingerprint pass fp:null — the next append rescans once and
// converges.
export async function writeIdentityCache(repoRoot, { spineIdentity, conflict = false, mode = null, fp = null }) {
  if (!WS_ID_RE.test(String(spineIdentity || '')) && !conflict) {
    throw new Error(`writeIdentityCache: invalid spineIdentity ${JSON.stringify(spineIdentity)}`);
  }
  const p = identityCachePath(repoRoot);
  // Unique tmp per write: concurrent cachers sharing one tmp path race the
  // rename (the loser ENOENTs on a tmp the winner already renamed away).
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const body = JSON.stringify({ v: 1, spineIdentity: conflict ? null : spineIdentity, conflict, mode, fp }) + '\n';
  await mkdir(join(repoRoot, '.maddu', 'events'), { recursive: true });
  await writeFile(tmp, body);
  const { rename, rm } = await import('node:fs/promises');
  try { await rename(tmp, p); }
  catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
  const back = await readFile(p, 'utf8');
  if (back !== body) {
    // A concurrent writer may have won the last rename — that is a benign
    // race for a last-writer-wins cache. Only a TORN/invalid file is fatal.
    try {
      const j = JSON.parse(back);
      const valid = j?.conflict === true || (typeof j?.spineIdentity === 'string' && WS_ID_RE.test(j.spineIdentity));
      if (valid) return;
    } catch { /* fall through to throw */ }
    throw new Error('writeIdentityCache: read-back mismatch');
  }
}

// The authority-relevant file fingerprint: COMMITTED byte sizes of every
// numeric segment (flat + every partition). "Committed" = the offset just
// past the last complete (newline-terminated) line — a torn/in-flight tail
// write is deliberately NOT covered, so fingerprint boundaries are always
// line-aligned and a marker can never straddle two delta windows
// (diff-funnel r2-F1: raw stat sizes let `"WS_IDENTI` / `TY_ANCHORED"` split
// across consecutive deltas, hiding a completed anchor forever). Sizes,
// never mtimes (S1 lesson: rename preserves mtime). An entry of -1 means
// "could not determine" and always forces a rescan.
async function committedSizeOf(path, rawSize) {
  if (rawSize === 0) return 0;
  const window = Math.min(rawSize, 65536);
  let fh;
  try { fh = await open(path, 'r'); } catch { return -1; }
  try {
    const buf = Buffer.alloc(window);
    const { bytesRead } = await fh.read(buf, 0, window, rawSize - window);
    if (bytesRead !== window) return -1;
    const idx = buf.lastIndexOf(0x0a);
    if (idx === -1) return rawSize > window ? -1 : 0; // no newline: whole file is one unterminated line
    return rawSize - (window - idx - 1);
  } catch { return -1; } finally { await fh.close().catch(() => {}); }
}
// Entries are { raw, committed }. When a previous fingerprint is supplied and
// a segment's RAW stat size is unchanged, its committed size is reused
// without any read (diff-funnel r4-F3: the hot path is stats-only when
// nothing changed; only grown/new segments pay the bounded tail read).
export async function computeAuthorityFingerprint(repoRoot, prevFp = null) {
  const segs = {};
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const prev = prevFp?.segs || {};
  const addDir = async (dir, prefix) => {
    for (const s of await listSegmentsInDir(dir)) {
      const key = `${prefix}${s}`;
      const p = join(dir, s);
      let raw = -1;
      try { raw = (await stat(p)).size; } catch { /* raw stays -1 */ }
      const old = prev[key];
      if (raw >= 0 && old && typeof old === 'object' && old.raw === raw && Number.isInteger(old.committed) && old.committed >= 0) {
        segs[key] = { raw, committed: old.committed };
      } else {
        segs[key] = { raw, committed: raw < 0 ? -1 : await committedSizeOf(p, raw) };
      }
    }
  };
  await addDir(eventsDir, 'flat:');
  const byReplica = join(eventsDir, 'by-replica');
  let ids = [];
  try { ids = (await readdir(byReplica)).filter((d) => isValidReplicaId(d)); } catch {}
  for (const id of ids.sort()) await addDir(join(byReplica, id), `${id}/`);
  return { segs };
}

const fpCommitted = (entry) => (entry && typeof entry === 'object' && Number.isInteger(entry.committed) ? entry.committed : -1);

function fpEqual(a, b) {
  const ka = Object.keys(a?.segs || {}), kb = Object.keys(b?.segs || {});
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const ca = fpCommitted(a.segs[k]), cb = fpCommitted(b.segs[k]);
    if (ca < 0 || cb < 0) return false; // undeterminable (or legacy shape) never matches
    if (ca !== cb) return false;
  }
  return true;
}

// Delta freshness check for a clean sync-mode cache: read ONLY the complete
// lines that landed since the cached fingerprint and look for authority-event
// markers. Both boundaries are committed (line-aligned) offsets, so every
// delta holds whole lines — no overlap window needed, no straddled marker.
//   'fresh'  — no new committed bytes at all (fingerprint identical)
//   'clean'  — new lines exist but carry no authority event (cache still
//              valid; caller refreshes the stored fingerprint)
//   'rescan' — an authority event appeared in the delta, a segment shrank or
//              vanished (append-only violated — full rescan decides), a size
//              was undeterminable, or the delta could not be read exactly
async function authorityDeltaState(repoRoot, cachedFp, currentFp) {
  if (fpEqual(cachedFp, currentFp)) return 'fresh';
  const old = cachedFp?.segs || {};
  const eventsDir = join(repoRoot, '.maddu', 'events');
  for (const key of Object.keys(old)) {
    if (!(key in (currentFp.segs || {}))) return 'rescan'; // segment vanished
  }
  for (const [key, entry] of Object.entries(currentFp.segs || {})) {
    const size = fpCommitted(entry);
    const prev = key in old ? fpCommitted(old[key]) : 0;
    if (size === prev) continue;
    if (size < prev || prev < 0 || size < 0) return 'rescan';
    const rel = key.startsWith('flat:')
      ? join(eventsDir, key.slice(5))
      : join(eventsDir, 'by-replica', key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1));
    try {
      const fh = await open(rel, 'r');
      try {
        const buf = Buffer.alloc(size - prev);
        const { bytesRead } = await fh.read(buf, 0, buf.length, prev);
        if (bytesRead !== buf.length) return 'rescan'; // short read — never advance past unread bytes
        const chunk = buf.toString('utf8');
        if (!chunk.endsWith('\n')) return 'rescan'; // boundary not line-aligned after all — defensive
        // PARSE is authoritative (r6-F1: escaped type values evade the raw
        // marker). Any authority event OR unparseable line in the delta →
        // full rescan (which applies the strict scan's own rules).
        for (const dl of chunk.split('\n')) {
          if (!dl.trim()) continue;
          let dev;
          try { dev = JSON.parse(dl); } catch { return 'rescan'; }
          if (dev?.type === 'WS_IDENTITY_ANCHORED' || dev?.type === 'WS_IDENTITY_RESOLVED') return 'rescan';
        }
      } finally { await fh.close(); }
    } catch { return 'rescan'; }
  }
  return 'clean';
}

// Read-only cache freshness for callers that must never scan (the token
// wrapper — diff-funnel r2-F5): the same mode/fingerprint/delta law as the
// writer's fast path, with NO cache rewrite and NO authority scan.
//   {state:'fresh', ws} — provably-current clean cache, stamp this
//   {state:'conflict'}  — cached freeze, caller drops
//   {state:'unknown'}   — absent/unresolvable/mode-less/unprovable cache —
//                         treat as absent, emit ws-less
export async function readFreshCachedIdentity(repoRoot, { refresh = false } = {}) {
  let c;
  try { c = await readIdentityCache(repoRoot); } catch { return { state: 'unknown' }; }
  if (c.state !== 'present') return { state: 'unknown' };
  if (c.conflict) return { state: 'conflict' };
  if (c.mode === 'flat') {
    return (await wsModeIsPartitioned(repoRoot)) ? { state: 'unknown' } : { state: 'fresh', ws: c.spineIdentity };
  }
  if (c.mode === 'sync' && c.fp) {
    if (!(await wsModeIsPartitioned(repoRoot))) return { state: 'unknown' };
    const cur = await computeAuthorityFingerprint(repoRoot, c.fp);
    const d = await authorityDeltaState(repoRoot, c.fp, cur);
    if (d === 'fresh') return { state: 'fresh', ws: c.spineIdentity };
    if (d === 'clean') {
      // Advance the fingerprint past the clean growth (r4-F3: a wrapper-only
      // workload would otherwise re-read an ever-growing delta) —
      // last-writer-wins best-effort, never blocking.
      if (refresh) {
        await writeIdentityCache(repoRoot, { spineIdentity: c.spineIdentity, mode: 'sync', fp: cur }).catch(() => {});
      }
      return { state: 'fresh', ws: c.spineIdentity };
    }
  }
  return { state: 'unknown' };
}

// Mode predicate — pinned to VERIFIER reality (plan-review r2-F2): ANY
// numeric-segment-bearing partition under by-replica ⇒ partitioned mode,
// including fresh clones without replica.json and workspaces with residual
// flat data.
export async function wsModeIsPartitioned(repoRoot) {
  const byReplica = join(repoRoot, '.maddu', 'events', 'by-replica');
  let ids = [];
  try { ids = await readdir(byReplica); } catch { return false; }
  for (const id of ids) {
    if (!isValidReplicaId(id)) continue;
    if ((await listSegmentsInDir(join(byReplica, id))).length > 0) return true;
  }
  return false;
}

// STRICT flat-genesis read (one shared enumerator — plan-review r2-F2: the
// identity path never uses the malformed-line-discarding stream readers).
// Returns {state:'ok', line} | {state:'absent'} | {state:'unresolvable', error}.
export async function readFlatGenesisLine(repoRoot) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  let segs = [];
  try { segs = (await readdir(eventsDir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort(); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unresolvable', error: e?.message || String(e) };
  }
  if (!segs.length) return { state: 'absent' };
  try {
    const txt = await readFile(join(eventsDir, segs[0]), 'utf8');
    // COMMITTED elements only (diff-funnel r6-F2): an unterminated first
    // line is an in-flight write — deriving from its partial bytes would
    // cache a poisoned identity that permanently mismatches the real
    // genesis once the newline lands. Until a complete line exists the
    // workspace is still bootstrap.
    const lines = txt.split('\n');
    const committed = txt.endsWith('\n') ? lines.length : lines.length - 1;
    const line = lines.slice(0, committed).find((l) => l.trim());
    return line ? { state: 'ok', line } : { state: 'absent' };
  } catch (e) { return { state: 'unresolvable', error: e?.message || String(e) }; }
}

// Read one exact stored line by partition position (anchor nomination target
// / verify re-read). lineNo is 1-based within the named segment.
export async function readPartitionLineAt(repoRoot, replicaId, segment, lineNo) {
  if (!isValidReplicaId(replicaId) || !/^\d{12}\.ndjson$/.test(String(segment))) {
    return { state: 'unresolvable', error: 'invalid nomination position' };
  }
  try {
    const txt = await readFile(join(partitionDir(repoRoot, replicaId), segment), 'utf8');
    const lines = txt.split('\n');
    // COMMITTED elements only (diff-funnel r7-F2): a nominated/cutover
    // position must never resolve to an unterminated final element — a
    // valid-JSON line whose newline hasn't landed is not part of the
    // record, and validating an anchor/head against it would bless
    // uncommitted authority.
    const committed = txt.endsWith('\n') ? lines.length : lines.length - 1;
    if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > committed) return { state: 'absent' };
    const line = lines[lineNo - 1];
    return line && line.trim() ? { state: 'ok', line } : { state: 'absent' };
  } catch (e) {
    return e && e.code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'unresolvable', error: e?.message || String(e) };
  }
}

// The merge-first genesis candidate for anchor NOMINATION (writer-only, at
// anchor-publication time — verify never re-derives from the evolving
// partition set once an anchor exists). Only numeric by-replica positions
// are nominable (r3-F3: residual flat segments are not Git-carried by sync,
// so a peer could receive the anchor without its line). Deterministic:
// smallest (ts, replicaId) head among partition first-lines.
export async function findMergeFirstGenesis(repoRoot) {
  const byReplica = join(repoRoot, '.maddu', 'events', 'by-replica');
  let ids = [];
  try { ids = (await readdir(byReplica)).filter((d) => isValidReplicaId(d)); } catch { return { state: 'absent' }; }
  let best = null;
  for (const id of ids.sort()) {
    const segs = await listSegmentsInDir(join(byReplica, id));
    if (!segs.length) continue;
    let txt;
    try { txt = await readFile(join(byReplica, id, segs[0]), 'utf8'); }
    catch (e) { return { state: 'unresolvable', error: `partition ${id}: ${e?.message || e}` }; }
    // COMMITTED elements only (r6-F2): never nominate an in-flight
    // unterminated first line — its bytes are not yet part of the record.
    const allLines = txt.split('\n');
    const committedN = txt.endsWith('\n') ? allLines.length : allLines.length - 1;
    const line = allLines.slice(0, committedN).find((l) => l.trim());
    if (!line) continue;
    let ts = null;
    try { ts = JSON.parse(line)?.ts ?? null; } catch { return { state: 'unresolvable', error: `partition ${id}: malformed first line` }; }
    if (typeof ts !== 'string') return { state: 'unresolvable', error: `partition ${id}: first line has no ts` };
    if (!best || ts < best.ts || (ts === best.ts && id < best.replicaId)) {
      best = { replicaId: id, segment: segs[0], line: 1, text: line, ts };
    }
  }
  return best ? { state: 'ok', ...best } : { state: 'absent' };
}

// Verify an anchor's nomination: the referenced position must exist and hash
// to genesis.hash, and the derived ws must equal the anchored spineIdentity.
export async function verifyAnchorNomination(repoRoot, data) {
  const g = data?.genesis;
  if (!g || typeof g.replicaId !== 'string' || typeof g.segment !== 'string'
    || !Number.isInteger(g.line) || typeof g.hash !== 'string'
    || !WS_ID_RE.test(String(data?.spineIdentity || ''))) {
    return { ok: false, reason: 'malformed anchor' };
  }
  const r = await readPartitionLineAt(repoRoot, g.replicaId, g.segment, g.line);
  if (r.state !== 'ok') return { ok: false, reason: `nominated position ${r.state}${r.error ? `: ${r.error}` : ''}` };
  if (hashLine(r.line) !== g.hash) return { ok: false, reason: 'nominated line hash mismatch' };
  if (wsFromLine(r.line) !== data.spineIdentity) return { ok: false, reason: 'derived identity mismatch' };
  return { ok: true };
}

// Scan every stored line for the two ws-authority event types (bootstrap /
// conflict recheck only — never on the per-append hot path). Cheap substring
// prefilter before parse. STRICT / fail-closed (diff-funnel r2-F3: a
// swallowed EACCES or a torn marker-bearing line must never make an anchor
// silently disappear from the law): only ENOENT reads as "no segments"; any
// other directory/read error, and any marker-bearing line that fails to
// parse as a COMPLETE line, throws WS_SCAN_UNRESOLVABLE. A torn tail WITHOUT
// the marker is skipped — it is not yet part of the record (no newline), and
// the committed-size fingerprint law guarantees it gets re-read whole once
// terminated.
export async function scanWsAuthorityEvents(repoRoot) {
  const anchors = [], resolutions = [];
  const scanUnresolvable = (where, detail) =>
    Object.assign(new Error(`ws scan: ${where}: ${detail}`), { code: 'WS_SCAN_UNRESOLVABLE' });
  const strictSegs = async (dir, source) => {
    let names;
    try { names = await readdir(dir); }
    catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw scanUnresolvable(source, e?.message || String(e));
    }
    return names.filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  };
  const scanDir = async (dir, source) => {
    for (const seg of await strictSegs(dir, source)) {
      let txt;
      try { txt = await readFile(join(dir, seg), 'utf8'); }
      catch (e) { throw scanUnresolvable(`${source}/${seg}`, e?.message || String(e)); }
      const lines = txt.split('\n');
      // An UNTERMINATED final element is an in-flight write and is not yet
      // part of the record — excluded BEFORE parsing (diff-funnel r3-F1: a
      // complete-looking anchor body that merely lacks its trailing newline
      // parses fine, but adopting it would let a writer stamp from
      // authority the committed-size law deliberately excludes).
      const committed = txt.endsWith('\n') ? lines.length : lines.length - 1;
      for (let i = 0; i < committed; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        // PARSE is authoritative (diff-funnel r6-F1: a substring prefilter
        // can be evaded with JSON escapes — `"WS_IDENTITY_ANCHORED"`
        // parses to the authority type while the raw bytes never contain
        // the marker). The marker substring is used ONLY to classify an
        // unparseable complete line: marker-bearing garbage is corrupt
        // authority state → unresolvable; other garbage is the chain
        // verifier's domain.
        let ev;
        try { ev = JSON.parse(line); }
        catch {
          if (line.includes('"WS_IDENTITY_')) {
            throw scanUnresolvable(`${source}/${seg}`, `malformed authority-candidate line ${i + 1}`);
          }
          continue;
        }
        if (ev?.type === 'WS_IDENTITY_ANCHORED') anchors.push(ev);
        else if (ev?.type === 'WS_IDENTITY_RESOLVED') resolutions.push(ev);
      }
    }
  };
  await scanDir(join(repoRoot, '.maddu', 'events'), 'flat');
  const byReplica = join(repoRoot, '.maddu', 'events', 'by-replica');
  let ids = [];
  try { ids = (await readdir(byReplica)).filter((d) => isValidReplicaId(d)); }
  catch (e) {
    if (!(e && e.code === 'ENOENT')) throw scanUnresolvable('by-replica', e?.message || String(e));
  }
  for (const id of ids.sort()) await scanDir(join(byReplica, id), id);
  return { anchors, resolutions };
}

// Pure authority law shared by writers and verify (r1-F3: ONE authority,
// outside any per-partition scan):
//   no anchors → { authority: flatWs ?? null }
//   anchors agreeing → { authority }
//   conflicting anchors + a resolution binding ALL of them selecting an
//   EXISTING identity → { authority: selected }
//   else → { conflict: true, identities }
export function validWsResolutions(anchors, resolutions) {
  const ids = [...new Set(anchors.map((a) => a?.data?.spineIdentity).filter((x) => WS_ID_RE.test(String(x || ''))))];
  return resolutions.filter((r) => {
    const sel = r?.data?.selected;
    return WS_ID_RE.test(String(sel || '')) && ids.includes(sel)
      && validateResolutionBinding(anchors, r?.data).ok;
  });
}

export function resolveWsAuthority({ anchors = [], resolutions = [], flatWs = null } = {}) {
  const ids = [...new Set(anchors.map((a) => a?.data?.spineIdentity).filter((x) => WS_ID_RE.test(String(x || ''))))];
  if (ids.length === 0) return { authority: flatWs };
  if (ids.length === 1) return { authority: ids[0] };
  const valid = validWsResolutions(anchors, resolutions);
  const selections = [...new Set(valid.map((r) => r.data.selected))];
  if (selections.length === 1) return { authority: selections[0], resolved: true };
  return { conflict: true, identities: ids };
}

// ── The resolution GRANDFATHER law (diff-funnel r4-F1) ──────────────────────
// A realistic conflict has WORK stamped with both identities before anyone
// notices (each offline first-writer stamped its triggering append). The
// ceremony is forward-only in an append-only spine — the losing stamps can
// never be rewritten — so WS_IDENTITY_RESOLVED binds a forward CUTOVER: the
// exact per-partition chain heads at ceremony time
// (`data.cutover: [{replicaId, segment, line, hash}]`, recorded atomically
// under the funnel lock by appendWsResolutionOnce). Verify and the
// history-compatibility law then tolerate a LOSING identity (bound by the
// resolution, ≠ selected) only at-or-before its partition's bound head;
// everything after the cutover must carry `selected` (or be ws-less legacy).
// A partition with no cutover entry had no events at ceremony time — losing
// stamps there are post-ceremony and stay red.
export function buildWsGrandfather(anchors, resolutions) {
  const valid = validWsResolutions(anchors, resolutions);
  const losing = new Set();
  const cutovers = []; // one map per valid resolution — ANY tolerating map grandfathers
  for (const r of valid) {
    const sel = r.data.selected;
    for (const c of Array.isArray(r.data.conflicts) ? r.data.conflicts : []) {
      if (WS_ID_RE.test(String(c?.spineIdentity || '')) && c.spineIdentity !== sel) losing.add(c.spineIdentity);
    }
    const map = new Map();
    for (const h of Array.isArray(r.data.cutover) ? r.data.cutover : []) {
      if (h && typeof h.replicaId === 'string' && typeof h.segment === 'string' && Number.isInteger(h.line)) {
        map.set(h.replicaId, { segment: h.segment, line: h.line });
      }
    }
    cutovers.push(map);
  }
  return { losing, cutovers };
}

// Is a `ws` stamp at (replicaId, segment, lineNo) tolerated by the
// grandfather law? (Pure position check — head-hash validation is verify's
// job.)
export function wsStampGrandfathered(grandfather, ws, replicaId, segment, lineNo) {
  if (!grandfather || !grandfather.losing.has(ws)) return false;
  for (const map of grandfather.cutovers) {
    const head = map.get(replicaId);
    if (head && (segment < head.segment || (segment === head.segment && lineNo <= head.line))) return true;
  }
  return false;
}

// The canonical binding a resolution must carry: EVERY conflicting anchor as
// an exact {eventId, genesisHash, spineIdentity} tuple, in canonical order
// (eventId, genesisHash, spineIdentity — plan-review r6 advisory 4:
// cross-partition duplicate eventIds are tolerated by design, the full tuple
// disambiguates them). Byte-wise comparison, never a locale collation.
const tupleCmp = (x, y) => (x.eventId < y.eventId ? -1 : x.eventId > y.eventId ? 1
  : x.genesisHash < y.genesisHash ? -1 : x.genesisHash > y.genesisHash ? 1
    : x.spineIdentity < y.spineIdentity ? -1 : x.spineIdentity > y.spineIdentity ? 1 : 0);
export function canonicalAnchorConflicts(anchors) {
  return anchors.map((a) => ({
    eventId: String(a?.id ?? ''),
    genesisHash: String(a?.data?.genesis?.hash ?? ''),
    spineIdentity: String(a?.data?.spineIdentity ?? ''),
  })).sort(tupleCmp);
}

// Strict binding law (diff-funnel r1-F2: an event-ID-only subset check let a
// hash-unbound or forged binding resolve a conflict). The stored `conflicts`
// array must DEEP-EQUAL the canonical anchor tuple list — same length, exact
// tuples, canonical order; duplicates included, extras rejected.
export function validateResolutionBinding(anchors, data) {
  const want = canonicalAnchorConflicts(anchors);
  const got = Array.isArray(data?.conflicts) ? data.conflicts : null;
  if (!got || got.length !== want.length) {
    return { ok: false, reason: `binding must cover the ${want.length} conflicting anchor(s) exactly (got ${got ? got.length : 'no'} row(s))` };
  }
  for (let i = 0; i < want.length; i++) {
    const g = got[i];
    if (!g || typeof g !== 'object'
      || g.eventId !== want[i].eventId
      || g.genesisHash !== want[i].genesisHash
      || g.spineIdentity !== want[i].spineIdentity) {
      return { ok: false, reason: `binding row ${i} does not match the canonical anchor set (exact {eventId, genesisHash, spineIdentity} tuples in canonical order required)` };
    }
  }
  return { ok: true };
}

// Writer-side identity resolution (r1-F2: WRITER-ONLY — reads never call
// this; verify uses the read-only pieces above). Fast path is the cache; the
// scan runs only at bootstrap or while a conflict is cached. Returns:
//   { ws }                       — stamp this
//   { ws: null, bootstrap: true }— fresh flat spine, first line is ws-less
//   { needAnchor: {spineIdentity, genesis} } — sync mode, caller publishes
//     WS_IDENTITY_ANCHORED (ws-less) then stamps spineIdentity
//   { refuse: reason }           — residual flat present (r3-F3) or
//     unresolvable genesis with identity at stake (r2-F2)
//   { conflict: identities }     — only WS_IDENTITY_RESOLVED may append
export async function resolveIdentityForAppend(repoRoot) {
  const cache = await readIdentityCache(repoRoot);
  const partitioned = await wsModeIsPartitioned(repoRoot);
  // Cache discipline (diff-funnel r1-F1): the cache is NEVER authority.
  //   unresolvable → DISCARD and re-resolve (a corrupt cache must not block
  //     writes — that would promote it to authority);
  //   clean flat cache → trust only while the mode is still flat (the flat
  //     genesis is immutable in an append-only spine);
  //   clean sync cache → trust only when the authority fingerprint proves no
  //     unscanned bytes exist; a byte-growth delta free of authority events
  //     refreshes the fingerprint; anything else rescans;
  //   conflict cache → NEVER a fast path: rescan (a pulled resolution must be
  //     able to thaw the freeze), and refuse via the law below if still
  //     conflicted.
  if (cache.state === 'unresolvable') {
    const { rm } = await import('node:fs/promises');
    await rm(identityCachePath(repoRoot), { force: true }).catch(() => {});
  } else if (cache.state === 'present' && !cache.conflict) {
    if (cache.mode === 'flat' && !partitioned) return { ws: cache.spineIdentity };
    if (cache.mode === 'sync' && partitioned && cache.fp) {
      const currentFp = await computeAuthorityFingerprint(repoRoot, cache.fp); // stat-reuse fast path (r5-F2)
      const delta = await authorityDeltaState(repoRoot, cache.fp, currentFp);
      if (delta === 'fresh') return { ws: cache.spineIdentity };
      if (delta === 'clean') {
        await writeIdentityCache(repoRoot, { spineIdentity: cache.spineIdentity, mode: 'sync', fp: currentFp }).catch(() => {});
        return { ws: cache.spineIdentity };
      }
    }
    // stale mode, missing fingerprint, or a rescan-worthy delta → fall through
  }

  if (!partitioned) {
    const g = await readFlatGenesisLine(repoRoot);
    if (g.state === 'absent') return { ws: null, bootstrap: true };
    if (g.state === 'unresolvable') return { refuse: `flat genesis unresolvable: ${g.error}` };
    const ws = wsFromLine(g.line);
    await writeIdentityCache(repoRoot, { spineIdentity: ws, mode: 'flat' }).catch(() => {}); // cache is never authority — a write failure must not block the append
    return { ws };
  }

  // Sync mode: anchors are the authority. Fingerprint BEFORE the scan so any
  // byte that lands during it stays inside the next append's delta window.
  const fpBefore = await computeAuthorityFingerprint(repoRoot, cache.state === 'present' ? cache.fp : null);
  let scan;
  try { scan = await scanWsAuthorityEvents(repoRoot); }
  catch (e) { return { refuse: e?.message || String(e) }; }
  const law = resolveWsAuthority(scan);
  if (law.conflict) {
    await writeIdentityCache(repoRoot, { spineIdentity: null, conflict: true, mode: 'sync' }).catch(() => {});
    return { conflict: law.identities };
  }
  if (law.authority) {
    // History-compatibility on ADOPTION (diff-funnel r4-F2): a scan that
    // transitions to an authority must not start stamping an identity that
    // instantly FAILs already-stamped history — losing pre-cutover stamps
    // bound by a valid resolution are grandfathered, anything else refuses.
    const bad = await findIncompatibleWsStamp(repoRoot, law.authority, buildWsGrandfather(scan.anchors, scan.resolutions));
    if (bad) {
      return { refuse: `existing event ${bad.id} is stamped ${bad.ws}, incompatible with the workspace authority ${law.authority} — resolve the histories before S2 writes` };
    }
    await writeIdentityCache(repoRoot, { spineIdentity: law.authority, mode: 'sync', fp: fpBefore }).catch(() => {});
    return { ws: law.authority };
  }
  // No anchor yet — this writer publishes it. Residual flat data blocks
  // nomination (finish the migration first; r3-F3).
  const flatResidual = await readFlatGenesisLine(repoRoot);
  if (flatResidual.state === 'ok') return { refuse: 'residual flat segments present — finish `spine sync init` migration before S2 writes' };
  if (flatResidual.state === 'unresolvable') return { refuse: `residual flat unresolvable: ${flatResidual.error}` };
  const mf = await findMergeFirstGenesis(repoRoot);
  if (mf.state === 'absent') return { ws: null, bootstrap: true }; // empty partition — bootstrap lines are ws-less
  if (mf.state === 'unresolvable') return { refuse: `merge-first genesis unresolvable: ${mf.error}` };
  return {
    needAnchor: {
      spineIdentity: wsFromLine(mf.text),
      genesis: { replicaId: mf.replicaId, segment: mf.segment, line: mf.line, hash: hashLine(mf.text) },
    },
  };
}

// Sweep every stored line for a ws stamp INCOMPATIBLE with `authority` —
// adoption/publication-time only (never on the hot path). A differing stamp
// is tolerated only when the grandfather law covers it (a LOSING identity
// bound by a valid resolution, at-or-before its partition's cutover head —
// diff-funnel r4-F1/F2). Returns {id, ws} of the first offender or null.
// Torn tails are skipped exactly like the authority scan (not yet part of
// the record); malformed complete lines are the chain verifier's domain,
// not the identity law's.
export async function findIncompatibleWsStamp(repoRoot, authority, grandfather = null) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const sweepDir = async (dir, replicaId) => {
    let names = [];
    try { names = (await readdir(dir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort(); }
    catch { return null; }
    for (const seg of names) {
      let txt;
      try { txt = await readFile(join(dir, seg), 'utf8'); } catch { continue; }
      const lines = txt.split('\n');
      const committed = txt.endsWith('\n') ? lines.length : lines.length - 1;
      for (let i = 0; i < committed; i++) {
        if (!lines[i].trim()) continue;
        // PARSE is authoritative (r6-F1: an escaped `ws` key evades any raw
        // substring check); unparseable complete lines are the chain
        // verifier's domain.
        let ev;
        try { ev = JSON.parse(lines[i]); } catch { continue; }
        if (!ev || typeof ev.ws !== 'string' || !WS_ID_RE.test(ev.ws) || ev.ws === authority) continue;
        if (wsStampGrandfathered(grandfather, ev.ws, replicaId, seg, i + 1)) continue;
        return { id: ev.id ?? null, ws: ev.ws };
      }
    }
    return null;
  };
  const flatHit = await sweepDir(eventsDir, ''); // flat has no cutover entries — losing stamps there stay incompatible
  if (flatHit) return flatHit;
  const byReplica = join(eventsDir, 'by-replica');
  let ids = [];
  try { ids = (await readdir(byReplica)).filter((d) => isValidReplicaId(d)); } catch {}
  for (const id of ids.sort()) {
    const hit = await sweepDir(join(byReplica, id), id);
    if (hit) return hit;
  }
  return null;
}

// Publish the one-time WS_IDENTITY_ANCHORED — serialized AND idempotent
// (diff-funnel r1 follow-up: concurrent first S2 writers each resolving
// `needAnchor` must not publish duplicate anchors — worse, ones nominating
// different merge-first candidates, manufacturing a conflict out of thin
// air). Under the partition's append lock we re-run the authority law: an
// anchor that landed while we waited is ADOPTED; a conflict freezes; only a
// still-anchorless workspace nominates and appends — inline, because
// appendPartitioned is not reentrant (we hold its lock).
// `buildEv` receives the merge-first nomination and returns the ws-less
// anchor event (id/ts minted by the caller — this module has no id
// generator).
export async function publishWsAnchorOnce(repoRoot, replicaId, buildEv) {
  if (!isValidReplicaId(replicaId)) return { unresolvable: `invalid replicaId "${replicaId}"` };
  const dir = partitionDir(repoRoot, replicaId);
  await mkdir(dir, { recursive: true });
  return withAppendLock(join(dir, '.append.lock'), async () => {
    let scan;
    try { scan = await scanWsAuthorityEvents(repoRoot); }
    catch (e) { return { unresolvable: e?.message || String(e) }; }
    const law = resolveWsAuthority(scan);
    if (law.conflict) return { conflict: law.identities };
    if (law.authority) {
      // Adoption applies the SAME history-compatibility law as publication
      // (diff-funnel r4-F2: adopting a peer anchor over an anchorless
      // workspace's already-stamped history is exactly as corrupting as
      // publishing one).
      const badAdopt = await findIncompatibleWsStamp(repoRoot, law.authority, buildWsGrandfather(scan.anchors, scan.resolutions));
      if (badAdopt) {
        return { unresolvable: `existing event ${badAdopt.id} is stamped ${badAdopt.ws}, incompatible with the anchored authority ${law.authority} — resolve the histories before S2 writes` };
      }
      return { adopted: law.authority };
    }
    const mf = await findMergeFirstGenesis(repoRoot);
    if (mf.state === 'absent') return { bootstrap: true }; // empty partition — the caller's event IS the genesis
    if (mf.state === 'unresolvable') return { unresolvable: mf.error };
    const proposed = wsFromLine(mf.text);
    // History-compatibility sweep (diff-funnel r3-F4): an anchor is
    // IRREVERSIBLE (append-only) — publishing one whose identity contradicts
    // events already ws-stamped in this workspace (e.g. S2-stamped flat
    // history migrated into an anchorless older sync workspace whose peer
    // genesis sorts merge-first) would make verify FAIL ws_mismatch on the
    // entire migrated history the moment it lands. Refuse instead. (No
    // anchors exist here, so no resolutions can be valid — the grandfather
    // is empty by construction.)
    const foreign = await findIncompatibleWsStamp(repoRoot, proposed, null);
    if (foreign) {
      return { unresolvable: `existing event ${foreign.id} is stamped ${foreign.ws} but the merge-first nomination derives ${proposed} — resolve the histories before anchoring (an anchor is irreversible)` };
    }
    const ev = buildEv({
      spineIdentity: proposed,
      genesis: { replicaId: mf.replicaId, segment: mf.segment, line: mf.line, hash: hashLine(mf.text) },
    });
    const prevLine = await lastEventLineInDir(dir);
    ev.prev_hash = prevLine === null ? null : hashLine(prevLine);
    const line = JSON.stringify(ev);
    if (line.includes('\n')) throw new Error('publishWsAnchorOnce: serialized event contains a raw newline');
    const seg = await currentSegmentInDir(dir);
    await appendFile(join(dir, seg), line + '\n', { flag: 'a' });
    return { published: ev, ws: wsFromLine(mf.text) };
  });
}

// Append a WS_IDENTITY_RESOLVED ceremony event ATOMICALLY: fresh scan,
// conflict check, binding validation, idempotency, and the inline append all
// happen under the active write funnel's lock (diff-funnel r2-F4: validating
// outside the lock let two concurrent ceremonies both pass and append
// duplicate — or worse, conflicting — resolutions). Outcomes:
//   { ev }               — appended (ev carries prev_hash)
//   { already: ws|null } — no unresolved conflict exists (a raced ceremony
//                          won, or nothing was conflicted) — nothing appended
//   { invalid: reason }  — the binding/selection fails the law — refused
//   { retry: true }      — the write funnel moved under us (migration) —
//                          re-resolve and call again
// Throws WS_SCAN_UNRESOLVABLE from the strict scan.
// The exact per-partition chain heads RIGHT NOW — the cutover a resolution
// (or extension) binds. Caller must hold the funnel lock that fences writes.
async function collectPartitionHeadsLocked(repoRoot) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const cutover = [];
  const byReplica = join(eventsDir, 'by-replica');
  let rids = [];
  try { rids = (await readdir(byReplica)).filter((d) => isValidReplicaId(d)); } catch {}
  for (const rid of rids.sort()) {
    const pdir = partitionDir(repoRoot, rid);
    let segsIn = [];
    try { segsIn = (await readdir(pdir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort(); } catch { continue; }
    let head = null;
    for (let si = segsIn.length - 1; si >= 0 && !head; si--) {
      let txt = '';
      try { txt = await readFile(join(pdir, segsIn[si]), 'utf8'); } catch { continue; }
      const lines = txt.split('\n');
      const committed = txt.endsWith('\n') ? lines.length : lines.length - 1;
      for (let li = committed - 1; li >= 0; li--) {
        if (lines[li].trim()) { head = { replicaId: rid, segment: segsIn[si], line: li + 1, hash: hashLine(lines[li]) }; break; }
      }
    }
    if (head) cutover.push(head);
  }
  return cutover;
}

// Inline chained append into `dir` — caller MUST hold dir's append lock.
async function appendLineLocked(dir, ev, site) {
  const prevLine = await lastEventLineInDir(dir);
  ev.prev_hash = prevLine === null ? null : hashLine(prevLine);
  const line = JSON.stringify(ev);
  if (line.includes('\n')) throw new Error(`${site}: serialized event contains a raw newline`);
  const seg = await currentSegmentInDir(dir);
  await appendFile(join(dir, seg), line + '\n', { flag: 'a' });
  return ev;
}

export async function appendWsResolutionOnce(repoRoot, ev) {
  const w = await resolveWriteReplica(repoRoot);
  if (w.pending) return { retry: true };
  if (w.unattached) return { invalid: 'this checkout has sync partitions but no replica identity — run `maddu spine sync init` first' };
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const dir = w.id ? partitionDir(repoRoot, w.id) : eventsDir;
  await mkdir(dir, { recursive: true });
  return withAppendLock(join(dir, '.append.lock'), async () => {
    if (!w.id) {
      // Flat funnel: a migration may have committed while we waited — never
      // strand the ceremony in an orphaned flat segment.
      const w2 = await resolveWriteReplica(repoRoot, { timeoutMs: 0 });
      if (w2.id || w2.pending || w2.unattached) return { retry: true };
    }
    const scan = await scanWsAuthorityEvents(repoRoot);
    const law = resolveWsAuthority(scan);
    if (!law.conflict) {
      // Cutover EXTENSION (diff-funnel r15-F1): a checkout that appended
      // losing-stamped work OFFLINE — before it learned of the resolution —
      // holds legitimate events beyond the bound heads. A SAME-selection
      // re-ceremony is then not "already resolved": it appends a further
      // resolution with FRESH heads, widening the grandfather union to cover
      // the pre-adoption work. Anything else (different selection, no
      // uncovered stamps, single-anchor authority) stays {already}.
      const uncovered = law.resolved && law.authority && law.authority === ev?.data?.selected
        ? await findIncompatibleWsStamp(repoRoot, law.authority, buildWsGrandfather(scan.anchors, scan.resolutions))
        : null;
      if (!uncovered) return { already: law.authority ?? null };
      const binding = validateResolutionBinding(scan.anchors, ev.data);
      if (!binding.ok) return { invalid: binding.reason };
      ev.data = { ...ev.data, cutover: await collectPartitionHeadsLocked(repoRoot) };
      return { ev: await appendLineLocked(dir, ev, 'appendWsResolutionOnce'), extended: true };
    }
    if (!law.identities.includes(ev?.data?.selected)) {
      return { invalid: `selected ${JSON.stringify(ev?.data?.selected)} is not among the conflicting identities (${law.identities.join(', ')})` };
    }
    const binding = validateResolutionBinding(scan.anchors, ev.data);
    if (!binding.ok) return { invalid: binding.reason };
    // Bind the forward CUTOVER (diff-funnel r4-F1): the exact per-partition
    // chain heads at ceremony time, recorded atomically under this lock. The
    // grandfather law tolerates LOSING-identity stamps at-or-before these
    // heads — the only way a both-sides-stamped conflict can ever resolve in
    // an append-only spine.
    ev.data = { ...ev.data, cutover: await collectPartitionHeadsLocked(repoRoot) };
    return { ev: await appendLineLocked(dir, ev, 'appendWsResolutionOnce') };
  });
}

// Cutover-extension check for callers ALREADY HOLDING the active funnel lock
// (syncGit's post-pull step — diff-funnel r15-F1): when the pulled resolution's
// heads predate this checkout's pre-adoption offline work, append a
// same-selection extension with fresh heads so the work is grandfathered
// BEFORE it is shared. `buildEv(selected, conflicts)` mints the envelope (this
// module has no id generator). Returns { extended: false } when the
// grandfather already covers everything (or no resolved authority exists).
export async function maybeExtendWsCutoverLocked(repoRoot, dir, buildEv) {
  let scan;
  try { scan = await scanWsAuthorityEvents(repoRoot); }
  catch (e) { return { unresolvable: e?.message || String(e) }; }
  const law = resolveWsAuthority(scan);
  if (law.conflict || !law.resolved || !law.authority) return { extended: false };
  const gf = buildWsGrandfather(scan.anchors, scan.resolutions);
  const uncovered = await findIncompatibleWsStamp(repoRoot, law.authority, gf);
  if (!uncovered) return { extended: false };
  const ev = buildEv(law.authority, canonicalAnchorConflicts(scan.anchors));
  ev.data = { ...ev.data, cutover: await collectPartitionHeadsLocked(repoRoot) };
  await appendLineLocked(dir, ev, 'maybeExtendWsCutoverLocked');
  await writeIdentityCache(repoRoot, { spineIdentity: law.authority, mode: 'sync' }).catch(() => {});
  return { extended: true, ev };
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
  if (!(await pendingReplicaExists(repoRoot))) {
    // { unattached } — segment-bearing partitions exist but this checkout has
    // no replica identity (a fresh clone of a synced repo, or a deleted
    // replica.json). Flat writes here are never Git-carried and silently
    // diverge from the team's record, so EVERY write path refuses/drops
    // centrally (diff-funnel r7-F1: a needAnchor-only guard let ordinary
    // appends, ceremonies, and wrapper events through). Reads are untouched.
    if (await wsModeIsPartitioned(repoRoot)) return { unattached: true };
    return { flat: true };
  }
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
    let tailText = null;
    try {
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, st.size - readLen);
      tailText = buf.toString('utf8');
    } finally { await fh.close(); }
    // Refuse a torn active tail (diff-funnel r8-F1): under the append lock
    // no concurrent writer can be mid-append, so a nonempty file that does
    // not end in '\n' is a crashed write. Hashing/chaining onto that
    // uncommitted line — and then possibly rolling segments past it — would
    // bury it as an interior "committed" event the identity law excludes.
    // Permanent until the operator repairs it (append the missing newline
    // if the JSON is complete, else trim the partial line).
    if (!tailText.endsWith('\n')) {
      const err = new Error(`spine append: segment ${segs[i]} ends with an unterminated line (a crashed write) — repair it before appending: append the missing newline if the JSON is complete, otherwise trim the partial line, then re-run \`maddu spine verify\``);
      err.code = 'TORN_TAIL';
      throw err;
    }
    const lines = tailText.split('\n').filter((l) => l.trim());
    if (lines.length) return lines[lines.length - 1];
    // Pathological single line > 64 KB — full read fallback.
    const full = await readFile(p, 'utf8');
    const fullLines = full.split('\n').filter((l) => l.trim());
    if (fullLines.length) return fullLines[fullLines.length - 1];
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

// Shared segment enumeration + parse for ONE stream dir. Returns the ordered event
// array (seq = segment index + line position) AND a strict `parseErrors` count (a
// torn/unreadable segment or a non-JSON line). The tolerant and strict readers
// BOTH go through here so their segment enumeration and parse rules can never
// drift (PR-D r3-b): the tolerant caller ignores `parseErrors` and logs each bad
// line; the strict caller uses `parseErrors` to refuse auto-recovery on any doubt.
async function parseStreamDir(dir, { onBadLine = null } = {}) {
  // Diff-r3 #3: distinguish a genuinely-absent stream (ENOENT → 0 errors, an empty
  // stream) from an ENUMERATION FAILURE (EACCES/EIO/… → 1 parse error). The tolerant
  // listSegmentsInDir swallows every error to [], which would let strict callers
  // report parseErrors:0 for an UNREADABLE partition and treat it as fully accounted.
  let segs;
  try {
    const files = await readdir(dir);
    segs = files.filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  } catch (e) {
    if (e && e.code === 'ENOENT') return { events: [], parseErrors: 0 };
    return { events: [], parseErrors: 1 };
  }
  const out = [];
  let parseErrors = 0;
  for (const seg of segs) {
    let text;
    try { text = await readFile(join(dir, seg), 'utf8'); }
    catch { parseErrors++; continue; } // an unreadable segment is an accounting gap
    const lines = text.split('\n');
    // Committed elements only (diff-funnel r8-F1): a nonempty unterminated
    // final element is not part of the record even when it parses — reads
    // must agree with the writers and the verifier about what exists. It
    // still COUNTS as a parse error (r9-F1): strict callers must see the
    // accounting gap, never treat a torn stream as fully accounted.
    const committed = text.endsWith('\n') ? lines.length : lines.length - 1;
    if (committed < lines.length && lines[committed].trim()) {
      parseErrors++;
      if (onBadLine) onBadLine(seg, new Error('unterminated final element (torn tail — not part of the committed record)'));
    }
    for (let i = 0; i < committed; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); }
      catch (err) { parseErrors++; if (onBadLine) onBadLine(seg, err); }
    }
  }
  return { events: out, parseErrors };
}

// Tolerant read (seq order), mirrors spine.mjs#readAll's bad-line tolerance so a
// torn line never aborts the whole read. Delegates to parseStreamDir.
async function readStreamEvents(dir) {
  const { events } = await parseStreamDir(dir, {
    onBadLine: (seg, err) => console.error(`spine: bad line in ${seg}:`, err.message),
  });
  return events;
}

// STRICT provenance read (PR-D §3.3): every stream — the flat sentinel ('' — kept
// even when empty so its parse status is knowable during migration) and each
// by-replica partition — as { replicaId, events, parseErrors }, WITHOUT merging
// (source provenance is exactly what recovery needs; readAllPartitioned discards
// it). No tolerance: a caller decides what a nonzero parseErrors means (recovery
// treats it as "cannot strict-account this partition → no auto").
export async function readPartitionStreamsStrict(repoRoot) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  const streams = [];
  const flat = await parseStreamDir(eventsDir);
  streams.push({ replicaId: '', events: flat.events, parseErrors: flat.parseErrors });
  const byReplica = join(eventsDir, 'by-replica');
  let dirs = [];
  try {
    dirs = (await readdir(byReplica, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    // Diff-r5 #3: only ENOENT means "no partitions". An EACCES/EIO enumeration
    // failure could HIDE partitions — inject a strict-accounting error so a strict
    // caller (recovery) fails closed (allStreamsStrict === false) instead of
    // treating an unreadable sync repo as flat.
    if (!e || e.code !== 'ENOENT') {
      streams.push({ replicaId: '\u0000by-replica-unreadable', events: [], parseErrors: 1 });
    }
  }
  for (const rid of dirs) {
    const s = await parseStreamDir(join(byReplica, rid));
    streams.push({ replicaId: rid, events: s.events, parseErrors: s.parseErrors });
  }
  return streams;
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
// Preflight EVERY ws-bearing write at the primitive layer (plan-review r6
// advisory 3 / diff-funnel r1-F1: a gate only in spine.append misses the
// wrapper's direct primitive calls). Cheap cache-only check — the cache is
// not authority, so absent/unresolvable tolerates (spine.append resolves
// before stamping; the wrapper only stamps FROM the cache) — but a cached
// conflict must freeze and a cached different identity must refuse. ws-less
// events (bootstrap/anchor/resolution/legacy) skip by definition.
async function preflightWsStamp(repoRoot, ev, site) {
  if (typeof ev?.ws !== 'string') return;
  if (!WS_ID_RE.test(ev.ws)) {
    const err = new Error(`${site}: malformed ws stamp ${JSON.stringify(ev.ws)}`);
    err.code = 'WS_IDENTITY_MISMATCH';
    throw err;
  }
  const c = await readIdentityCache(repoRoot);
  if (c.state !== 'present') return;
  if (c.conflict) {
    const err = new Error(`${site}: workspace identity is conflict-frozen — run \`maddu spine identity resolve --keep <ws_...>\``);
    err.code = 'WS_IDENTITY_CONFLICT';
    throw err;
  }
  if (c.spineIdentity !== ev.ws) {
    const err = new Error(`${site}: ws stamp ${ev.ws} ≠ cached workspace identity ${c.spineIdentity}`);
    err.code = 'WS_IDENTITY_MISMATCH';
    throw err;
  }
}

// The FINAL ws gate, run INSIDE the append lock (diff-funnel r11-F1): a
// writer that resolved and stamped identity A before the lock can otherwise
// append AFTER a ceremony that — under this same lock — selected B and
// recorded its cutover, landing a post-cutover losing stamp that no
// grandfather tolerates and no further ceremony can heal. Re-resolution here
// is fingerprint-fast when nothing changed (cache read + stats) and rescans
// exactly when authority bytes moved. The pre-lock cache preflight above
// stays as the cheap early refusal — it is never the final word.
async function assertWsStampCurrent(repoRoot, ev, site) {
  if (typeof ev?.ws !== 'string') return;
  const idr = await resolveIdentityForAppend(repoRoot);
  if (idr.conflict) {
    const err = new Error(`${site}: workspace identity became conflict-frozen — run \`maddu spine identity resolve --keep <ws_...>\``);
    err.code = 'WS_IDENTITY_CONFLICT';
    throw err;
  }
  if (!idr.ws || idr.ws !== ev.ws) {
    const err = new Error(`${site}: ws stamp ${ev.ws} is stale — the workspace authority is now ${idr.ws ?? (idr.refuse ? `unresolvable (${idr.refuse})` : 'unresolved')}`);
    err.code = 'WS_IDENTITY_MISMATCH';
    throw err;
  }
}

export async function appendPartitioned(repoRoot, replicaId, ev, { maxWaitMs = Infinity } = {}) {
  if (!isValidReplicaId(replicaId)) {
    throw new Error(`appendPartitioned: invalid replicaId "${replicaId}"`);
  }
  await preflightWsStamp(repoRoot, ev, 'appendPartitioned');
  const dir = partitionDir(repoRoot, replicaId);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, '.append.lock');
  return withAppendLock(
    lockPath,
    async () => {
      await assertWsStampCurrent(repoRoot, ev, 'appendPartitioned'); // r11-F1: the final gate, under the lock
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

// Append a pre-built event into the DEFAULT flat events dir under the SAME append
// funnel the partitioned path uses, with `prev_hash` computed INSIDE the lock so a
// concurrent flat writer can never fork the chain (audit P1). This is the single
// locked+chained flat primitive: both spine.append()'s flat branch AND the worker
// token wrapper (_wrapper-common.mjs) route through it, so every flat write on a
// post-lock (>=1.98) install carries prev_hash — no keyless flat writer remains.
//
// Because a `spine sync init` migration can commit WHILE we wait for the flat lock,
// we RE-RESOLVE the write replica once we hold it — NON-WAITING (timeoutMs:0), so a
// best-effort caller (the token wrapper) is never blocked by a pending migration.
// The outcome is a discriminated result the caller acts on AFTER the lock releases:
//   { ev }          — the flat append committed (ev now carries prev_hash)
//   { reroute: id } — a partition committed under us; caller routes to appendPartitioned
//   { pending }     — a migration is publishing; caller retries later / drops
// `maxWaitMs` bounds CONTENTION POLLING for the lock (best-effort, excludes FS
// latency); acquireAppendLock throws on timeout, so a bounded caller drops without
// writing and an Infinity caller (spine.append) never trips.
export async function appendFlatChained(repoRoot, eventsDir, ev, { maxWaitMs = Infinity } = {}) {
  // The lock file lives inside eventsDir, so the dir must exist before withAppendLock
  // opens it (mirrors appendPartitioned's mkdir). Self-sufficient for the token
  // wrapper, which may run before ensureSpine on a very fresh repo.
  await preflightWsStamp(repoRoot, ev, 'appendFlatChained');
  await mkdir(eventsDir, { recursive: true });
  const lockPath = join(eventsDir, '.append.lock');
  return withAppendLock(
    lockPath,
    async () => {
      // Re-resolve under the lock, non-waiting: if a migration committed while we
      // waited, DO NOT strand a flat write — hand the caller a reroute/pending.
      const w = await resolveWriteReplica(repoRoot, { timeoutMs: 0 });
      if (w.id) return { reroute: w.id };
      if (w.pending) return { pending: true };
      if (w.unattached) return { unattached: true }; // r7-F1: never write flat into an unattached clone
      await assertWsStampCurrent(repoRoot, ev, 'appendFlatChained'); // r11-F1: the final gate, under the lock
      const prevLine = await lastEventLineInDir(eventsDir);
      ev.prev_hash = prevLine === null ? null : hashLine(prevLine);
      const line = JSON.stringify(ev);
      if (line.includes('\n')) {
        throw new Error('spine-append-core.appendFlatChained: serialized event contains a raw newline — NDJSON framing invariant violated');
      }
      const seg = await currentSegmentInDir(eventsDir);
      await appendFile(join(eventsDir, seg), line + '\n', { flag: 'a' });
      return { ev };
    },
    { onWait: onWaitStderr(eventsDir), maxWaitMs }
  );
}
