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

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES } from './spine.mjs';
import { isImportedEvent, listSpineShards } from './insights.mjs';
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
  const shards = await listSpineShards(join(repoRoot, '.maddu', 'events'));
  if (shards === null) return { claims, complete: false };
  let complete = true;
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
// "catalog unreadable", never crashes. Returns { catalog, raw, readable }.
async function readCatalogTolerant(repoRoot) {
  const p = pathsFor(repoRoot).laneCatalog;
  let raw;
  try { raw = await readFile(p, 'utf8'); } catch { return { catalog: { lanes: [] }, raw: null, readable: false }; }
  try {
    const catalog = JSON.parse(raw);
    if (!catalog || !Array.isArray(catalog.lanes)) return { catalog: { lanes: [] }, raw, readable: false };
    return { catalog, raw, readable: true };
  } catch { return { catalog: { lanes: [] }, raw, readable: false }; }
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

// Atomic write (temp + rename; Node's rename replaces on every platform) so
// a concurrent reader never sees torn/malformed JSON. Concurrent ADMIN
// writers (another adopt/prune, the bridge admin route) remain last-writer-
// wins — same as the pre-existing bridge behavior; catalog admin is a rare,
// operator-confirmed action and the spine records every mutation.
async function writeCatalogAtomic(repoRoot, body) {
  const p = pathsFor(repoRoot).laneCatalog;
  const tmp = `${p}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, p);
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
  const { catalog: cat, readable: catalogReadable } = await readCatalogTolerant(repoRoot);
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
    claimsComplete, catalogReadable,
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
async function mutateCatalog(repoRoot, { prevRaw, nextCatalog, event, _testFailAppend }) {
  await writeCatalogAtomic(repoRoot, serializeCatalog(nextCatalog));
  try {
    if (_testFailAppend) throw new Error('injected append failure (test hook)');
    return await append(repoRoot, event);
  } catch (e) {
    try { await writeCatalogAtomic(repoRoot, prevRaw); } catch {}
    throw new Error(`spine append failed — catalog restored, nothing adopted/pruned (${e.message})`);
  }
}

export async function adoptLane(repoRoot, id, { by = null, _testFailAppend = false } = {}) {
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
    prevRaw, nextCatalog: next, _testFailAppend,
    event: { type: EVENT_TYPES.LANE_ADDED, actor: by, lane: id, data: { lane } },
  });
  return { lane, event: ev.id, claims: s.claims };
}

// Prune a NEVER-CLAIMED catalog entry. Deliberately refuses an entry with
// any lifetime claim — pruning is for the dead placements the audit found,
// not a general remove (history referenced the lane; keep it addressable).
// Requires a COMPLETE claim harvest: an unreadable shard reading as "zero
// claims" must never delete a historically-claimed lane (Codex round 1).
// Residual TOCTOU (a claim landing between this harvest and the write) is
// BENIGN by design: claims are not catalog-bound — a lane pruned while
// being claimed simply reads as ad-hoc thereafter and can re-graduate.
export async function pruneLane(repoRoot, id, { by = null, _testFailAppend = false } = {}) {
  const { catalog: cat, raw: prevRaw } = await readCatalogStrict(repoRoot);
  if (!cat.lanes.some((l) => l.id === id)) throw new Error(`lane "${id}" is not in the catalog`);
  const { claims, complete } = await harvestLaneClaims(repoRoot);
  if (!complete) throw new Error(`spine scan incomplete (unreadable events dir or shard) — refusing to prune "${id}": cannot prove it was never claimed`);
  const used = claims.get(id) || 0;
  if (used > 0) throw new Error(`lane "${id}" has ${used} lifetime claim(s) — prune is only for never-claimed entries`);
  const next = { ...cat, lanes: cat.lanes.filter((l) => l.id !== id) };
  const ev = await mutateCatalog(repoRoot, {
    prevRaw, nextCatalog: next, _testFailAppend,
    event: { type: EVENT_TYPES.LANE_REMOVED, actor: by, lane: id, data: { ok: true } },
  });
  return { id, event: ev.id };
}
