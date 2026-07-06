// @maddu-model-gates v1
// dataset-license-known — SLM-governance starter pack (operator-owned copy;
// installed by `maddu model gates install`, plan pln_20260706133422_0f60).
// Every recorded dataset snapshot must declare a real license — "unknown"
// (or empty) is legal to RECORD but this gate keeps it visible and, when
// ci-pinned, blocking. Declaration-level: the license is the manifest
// author's claim (design §4 honesty rule).

export default {
  id: 'dataset-license-known',
  label: 'dataset license known',
  severity: 'fail',
  description: 'No recorded dataset snapshot declares license "unknown" or empty (declaration-level).',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const ds = events.filter((e) => e.type === 'MODEL_DATASET_SNAPSHOT_RECORDED');
    if (ds.length === 0) return { ok: true, message: 'no dataset snapshots on this spine (nothing to check)' };
    const bad = ds.filter((e) => {
      const lic = e.data?.license;
      return typeof lic !== 'string' || lic.trim() === '' || lic.trim().toLowerCase() === 'unknown';
    });
    if (bad.length > 0) {
      return { ok: false, message: `${bad.length} dataset(s) with unknown/empty license: ${bad.map((e) => e.data?.dataset_id ?? e.id).join(', ')}` };
    }
    return { ok: true, message: `${ds.length} dataset(s), all licenses declared` };
  },
};
