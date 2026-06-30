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
// Pure over plain data: the command layer does the fs/git reads and hands these
// functions plain numbers + hash maps.

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
