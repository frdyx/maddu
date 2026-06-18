// v1.1.0 Phase 5 — Kanban projection coherence. A plan should never
// appear in both 'done' and 'now', or be missing entirely when it has
// open phases.

import { loadGateLib } from '../../lib/gate-libroot.mjs';

export default {
  id: 'kanban-coherent',
  label: 'kanban coherent',
  severity: 'safety',
  description: 'Kanban projection: no plan in both Now and Done; open plans appear in at least one column.',
  run: async (ctx) => {
    const lib = await loadGateLib(ctx.repoRoot, 'plans.mjs');
    if (!lib) return { ok: true, message: 'plans lib not present (skipped)' };
    const board = await lib.kanban(ctx.repoRoot);
    const problems = [];
    // v1.1.1: phase-level rows mean a plan legitimately appears in multiple
    // columns (e.g. completed phase in Done, pending phase in Now). The
    // coherence rule now checks the *plan-level* placement only: a plan
    // whose status is `completed`/`cancelled` must not also have a NOW row.
    const nowPlanLevelIds = new Set(board.now.filter((x) => !x.phase).map((x) => x.planId));
    for (const d of board.done) {
      // Only enforce when the DONE row is plan-level (no phase set) AND
      // the NOW row is also plan-level.
      if (!d.phase && nowPlanLevelIds.has(d.planId)) {
        problems.push({ planId: d.planId, reason: 'plan-level row in both Now and Done' });
      }
    }
    const all = await lib.listPlans(ctx.repoRoot);
    const allNowIds = new Set(board.now.map((x) => x.planId));
    const allBlockedIds = new Set(board.blocked.map((x) => x.planId));
    const allDoneIds = new Set(board.done.map((x) => x.planId));
    for (const p of all) {
      if (p.status === 'completed' || p.status === 'cancelled') continue;
      const hasOpenPhase = (p.phases || []).some((x) => x.status === 'pending');
      if (!hasOpenPhase) {
        // Open plan with all phases done should be in DONE per v1.1.1.
        if ((p.phases || []).length > 0 && !allDoneIds.has(p.planId) && !allBlockedIds.has(p.planId)) {
          problems.push({ planId: p.planId, reason: 'open plan with all phases complete not surfaced in Done' });
        }
        continue;
      }
      const present = allNowIds.has(p.planId) || allBlockedIds.has(p.planId);
      if (!present) problems.push({ planId: p.planId, reason: 'open plan with pending phase not in any column' });
    }
    if (problems.length === 0) {
      const total = board.now.length + board.next.length + board.blocked.length + board.done.length;
      return { ok: true, message: `kanban coherent (${total} placements across 4 columns)` };
    }
    return { ok: false, message: `${problems.length} kanban coherence issue(s)`, evidence: { problems } };
  },
};
