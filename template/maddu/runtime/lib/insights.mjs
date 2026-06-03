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

// Join the harvested projects against the DEFINED event-type set.
export function buildMatrix(projects, definedSet) {
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
    return {
      type: t,
      defined: definedSet.has(t),
      count: globalCount.get(t) || 0,
      projects: proj,
      cls: classify(proj, n),
      // a type seen in spines but absent from EVENT_TYPES = drift the other way
      undeclared: !definedSet.has(t),
    };
  }).sort((a, b) => b.projects - a.projects || b.count - a.count);

  const counts = { 'load-bearing': 0, occasional: 0, 'single-project': 0, dead: 0 };
  for (const r of rows) counts[r.cls]++;
  const deadDefined = rows.filter((r) => r.cls === 'dead' && r.defined).map((r) => r.type);

  return { n, rows, counts, deadDefined, definedTotal: definedSet.size, everFired: seen.size };
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
