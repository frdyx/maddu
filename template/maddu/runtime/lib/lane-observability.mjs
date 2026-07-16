// Lane observability + suggest (usage-audit roadmap Tier 4a, v1.103.0).
//
// The 2026-07-16 fleet usage audit found the default 7-lane catalog 76% DEAD
// (112/147 placements never claimed) while 64% of consumer claims were
// ad-hoc ids invented at claim time — the catalog prescribes and reality
// routes around it. This module makes the gap observable and lets repeated
// reality graduate into the catalog:
//
//   - laneReport(repoRoot): catalog vs lifetime claims — which catalog
//     entries were never claimed (dead), which ad-hoc ids carry real use.
//   - suggestions: ad-hoc ids claimed ≥ SUGGEST_MIN_CLAIMS times, EXCLUDING
//     ephemeral ids (auto/<id> worktree-style ids, purely numeric ids).
//     Claim counts are the ONLY heuristic — repo-structure inference was
//     explicitly dropped by the roadmap (work is feature/phase-shaped, not
//     directory-shaped). Suggestions only; the operator confirms.
//   - adoptLane / pruneLane: the confirm paths. Adopt appends to
//     `.maddu/lanes/catalog.json` and emits LANE_ADDED { lane } (dormant
//     type, schema-fit verified). Prune removes a NEVER-CLAIMED entry and
//     emits LANE_REMOVED { ok: true } — the shape the event schema has
//     always documented. (Roadmap finding, reported in the Tier-4a PR: the
//     bridge's legacy emitter wrote `{}` against a documented
//     `{ ok: boolean }`; both emitters now conform. The type had never
//     fired anywhere, so no read-side consumer existed to break.)
//
// Reads are native-only (imported backfill never counts as lane usage) and
// partition-aware via the shared listSpineShards. Pure lib — no console
// output, no process.exit. Node stdlib only (rule #4).

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES } from './spine.mjs';
import { isImportedEvent, listSpineShardsDetailed } from './insights.mjs';
import { redactLeaves } from './secret-scan.mjs';

export const SUGGEST_MIN_CLAIMS = 3;

// Ephemeral claim ids that must never become catalog suggestions:
// worktree/auto-generated ids (auto/<x>, auto-<x>) and purely numeric ids.
export function isEphemeralLaneId(id) {
  const s = String(id || '');
  return /^auto[/-]/i.test(s) || /^\d+$/.test(s);
}

// Lifetime native claim counts per lane id, from the spine.
// → { claims: Map<laneId, count>, complete: boolean }.
// `complete` is false when the events dir was unreadable or ANY shard read
// failed — an undercount. Read-only surfaces may still display (flagged);
// MUTATING paths must treat incomplete as refuse: "unreadable spine" reading
// as "zero claims" would let prune delete a historically-claimed lane
// (Codex Tier-4a round 1 — fail-open must never become destructive).
export async function harvestLaneClaims(repoRoot) {
  const claims = new Map();
  // Detailed listing: a swallowed PARTITION-dir error must also read as
  // incomplete, or prune could miss a partition's claims (Codex round 2).
  const listing = await listSpineShardsDetailed(join(repoRoot, '.maddu', 'events'));
  if (listing.files === null) return { claims, complete: false };
  const shards = listing.files;
  let complete = listing.complete;
  for (const shard of shards) {
    let text;
    try { text = await readFile(shard, 'utf8'); } catch { complete = false; continue; }
    for (const line of text.split('\n')) {
      if (!line.trim() || !line.includes('LANE_CLAIMED')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'LANE_CLAIMED' || isImportedEvent(e)) continue;
      const id = typeof e.lane === 'string' && e.lane ? e.lane : null;
      if (!id) continue;
      claims.set(id, (claims.get(id) || 0) + 1);
    }
  }
  return { claims, complete };
}

