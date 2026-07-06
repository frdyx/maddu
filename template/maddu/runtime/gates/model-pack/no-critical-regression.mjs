// @maddu-model-gates v1
// no-critical-regression — SLM-governance starter pack (operator-owned copy).
// No checkpoint at candidate or above (spine-DERIVED stage, never declared)
// may carry a critical regression that lacks an explicit operator
// acknowledgment. Recovery is `maddu model regression ack <eval-id>
// --reason "…"` — a recorded judgment, never "promote again to shadow it".
// The stage derivation is runtime-resolved from the installed framework;
// absent runtime → honest SKIP, never a false ok.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'no-critical-regression',
  label: 'no unacknowledged critical regression',
  severity: 'fail',
  description: 'Checkpoints at candidate+ carry no critical regression without a recorded MODEL_REGRESSION_ACKNOWLEDGED.',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    if (!events.some((e) => e.type === 'MODEL_REGRESSION_FOUND')) {
      return { ok: true, message: 'no critical regressions recorded on this spine (nothing to check)' };
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
    const offenders = [];
    for (const e of reg.evals.values()) {
      if (e.criticalRegressions > 0 && !e.acknowledged) {
        const stage = reg.checkpoints.get(e.checkpointKey)?.stage ?? 'experiment';
        if (gated.has(stage)) offenders.push(`${e.eval_id} (checkpoint at ${stage})`);
      }
    }
    if (offenders.length > 0) {
      return { ok: false, message: `${offenders.length} unacknowledged critical regression eval(s) on candidate+ checkpoints: ${offenders.join(', ')} — acknowledge with \`maddu model regression ack <eval-id> --reason\`` };
    }
    return { ok: true, message: 'every critical regression on a candidate+ checkpoint carries a recorded acknowledgment' };
  },
};
