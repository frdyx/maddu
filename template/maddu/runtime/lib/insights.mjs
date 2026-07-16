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
import { dormantByDesignMap } from './event-dispositions.mjs';
import { resolveInstalledVersion, isSourceCheckout } from './installed-version.mjs';
import { readReceiptStats } from './invocation-receipts.mjs';

// ── Imported-event discriminator (Tier 1, 2026-07-16 audit) ────────────────
// A spine event is IMPORTED (backfilled from an external corpus, not native
// activity) iff its data.source carries one of these markers. Writers:
// `maddu usage import --from claude-code` stamps 'claude-code-transcript'
// (commands/usage.mjs); `maddu import submit` stamps 'import-submit' on the
// spine events its accepted kinds produce — the INBOX_MESSAGE content row
// (kind=inbox-note) and the SKILL_CREATED/SKILL_UPDATED lifecycle receipts
// (kind=skill, via saveSkill's trusted-caller opts). The IMPORT_* receipts
// witness the local accept/reject operation itself and stay native; the
// remaining kinds (memory-note/lane/brief) write files, not spine events.
// Native emitters omit the field entirely, so absence = native — verified
// across the 2026-07-16 fleet (snyggare: 53,668 stamped import rows, 0
// unstamped).
export const IMPORTED_DATA_SOURCES = new Set(['claude-code-transcript', 'import-submit']);

export function isImportedEvent(e) {
  return !!(e && e.data && typeof e.data.source === 'string' && IMPORTED_DATA_SOURCES.has(e.data.source));
}

// ── DEFINED surface ─────────────────────────────────────────────────────────

// The authority for "what could fire" is the spine the install ships with.
export async function definedEventTypes(spineLib) {
  return new Set(Object.values(spineLib.EVENT_TYPES || {}));
}

// ── Spine harvest (UTILIZED) ────────────────────────────────────────────────

// Every spine shard file for a repo: flat `.maddu/events/` segments PLUS
// sync-mode `by-replica/<id>/` partitions (roadmap #12c) — a migrated
// team-sync repo keeps its history in partitions, and a reader that only saw
// flat segments would report an active repo as near-empty (Codex Tier-3
// review round 1). Deliberately NOT spine.readAll: that routes through
// ensureSpine, which WRITES dirs + a default catalog — a fleet/insights scan
// must stay read-only on repos it merely observes. Events live in exactly one
// shard by construction (migration RENAMES segments into a partition), so a
// flat+partition union never double-counts; a rename racing this listing at
// worst hides a shard for one scan (counting reads re-run; nothing is cursor-
// based here).
//
// Contract details (Codex round 2):
//   - Returns NULL when the events dir itself is unreadable/absent — callers
//     must distinguish "no readable spine" (skip the project) from "readable
//     but empty" (a real zero-event repo), or an IO error would silently
//     count as an empty project and distort presence rates.
//   - Only CANONICAL segment names count (the same /^\d{12}\.ndjson$/ every
//     spine reader uses) — a stray backup/copy .ndjson in events/ or a
//     partition dir is not spine data and must not inflate counts or advance
//     the activation funnel.
//   - Detailed variant: `complete` is false when any PARTITION directory
//     read failed (an absent by-replica dir is fine — that's just "no
//     partitions"). A caller whose decision is DESTRUCTIVE (lane prune)
//     must require complete=true: a swallowed partition-dir error would
//     otherwise omit claimed lanes and re-open the fail-open-becomes-
//     destructive hole one level down (Codex Tier-4a round 2).
const SEGMENT_NAME_RE = /^\d{12}\.ndjson$/;
export async function listSpineShardsDetailed(evDir) {
  let entries;
  try { entries = await readdir(evDir, { withFileTypes: true }); } catch { return { files: null, complete: false }; }
  let complete = true;
  const files = [];
  for (const ent of entries) {
    if (ent.isFile() && SEGMENT_NAME_RE.test(ent.name)) files.push(join(evDir, ent.name));
  }
  let parts = null;
  try { parts = await readdir(join(evDir, 'by-replica'), { withFileTypes: true }); }
  catch (e) { if (e && e.code !== 'ENOENT') complete = false; }
  if (parts) {
    for (const p of parts) {
      if (!p.isDirectory()) continue;
      try {
        for (const f of await readdir(join(evDir, 'by-replica', p.name))) {
          if (SEGMENT_NAME_RE.test(f)) files.push(join(evDir, 'by-replica', p.name, f));
        }
      } catch { complete = false; }
    }
  }
  return { files: files.sort(), complete };
}
export async function listSpineShards(evDir) {
  return (await listSpineShardsDetailed(evDir)).files;
}