// Tolerant read for REPORTS: a missing/malformed catalog renders as
// "catalog unreadable", never crashes. `state` distinguishes 'missing'
// (never had lanes / not a lane-bearing repo — a fleet report may skip it
// quietly) from 'malformed' (a FAILURE that must be surfaced, never
// silently hidden from the fleet table — Codex round 3).
// Returns { catalog, raw, readable, state: 'ok'|'missing'|'malformed' }.
async function readCatalogTolerant(repoRoot) {
  const p = pathsFor(repoRoot).laneCatalog;
  let raw;
  try { raw = await readFile(p, 'utf8'); }
  catch (e) {
    // Only a genuine ENOENT is 'missing' (never had lanes). A permission or
    // I/O error is 'unreadable' — a FAILURE the fleet must surface, never
    // silently bucket with lane-less repos (Codex round 4).
    const state = e && e.code === 'ENOENT' ? 'missing' : 'unreadable';
    return { catalog: { lanes: [] }, raw: null, readable: false, state };
  }
  try {
    const catalog = JSON.parse(raw);
    if (!catalog || !Array.isArray(catalog.lanes)) return { catalog: { lanes: [] }, raw, readable: false, state: 'malformed' };
    return { catalog, raw, readable: true, state: 'ok' };
  } catch { return { catalog: { lanes: [] }, raw, readable: false, state: 'malformed' }; }
}

