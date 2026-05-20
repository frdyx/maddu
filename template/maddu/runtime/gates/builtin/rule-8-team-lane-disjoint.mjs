// rule-8-team-lane-disjoint — v0.18 Phase 4.
//
// Companion to rule-8-no-duplicate-claims (which catches LANE_CLAIMED
// collisions). This gate refuses to PASS when any open TEAM has lanes
// that overlap with another open team or with active lane claims.
//
// Why a separate gate: teams pre-allocate lanes via TEAM_LANE_ALLOCATED
// *before* members claim them. Operators wiring up a team can violate
// rule #8 by declaring overlapping lane lists, and the existing
// no-duplicate-claims gate wouldn't notice until claims fire. This
// gate makes the overlap visible at team-open time.
//
// Severity: critical — overlapping lanes are a rule #8 violation.

export default {
  id: 'rule-8-team-lane-disjoint',
  label: 'rule #8 team lane disjoint',
  severity: 'critical',
  description: 'Open teams pre-allocate disjoint lanes; no team-lane / claim overlap.',
  run: async (ctx) => {
    const proj = await ctx.project();
    const teams = (proj.teams || []).filter((t) => t.status === 'open');
    if (teams.length === 0) {
      return { ok: true, message: 'no open teams' };
    }
    const seen = new Map();   // lane -> teamId that allocated it first
    const conflicts = [];
    for (const t of teams) {
      for (const lane of (t.lanes || [])) {
        if (seen.has(lane)) {
          conflicts.push({ lane, teamA: seen.get(lane), teamB: t.id });
        } else {
          seen.set(lane, t.id);
        }
      }
    }
    // Also check against currently-held claims (the no-duplicate-claims
    // gate enforces uniqueness across claims themselves; we add the
    // cross-surface check that a team hasn't pre-allocated a lane that
    // an unrelated non-team claim holds).
    const claims = Array.isArray(proj.claims) ? proj.claims : [];
    for (const c of claims) {
      const allocatingTeam = seen.get(c.lane);
      if (!allocatingTeam) continue;
      const t = teams.find((x) => x.id === allocatingTeam);
      // If the team's member list includes this claim's session, it's
      // a legitimate team claim — not a conflict.
      if (t && t.members.some((m) => m.sessionId === c.sessionId)) continue;
      conflicts.push({ lane: c.lane, team: allocatingTeam, externalClaim: c.sessionId });
    }
    if (conflicts.length === 0) {
      return { ok: true, message: `${teams.length} open team(s), all lanes disjoint` };
    }
    return {
      ok: false,
      message: `${conflicts.length} team-lane conflict(s) — rule #8 violation`,
      evidence: { conflicts },
    };
  },
};
