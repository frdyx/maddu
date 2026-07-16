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

import { readFile, writeFile } from 'node:fs/promises';
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
// → Map<laneId, count> (empty when no readable spine).
export async function harvestLaneClaims(repoRoot) {
  const claims = new Map();
  const shards = (await listSpineShards(join(repoRoot, '.maddu', 'events'))) || [];
  for (const shard of shards) {
    let text;
    try { text = await readFile(shard, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim() || !line.includes('LANE_CLAIMED')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'LANE_CLAIMED' || isImportedEvent(e)) continue;
      const id = typeof e.lane === 'string' && e.lane ? e.lane : null;
      if (!id) continue;
      claims.set(id, (claims.get(id) || 0) + 1);
    }
  }
  return claims;
}

async function readCatalog(repoRoot) {
  const p = pathsFor(repoRoot).laneCatalog;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return { lanes: [] }; }
}
async function writeCatalog(repoRoot, catalog) {
  const p = pathsFor(repoRoot).laneCatalog;
  await writeFile(p, JSON.stringify(redactLeaves(catalog), null, 2) + '\n');
}

// The full catalog-vs-reality report the audit derived by hand:
//   catalog      — [{ id, scope, claims }] every catalog entry + lifetime claims
//   unusedCatalog— catalog ids never claimed (the dead placements)
//   adHoc        — [{ id, claims, ephemeral }] claimed ids NOT in the catalog
//   suggestions  — non-ephemeral ad-hoc ids with ≥ SUGGEST_MIN_CLAIMS claims
export async function laneReport(repoRoot) {
  const cat = await readCatalog(repoRoot);
  const lanes = Array.isArray(cat.lanes) ? cat.lanes : [];
  const claims = await harvestLaneClaims(repoRoot);
  const catalogIds = new Set(lanes.map((l) => l.id));
  const catalog = lanes.map((l) => ({ id: l.id, scope: l.scope || '', claims: claims.get(l.id) || 0 }));
  const unusedCatalog = catalog.filter((l) => l.claims === 0).map((l) => l.id);
  const adHoc = [...claims.entries()]
    .filter(([id]) => !catalogIds.has(id))
    .map(([id, count]) => ({ id, claims: count, ephemeral: isEphemeralLaneId(id) }))
    .sort((a, b) => b.claims - a.claims || a.id.localeCompare(b.id));
  const suggestions = adHoc.filter((a) => !a.ephemeral && a.claims >= SUGGEST_MIN_CLAIMS);
  return { catalog, unusedCatalog, adHoc, suggestions, totalClaims: [...claims.values()].reduce((a, b) => a + b, 0) };
}

// Confirm-adopt a suggested ad-hoc lane into the catalog. Guards: id must be
// a real suggestion (≥ min claims, non-ephemeral, not already cataloged) —
// adoption is the operator confirming observed reality, not a free-form
// catalog editor (the bridge admin route exists for that).
export async function adoptLane(repoRoot, id, { by = null } = {}) {
  const report = await laneReport(repoRoot);
  if (report.catalog.some((l) => l.id === id)) throw new Error(`lane "${id}" is already in the catalog`);
  const s = report.suggestions.find((x) => x.id === id);
  if (!s) {
    const adhoc = report.adHoc.find((x) => x.id === id);
    if (adhoc?.ephemeral) throw new Error(`lane "${id}" is ephemeral (auto/numeric) — not adoptable`);
    throw new Error(`lane "${id}" has ${adhoc ? adhoc.claims : 0} claim(s) — needs ≥${SUGGEST_MIN_CLAIMS} to be adoptable (suggestions only graduate observed reality)`);
  }
  const cat = await readCatalog(repoRoot);
  cat.lanes = Array.isArray(cat.lanes) ? cat.lanes : [];
  const lane = { id, scope: `Adopted from ${s.claims} observed ad-hoc claim(s) via \`maddu lane suggest\`. Edit this scope to describe the surface.` };
  cat.lanes.push(lane);
  await writeCatalog(repoRoot, cat);
  const ev = await append(repoRoot, { type: EVENT_TYPES.LANE_ADDED, actor: by, lane: id, data: { lane } });
  return { lane, event: ev.id, claims: s.claims };
}

// Prune a NEVER-CLAIMED catalog entry. Deliberately refuses an entry with
// any lifetime claim — pruning is for the dead placements the audit found,
// not a general remove (history referenced the lane; keep it addressable).
export async function pruneLane(repoRoot, id, { by = null } = {}) {
  const cat = await readCatalog(repoRoot);
  const lanes = Array.isArray(cat.lanes) ? cat.lanes : [];
  if (!lanes.some((l) => l.id === id)) throw new Error(`lane "${id}" is not in the catalog`);
  const claims = await harvestLaneClaims(repoRoot);
  const used = claims.get(id) || 0;
  if (used > 0) throw new Error(`lane "${id}" has ${used} lifetime claim(s) — prune is only for never-claimed entries`);
  cat.lanes = lanes.filter((l) => l.id !== id);
  await writeCatalog(repoRoot, cat);
  const ev = await append(repoRoot, { type: EVENT_TYPES.LANE_REMOVED, actor: by, lane: id, data: { ok: true } });
  return { id, event: ev.id };
}
