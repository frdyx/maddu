// fleet-upgrade.mjs (roadmap #10, F1 delivery leg) — the PLAN half.
//
// `maddu fleet` answered "who is behind?" but the operator still had to walk
// into each repo and run `maddu upgrade` by hand — the "fixed in-tree, never
// received" gap, structurally. This is the staged-delivery planner: from the
// canonical checkout it computes, per behind repo, (a) whether it is QUIESCENT
// enough to touch safely and (b) exactly which managed bytes a delivery would
// change. `--plan` ships first (this); the mutation is a guarded follow-up.
//
// Two hard safety rules live here as pure, fixture-tested logic:
//   * Quiescence interlock — never deliver into a repo that is mid-work. ANY of
//     {active lane claim, dirty git tree, recent spine activity} blocks it.
//   * Byte delta is computed over MANAGED framework files only; the live spine
//     (.maddu/events/) is never in the managed set, so it can never be in a
//     plan — the delivery can't roll back history.
//
// The planner half (quiescence + byte delta) is pure over plain data. The
// delivery half (--apply) adds the roadmap's safety primitives — target scoping,
// a managed-byte snapshot (never the spine), and a halt-on-red summary; the
// snapshot does fs, the rest stays pure and fixture-tested.

// A repo is "busy" if its newest spine event is within this window.
export const RECENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// Is this repo safe to deliver into right now? Returns { eligible, blockers }.
// blockers is a human-readable list; eligible === (blockers.length === 0).
export function quiescenceVerdict({ activeClaims = 0, dirty = false, lastActivityMs = null, now = 0, recentWindowMs = RECENT_WINDOW_MS } = {}) {
  const blockers = [];
  if (activeClaims > 0) blockers.push(`${activeClaims} active lane claim(s)`);
  if (dirty) blockers.push('dirty working tree');
  if (lastActivityMs != null && now - lastActivityMs >= 0 && now - lastActivityMs < recentWindowMs) {
    blockers.push('recent spine activity (<10m)');
  }
  return { eligible: blockers.length === 0, blockers };
}

// Byte delta between the canonical manifest (what the source ships now) and a
// repo's RECORDED manifest (the hashes its maddu.json says it installed). Both
// are { relPath: sha256 } maps over MANAGED files only. Returns counts + small
// samples; the live spine is never a managed file, so it can never appear here.
export function byteDelta(canonical = {}, recorded = {}) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, hash] of Object.entries(canonical)) {
    if (!(rel in recorded)) added.push(rel);
    else if (recorded[rel] !== hash) changed.push(rel);
  }
  for (const rel of Object.keys(recorded)) {
    if (!(rel in canonical)) removed.push(rel);
  }
  changed.sort(); added.sort(); removed.sort();
  const total = changed.length + added.length + removed.length;
  return {
    changed, added, removed, total,
    counts: { changed: changed.length, added: added.length, removed: removed.length },
    sample: [...changed.slice(0, 3), ...added.slice(0, 2)].slice(0, 5),
  };
}

// ── delivery (the --apply leg) ─────────────────────────────────────────────
// The mutation reuses the proven single-repo engine: `maddu upgrade` spawned
// with cwd=<target> delivers the canonical bytes (pristine-respecting, spine-
// preserving). These helpers wrap it in the roadmap's safety rules: scope the
// targets deliberately, snapshot the bytes a delivery would overwrite (never the
// spine), and stop the whole run on the first red doctor.

import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// Which currently-present managed files a delivery would overwrite or remove —
// the set worth snapshotting for rollback. ADDED files aren't snapshotted (they
// don't exist yet; rollback is just deleting them).
export function snapshotRelPaths(delta) {
  if (!delta) return [];
  return [...(delta.changed || []), ...(delta.removed || [])].sort();
}

// Choose delivery targets from plan rows. Forces the operator to scope the blast
// radius: `--only <id>` (one repo, must be eligible) or `--all` (every eligible
// repo, capped by max). Neither → an error, never a default fleet-wide mutation.
// Returns { targets, error }.
export function selectTargets(rows, { only = null, all = false, max = Infinity } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const eligible = list.filter((r) => r.quiescence && r.quiescence.eligible);
  if (only) {
    const r = list.find((x) => x.id === only || x.label === only);
    if (!r) return { targets: [], error: `no behind active repo matches "${only}"` };
    if (!(r.quiescence && r.quiescence.eligible)) {
      return { targets: [], error: `"${only}" is blocked: ${(r.quiescence && r.quiescence.blockers || []).join('; ')}` };
    }
    return { targets: [r], error: null };
  }
  if (all) return { targets: eligible.slice(0, max), error: null };
  return { targets: [], error: 'specify --only <repo> (one repo) or --all (every eligible repo) — refusing an unscoped fleet mutation' };
}

// Copy the current on-disk content of relPaths from targetRoot into snapDir
// (preserving relative paths) and write a snapshot.json manifest. The live spine
// is never a managed file, but we belt-and-suspenders skip any .maddu/events
// path so a snapshot can never read or rewrite history. Returns { dir, files }.
export async function snapshotManagedBytes(targetRoot, relPaths, snapDir, meta = {}) {
  await mkdir(snapDir, { recursive: true });
  const copied = [];
  for (const rel of (relPaths || [])) {
    if (/\.maddu[/\\]events/.test(rel)) continue; // never the spine
    const src = join(targetRoot, rel);
    try { await stat(src); } catch { continue; } // skip files not present
    const dst = join(snapDir, 'files', rel);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    copied.push(rel);
  }
  await writeFile(join(snapDir, 'snapshot.json'), JSON.stringify({ ...meta, takenFrom: targetRoot, snapshotted: copied }, null, 2) + '\n');
  return { dir: snapDir, files: copied };
}

// Roll per-repo apply results into a summary. Each result: { id, delivered,
// doctorOk, halted }. Halt-on-red means the run stops at the first repo whose
// delivery failed or whose post-delivery doctor went red.
export function summarizeApply(results) {
  const list = Array.isArray(results) ? results : [];
  const delivered = list.filter((r) => r.delivered && r.doctorOk).length;
  const haltedRow = list.find((r) => r.halted) || null;
  return { attempted: list.length, delivered, haltedAt: haltedRow ? haltedRow.id : null };
}

// Roll a set of per-repo plan rows into headline counts for the command output.
export function planSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const behind = list.length;
  const eligible = list.filter((r) => r.quiescence && r.quiescence.eligible).length;
  return {
    behind,
    eligible,
    blocked: behind - eligible,
    totalBytes: list.reduce((n, r) => n + (r.delta ? r.delta.total : 0), 0),
  };
}
