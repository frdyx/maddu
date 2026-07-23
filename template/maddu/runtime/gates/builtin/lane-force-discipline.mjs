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
// STRENGTHENED HOLDER CHECK (PR-C §3.7). A PR-C force stamps a shared
// `data.forceGroup` id on every preempt-LANE_RELEASED + the LANE_CLAIM_FORCED
// marker + the trailing LANE_CLAIMED. The gate reconstructs each force's bundle
// by that id — NOT by spine contiguity, which is not import-stable (sync-merge
// interleaves partitions by head-ts, so a late-imported foreign event can land
// between a local release and its marker). It then reduces ownership over the
// prefix strictly BEFORE the earliest event of that forceGroup (mode-aware
// `ownersOf`) to recover the pre-force holder and compares it to priorSessionId:
//   - DEFAULT mode: the merged history IS the local history, so a mismatch is a
//     real discipline violation → hard-fail.
//   - SYNC mode: the reconstruction is NOT SOUND and is WITHHELD entirely. A
//     merged replica history can carry independently-authored (or forged)
//     fg-events; under first-claimer ordering, filtering a planted earlier
//     preempt-release resurrects an earlier claimant, so a forged prior could
//     MATCH and pass (and a late-imported reorder could spuriously mismatch).
//     The gate cannot prove the writer's local snapshot on a merged history, and
//     forgery detection belongs to the integrity layer (`maddu verify`), not a
//     discipline gate. Sync mode therefore relies ONLY on the import-stable
//     prior-once-claimed check.
//   - Backward compat: pre-PR-C triples carry NO forceGroup → only the
//     prior-once-claimed check runs (never newly-fails legacy history).
// The priorSessionId-was-an-ex-claimer sanity check still runs in BOTH modes
// (that IS import-stable — a claim by that id somewhere in history).

import { readAll, EVENT_TYPES } from '../../lib/spine.mjs';
import { project, ownersOf } from '../../lib/projections.mjs';
import { readActiveReplicaId } from '../../lib/spine-append-core.mjs';
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
    const syncMode = !!(await readActiveReplicaId(ctx.repoRoot));
    const indexOf = new Map(all.map((e, i) => [e, i]));
    const problems = [];
    for (const ev of forced) {
      const prior = ev.data?.priorSessionId;
      if (!prior) { problems.push({ id: ev.id, reason: 'missing priorSessionId' }); continue; }
      // The prior must be a session that claimed this lane earlier in the spine
      // (spine order, not `ts`). Import-stable — runs in both modes, unchanged.
      const evIdx = indexOf.get(ev);
      const matched = all.some((x, i) => i < evIdx && x.type === EVENT_TYPES.LANE_CLAIMED && x.lane === ev.lane && x.actor === prior);
      if (!matched) { problems.push({ id: ev.id, reason: 'no matching prior LANE_CLAIMED' }); continue; }
      // PR-C strengthened holder check — DEFAULT MODE ONLY. Reconstruct the
      // pre-force holder from all events before the MARKER, minus the bundle's
      // own preempt-releases (a LANE_RELEASED carrying this forceGroup). A
      // legitimate bundle's ONLY pre-marker events are those preempt-releases
      // (its LANE_CLAIMED is the TRAILING claim, after the marker), so:
      //   - a planted LANE_RELEASED with the fg is filtered → can't clear the
      //     real holder; last-writer semantics then still select the real
      //     holder, so a forged prior mismatches → hard-fail;
      //   - a pre-marker LANE_CLAIMED with the fg is NEVER legitimate and is NOT
      //     filtered → a forged fg-tagged claim can't hide the holder;
      //   - an ordinary intervening claim (no fg) survives and is recovered.
      //
      // SYNC MODE: the reconstruction is NOT SOUND and is deliberately NOT run.
      // A merged replica history can carry independently-authored fg-events, and
      // under first-claimer ordering filtering a (possibly forged) earlier
      // preempt-release RESURRECTS an earlier claimant as the reconstructed
      // holder — so a forged prior could MATCH and pass, or a legitimate
      // late-imported reorder could spuriously mismatch. The gate cannot prove
      // the writer's local snapshot on a merged history, and forgery detection is
      // the integrity layer's domain (the hash chain / `maddu verify`), not a
      // discipline gate's. So in sync mode the strengthened holder check is
      // withheld entirely; only the import-stable prior-once-claimed check above
      // governs. (Was a sync "advisory warn" — dropped as unsound: it could be
      // evaded to no-warn by exactly this planted-release construction.)
      const fg = ev.data && ev.data.forceGroup;
      if (fg && !syncMode) {
        const prefix = all.slice(0, evIdx).filter((e) => !(e && e.type === EVENT_TYPES.LANE_RELEASED && e.data && e.data.forceGroup === fg));
        const recon = ownersOf(prefix, ev.lane, { syncMode: false }).holder;
        const reconId = recon ? recon.sessionId : null;
        if (prior !== reconId) {
          problems.push({ id: ev.id, reason: `priorSessionId ${prior} does not match the reconstructed pre-force holder ${reconId ?? 'none'}` });
        }
      }
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
    if (problems.length > 0) return { ok: false, message: `${problems.length} force-claim issue(s)`, evidence: { problems } };
    return { ok: true, message: `${forced.length} force-claim(s), all with valid priors` };
  },
};
