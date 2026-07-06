// @maddu-model-gates v1
// latency-cost-budget-met — SLM-governance starter pack (operator-owned copy).
// OPT-IN (the cost-budget precedent): does nothing until the repo carries
// .maddu/config/model-budgets.json:
//   { "<benchmark>": { "latency_ms_max": 2500, "cost_usd_max": 0.75 } }
// Reads each configured benchmark's eval MANIFEST (current file at the
// recorded path) and compares the conventional keys `latency.ms` and
// `cost.usd` — both DECLARED values (design §4 honesty rule). Evals whose
// manifests omit the keys are reported, not failed. WARN, never FAIL.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default {
  id: 'latency-cost-budget-met',
  label: 'latency/cost budget met',
  severity: 'warn',
  description: 'Declared eval latency.ms / cost.usd within the opt-in budgets (.maddu/config/model-budgets.json).',
  run: async (ctx) => {
    let budgets;
    try { budgets = JSON.parse(await readFile(join(ctx.repoRoot, '.maddu', 'config', 'model-budgets.json'), 'utf8')); }
    catch { return { ok: true, message: 'no model budgets set (opt-in — create .maddu/config/model-budgets.json { "<benchmark>": { latency_ms_max, cost_usd_max } })' }; }

    const events = await ctx.spine.readAll(ctx.repoRoot);
    const evals = events.filter((e) => e.type === 'MODEL_EVAL_RAN' && budgets[e.data?.benchmark]);
    if (evals.length === 0) return { ok: true, message: 'no evals on budgeted benchmarks (nothing to check)' };

    const over = [];
    const undeclared = [];
    for (const ev of evals) {
      const b = budgets[ev.data.benchmark];
      let m = null;
      try { m = JSON.parse(await readFile(join(ctx.repoRoot, String(ev.data?.manifestPath)), 'utf8')); } catch {}
      const lat = m?.latency?.ms;
      const cost = m?.cost?.usd;
      if (typeof b.latency_ms_max === 'number') {
        if (typeof lat !== 'number') undeclared.push(`${ev.data.eval_id}:latency.ms`);
        else if (lat > b.latency_ms_max) over.push(`${ev.data.eval_id} latency ${lat}ms > ${b.latency_ms_max}ms`);
      }
      if (typeof b.cost_usd_max === 'number') {
        if (typeof cost !== 'number') undeclared.push(`${ev.data.eval_id}:cost.usd`);
        else if (cost > b.cost_usd_max) over.push(`${ev.data.eval_id} cost $${cost} > $${b.cost_usd_max}`);
      }
    }
    if (over.length > 0) {
      return { ok: false, message: `${over.length} declared budget overrun(s): ${over.join(' · ')}${undeclared.length ? ` (undeclared: ${undeclared.join(', ')})` : ''}` };
    }
    return { ok: true, message: `${evals.length} budgeted eval(s) within declared budgets${undeclared.length ? ` — ${undeclared.length} value(s) undeclared: ${undeclared.join(', ')}` : ''}` };
  },
};
