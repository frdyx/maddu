// Cross-project usage insights (v1.4.0).
//
// Where `maddu doctor` verifies one consumer INSTALL and `maddu audit` verifies
// the FRAMEWORK source for coherence-rot, `maddu insights` answers the empirical
// question the 2026-06-03 usage audit opened: across every real project, what is
// actually UTILIZED vs merely DEFINED+REACHABLE?
//
// It joins three layers of truth:
//   DEFINED    — EVENT_TYPES the framework declares (read from spine.mjs).
//   REACHABLE  — what code can emit (owned by `maddu audit`).
//   UTILIZED   — what actually fired, harvested from real `.maddu/events` spines.
//
// Discovery is the workspace registry (`maddu workspace add`), so this is not a
// hand-audit: it reads exactly the projects the operator registered. Per-project
// PRESENCE (fired in N of M projects) is the primary weight so one high-volume
// project can't masquerade as broad utilization.
//
// Pure lib — no console output, no process.exit. The command layer presents.
// Hard-rule compliant: reads NDJSON spines (rule #1), Node stdlib only (rule #4).

import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── DEFINED surface ─────────────────────────────────────────────────────────

// The authority for "what could fire" is the spine the install ships with.
export async function definedEventTypes(spineLib) {
  return new Set(Object.values(spineLib.EVENT_TYPES || {}));
}

// ── Spine harvest (UTILIZED) ────────────────────────────────────────────────

