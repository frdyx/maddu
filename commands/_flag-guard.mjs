// _flag-guard.mjs — unknown-flag detection at the dispatch chokepoint (A1).
//
// parseFlags (commands/_args.mjs) accepts ANY --key and no verb validates the
// key set, so a typo'd or stale flag is silently ignored and the value falls
// through to ambient resolution — that is how `session close --session-id`
// closed the wrong session at exit 0 (defect A2). The dispatcher calls
// checkUnknownFlags before every verb; unknown keys EXIT 2 (strict by
// default since v1.122.0, flipped after the v1.120.0 warn soak per the
// operator's warn-then-block ruling). MADDU_STRICT_FLAGS=0 is the temporary
// warn-only opt-out for callers mid-migration; '1' remains accepted.
//
// Exactness note: parseFlags never lets a VALUE start with `--`
// (`argv[i+1].startsWith('--')` demotes it to `true`), so every `--token` in
// rest is definitively a flag key — this scan cannot misread a value.

// Extract flag keys from a raw argv slice, in order, deduped. A bare `--`
// yields the empty key — parseFlags really does treat it as one (key '', and
// it swallows the next token as its value), so it is reported, not skipped.
export function extractFlagKeys(rest) {
  const keys = [];
  const seen = new Set();
  for (const a of rest) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function nearest(key, candidates) {
  let best = null;
  let bestD = 3; // suggestions only within distance 2 — beyond that they mislead
  for (const c of candidates) {
    const d = levenshtein(key, c);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

// → [{ key, suggestion|null }] — empty when everything is known, the verb is
// open/unlisted (fail-open), or rest carries no flags. `--help`/`-h` never
// reach here (the dispatcher short-circuits them), but the universal keys are
// tolerated anyway so a future call path cannot regress into warning on them.
export function checkUnknownFlags({ verb, rest, allowlists }) {
  if (!allowlists || typeof allowlists !== 'object') return [];
  if (Array.isArray(allowlists.open) && allowlists.open.includes(verb)) return [];
  const allowed = allowlists.verbs?.[verb];
  if (!Array.isArray(allowed)) return []; // unlisted verb → fail-open
  const universal = ['help', 'h'];
  const findings = [];
  for (const key of extractFlagKeys(rest)) {
    if (allowed.includes(key) || universal.includes(key)) continue;
    findings.push({ key, suggestion: key ? nearest(key, allowed) : null });
  }
  return findings;
}
