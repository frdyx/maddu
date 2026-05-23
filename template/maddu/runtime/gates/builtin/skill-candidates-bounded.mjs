// v1.1.0 Phase 8 — bound the skill candidate queue. If more than 20
// candidates accumulate without being approved or rejected, surface as
// WARN — operator should triage.

import { readAll, EVENT_TYPES } from '../../lib/spine.mjs';

export default {
  id: 'skill-candidates-bounded',
  label: 'skill candidates bounded',
  severity: 'warn',
  description: 'Pending skill candidate queue stays bounded (≤20).',
  run: async (ctx) => {
    const all = await readAll(ctx.repoRoot);
    const detected = all.filter((e) => e.type === EVENT_TYPES.SKILL_CANDIDATE_DETECTED).map((e) => e.data?.hash);
    const approved = new Set(all.filter((e) => e.type === EVENT_TYPES.SKILL_CANDIDATE_APPROVED).map((e) => e.data?.hash));
    const rejected = new Set(all.filter((e) => e.type === EVENT_TYPES.SKILL_CANDIDATE_REJECTED).map((e) => e.data?.hash));
    const pending = detected.filter((h) => !approved.has(h) && !rejected.has(h));
    if (pending.length === 0) return { ok: true, message: 'no pending skill candidates' };
    if (pending.length <= 20) return { ok: true, message: `${pending.length} pending skill candidate(s) — review via /maddu-skills-review` };
    return { ok: false, message: `${pending.length} pending skill candidates (>20) — please triage`, evidence: { pending } };
  },
};
