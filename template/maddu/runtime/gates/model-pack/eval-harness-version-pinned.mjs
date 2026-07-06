// @maddu-model-gates v1
// eval-harness-version-pinned — SLM-governance starter pack (operator-owned copy).
// An eval without a pinned harness version is not reproducible as recorded.
// WARN by design (matching the contract's verifier severity) — pin it as a
// required ci gate to make it blocking.

export default {
  id: 'eval-harness-version-pinned',
  label: 'eval harness version pinned',
  severity: 'warn',
  description: 'Every recorded eval declares a non-empty harness_version (reproducibility of the record).',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const evals = events.filter((e) => e.type === 'MODEL_EVAL_RAN');
    if (evals.length === 0) return { ok: true, message: 'no model evals on this spine (nothing to check)' };
    const bad = evals.filter((e) => typeof e.data?.harness_version !== 'string' || e.data.harness_version.trim() === '');
    if (bad.length > 0) {
      return { ok: false, message: `${bad.length} eval(s) without a pinned harness version: ${bad.map((e) => e.data?.eval_id ?? e.id).join(', ')}` };
    }
    return { ok: true, message: `${evals.length} eval(s), all harness versions pinned` };
  },
};
