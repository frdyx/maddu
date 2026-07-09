// v1.1.0 Phase 8 — every LANE_CLAIM_FORCED event must be preceded by a
// LANE_CLAIM that the force replaced (priorSessionId must be a real
// session id that held the lane at that moment).
//
// The governance-forbids check is scoped to LIVE force-claims only. Tightening
// governance to forbid force must NOT retroactively fail the gate on force-claims
// that were legitimate when they happened and have since been released,
// superseded, or ended with their session. Only a force whose eviction is still
// in effect — the lane is still held via that force — violates current
// governance. This is what lets a repo be pinned `strict` persistently without
// every historical force-claim turning the gate red.
//
// Ordering: SPINE ORDER (array index), never wall-clock timestamps, drives every
// "before this event / since this event" test here. Two events can share a
// millisecond (a force emits three events back-to-back) and imported/skewed
// histories can carry non-monotonic `ts`, so ordering by `ts` would mis-bind a
// prior or a supersede.
//
// Current lane ownership (the "is this force still live" test) comes from
// `project()` — the ONE authoritative reducer for the final active-claim set,
// which handles every claim-affecting case (release, session-close, janitor
// SESSION_AUTO_CLOSED, team-sync first-claimer reconciliation). Re-implementing
// that reduction here once produced a false block (an inline copy silently
// dropped SESSION_AUTO_CLOSED), so we defer to the projection. The tiny read
// window between readAll() and project() is ordered readAll()→project() so the
// common race is a transient false-NEGATIVE (a just-created live force missed for
// one run, caught next run); a same-actor release-then-reclaim landing in that
// window could in principle produce a rare transient false-positive that
// self-heals on the next run and never corrupts state.
//
// NOTE (scoped follow-up): the prior-match below only proves priorSessionId once
// claimed this lane, not that it was the HOLDER at the force point, and force
// under team-sync contention needs mode-aware holder semantics. Both are
// pre-existing gaps orthogonal to the strict-pin scoping fixed here; tracked
// separately rather than reimplementing a mode-aware prefix reducer inline.

import { readAll, EVENT_TYPES } from '../../lib/spine.mjs';
import { project } from '../../lib/projections.mjs';
import { readGovernance, effectiveValue } from '../../lib/governance.mjs';

// A forced claim is "live" iff the lane is still held by the forcer (present in
// the authoritative active claims) AND the forcer has not since released it —
// i.e. the current hold IS this force, not a subsequent legitimate re-claim.
//
// A `--force` emits a triple: LANE_RELEASED (prior) + LANE_CLAIM_FORCED +
// LANE_CLAIMED (the forcer). Ownership comes from that trailing LANE_CLAIMED, so
// the active claims already reflect the force. The only signal the forcer LATER
// let go is a subsequent LANE_RELEASED by that same actor on that same lane — a
// later LANE_CLAIMED is NOT a supersede (the force's own trailing claim is
// exactly such an event). A release-then-normal-reclaim leaves that release
// behind, correctly marking the current hold as a fresh claim rather than the
// force. "Since" is measured by array index (spine order), not `ts`.
function liveForceClaims(all, forced, activeClaims) {
  const active = new Set(activeClaims.map((c) => JSON.stringify([c.lane, c.sessionId])));
  const indexOf = new Map(all.map((e, i) => [e, i]));
  return forced.filter((ev) => {
    if (!active.has(JSON.stringify([ev.lane, ev.actor]))) return false;
    const evIdx = indexOf.get(ev);
    const releasedSince = all.some(
      (x, i) =>
        i > evIdx &&
        x.lane === ev.lane &&
        x.actor === ev.actor &&
        x.type === EVENT_TYPES.LANE_RELEASED
    );
    return !releasedSince;
  });
}

export default {
  id: 'lane-force-discipline',
  label: 'lane force-claim discipline',
  severity: 'safety',
  description: 'Every LANE_CLAIM_FORCED references a prior claim; a force is only allowed when governance permits AND its eviction is still in effect.',
  run: async (ctx) => {
    const all = await readAll(ctx.repoRoot);
    const gov = await readGovernance(ctx.repoRoot);
    const forceAllowed = effectiveValue(gov, 'force-claim-allowed');
    const forced = all.filter((e) => e.type === EVENT_TYPES.LANE_CLAIM_FORCED);
    if (forced.length === 0) return { ok: true, message: 'no force-claims (skipped)' };
    const indexOf = new Map(all.map((e, i) => [e, i]));
    const problems = [];
    for (const ev of forced) {
      const prior = ev.data?.priorSessionId;
      if (!prior) { problems.push({ id: ev.id, reason: 'missing priorSessionId' }); continue; }
      // The prior must be a session that claimed this lane earlier in the spine
      // (spine order, not `ts`). This is the pre-existing invariant, unchanged.
      const evIdx = indexOf.get(ev);
      const matched = all.some((x, i) => i < evIdx && x.type === EVENT_TYPES.LANE_CLAIMED && x.lane === ev.lane && x.actor === prior);
      if (!matched) problems.push({ id: ev.id, reason: 'no matching prior LANE_CLAIMED' });
    }
    if (forceAllowed === false) {
      // Only flag force-claims whose eviction is STILL live — a tightened
      // governance never retroactively condemns released/superseded history.
      const proj = await project(ctx.repoRoot);
      const live = liveForceClaims(all, forced, proj.claims || []);
      if (live.length > 0) {
        problems.push({
          reason: `governance mode ${gov.mode} forbids force-claim but ${live.length} live force-claim(s) still hold a lane`,
          live: live.map((e) => ({ id: e.id, lane: e.lane, by: e.actor })),
        });
      }
    }
    if (problems.length === 0) return { ok: true, message: `${forced.length} force-claim(s), all with valid priors` };
    return { ok: false, message: `${problems.length} force-claim issue(s)`, evidence: { problems } };
  },
};
