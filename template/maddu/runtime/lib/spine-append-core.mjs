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

// Three-state cache read: {state:'present', spineIdentity, conflict} |
// {state:'absent'} | {state:'unresolvable', error}. Malformed content is
// UNRESOLVABLE (never guessed, never treated as foreign).
export async function readIdentityCache(repoRoot) {
  let txt;
  try { txt = await readFile(identityCachePath(repoRoot), 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unresolvable', error: e?.message || String(e) };
  }
  try {
    const j = JSON.parse(txt);
    if (j && typeof j.spineIdentity === 'string' && WS_ID_RE.test(j.spineIdentity)) {
      return { state: 'present', spineIdentity: j.spineIdentity, conflict: j.conflict === true };
    }
    return { state: 'unresolvable', error: 'identity.json malformed (no valid spineIdentity)' };
  } catch { return { state: 'unresolvable', error: 'identity.json is not JSON' }; }
}

// Atomic cache write + exact read-back (a torn cache must never survive).
export async function writeIdentityCache(repoRoot, { spineIdentity, conflict = false }) {
  if (!WS_ID_RE.test(String(spineIdentity || '')) && !conflict) {
    throw new Error(`writeIdentityCache: invalid spineIdentity ${JSON.stringify(spineIdentity)}`);
  }
  const p = identityCachePath(repoRoot);
  const tmp = p + '.tmp';
  const body = JSON.stringify({ v: 1, spineIdentity: spineIdentity ?? null, conflict }) + '\n';
  await mkdir(join(repoRoot, '.maddu', 'events'), { recursive: true });
  await writeFile(tmp, body);
  const { rename } = await import('node:fs/promises');
  await rename(tmp, p);
  const back = await readFile(p, 'utf8');
  if (back !== body) throw new Error('writeIdentityCache: read-back mismatch');
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
    const line = txt.split('\n').find((l) => l.trim());
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
    const line = txt.split('\n').find((l) => l.trim());
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
// prefilter before parse; malformed candidate lines are UNRESOLVABLE (r2-F2:
// never a silent skip).
export async function scanWsAuthorityEvents(repoRoot) {
  const anchors = [], resolutions = [];
  const scanDir = async (dir, source) => {
    for (const seg of await listSegmentsInDir(dir)) {
      let txt;
      try { txt = await readFile(join(dir, seg), 'utf8'); }
      catch (e) { throw Object.assign(new Error(`ws scan: ${source}/${seg}: ${e?.message || e}`), { code: 'WS_SCAN_UNRESOLVABLE' }); }
      for (const line of txt.split('\n')) {
        if (!line.includes('"WS_IDENTITY_')) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; } // non-event text containing the token
        if (ev?.type === 'WS_IDENTITY_ANCHORED') anchors.push(ev);
        else if (ev?.type === 'WS_IDENTITY_RESOLVED') resolutions.push(ev);
      }
    }
  };
  await scanDir(join(repoRoot, '.maddu', 'events'), 'flat');
  const byReplica = join(repoRoot, '.maddu', 'events', 'by-replica');
  let ids = [];
  try { ids = (await readdir(byReplica)).filter((d) => isValidReplicaId(d)); } catch {}
  for (const id of ids) await scanDir(join(byReplica, id), id);
  return { anchors, resolutions };
}

// Pure authority law shared by writers and verify (r1-F3: ONE authority,
// outside any per-partition scan):
//   no anchors → { authority: flatWs ?? null }
//   anchors agreeing → { authority }
//   conflicting anchors + a resolution binding ALL of them selecting an
//   EXISTING identity → { authority: selected }
//   else → { conflict: true, identities }
export function resolveWsAuthority({ anchors = [], resolutions = [], flatWs = null } = {}) {
  const ids = [...new Set(anchors.map((a) => a?.data?.spineIdentity).filter((x) => WS_ID_RE.test(String(x || ''))))];
  if (ids.length === 0) return { authority: flatWs };
  if (ids.length === 1) return { authority: ids[0] };
  const anchorIds = new Set(anchors.map((a) => a?.id).filter(Boolean));
  const valid = resolutions.filter((r) => {
    const sel = r?.data?.selected;
    const bound = Array.isArray(r?.data?.conflicts) ? r.data.conflicts.map((c) => c?.eventId).filter(Boolean) : [];
    return WS_ID_RE.test(String(sel || '')) && ids.includes(sel) && [...anchorIds].every((a) => bound.includes(a));
  });
  const selections = [...new Set(valid.map((r) => r.data.selected))];
  if (selections.length === 1) return { authority: selections[0], resolved: true };
  return { conflict: true, identities: ids };
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
  if (cache.state === 'present' && !cache.conflict) return { ws: cache.spineIdentity };
  if (cache.state === 'unresolvable') return { refuse: `identity cache unresolvable: ${cache.error}` };

  const partitioned = await wsModeIsPartitioned(repoRoot);
  if (!partitioned) {
    const g = await readFlatGenesisLine(repoRoot);
    if (g.state === 'absent') return { ws: null, bootstrap: true };
    if (g.state === 'unresolvable') return { refuse: `flat genesis unresolvable: ${g.error}` };
    const ws = wsFromLine(g.line);
    await writeIdentityCache(repoRoot, { spineIdentity: ws });
    return { ws };
  }

  // Sync mode: anchors are the authority.
  let scan;
  try { scan = await scanWsAuthorityEvents(repoRoot); }
  catch (e) { return { refuse: e?.message || String(e) }; }
  const law = resolveWsAuthority(scan);
  if (law.conflict) {
    await writeIdentityCache(repoRoot, { spineIdentity: null, conflict: true }).catch(() => {});
    return { conflict: law.identities };
  }
  if (law.authority) {
    await writeIdentityCache(repoRoot, { spineIdentity: law.authority });
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
    for (const line of text.split('\n')) {
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
      streams.push({ replicaId: ' by-replica-unreadable', events: [], parseErrors: 1 });
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
