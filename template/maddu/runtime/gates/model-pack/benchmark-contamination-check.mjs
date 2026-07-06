// @maddu-model-gates v1
// benchmark-contamination-check — SLM-governance starter pack (operator-owned copy).
// DECLARATION-LEVEL ONLY, and the message says so: this cannot detect actual
// content contamination (that needs the eval harness's own decontamination
// tooling). What it CAN hold true from the record:
//   1. an eval's benchmark id must not appear in the training dataset's
//      declared source (a declared "we trained on the benchmark" is flagged);
//   2. a dataset's declared train/eval split hashes must differ (an
//      identical hash declares train==eval — self-evaluation).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default {
  id: 'benchmark-contamination-check',
  label: 'benchmark contamination (declared)',
  severity: 'warn',
  description: 'Declared sources/splits show no benchmark contamination. DECLARATION-LEVEL — cannot see dataset content.',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const ds = events.filter((e) => e.type === 'MODEL_DATASET_SNAPSHOT_RECORDED');
    const runs = events.filter((e) => e.type === 'MODEL_TRAINING_RUN_STARTED');
    const ckpts = events.filter((e) => e.type === 'MODEL_CHECKPOINT_REGISTERED');
    const evals = events.filter((e) => e.type === 'MODEL_EVAL_RAN');
    if (evals.length === 0 && ds.length === 0) return { ok: true, message: 'no model evals/datasets on this spine (nothing to check)' };

    const issues = [];

    // 1. benchmark id vs the training dataset's declared source
    const lc = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
    const runByCkpt = new Map(ckpts.filter((c) => c.data?.run_id).map((c) => [lc(c.data.checkpointKey), c.data.run_id]));
    const dsByRun = new Map(runs.map((r) => [r.data?.run_id, r.data?.dataset_snapshot]));
    const srcByDs = new Map(ds.map((d) => [d.data?.dataset_id, String(d.data?.source ?? '')]));
    for (const ev of evals) {
      const bench = String(ev.data?.benchmark ?? '').toLowerCase();
      if (!bench) continue;
      const dsId = dsByRun.get(runByCkpt.get(lc(ev.data?.checkpointKey)));
      const src = (srcByDs.get(dsId) ?? '').toLowerCase();
      if (dsId && src.includes(bench)) {
        issues.push(`eval ${ev.data?.eval_id}: benchmark "${ev.data?.benchmark}" appears in training dataset ${dsId}'s declared source`);
      }
    }

    // 2. declared split hashes must differ (read the current manifest once
    //    per dataset_id — duplicate snapshots must not double-report)
    const seenDs = new Set();
    for (const d of ds) {
      const id = d.data?.dataset_id;
      if (seenDs.has(id)) continue;
      seenDs.add(id);
      let m = null;
      try { m = JSON.parse(await readFile(join(ctx.repoRoot, String(d.data?.manifestPath)), 'utf8')); } catch {}
      const split = m?.train_eval_split;
      if (split && split.train && split.train === split.eval) {
        issues.push(`dataset ${id}: declared train and eval split hashes are IDENTICAL`);
      }
    }

    if (issues.length > 0) return { ok: false, message: `${issues.length} declared-contamination signal(s) — ${issues.join(' · ')} (declaration-level; content-level decontamination is the harness's job)` };
    return { ok: true, message: `no declared-contamination signals across ${evals.length} eval(s) / ${ds.length} dataset(s) (declaration-level only)` };
  },
};
