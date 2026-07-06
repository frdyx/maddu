// @maddu-model-gates v1
// training-config-pinned — SLM-governance starter pack (operator-owned copy).
// Every recorded training run must pin its configuration of record:
// base-model sha256, seed, and code commit on the event, with the full
// recipe pinned transitively by the recorded manifestHash. (A post-ingest
// manifest edit does NOT unpin the record — the hash on the spine is the
// pin; drift concerns belong to dataset-manifest-no-secrets.)

const SHA = /^sha256:[0-9a-f]{64}$/i;

export default {
  id: 'training-config-pinned',
  label: 'training config pinned',
  severity: 'fail',
  description: 'Every training run pins base_model hash, seed, commit, and a manifestHash (recipe rides the hash).',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const runs = events.filter((e) => e.type === 'MODEL_TRAINING_RUN_STARTED');
    if (runs.length === 0) return { ok: true, message: 'no training runs on this spine (nothing to check)' };
    const bad = runs.filter((e) => {
      const d = e.data || {};
      return !SHA.test(String(d.base_model?.hash ?? ''))
        || typeof d.seed !== 'number'
        || typeof d.commit !== 'string' || d.commit.trim() === ''
        || !SHA.test(String(d.manifestHash ?? ''));
    });
    if (bad.length > 0) {
      return { ok: false, message: `${bad.length} training run(s) with unpinned config: ${bad.map((e) => e.data?.run_id ?? e.id).join(', ')}` };
    }
    return { ok: true, message: `${runs.length} training run(s), all configs pinned` };
  },
};
