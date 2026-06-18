// v1.1.0 Phase 5 — plan state.json must be derivable from the spine.
// Replays plan projections twice and asserts byte-equality; also asserts
// any on-disk state.json matches the fresh projection.

import { loadGateLib } from '../../lib/gate-libroot.mjs';

export default {
  id: 'plan-state-derivable',
  label: 'plan state derivable',
  severity: 'safety',
  description: 'Plan state.json is byte-equal to a fresh projection from the spine.',
  run: async (ctx) => {
    const lib = await loadGateLib(ctx.repoRoot, 'plans.mjs');
    if (!lib) return { ok: true, message: 'plans lib not present (skipped)' };
    const res = await lib.isPlanStateDerivable(ctx.repoRoot);
    if (!res.ok) {
      return { ok: false, message: `${res.problems.length} plan derivability problem(s)`, evidence: res };
    }
    if ((res.count || 0) === 0) return { ok: true, message: 'no plans (nothing to derive)' };
    return { ok: true, message: `${res.count} plan(s), all state.json derivable from spine` };
  },
};
