// @maddu-model-gates v1
// candidate-promotion-complete — SLM-governance starter pack (operator-owned copy).
// Every checkpoint at candidate or above (spine-DERIVED stage) must carry
// full provenance on the record: a completed training run, dataset lineage,
// at least one recorded eval, and the approval that advanced it. A foreign
// checkpoint (registered without a run) can live at experiment forever, but
// may not hold candidate+ without lineage — that is the point of the gate.
// Stage derivation runtime-resolved; absent runtime → honest SKIP.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'candidate-promotion-complete',
  label: 'candidate promotion complete',
  severity: 'fail',
  description: 'Checkpoints at candidate+ have completed-run + dataset lineage, ≥1 eval, and an approval ref on the record.',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    if (!events.some((e) => e.type === 'MODEL_PROMOTION_APPROVED')) {
      return { ok: true, message: 'no approved promotions on this spine (nothing to check)' };
    }
    let derive;
    try {
      ({ deriveModels: derive } = await import(pathToFileURL(join(ctx.repoRoot, 'maddu', 'runtime', 'lib', 'model-projection.mjs')).href));
    } catch (err) {
      // SKIP only on a genuinely absent runtime; a broken lib must surface
      // as a real failure, never fail open (design §7).
      if (err?.code === 'ERR_MODULE_NOT_FOUND') {
        return { ok: true, message: 'runtime model-projection unresolvable from this repo — stage derivation skipped (install the framework runtime to activate this gate)' };
      }
      throw err;
    }
    const reg = derive(events);
    const gated = new Set(['candidate', 'canary', 'released']);
    const problems = [];
    for (const c of reg.checkpoints.values()) {
      if (!gated.has(c.stage)) continue;
      const missing = [];
      const run = c.run_id ? reg.runs.get(c.run_id) : null;
      if (!run) missing.push('completed training run (foreign checkpoint has no lineage)');
      else {
        if (!run.completedAt) missing.push('completed training run');
        if (!run.dataset_snapshot || !reg.datasets.has(run.dataset_snapshot)) missing.push('dataset lineage');
      }
      if (![...reg.evals.values()].some((e) => e.checkpointKey === c.checkpointKey)) missing.push('at least one recorded eval');
      if (![...reg.proposals.values()].some((p) => p.checkpointKey === c.checkpointKey && p.approved)) missing.push('a bound approval ref');
      if (missing.length > 0) problems.push(`${c.checkpointKey.slice(0, 18)}… at ${c.stage}: missing ${missing.join(', ')}`);
    }
    if (problems.length > 0) return { ok: false, message: `${problems.length} candidate+ checkpoint(s) with incomplete provenance — ${problems.join(' · ')}` };
    return { ok: true, message: 'every candidate+ checkpoint carries complete provenance' };
  },
};