async function harvestOne(name, repoRoot) {
  const evDir = join(repoRoot, '.maddu', 'events');
  let shards;
  try { shards = (await readdir(evDir)).filter((f) => f.endsWith('.ndjson')).sort(); }
  catch { return null; } // no spine — not a Máddu repo (or never run)
  const counts = new Map();
  let total = 0, installedVersion = null, lastTs = null, firstTs = null;
  for (const shard of shards) {
    let text;
    try { text = await readFile(join(evDir, shard), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      counts.set(e.type, (counts.get(e.type) || 0) + 1);
      total++;
      if (e.ts) { lastTs = e.ts; if (!firstTs) firstTs = e.ts; }
      if (e.type === 'FRAMEWORK_INSTALLED' && e.data?.version) installedVersion = e.data.version;
    }
  }
  return { name, repoRoot, counts, total, installedVersion, firstTs, lastTs };
}

// Harvest every registered workspace. `workspaces` is [{id,label,path}].
export async function harvestSpines(workspaces) {
  const projects = [];
  for (const w of workspaces) {
    if (!w?.path) continue;
    const p = await harvestOne(w.label || w.id || w.path, w.path);
    if (p) projects.push(p);
  }
  return projects;
}

// ── Aggregate + classify ────────────────────────────────────────────────────

export function classify(presence, n) {
  if (presence === 0) return 'dead';
  if (n > 0 && presence >= Math.ceil(n / 2)) return 'load-bearing';
  if (presence === 1) return 'single-project';
  return 'occasional';
}

// ── Dormant-by-design registry (v1.7.0 invocation-logic) ───────────────
// Core event types that fire ONLY under a specific operator posture
// (API-key auth instead of OAuth, opt-in schedules, manual dep-pinning) or
// an attack/edge condition — not in the default flow. A type here that never
// fired is NOT a gap; it's insurance working as intended. Separating these
// from genuinely-dead types keeps `insights dead` honest: the dead count
// then reflects real "nothing invokes it" gaps worth fixing, which is the
// whole point of the invocation-logic work. Map: type -> why-dormant.
export const DORMANT_BY_DESIGN = new Map([
  ['AUTH_KEY_ADDED',           'API-key auth path; OAuth is the default'],
  ['AUTH_KEY_REMOVED',         'API-key auth path; OAuth is the default'],
  ['AUTH_KEY_ROTATED',         'API-key auth path; OAuth is the default'],
  ['AUTH_KEY_RATE_LIMITED',    'fires only on a provider rate-limit response'],
  ['SCHEDULE_CREATED',         'operator opt-in recurring tasks'],
  ['SCHEDULE_UPDATED',         'operator opt-in recurring tasks'],
  ['SCHEDULE_REMOVED',         'operator opt-in recurring tasks'],
  ['SCHEDULE_FIRED',           'operator opt-in recurring tasks'],
  ['TRUST_PIN_ADDED',          'fires only when an operator pins a dependency'],
  ['TRUST_PIN_REMOVED',        'fires only when an operator unpins a dependency'],
  ['MCP_PROVENANCE_VERIFIED',  'fires only under MCP use with provenance checks'],
  ['MCP_PROVENANCE_MISMATCH',  'attack/tamper signal under MCP provenance checks'],
  ['MCP_APPROVAL_GRANTED',     'fires only under gated MCP approval'],
  ['WORKER_ENV_FILTERED',      'fires only when a real worker spawn strips env'],
  ['IMPORT_ACCEPTED',          'cross-machine spine import only'],
  ['IMPORT_REJECTED',          'cross-machine spine import only'],
  ['CHECKPOINT_WORKTREE_CREATED',    'fires only when an operator materializes a checkpoint worktree'],
  ['CHECKPOINT_ROLLBACK_REQUESTED',  'fires only when an operator rolls back to a checkpoint'],
  // v1.9.0 failure-learning — fire only when `maddu learn` runs (LEARN_MINED is
  // the load-bearing entry point and is intentionally NOT listed here).
  ['LEARN_DIGEST_WRITTEN',     'no-provider fallback path; autonomous judging is the default'],
  ['LEARN_JUDGED',             'fires only when a `maddu learn` judgment worker runs'],
  ['LEARN_CORRECTION_WRITTEN', 'fires only when `maddu learn` writes a correction'],
  ['MEMORY_FACT_SUPERSEDED',   'fires only when a memory fact is superseded'],
  ['BRIEFING_CURATED',         'fires only under a curated (--curate) orient/handoff briefing'],
  // Focus Director — opt-in trajectory instrument (off by default); emits only
  // when the operator allowlists heartbeat:focus-director / slice-stop:focus-director.
  ['FOCUS_TAGGED',             'Focus Director is opt-in (off by default)'],
  ['DRIFT_FLAGGED',            'Focus Director is opt-in; fires only on sustained drift'],
]);

// Join the harvested projects against the DEFINED event-type set.
//
// `pluginOwners` (type -> plugin name) reclassifies a would-be-dead type that is
// actually owned by a plugin: it's `dormant` (the capability exists as a plugin,
// off in these projects), never `dead`. Only genuinely core-owned types that
// never fired count toward `deadDefined`.
export function buildMatrix(projects, definedSet, pluginOwners = new Map()) {
  const n = projects.length;
  const globalCount = new Map(); // type -> total occurrences
  const presence = new Map();    // type -> # projects it fired in
  for (const p of projects) {
    for (const [t, c] of p.counts) {
      globalCount.set(t, (globalCount.get(t) || 0) + c);
      presence.set(t, (presence.get(t) || 0) + 1);
    }
  }
  const seen = new Set(globalCount.keys());
  const allTypes = new Set([...definedSet, ...seen]);
  const rows = [...allTypes].map((t) => {
    const proj = presence.get(t) || 0;
    let cls = classify(proj, n);
    const owner = pluginOwners.get(t) || null;
    const dormantReason = DORMANT_BY_DESIGN.get(t) || null;
    // A plugin-owned type that never fired is dormant (plugin off here), not dead.
    if (cls === 'dead' && owner) cls = 'dormant';
    // A core type that fires only under a specific posture/edge is dormant
    // by design, not a gap (v1.7.0). Plugin ownership takes precedence.
    else if (cls === 'dead' && dormantReason) cls = 'dormant';
    return {
      type: t,
      defined: definedSet.has(t),
      count: globalCount.get(t) || 0,
      projects: proj,
      cls,
      owner: owner ? `plugin:${owner}` : (dormantReason ? 'dormant-by-design' : 'core'),
      dormantReason: owner ? null : dormantReason,
      // a type seen in spines but absent from EVENT_TYPES = drift the other way
      undeclared: !definedSet.has(t),
    };
  }).sort((a, b) => b.projects - a.projects || b.count - a.count);

  const counts = { 'load-bearing': 0, occasional: 0, 'single-project': 0, dormant: 0, dead: 0 };
  for (const r of rows) counts[r.cls]++;
  const deadDefined = rows.filter((r) => r.cls === 'dead' && r.defined).map((r) => r.type);
  const dormantByDesign = rows.filter((r) => r.cls === 'dormant' && r.owner === 'dormant-by-design').map((r) => r.type);

  return { n, rows, counts, deadDefined, dormantByDesign, definedTotal: definedSet.size, everFired: seen.size };
}

// ── Transcript scan (verb + slash BEHAVIOR) — best-effort, host-specific ─────
// Reads ~/.claude/projects/*/*.jsonl for `maddu <verb>` invocations and
// `/maddu-*` slash usage. Returns null if the transcripts root is absent.
export async function scanTranscripts(commandSet) {
  const root = join(homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()); }
  catch { return null; }
  const verbCount = new Map(), verbDirs = new Map(), slashCount = new Map();
  let filesScanned = 0;
  const reMaddu = /\bmaddu(?:\/run|\s+run)?\s+([a-z][a-z-]+)/g;
  const reSlash = /\/(maddu-[a-z-]+)\b/g;
  for (const d of dirs) {
    const sub = join(root, d.name);
    let files;
    try { files = (await readdir(sub)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      filesScanned++;
      const rl = createInterface({ input: createReadStream(join(sub, f), { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.includes('maddu')) continue;
        let m;
        reMaddu.lastIndex = 0;
        while ((m = reMaddu.exec(line))) {
          const v = m[1];
          if (!commandSet.has(v)) continue;
          verbCount.set(v, (verbCount.get(v) || 0) + 1);
          if (!verbDirs.has(v)) verbDirs.set(v, new Set());
          verbDirs.get(v).add(d.name);
        }
        reSlash.lastIndex = 0;
        while ((m = reSlash.exec(line))) slashCount.set(m[1], (slashCount.get(m[1]) || 0) + 1);
      }
    }
  }
  return { filesScanned, verbCount, verbDirs, slashCount };
}
