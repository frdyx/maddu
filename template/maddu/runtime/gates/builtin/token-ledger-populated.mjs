// token-ledger-populated — v0.19 Phase 1.
//
// Warns when at least one provider session has closed but the token
// ledger is still empty (or all rows are gemini count-only). The intent
// is to surface a misconfigured wrapper — a real worker ran, exited
// cleanly, but no TOKEN_USAGE_REPORTED landed.
//
// Severity: warn — empty ledgers are valid before the first slice ships.
// We only complain after evidence of real provider activity is on the spine.

export default {
  id: 'token-ledger-populated',
  label: 'token ledger populated',
  severity: 'warn',
  description: 'After a worker session closes, expect at least one TOKEN_USAGE_REPORTED with input/output counts (skipped if no workers exited yet).',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const exitedWorkers = events.filter(
      (e) => e.type === 'WORKER_EXITED' && (e.data?.exitCode === 0 || e.data?.exitCode === null)
    );
    if (exitedWorkers.length === 0) {
      return { ok: true, message: 'no exited workers yet (skipped)' };
    }
    const proj = await ctx.project();
    const ledger = Array.isArray(proj.tokenLedger) ? proj.tokenLedger : [];
    const withTokens = ledger.filter((r) => r.inputTokens != null || r.outputTokens != null);
    if (withTokens.length > 0) {
      return {
        ok: true,
        message: `${withTokens.length} populated row(s) of ${ledger.length} total`,
      };
    }
    // Workers ran; nothing populated. Check whether all rows are gemini-style
    // unreported — those are honest count-only, not a misconfiguration.
    const unreported = ledger.filter((r) => r.inputTokens == null);
    if (ledger.length > 0 && unreported.length === ledger.length) {
      return {
        ok: true,
        message: `${ledger.length} row(s), all count-only (no input/output tokens reported)`,
      };
    }
    return {
      ok: false,
      message: `${exitedWorkers.length} worker(s) exited but token ledger is empty — wrapper may not be wired`,
      evidence: { exitedWorkers: exitedWorkers.length, ledgerRows: ledger.length },
    };
  },
};