// Serialize maddu-side catalog mutations with an atomic lock DIRECTORY
// (mkdir fails EEXIST — the worktrees-lib pattern) carrying an OWNER TOKEN.
// Inside the lock, read → guard → write → append → rollback run without
// another LOCK-HONORING writer interleaving.
//
// There is deliberately NO automated stale-lock eviction (Codex rounds 4-6:
// every timeout-eviction design spawned a narrower REAL lost-update race —
// ABA on the staleness stat, evictee-vs-successor release, third-writer
// overlap during rename-back — automated eviction IS the race generator).
// A leftover lock from a crashed operation is instead an EXPLICIT operator
// action: acquisition waits up to 5s, then refuses with the holder's
// pid/timestamp and the exact removal instruction. Catalog admin is rare
// and interactive — the operator is present to make that call. Absent
// manual removal, no process can ever take a live holder's lock, which is
// what makes the lost-update guarantee hold.
//
// Ownership semantics that remain (they guard the MANUAL-removal edge):
//   - the holder's callback receives `assertOwned()`; mutateCatalog calls
//     it immediately before the catalog write, so a holder whose lock was
//     hand-removed (and possibly re-acquired by another) ABORTS instead of
//     writing;
//   - release detaches via atomic rename and inspects the token — another
//     holder's lock is never torn down.
// Residuals, stated plainly (Codex round 7 precision):
// (a) the bridge admin route and operator hand-edits do NOT take this
//     lock (atomic write + conditional rollback are best-effort there;
//     the spine is the reconciliation source);
// (b) removing the lock while its operation is STILL running voids the
//     serialization guarantee for that operation. Usually the displaced
//     holder safe-aborts at its next assertOwned; but a removal PLUS
//     re-acquisition landing inside the window between a holder's
//     assertOwned and its catalog rename completing can produce
//     overlapping writes (last-writer-wins). That window is narrow but
//     I/O-BOUND, not sub-millisecond — it contains the awaited temp-file
//     write of the atomic catalog write, which under load can take
//     arbitrarily long. assertOwned is adjacent to the write, never
//     atomically bound to it; that is why the removal instruction warns
//     against removing a live operation's lock at all;
// (c) leftover locks arise from a crashed operation OR from a release
//     that failed to remove its own lock (e.g. a permission error on the
//     rename — release never fails a successful operation over it). Both
//     surface at the NEXT acquisition, which refuses with the removal
//     instruction — plus the holder's pid/timestamp when owner.json
//     exists (a crash between mkdir and the token write leaves an
//     ANONYMOUS leftover: same refusal, no identity to show).
const LOCK_WAIT_MS = 5_000;
function lockPaths(repoRoot) {
  const lockDir = join(pathsFor(repoRoot).lanes, 'catalog.lock');
  return { lockDir, ownerFile: join(lockDir, 'owner.json') };
}
// Atomically DETACH the lock dir by renaming it to a private name — rename
// is atomic, so of N racing processes exactly one wins (Codex round 5:
// bare check-then-rm could delete a freshly replaced lock). Used by RELEASE
// only; returns the detached path, or null when the rename failed — which
// means "already gone" OR "undetachable" (e.g. EACCES; round 7): release
// treats both as not-removable-now, never fails the completed operation,
// and any lock left behind surfaces at the next acquisition's refusal.
async function detachLock(lockDir) {
  const taken = `${lockDir}.take-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { await rename(lockDir, taken); return taken; } catch { return null; }
}

export async function withCatalogLock(repoRoot, fn) {
  const { lockDir, ownerFile } = lockPaths(repoRoot);
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const t0 = Date.now();
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      // Never leak an OWNERLESS lock: if the token write fails (disk full,
      // permissions), tear the fresh dir down before rethrowing (round 5).
      try { await writeFile(ownerFile, JSON.stringify({ token, pid: process.pid, ts: new Date().toISOString() })); }
      catch (e) { try { await rm(lockDir, { recursive: true, force: true }); } catch {} throw e; }
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      if (Date.now() - t0 > LOCK_WAIT_MS) {
        let holder = '';
        try {
          const o = JSON.parse(await readFile(ownerFile, 'utf8'));
          holder = ` (held by pid ${o.pid} since ${o.ts})`;
        } catch {}
        throw new Error(
          `lane catalog is locked by another admin operation${holder} — if that process is no longer running, ` +
          `remove .maddu/lanes/catalog.lock by hand and retry. Removing it while the operation is STILL running ` +
          `voids the serialization guarantee for that operation.`
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const assertOwned = async () => {
    let owned = false;
    try { owned = JSON.parse(await readFile(ownerFile, 'utf8')).token === token; } catch {}
    if (!owned) throw new Error('lane catalog lock lost (removed by hand while this operation ran) — aborting WITHOUT writing; retry the operation');
  };
  try { return await fn(assertOwned); }
  finally {
    // Release via atomic detach: rename whatever lock exists to a private
    // name, THEN inspect. Ours → remove. Not ours (only possible after a
    // MANUAL removal + re-acquisition) → rename it back; if even that
    // races, drop it — the displaced holder aborts at its next assertOwned
    // (subject to residual (b) above: an assertOwned already passed with
    // the write in flight is the one manual-removal shape that can still
    // overlap). A failed detach (already gone, or undetachable — residual
    // (c)) never fails the completed operation.
    try {
      const taken = await detachLock(lockDir);
      if (taken) {
        let ours = false;
        try { ours = JSON.parse(await readFile(join(taken, 'owner.json'), 'utf8')).token === token; } catch {}
        if (ours) await rm(taken, { recursive: true, force: true });
        else {
          try { await rename(taken, lockDir); }
          catch { try { await rm(taken, { recursive: true, force: true }); } catch {} }
        }
      }
    } catch {}
  }
}
// STRICT read for MUTATIONS: a missing or malformed catalog must REFUSE the
// operation — silently treating it as `{lanes:[]}` would let adopt overwrite
// and destroy the real file (Codex round 1). Returns { catalog, raw }.
async function readCatalogStrict(repoRoot) {
  const t = await readCatalogTolerant(repoRoot);
  if (!t.readable) {
    throw new Error(`lane catalog unreadable or malformed at .maddu/lanes/catalog.json — refusing to mutate (fix or restore the file first)`);
  }
  return { catalog: t.catalog, raw: t.raw };
}

// Atomic write (UNIQUE temp per write + rename; Node's rename replaces on
// every platform) so a concurrent reader never sees torn/malformed JSON and
// two concurrent writers can never race on a shared temp file (Codex round
// 2 — a shared `.tmp` could pair one mutation's catalog with another's
// event). Concurrent ADMIN writers remain last-writer-wins on the FINAL
// rename — same as the pre-existing bridge behavior; catalog admin is a
// rare, operator-confirmed action and the spine records every mutation.
async function writeCatalogAtomic(repoRoot, body) {
  const p = pathsFor(repoRoot).laneCatalog;
  const tmp = `${p}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, body);
  try { await rename(tmp, p); }
  catch (e) { try { await rm(tmp, { force: true }); } catch {} throw e; }
}
function serializeCatalog(catalog) {
  return JSON.stringify(redactLeaves(catalog), null, 2) + '\n';
}

