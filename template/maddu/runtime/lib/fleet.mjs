// fleet.mjs (roadmap #1) — the read-only, single-machine fleet aggregator.
//
// The bridge already knows every workspace path (workspaces.json), but only
// ever reads one repo at a time, so version skew (F1), liveness, and the
// delivery delta are invisible fleet-wide. This walks the registry and, per
// repo, reads its on-disk projection + version.json WITHOUT running that repo's
// maddu — so even a never-run cold repo is seen. Each repo is tiered
// ACTIVE / DORMANT / ABANDONED from its last-event time; every fleet metric
// scopes to ACTIVE so a dead repo can neither inflate nor hide the numbers.
//
// Fully offline + files-only (rule #1, #3): sibling-folder reads on one disk,
// zero network — which is exactly why it sidesteps the private-repo constraint
// that kills a network "latest version" check. It writes to no repo's spine.
//
// Pure split for testability: `aggregate(digests, now)` is a pure rollup;
// `digestRepo` does the fs read; `buildFleet` wires registry → digests →
// rollup.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './projections.mjs';
import { readRegistry } from './workspaces.mjs';
import { currencyVerdict } from './framework-currency.mjs';

const DAY_MS = 86400000;
// Liveness tiers, in days since the last spine event.
export const ACTIVE_MAX_DAYS = 14;
export const DORMANT_MAX_DAYS = 60;

// Event ids are `evt_YYYYMMDDHHMMSS_<hex>` — parse the embedded wall-clock so we
// get last-activity without a separate spine read. Returns epoch ms or null.
export function tsFromEventId(id) {
  const m = /^[a-z]+_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(id || ''));
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  const t = Date.parse(`${Y}-${Mo}-${D}T${H}:${Mi}:${S}Z`);
  return Number.isNaN(t) ? null : t;
}

export function parseVer(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function verGt(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}
// Pick the highest semver from a list of version strings (the fleet's "latest",
// which on this workstation is the canonical checkout). Ignores unparseable.
export function maxVersion(versions) {
  let best = null;
  for (const v of versions) { if (parseVer(v) && (best === null || verGt(v, best))) best = v; }
  return best;
}

export function classifyLiveness(lastActivityMs, nowMs) {
  if (lastActivityMs == null) return 'abandoned';
  const days = (nowMs - lastActivityMs) / DAY_MS;
  if (days <= ACTIVE_MAX_DAYS) return 'active';
  if (days <= DORMANT_MAX_DAYS) return 'dormant';
  return 'abandoned';
}

// Latest run per distinct gate → fraction ok. Returns { total, ok, rate } or
// null when there are no gate runs. Tolerates old/absent projection shapes.
export function gatePassRate(gatesProjection) {
  const runs = gatesProjection && Array.isArray(gatesProjection.runs) ? gatesProjection.runs : [];
  if (!runs.length) return null;
  const latest = new Map(); // gateId -> ok (last wins; runs are in spine order)
  for (const r of runs) { if (r && r.gateId) latest.set(r.gateId, !!r.ok); }
  const total = latest.size;
  if (!total) return null;
  const okCount = [...latest.values()].filter(Boolean).length;
  return { total, ok: okCount, rate: okCount / total };
}

async function readMeta(repoRoot) {
  for (const rel of ['maddu/version.json', 'version.json']) {
    try {
      const v = JSON.parse(await readFile(join(repoRoot, rel), 'utf8'));
      return { version: v.version || null, released: v.released || null };
    } catch {}
  }
  return { version: null, released: null };
}

// Digest one workspace WITHOUT running its maddu — read its projection + meta.
// Returns null only when the repo can't be read at all. `now` injected for tests.
export async function digestRepo(workspace, now = Date.now()) {
  const repoRoot = workspace.path;
  let proj = null;
  try { proj = await project(repoRoot); } catch { proj = null; }
  const meta = await readMeta(repoRoot);
  const lastActivity = proj ? tsFromEventId(proj.lastEventId) : null;
  const liveness = classifyLiveness(lastActivity, now);
  const currency = currencyVerdict({ released: meta.released, version: meta.version, now });
  const stops = proj && Array.isArray(proj.sliceStops) ? proj.sliceStops : [];
  const lastStop = stops.length ? stops[stops.length - 1] : null;
  return {
    id: workspace.id || workspace.label || repoRoot,
    label: workspace.label || workspace.id || repoRoot,
    role: workspace.role || 'project',
    path: repoRoot,
    version: meta.version,
    released: meta.released,
    currency: { level: currency.level, ageDays: currency.ageDays },
    liveness,
    lastActivity: lastActivity != null ? new Date(lastActivity).toISOString() : null,
    eventCount: proj ? (proj.eventCount || 0) : 0,
    gatePassRate: proj ? gatePassRate(proj.gates) : null,
    lastSlice: lastStop ? { ts: lastStop.ts, summary: (lastStop.summary || '').split('\n')[0].slice(0, 100) } : null,
    goal: proj && proj.goal ? (proj.goal.objective || null) : null,
    readable: !!proj,
  };
}

// Pure rollup over already-built digests. Fleet metrics scope to ACTIVE repos;
// the version delta (F1) is computed against the fleet's highest version.
export function aggregate(digests, now = Date.now()) {
  const repos = digests.filter(Boolean);
  const fleetLatest = maxVersion(repos.map((r) => r.version));
  for (const r of repos) {
    r.behind = !!(fleetLatest && verGt(fleetLatest, r.version));
    r.fleetLatest = fleetLatest;
  }
  const counts = { active: 0, dormant: 0, abandoned: 0 };
  for (const r of repos) counts[r.liveness] = (counts[r.liveness] || 0) + 1;
  const activeRepos = repos.filter((r) => r.liveness === 'active');
  const behindActive = activeRepos.filter((r) => r.behind);
  const staleActive = activeRepos.filter((r) => r.currency.level === 'WARN');
  return {
    generatedAt: new Date(now).toISOString(),
    fleetLatest,
    total: repos.length,
    counts,
    active: {
      total: activeRepos.length,
      behind: behindActive.length,
      behindIds: behindActive.map((r) => r.id),
      staleWarn: staleActive.length,
    },
    repos,
  };
}

// Top-level entry: registry → per-repo digests → rollup. now injected for tests.
export async function buildFleet({ now = Date.now() } = {}) {
  const reg = await readRegistry();
  const workspaces = Array.isArray(reg.workspaces) ? reg.workspaces : [];
  const digests = [];
  for (const w of workspaces) {
    if (!w || !w.path) continue;
    try { digests.push(await digestRepo(w, now)); } catch {}
  }
  return aggregate(digests, now);
}
