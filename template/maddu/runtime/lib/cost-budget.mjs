// cost-budget.mjs (roadmap #14) — the runaway-session guard.
//
// The capture (worker/`maddu usage import` reads Claude Code's on-disk usage →
// TOKEN_USAGE_REPORTED) and the rollup (`maddu cost` over the tokenLedger) already
// ship. The spike confirmed both work (60k+ usage turns importable). The one
// net-new piece F5 names — "a runaway session staying invisible" — is a budget
// signal: WARN (never FAIL — advisory) when recent token spend crosses an opt-in
// ceiling. Pure over the tokenLedger rows + plain config; the gate does the reads.

export const DAY_MS = 86400000;

// Tokens for one ledger row under a metric. 'total' = input+output (the work
// proxy), 'output' = the expensive half, 'input' = context size. Nulls → 0.
export function tokensFor(row, metric = 'total') {
  const i = Number(row && row.inputTokens) || 0;
  const o = Number(row && row.outputTokens) || 0;
  if (metric === 'output') return o;
  if (metric === 'input') return i;
  return i + o;
}

// Verdict over the tokenLedger within a trailing window.
//   rows: [{ ts, inputTokens, outputTokens, ... }]
//   now: epoch ms (injected for tests); windowDays: trailing window;
//   maxTokens: the budget; metric: 'total'|'output'|'input'.
// Returns { level: 'OK'|'WARN'|'SKIP', total, max, windowDays, counted, metric, message }.
// SKIP when there is no usable budget (the gate treats SKIP as a pass).
export function costVerdict({ rows, now = 0, windowDays = 1, maxTokens, metric = 'total' } = {}) {
  const win = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 1;
  const m = (metric === 'output' || metric === 'input') ? metric : 'total';
  const cutoff = now - win * DAY_MS;
  let total = 0, counted = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const t = r && r.ts ? Date.parse(r.ts) : NaN;
    if (Number.isNaN(t) || t < cutoff || t > now) continue;
    total += tokensFor(r, m);
    counted++;
  }
  const max = Number(maxTokens);
  if (!Number.isFinite(max) || max <= 0) {
    return { level: 'SKIP', total, max: null, windowDays: win, counted, metric: m, message: 'no positive maxTokens budget configured' };
  }
  const level = total > max ? 'WARN' : 'OK';
  const pct = Math.round((total / max) * 100);
  // Deterministic comma grouping — locale-independent so the gate message is
  // stable across machines (toLocaleString varies by locale).
  const grp = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return {
    level, total, max, windowDays: win, counted, metric: m,
    message: `${m} tokens ${grp(total)} / ${grp(max)} (${pct}%) over the last ${win}d (${counted} turn(s))`,
  };
}