// The full catalog-vs-reality report the audit derived by hand:
//   catalog      — [{ id, scope, claims }] every catalog entry + lifetime claims
//   unusedCatalog— catalog ids never claimed (the dead placements)
//   adHoc        — [{ id, claims, ephemeral }] claimed ids NOT in the catalog
//   suggestions  — non-ephemeral ad-hoc ids with ≥ SUGGEST_MIN_CLAIMS claims
export async function laneReport(repoRoot) {
  const { catalog: cat, readable: catalogReadable, state: catalogState } = await readCatalogTolerant(repoRoot);
  const lanes = cat.lanes;
  const { claims, complete: claimsComplete } = await harvestLaneClaims(repoRoot);
  const catalogIds = new Set(lanes.map((l) => l.id));
  const catalog = lanes.map((l) => ({ id: l.id, scope: l.scope || '', claims: claims.get(l.id) || 0 }));
  // "never claimed" is only assertable from a COMPLETE harvest — an
  // undercount must not brand a real lane unused (Codex round 1).
  const unusedCatalog = claimsComplete ? catalog.filter((l) => l.claims === 0).map((l) => l.id) : [];
  const adHoc = [...claims.entries()]
    .filter(([id]) => !catalogIds.has(id))
    .map(([id, count]) => ({ id, claims: count, ephemeral: isEphemeralLaneId(id) }))
    .sort((a, b) => b.claims - a.claims || a.id.localeCompare(b.id));
  const suggestions = adHoc.filter((a) => !a.ephemeral && a.claims >= SUGGEST_MIN_CLAIMS);
  return {
    catalog, unusedCatalog, adHoc, suggestions,
    totalClaims: [...claims.values()].reduce((a, b) => a + b, 0),
    claimsComplete, catalogReadable, catalogState,
  };
}

// Confirm-adopt a suggested ad-hoc lane into the catalog. Guards: id must be
// a real suggestion (≥ min claims, non-ephemeral, not already cataloged) —
// adoption is the operator confirming observed reality, not a free-form
// catalog editor (the bridge admin route exists for that).
// Mutation ordering (Codex round 1): guard → atomic catalog write → spine
// append; if the append FAILS the catalog is restored from the pre-mutation
// bytes and the error propagates, so "refused" is never printed over a
// mutation that actually happened. Residual: a crash between write and
// append leaves the mutation unrecorded — accepted for a rare operator
// admin action (the catalog diff is still visible in git/status surfaces).
// `_testFailAppend` is a GUARDED TEST-ONLY hook (no-op in production) that
// forces the append to throw so the rollback path is provable.
async function mutateCatalog(repoRoot, { prevRaw, nextCatalog, event, assertOwned = null, _testFailAppend }) {
  const nextRaw = serializeCatalog(nextCatalog);
  // Ownership check immediately before the dangerous action: a holder whose
  // lock was hand-removed aborts here instead of writing over a successor.
  if (assertOwned) await assertOwned();
  await writeCatalogAtomic(repoRoot, nextRaw);
  try {
    if (_testFailAppend) throw new Error('injected append failure (test hook)');
    return await append(repoRoot, event);
  } catch (e) {
    // Restore ONLY if the file still holds OUR bytes — if a concurrent
    // writer already replaced them, restoring prevRaw would clobber THEIR
    // successful mutation with stale content (Codex round 2). And never
    // claim restoration that didn't happen: the message states the actual
    // outcome, because "restored" over a still-mutated catalog is exactly
    // the refusal-over-a-completed-mutation lie this path exists to prevent.
    let restored = false;
    try {
      const current = await readFile(pathsFor(repoRoot).laneCatalog, 'utf8');
      if (current === nextRaw && (!assertOwned || (await assertOwned(), true))) {
        await writeCatalogAtomic(repoRoot, prevRaw);
        restored = true;
      }
    } catch {}
    throw new Error(restored
      ? `spine append failed — catalog restored, nothing adopted/pruned (${e.message})`
      : `spine append failed and the catalog was NOT rolled back (concurrent write or restore failure) — reconcile .maddu/lanes/catalog.json by hand (${e.message})`);
  }
}

