// governance-budget.mjs (roadmap #7) — the self-applying cap on Máddu's own
// governance surface.
//
// F3 (dead event domains) and F4 (the discipline layer mistaken for dead
// orchestration) were both "surface grew faster than dead surface retired".
// The fix for each was MORE machinery — a gate, a registry, a verb. Without a
// budget, the cure for F3/F4 becomes the next F3/F4: the enforcement layer
// itself bloats unchecked. This caps each governance category (gates, CLI
// verbs, audit checks). To exceed a cap you must retire/merge something OR log
// a waiver — each waiver raises that category's effective cap by exactly one
// and shows as visible debt, so the escape hatch is always recorded, never
// silent.
//
// Pure over plain data: `budgetVerdict({counts, manifest})` over already-read
// counts + the manifest; `latencyVerdict({durationMs, selfTest})` over the last
// recorded self-test duration. No fs, no clock — the audit check does the
// reads and hands plain numbers in, so the whole thing is fixture-testable.

export const BUDGET_LEVELS = Object.freeze({ OK: 'OK', WARN: 'WARN', OVER: 'OVER' });

// Active waivers for a category. A waiver is any row whose `category` matches;
// its presence is what raises the ceiling (the `reason`/`added` fields are for
// humans + the audit detail, not the arithmetic).
export function waiversFor(category, manifest) {
  const list = Array.isArray(manifest?.waivers) ? manifest.waivers : [];
  return list.filter((w) => w && w.category === category);
}

// Effective cap = declared cap + one slot per active waiver. A category with no
// declared cap is unbounded (Infinity) — it simply isn't budgeted yet.
export function effectiveCap(category, manifest) {
  const spec = manifest?.categories?.[category];
  const base = spec && Number.isFinite(spec.cap) ? spec.cap : Infinity;
  return base + waiversFor(category, manifest).length;
}

// Verdict over every declared category. `counts` is { <category>: number } read
// from ground truth by the caller. Returns:
//   level: 'PASS' (all OK) | 'WARN' (a category carried by waivers) | 'FAIL'
//          (a category over even its waiver-raised ceiling).
//   rows:  per-category { category, count, cap, waivers, effectiveCap, level, note }
//   over/warn: the rows at each non-OK level (for a terse detail line).
export function budgetVerdict({ counts, manifest } = {}) {
  const cats = manifest?.categories || {};
  const rows = [];
  for (const [category, spec] of Object.entries(cats)) {
    const count = Number(counts?.[category] ?? 0);
    const cap = Number.isFinite(spec?.cap) ? spec.cap : Infinity;
    const waivers = waiversFor(category, manifest).length;
    const eff = cap + waivers;
    let level = BUDGET_LEVELS.OK;
    if (count > eff) level = BUDGET_LEVELS.OVER;          // over even with waivers → must retire
    else if (count > cap) level = BUDGET_LEVELS.WARN;     // within cap+waivers → recorded debt
    rows.push({ category, count, cap, waivers, effectiveCap: eff, level, note: spec?.note || '' });
  }
  rows.sort((a, b) => a.category.localeCompare(b.category));
  const over = rows.filter((r) => r.level === BUDGET_LEVELS.OVER);
  const warn = rows.filter((r) => r.level === BUDGET_LEVELS.WARN);
  const level = over.length ? 'FAIL' : (warn.length ? 'WARN' : 'PASS');
  return { level, rows, over, warn };
}

// Relative self-test latency. WARN (never FAIL — latency is advisory) when the
// last recorded duration exceeds baselineMs * (1 + tolerancePct/100). SKIP when
// either number is missing/unusable so a fresh or consumer checkout degrades to
// silence rather than a false alarm.
export function latencyVerdict({ durationMs, selfTest } = {}) {
  const baseline = Number(selfTest?.baselineMs);
  const tol = Number.isFinite(selfTest?.tolerancePct) ? selfTest.tolerancePct : 50;
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return { level: 'SKIP', message: 'no self-test baseline configured' };
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { level: 'SKIP', message: 'no recorded self-test duration' };
  }
  const ceiling = baseline * (1 + tol / 100);
  const ratio = durationMs / baseline;
  const secs = (ms) => Math.round(ms / 1000);
  if (durationMs > ceiling) {
    return {
      level: 'WARN',
      ratio,
      ceiling,
      message: `self-test ${secs(durationMs)}s is ${Math.round((ratio - 1) * 100)}% over the ${secs(baseline)}s baseline (> ${tol}% tol) — raise the baseline only for a real growth`,
    };
  }
  return {
    level: 'OK',
    ratio,
    ceiling,
    message: `self-test ${secs(durationMs)}s within ${tol}% of ${secs(baseline)}s baseline`,
  };
}

// One terse line for the audit detail: "gates 66/70 · verbs 66/70 · audit-checks 15/17".
export function summarizeBudget(verdict) {
  return (verdict?.rows || [])
    .map((r) => `${r.category} ${r.count}/${r.cap}${r.waivers ? `+${r.waivers}w` : ''}`)
    .join(' · ');
}
