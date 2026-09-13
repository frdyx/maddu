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

// Relative self-test latency, PER PROFILE (v1.138.0, register F1). The manifest
// carries `selfTest.profiles.<profile> = { baselineMs, tolerancePct }`; a quick
// run is judged against the quick baseline and a full run against the full one
// — one number for both judged every full run as 500% over a quick baseline.
//
// Four levels, each its own visible state (never folded into another):
//   OK / WARN     — a supported profile with a recorded duration, judged.
//                   WARN, never FAIL: latency is advisory.
//   SKIP          — a supported profile but no recorded duration (fresh checkout).
//   UNSUPPORTED   — the report's profile has no baseline in the manifest
//                   (smoke, a profile added later, or a report that predates
//                   profile recording). The budget cannot judge it and says so;
//                   this is NOT a skip, because a run DID happen.
// Module-local on purpose: nothing outside reads the table (callers compare the
// string on the verdict), and an unread export is exactly what the v1.137.0
// export-liveness row rejects — it caught this constant in the round-1 funnel.
const LATENCY_LEVELS = Object.freeze({ OK: 'OK', WARN: 'WARN', SKIP: 'SKIP', UNSUPPORTED: 'UNSUPPORTED' });

export function supportedLatencyProfiles(selfTest) {
  const profiles = selfTest && typeof selfTest.profiles === 'object' && selfTest.profiles ? selfTest.profiles : {};
  return Object.keys(profiles)
    .filter((p) => Number.isFinite(Number(profiles[p]?.baselineMs)) && Number(profiles[p].baselineMs) > 0)
    .sort();
}

export function latencyVerdict({ durationMs, profile, selfTest } = {}) {
  const supported = supportedLatencyProfiles(selfTest);
  const name = typeof profile === 'string' && profile ? profile : null;
  const spec = name && supported.includes(name) ? selfTest.profiles[name] : null;
  if (!spec) {
    const have = supported.length ? supported.join(', ') : 'none';
    return {
      level: LATENCY_LEVELS.UNSUPPORTED,
      profile: name,
      supported,
      message: name
        ? `profile "${name}" has no latency baseline (budgeted profiles: ${have}) — the recorded run cannot be judged`
        : `the recorded self-test run has no profile recorded (unknown profile; budgeted profiles: ${have}) — it cannot be judged`,
    };
  }
  const baseline = Number(spec.baselineMs);
  const tol = Number.isFinite(spec.tolerancePct) ? spec.tolerancePct : 50;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { level: LATENCY_LEVELS.SKIP, profile: name, supported, message: `no recorded ${name} self-test duration` };
  }
  const ceiling = baseline * (1 + tol / 100);
  const ratio = durationMs / baseline;
  const secs = (ms) => Math.round(ms / 1000);
  if (durationMs > ceiling) {
    return {
      level: LATENCY_LEVELS.WARN,
      profile: name,
      supported,
      ratio,
      ceiling,
      message: `${name} self-test ${secs(durationMs)}s is ${Math.round((ratio - 1) * 100)}% over the ${secs(baseline)}s ${name} baseline (> ${tol}% tol) — raise the baseline only for a real growth`,
    };
  }
  return {
    level: LATENCY_LEVELS.OK,
    profile: name,
    supported,
    ratio,
    ceiling,
    message: `${name} self-test ${secs(durationMs)}s within ${tol}% of the ${secs(baseline)}s ${name} baseline`,
  };
}

// One terse line for the audit detail: "gates 66/70 · verbs 66/70 · audit-checks 15/17".
export function summarizeBudget(verdict) {
  return (verdict?.rows || [])
    .map((r) => `${r.category} ${r.count}/${r.cap}${r.waivers ? `+${r.waivers}w` : ''}`)
    .join(' · ');
}
