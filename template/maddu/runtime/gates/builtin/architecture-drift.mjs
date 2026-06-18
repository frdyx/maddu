// architecture-drift — v1.18.0.
//
// Compares the declared architecture CONTRACT
// (.maddu/config/architecture.json) against the OBSERVED code import graph and
// reports drift, honoring the contract's `failOn` ladder:
//
//   failOn: "none"  → WARN (visible, never blocks) — the default + ratchet
//   failOn: "new"   → FAIL on violations not in the baseline (grandfathered)
//   failOn: "any"   → FAIL on any violation
//
// Severity is `safety` so it CAN fail; for failOn:none the run returns
// status:'warn' so it shows as a WARN row without blocking doctor. Skips
// gracefully when no contract exists (the common case — most repos, and the
// Máddu framework source itself, declare none).

import { loadContract, contractOptions, assessDrift, loadBaseline, evaluateFailOn, violationList } from '../../lib/architecture.mjs';

export default {
  id: 'architecture-drift',
  label: 'architecture drift',
  severity: 'safety',
  description: 'observed import graph matches the declared architecture contract (failOn ladder).',
  run: async (ctx) => {
    const repoRoot = ctx.repoRoot;
    let contract, contractPath;
    try { ({ contract, path: contractPath } = await loadContract(repoRoot)); }
    catch (err) { return { ok: false, message: `invalid architecture contract: ${err.message}` }; }
    if (!contract) return { ok: true, message: 'no architecture contract (.maddu/config/architecture.json) — skipped' };

    const opts = contractOptions(contract);
    const result = await assessDrift({ repoRoot, contract });
    const baseline = await loadBaseline(repoRoot);
    const evalR = evaluateFailOn(result, baseline.keys, opts.failOn);
    const total = violationList(result).length;

    if (total === 0) {
      return { ok: true, message: `contract and reality agree — ${result.counts.modules} module(s), ${result.counts.edges} edge(s), drift score 0` };
    }

    const detail = `drift score ${result.driftScore} — forbidden:${result.counts.forbidden} cycles:${result.counts.cycles} undeclared:${result.counts.undeclared} (failOn:${opts.failOn}, ${evalR.new} new vs baseline)`;
    const evidence = {
      driftScore: result.driftScore,
      forbidden: result.violations.forbidden.map((f) => `${f.from}->${f.to}`),
      cycles: result.violations.cycles.map((c) => c.modules.join('->')),
      undeclared: result.violations.undeclared.map((u) => u.area),
      new: evalR.freshViolations.map((v) => v.key),
    };

    if (opts.failOn === 'none') {
      // Visible WARN, never blocks; nudge toward hardening.
      return { ok: true, status: 'warn', message: `${detail} — set options.failOn:"new" to enforce`, evidence };
    }
    if (evalR.blocking) {
      return { ok: false, message: detail, evidence };
    }
    return { ok: true, message: `${detail} — all grandfathered by baseline`, evidence };
  },
};
