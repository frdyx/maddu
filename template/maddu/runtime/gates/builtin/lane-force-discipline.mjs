// v1.1.0 Phase 8 — every LANE_CLAIM_FORCED event must be preceded by a
// LANE_CLAIM that the force replaced (priorSessionId must be a real
// session id that held the lane at that moment).

import { readAll, EVENT_TYPES } from '../../lib/spine.mjs';
import { readGovernance, effectiveValue } from '../../lib/governance.mjs';

export default {
  id: 'lane-force-discipline',
  label: 'lane force-claim discipline',
  severity: 'safety',
  description: 'Every LANE_CLAIM_FORCED references a prior claim; force is only allowed when governance permits.',
  run: async (ctx) => {
    const all = await readAll(ctx.repoRoot);
    const gov = await readGovernance(ctx.repoRoot);
    const forceAllowed = effectiveValue(gov, 'force-claim-allowed');
    const forced = all.filter((e) => e.type === EVENT_TYPES.LANE_CLAIM_FORCED);
    if (forced.length === 0) return { ok: true, message: 'no force-claims (skipped)' };
    const problems = [];
    for (const ev of forced) {
      const prior = ev.data?.priorSessionId;
      if (!prior) { problems.push({ id: ev.id, reason: 'missing priorSessionId' }); continue; }
      // Look backwards for the matching LANE_CLAIMED on the same lane by priorSessionId.
      const matched = all.find((x) => x.ts < ev.ts && x.type === EVENT_TYPES.LANE_CLAIMED && x.lane === ev.lane && x.actor === prior);
      if (!matched) problems.push({ id: ev.id, reason: 'no matching prior LANE_CLAIMED' });
    }
    if (forceAllowed === false && forced.length > 0) {
      problems.push({ reason: `governance mode ${gov.mode} forbids force-claim but ${forced.length} occurred` });
    }
    if (problems.length === 0) return { ok: true, message: `${forced.length} force-claim(s), all with valid priors` };
    return { ok: false, message: `${problems.length} force-claim issue(s)`, evidence: { problems } };
  },
};