export async function adoptLane(repoRoot, id, { by = null, _testFailAppend = false } = {}) {
  return withCatalogLock(repoRoot, async (assertOwned) => {
    const { catalog: cat, raw: prevRaw } = await readCatalogStrict(repoRoot);
    const report = await laneReport(repoRoot);
    if (cat.lanes.some((l) => l.id === id)) throw new Error(`lane "${id}" is already in the catalog`);
    const s = report.suggestions.find((x) => x.id === id);
    if (!s) {
      const adhoc = report.adHoc.find((x) => x.id === id);
      if (adhoc?.ephemeral) throw new Error(`lane "${id}" is ephemeral (auto/numeric) — not adoptable`);
      const hint = report.claimsComplete ? '' : ' (note: the spine scan was INCOMPLETE — fix the unreadable shard(s) and retry)';
      throw new Error(`lane "${id}" has ${adhoc ? adhoc.claims : 0} claim(s) — needs ≥${SUGGEST_MIN_CLAIMS} to be adoptable (suggestions only graduate observed reality)${hint}`);
    }
    const lane = { id, scope: `Adopted from ${s.claims} observed ad-hoc claim(s) via \`maddu lane suggest\`. Edit this scope to describe the surface.` };
    const next = { ...cat, lanes: [...cat.lanes, lane] };
    const ev = await mutateCatalog(repoRoot, {
      prevRaw, nextCatalog: next, assertOwned, _testFailAppend,
      event: { type: EVENT_TYPES.LANE_ADDED, actor: by, lane: id, data: { lane } },
    });
    return { lane, event: ev.id, claims: s.claims };
  });
}

// Prune a NEVER-CLAIMED catalog entry. Deliberately refuses an entry with
// any lifetime claim — pruning is for the dead placements the audit found,
// not a general remove (history referenced the lane; keep it addressable).
// Requires a COMPLETE claim harvest: an unreadable shard reading as "zero
// claims" must never delete a historically-claimed lane (Codex round 1).
//
// Residual TOCTOU — a claim landing between this harvest and the catalog
// write — is NOT universally benign (Codex round 2 corrected the round-1
// claim): plain claims are catalog-unbound (a pruned-while-claimed lane
// just reads as ad-hoc thereafter), but `lane claim --worktree` RE-ASSERTS
// catalog membership inside attachLaneWorktree AFTER its claim lands, so a
// prune inside that window leaves an active claim whose worktree attach
// refuses. Files-only means the window can't be locked away; instead a
// POST-WRITE recheck detects it and reports `racedClaim: true` so the
// caller can surface the recovery (re-adopt the lane, or release + reclaim
// without --worktree). The claim itself is never invalidated.
// `_testAfterMutate` is a guarded test-only hook (no-op in production) run
// between the catalog mutation and the racedClaim recheck, so the
// positive-detection path is provable (Codex round 3: only the negative
// path was tested).
export async function pruneLane(repoRoot, id, { by = null, _testFailAppend = false, _testAfterMutate = null } = {}) {
  return withCatalogLock(repoRoot, async (assertOwned) => {
    const { catalog: cat, raw: prevRaw } = await readCatalogStrict(repoRoot);
    if (!cat.lanes.some((l) => l.id === id)) throw new Error(`lane "${id}" is not in the catalog`);
    const { claims, complete } = await harvestLaneClaims(repoRoot);
    if (!complete) throw new Error(`spine scan incomplete (unreadable events dir or shard) — refusing to prune "${id}": cannot prove it was never claimed`);
    const used = claims.get(id) || 0;
    if (used > 0) throw new Error(`lane "${id}" has ${used} lifetime claim(s) — prune is only for never-claimed entries`);
    const next = { ...cat, lanes: cat.lanes.filter((l) => l.id !== id) };
    const ev = await mutateCatalog(repoRoot, {
      prevRaw, nextCatalog: next, assertOwned, _testFailAppend,
      event: { type: EVENT_TYPES.LANE_REMOVED, actor: by, lane: id, data: { ok: true } },
    });
    if (typeof _testAfterMutate === 'function') { try { await _testAfterMutate(); } catch {} }
    // racedClaim is a POSITIVE detector, not a proof of absence: the claim
    // path is lock-free by design (hot path — never serialized behind
    // admin), so a claim can still land after this recheck. true = a race
    // definitely happened; false = none detected at recheck time.
    let racedClaim = false;
    try {
      const after = await harvestLaneClaims(repoRoot);
      racedClaim = (after.claims.get(id) || 0) > 0;
    } catch {}
    return { id, event: ev.id, racedClaim };
  });
}
