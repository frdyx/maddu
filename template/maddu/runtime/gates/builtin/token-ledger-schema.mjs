// token-ledger-schema — v0.18 Phase 4.
//
// Verifies every TOKEN_USAGE_REPORTED event in the spine carries the
// minimum schema: { runtime, sessionId, model, ts }. Optional fields
// (inputTokens, outputTokens, cacheRead, cacheCreation) are not
// required — gaps are surfaced honestly by `maddu cost
// --unreported-count` rather than enforced here.
//
// Severity: critical (v0.19 upgrade) — schema violations indicate a
// wrapper or worker is emitting malformed rows. Token rollups can no
// longer trust the projection if minimum-schema rows are present, so
// doctor fails until the worker is fixed.

export default {
  id: 'token-ledger-schema',
  label: 'token ledger schema',
  severity: 'critical',
  description: 'Every TOKEN_USAGE_REPORTED row carries the minimum schema (runtime, sessionId, model, ts).',
  run: async (ctx) => {
    const proj = await ctx.project();
    const ledger = Array.isArray(proj.tokenLedger) ? proj.tokenLedger : [];
    if (ledger.length === 0) {
      return { ok: true, message: 'no token usage reported yet (skipped)' };
    }
    const violations = [];
    for (let i = 0; i < ledger.length; i++) {
      const row = ledger[i];
      const missing = [];
      if (!row.runtime) missing.push('runtime');
      if (!row.sessionId) missing.push('sessionId');
      if (!row.model) missing.push('model');
      if (!row.ts) missing.push('ts');
      if (missing.length) violations.push({ index: i, missing });
    }
    if (violations.length === 0) {
      return {
        ok: true,
        message: `${ledger.length} row(s), schema clean`,
      };
    }
    return {
      ok: false,
      message: `${violations.length} of ${ledger.length} row(s) missing minimum-schema fields`,
      evidence: { violations: violations.slice(0, 10), totalViolations: violations.length },
    };
  },
};
