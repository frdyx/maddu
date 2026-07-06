// @maddu-model-gates v1
// train-eval-split-frozen — SLM-governance starter pack (operator-owned copy).
// A dataset's declared definition (including its train/eval split hashes)
// must never change across snapshots of the same dataset_id. The recorded
// manifestHash is the frozen declaration: two snapshots of one id with
// different hashes mean the split cannot be proven frozen. `maddu model`
// refuses duplicate ids outright, so a violation here means a foreign
// writer or hand-crafted events — exactly what a gate should surface.

export default {
  id: 'train-eval-split-frozen',
  label: 'train/eval split frozen',
  severity: 'fail',
  description: 'Snapshots sharing a dataset_id share one manifestHash — the declared split never silently changes.',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const ds = events.filter((e) => e.type === 'MODEL_DATASET_SNAPSHOT_RECORDED' && e.data?.dataset_id);
    if (ds.length === 0) return { ok: true, message: 'no dataset snapshots on this spine (nothing to check)' };
    const byId = new Map();
    for (const e of ds) {
      const id = e.data.dataset_id;
      if (!byId.has(id)) byId.set(id, new Set());
      byId.get(id).add(String(e.data.manifestHash ?? '(none)'));
    }
    const drifted = [...byId.entries()].filter(([, hashes]) => hashes.size > 1).map(([id]) => id);
    if (drifted.length > 0) {
      return { ok: false, message: `${drifted.length} dataset_id(s) with divergent snapshot declarations (split not provably frozen): ${drifted.join(', ')}` };
    }
    return { ok: true, message: `${byId.size} dataset id(s), each with a single frozen declaration` };
  },
};
