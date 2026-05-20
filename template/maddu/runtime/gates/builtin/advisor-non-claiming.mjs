// advisor-non-claiming — v0.18 Phase 4.
//
// Verifies that no LANE_CLAIMED event references a session that was
// recorded as an advisor (kind: 'advisor') via ADVISOR_INVOKED. The
// invariant: advisors run in read-only / artifact-only mode; they
// never claim lanes.
//
// We walk the raw event log because the projection collapses advisors
// into a flat list; the gate wants to cross-reference advisor session
// ids against every LANE_CLAIMED event regardless of recency.

export default {
  id: 'advisor-non-claiming',
  label: 'advisor non-claiming',
  severity: 'critical',
  description: 'Advisor sessions (kind=advisor) never appear as actors in LANE_CLAIMED events.',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const advisorSessions = new Set();
    // Both forms supported:
    //   1. ADVISOR_INVOKED.data.parentSessionId = caller, advisorId is the artifact id.
    //   2. ADVISOR_INVOKED.data.sessionId = the advisor's own session if spawned.
    // Mark advisorId AND any sessionId tagged kind:'advisor'.
    for (const ev of events) {
      if (ev.type === 'ADVISOR_INVOKED' && ev.data) {
        if (ev.data.sessionId) advisorSessions.add(ev.data.sessionId);
        // The advisorId is not a session id, but downstream slash
        // commands may register a session WITH the advisorId as
        // sessionId. Capture both.
        if (ev.data.advisorId) advisorSessions.add(ev.data.advisorId);
      }
      // Future shape — sessions registered with explicit kind:'advisor'.
      if ((ev.type === 'SESSION_REGISTERED' || ev.type === 'SESSION_AUTO_REGISTERED')
          && ev.data && ev.data.kind === 'advisor') {
        advisorSessions.add(ev.actor || ev.data.sessionId);
      }
    }
    if (advisorSessions.size === 0) {
      return { ok: true, message: 'no advisors recorded (skipped)' };
    }
    const violations = [];
    for (const ev of events) {
      if (ev.type !== 'LANE_CLAIMED') continue;
      const sid = ev.actor || ev.data?.sessionId;
      if (sid && advisorSessions.has(sid)) {
        violations.push({ eventId: ev.id, sessionId: sid, lane: ev.data?.lane, ts: ev.ts });
      }
    }
    if (violations.length === 0) {
      return {
        ok: true,
        message: `${advisorSessions.size} advisor(s); 0 claim violations`,
      };
    }
    return {
      ok: false,
      message: `${violations.length} advisor session(s) claimed lanes — rule #8 / advisor invariant violation`,
      evidence: { violations },
    };
  },
};
