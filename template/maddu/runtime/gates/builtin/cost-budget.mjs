// cost-budget (roadmap #14, F5) — WARN when recent token spend crosses a ceiling.
//
// OPT-IN: does nothing unless the repo carries .maddu/config/cost-budget.json:
//   { "windowDays": 1, "maxTokens": 2000000, "metric": "total" }
// (metric: "total"|"output"|"input", default "total"). With a budget set, this
// reads the tokenLedger projection (TOKEN_USAGE_REPORTED, populated by
// `maddu usage import` / spawned workers), sums spend in the trailing window, and
// WARNs — never FAILs — when it's over. Advisory: makes a runaway session visible
// in doctor/audit without ever blocking a land. No provider call (rule #5): it
// only sums numbers the ledger already holds.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGateLib } from '../../lib/gate-libroot.mjs';

export default {
  id: 'cost-budget',
  label: 'cost budget',
  severity: 'warn',
  description: 'Recent token spend is within the opt-in budget (.maddu/config/cost-budget.json). Advisory — WARN, never FAIL.',
  run: async (ctx) => {
    let cfg;
    try { cfg = JSON.parse(await readFile(join(ctx.repoRoot, '.maddu', 'config', 'cost-budget.json'), 'utf8')); }
    catch { return { ok: true, message: 'no cost budget set (opt-in — create .maddu/config/cost-budget.json {windowDays,maxTokens,metric})' }; }

    const lib = await loadGateLib(ctx.repoRoot, 'cost-budget.mjs');
    if (!lib?.costVerdict) return { ok: true, message: 'cost-budget lib not present (skipped)' };

    let proj;
    try { proj = await ctx.project(ctx.repoRoot); }
    catch { return { ok: true, message: 'projection unavailable (skipped)' }; }
    const rows = Array.isArray(proj.tokenLedger) ? proj.tokenLedger : [];

    const v = lib.costVerdict({ rows, now: Date.now(), windowDays: cfg.windowDays, maxTokens: cfg.maxTokens, metric: cfg.metric });
    if (v.level === 'SKIP') return { ok: true, message: `cost-budget.json: ${v.message} (skipped)` };
    if (v.level === 'WARN') {
      return { ok: false, status: 'warn', message: `over budget — ${v.message}`, evidence: { total: v.total, max: v.max, windowDays: v.windowDays, metric: v.metric } };
    }
    return { ok: true, message: `within budget — ${v.message}` };
  },
};