// Harvest one repo's spine. By default (Tier 1) counts/total/first/last
// reflect NATIVE activity only — imported backfill rows are tallied apart in
// `importedCounts`/`importedTotal` so a one-time transcript import (97% of one
// audited repo's volume) can't masquerade as activity. `includeImported: true`
// restores the merged pre-Tier-1 behavior for callers that want raw volume.
async function harvestOne(name, repoRoot, { includeImported = false } = {}) {
  // null = no readable spine → SKIP the project (never count an IO error as
  // a zero-event repo); [] = readable-but-empty → a real project with 0 events.
  const shards = await listSpineShards(join(repoRoot, '.maddu', 'events'));
  if (shards === null) return null;
  const counts = new Map(), importedCounts = new Map();
  let total = 0, importedTotal = 0, lastTs = null, firstTs = null;
  const gateOutcomes = { ok: 0, warn: 0, fail: 0, other: 0 };
  for (const shard of shards) {
    let text;
    try { text = await readFile(shard, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (isImportedEvent(e)) {
        // Always tallied apart so the native/imported split stays honest in
        // JSON even under includeImported (Codex diff-review round 1).
        importedCounts.set(e.type, (importedCounts.get(e.type) || 0) + 1);
        importedTotal++;
        if (!includeImported) continue; // imported rows never move activity/recency/volume
      }
      counts.set(e.type, (counts.get(e.type) || 0) + 1);
      total++;
      // min/max by comparison, not iteration order — partitioned shards
      // (by-replica) don't interleave chronologically on the path sort.
      if (e.ts) {
        if (!firstTs || e.ts < firstTs) firstTs = e.ts;
        if (!lastTs || e.ts > lastTs) lastTs = e.ts;
      }
      // Gate OUTCOME discrimination (Tier 2): the audit could only say
      // "10,229 pass / 0 fail / 104 other" fleet-wide — pass/non-pass states
      // weren't enumerated anywhere. Tally by resolved status.
      if (e.type === 'GATE_RAN') gateOutcomes[gateStatusOf(e.data)]++;
    }
  }
  // Version from the shared SSOT resolver — NOT the spine's FRAMEWORK_INSTALLED
  // event, which is frozen at install time and made insights disagree with
  // fleet on every since-upgraded repo (the 2026-07-16 audit's 0.19.0-vs-1.15.0).
  const ver = await resolveInstalledVersion(repoRoot);
  return {
    name, repoRoot, counts, total, firstTs, lastTs,
    importedCounts, importedTotal, gateOutcomes,
    installedVersion: ver.version, versionSource: ver.source,
  };
}

// Resolve one GATE_RAN event's outcome. Mirrors the runner's status logic
// (gates.mjs): explicit `status` wins (persisted since the verdict-ledger
// work — it alone can express a soft warn on a non-warn gate); legacy events
// without it derive from ok×severity — but ONLY when the full pair is
// available: the runner never emitted ok:false without a severity, so a
// record missing it is outside the writer's shapes and counts as 'other',
// never guessed into 'fail' (Codex diff-review round 1). ok:true needs no
// severity (the runner resolves ok regardless).
export function gateStatusOf(data) {
  if (data && (data.status === 'ok' || data.status === 'warn' || data.status === 'fail')) return data.status;
  if (data && typeof data.ok === 'boolean') {
    if (data.ok) return 'ok';
    if (typeof data.severity !== 'string' || !data.severity) return 'other';
    return data.severity === 'warn' ? 'warn' : 'fail';
  }
  return 'other';
}

// Harvest every registered workspace. `workspaces` is [{id,label,path,role}].
export async function harvestSpines(workspaces, opts = {}) {
  const projects = [];
  for (const w of workspaces) {
    if (!w?.path) continue;
    const p = await harvestOne(w.label || w.id || w.path, w.path, opts);
    if (p) { p.role = await workspaceRole(w); projects.push(p); }
  }
  return projects;
}

// ── Invocation-receipt harvest (Tier 2) ─────────────────────────────────────
// Per-workspace execution telemetry from `.maddu/state/invocation-receipts.
// ndjson` (see invocation-receipts.mjs for the corpus + honesty contract).
// Every entry carries its retention window and dropped-line count — callers
// must render those alongside the counts (observed window, never lifetime
// totals). A workspace with no corpus yet (pre-v1.101 install, or never ran
// a verb since upgrading) reports count 0 with window null — an honest "no
// telemetry", not "never used".
export async function harvestReceipts(workspaces) {
  const out = [];
  for (const w of workspaces) {
    if (!w?.path) continue;
    let stats;
    try { stats = await readReceiptStats(w.path); } catch { continue; }
    out.push({ name: w.label || w.id || w.path, path: w.path, role: await workspaceRole(w), ...stats });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ── Role segmentation (Tier 1) ──────────────────────────────────────────────
// 'self' = the framework's own source checkout (template/maddu + bin/maddu.mjs
// on disk — a deterministic file test, not a name match), 'fixture' = the
// registry says so, 'consumer' = everything else. The self test runs FIRST:
// the framework repo is self-dev even if someone registers it as a fixture
// (roadmap: "framework repo = self, registry role fields for the rest").
export async function workspaceRole(workspace) {
  if (await isSourceCheckout(workspace?.path || '')) return 'self';
  if (workspace?.role === 'fixture') return 'fixture';
  return 'consumer';
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
//
// DERIVED (DD1, roadmap #3): this is no longer a hand-maintained Map — it is
// computed from the definition-site disposition registry
// (event-dispositions.mjs), the single source of truth that the
// `event-dispositions-complete` gate holds in 1:1 parity with EVENT_TYPES. To
// accept a type as dormant, give it `disp:'dormant'` + a reason there; it then
// flows here automatically and can never silently re-read as "dead".
export const DORMANT_BY_DESIGN = dormantByDesignMap();

// Join the harvested projects against the DEFINED event-type set.
//
// `pluginOwners` (type -> plugin name) reclassifies a would-be-dead type that is
// actually owned by a plugin: it's `dormant` (the capability exists as a plugin,
// off in these projects), never `dead`. Only genuinely core-owned types that
// never fired count toward `deadDefined`.
export function buildMatrix(projects, definedSet, pluginOwners = new Map()) {
  const n = projects.length;
  const globalCount = new Map();    // type -> total NATIVE occurrences
  const importedCount = new Map();  // type -> total IMPORTED occurrences (Tier 1)
  const presence = new Map();       // type -> # projects it natively fired in
  for (const p of projects) {
    for (const [t, c] of p.counts) {
      globalCount.set(t, (globalCount.get(t) || 0) + c);
      presence.set(t, (presence.get(t) || 0) + 1);
    }
    for (const [t, c] of p.importedCounts || []) {
      importedCount.set(t, (importedCount.get(t) || 0) + c);
    }
  }
  const seen = new Set(globalCount.keys());
  const allTypes = new Set([...definedSet, ...seen, ...importedCount.keys()]);
  const rows = [...allTypes].map((t) => {
    const proj = presence.get(t) || 0;
    let cls = classify(proj, n);
    const owner = pluginOwners.get(t) || null;
    const dormantReason = DORMANT_BY_DESIGN.get(t) || null;
    // Never fired natively but present via imported backfill: honest middle
    // ground (Tier 1) — not activity, but not "nothing invokes it" either.
    // Checked FIRST so row cls and partitionDefined share one precedence:
    // fired > imported-only > dormant-by-design/plugin > dead.
    if (cls === 'dead' && (importedCount.get(t) || 0) > 0) cls = 'imported-only';
    // A plugin-owned type that never fired is dormant (plugin off here), not dead.
    else if (cls === 'dead' && owner) cls = 'dormant';
    // A core type that fires only under a specific posture/edge is dormant
    // by design, not a gap (v1.7.0). Plugin ownership takes precedence.
    else if (cls === 'dead' && dormantReason) cls = 'dormant';
    return {
      type: t,
      defined: definedSet.has(t),
      count: globalCount.get(t) || 0,
      importedCount: importedCount.get(t) || 0,
      projects: proj,
      cls,
      owner: owner ? `plugin:${owner}` : (dormantReason ? 'dormant-by-design' : 'core'),
      dormantReason: owner ? null : dormantReason,
      // a type seen in spines but absent from EVENT_TYPES = drift the other way
      undeclared: !definedSet.has(t),
    };
  }).sort((a, b) => b.projects - a.projects || b.count - a.count);

  const counts = { 'load-bearing': 0, occasional: 0, 'single-project': 0, dormant: 0, 'imported-only': 0, dead: 0 };
  for (const r of rows) counts[r.cls]++;
  const deadDefined = rows.filter((r) => r.cls === 'dead' && r.defined).map((r) => r.type);
  const dormantByDesign = rows.filter((r) => r.cls === 'dormant' && r.owner === 'dormant-by-design').map((r) => r.type);

  return {
    n, rows, counts, deadDefined, dormantByDesign,
    definedTotal: definedSet.size, everFired: seen.size,
    // Undeclared drift (seen in spines, absent from EVENT_TYPES) is counted
    // apart: it participates in `counts` rows but never in the defined
    // partition, so the two totals must be reconciled by the caller's render
    // (headline counts may exceed definedTotal by exactly this number).
    undeclaredCount: rows.filter((r) => r.undeclared).length,
    partition: partitionDefined(rows, definedSet),
  };
}

// ── Exhaustive taxonomy partition (Tier 1) ──────────────────────────────────
// Every DEFINED type lands in exactly one bucket — the audit found the summary
// line (92 fired + 70 dormant-by-design + 1 dead = 163) leaving 19 types
// unexplained (they were plugin-owned, silently folded into "dormant").
// Buckets, in precedence order:
//   fired             — natively fired somewhere (dormant annotation or not)
//   imported-only     — never fired natively; only imported backfill rows exist
//   dormant-by-design — never fired; disposition registry carries a reason
//   plugin-owned      — never fired; owned by an optional plugin
//   dead              — never fired, no excuse on file
// The `insights-partition` self-test asserts the buckets are disjoint and sum
// to definedTotal, so the taxonomy can never silently leak types again.
export function partitionDefined(rows, definedSet) {
  const buckets = { fired: [], 'imported-only': [], 'dormant-by-design': [], 'plugin-owned': [], dead: [] };
  for (const r of rows) {
    if (!definedSet.has(r.type)) continue; // undeclared drift is reported apart
    if (r.count > 0) buckets.fired.push(r.type);
    else if (r.importedCount > 0) buckets['imported-only'].push(r.type);
    else if (r.owner === 'dormant-by-design') buckets['dormant-by-design'].push(r.type);
    else if (String(r.owner).startsWith('plugin:')) buckets['plugin-owned'].push(r.type);
    else buckets.dead.push(r.type);
  }
  const sum = Object.values(buckets).reduce((a, b) => a + b.length, 0);
  return { buckets, sum, complete: sum === definedSet.size };
}

// ── Transcript scan (verb + slash BEHAVIOR) — best-effort, host-specific ─────
// Reads ~/.claude/projects/*/*.jsonl for `maddu <verb>` invocations and
// `/maddu-*` slash usage. Returns null if the transcripts root is absent.

// Claude Code encodes a workspace path into its transcript dir name by
// replacing every non-alphanumeric character with '-' (e.g.
// C:\Users\X\proj → C--Users-X-proj). Lowercased for comparison: observed
// transcript dirs vary in case for the same workspace (Windows paths are
// case-insensitive). Used to scope the transcript scan to a role-filtered
// workspace set so --role consumer can't be polluted by framework self-dev
// sessions (Codex diff-review round 1).
export function transcriptDirName(workspacePath) {
  return String(workspacePath || '').replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
}

// `dirAllow` (optional Set of lowercased transcriptDirName strings) scopes the
// scan; omitted = all session dirs (the pre-Tier-1 behavior, labeled as such).
export async function scanTranscripts(commandSet, { dirAllow = null } = {}) {
  const root = join(homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()); }
  catch { return null; }
  if (dirAllow) dirs = dirs.filter((d) => dirAllow.has(d.name.toLowerCase()));
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
