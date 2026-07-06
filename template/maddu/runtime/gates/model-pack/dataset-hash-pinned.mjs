// @maddu-model-gates v1
// dataset-hash-pinned — SLM-governance starter pack (operator-owned copy).
// Every recorded dataset snapshot must declare a sha256 artifact hash — the
// declared identity of the data the factory trained on. Declaration-level:
// Máddu never fetches the artifact (design §1 non-goals).

const SHA = /^sha256:[0-9a-f]{64}$/i;

export default {
  id: 'dataset-hash-pinned',
  label: 'dataset hash pinned',
  severity: 'fail',
  description: 'Every recorded dataset snapshot declares a sha256:<hex> artifact hash (declaration-level).',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const ds = events.filter((e) => e.type === 'MODEL_DATASET_SNAPSHOT_RECORDED');
    if (ds.length === 0) return { ok: true, message: 'no dataset snapshots on this spine (nothing to check)' };
    const bad = ds.filter((e) => !SHA.test(String(e.data?.hash ?? '')));
    if (bad.length > 0) {
      return { ok: false, message: `${bad.length} dataset(s) without a sha256-pinned artifact hash: ${bad.map((e) => e.data?.dataset_id ?? e.id).join(', ')}` };
    }
    return { ok: true, message: `${ds.length} dataset(s), all artifact hashes declared` };
  },
};
