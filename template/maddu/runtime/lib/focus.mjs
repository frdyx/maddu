// Focus Director — deterministic, domain-blind trajectory tagger.
//
// PURE: no IO, no LLM, no spine access. Given the declared goal and a window of
// recent events, it scores how far the pilot's CURRENT attention has drifted
// from the goal, and decides when SUSTAINED drift earns a flag. The cheap-model
// worker (slice worker-flag) only ever runs AFTER shouldFlag() says so — this
// module is the always-on, zero-cost floor that keeps the director honest.
//
// "Domain-blind" by construction: it compares attention-text tokens to
// goal-text tokens. It never inspects code, correctness, or technical merit —
// so it cannot be argued out of a flag on technical grounds.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'under',
  'are', 'was', 'were', 'has', 'have', 'had', 'will', 'would', 'should', 'could',
  'not', 'but', 'all', 'any', 'can', 'its', 'our', 'their', 'then', 'than',
  'add', 'set', 'get', 'use', 'via', 'per', 'out', 'now', 'new', 'one', 'two',
  'slice', 'maddu', 'focus', 'work', 'working', 'task', 'thing', 'stuff',
]);

function round2(x) { return Math.round(x * 100) / 100; }

// Light deterministic suffix-stripper so inflections meet their stems
// ("scored"/"scoring"/"score" → "scor", "verified"/"verify" → "verifi").
// v1.92.2: without this, the goal's vocabulary missed its own inflections in
// slice summaries and honest on-goal turns read as drift. Crude by design —
// it only needs to be SELF-consistent, never linguistically correct.
function stem(t) {
  let s = t;
  if (s.endsWith('ies') || s.endsWith('ied')) s = s.slice(0, -3) + 'i';
  else if (s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.endsWith('ed') || s.endsWith('es')) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.endsWith('e')) s = s.slice(0, -1);
  if (s.endsWith('y')) s = s.slice(0, -1) + 'i';
  return s.length >= 3 ? s : t;
}

// Tokenize free text into meaningful lowercase stems.
export function tokenize(text) {
  const raw = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return raw.filter((t) => t.length >= 3 && !STOPWORDS.has(t)).map(stem);
}

// The goal's keyword set — objective + constraints ONLY. Success-condition
// texts are deliberately excluded (v1.92.2): they are verification commands
// ("self-test", "fixture", "green", "exits 0") whose generic vocabulary
// matched genuinely off-goal maintenance work and diluted the goal's
// distinctive terms. The objective is what the operator MEANS; the
// constraints are how they bound it; the success conditions are how orient
// checks it — only the first two describe the goal axis.
export function goalTokens(goal) {
  if (!goal) return new Set();
  const parts = [goal.objective, ...(goal.constraints || [])];
  return new Set(parts.flatMap(tokenize));
}

// Focus-bearing signals in chronological order: what the pilot said they were
// doing. SESSION_HEARTBEAT.focus / LANE_CLAIMED.focus / SLICE_STOP.summary.
function focusSignals(recentEvents) {
  const out = [];
  for (const ev of recentEvents || []) {
    if (!ev || !ev.type) continue;
    if (ev.type === 'SESSION_HEARTBEAT' && ev.data?.focus) out.push(ev.data.focus);
    else if (ev.type === 'LANE_CLAIMED' && ev.data?.focus) out.push(ev.data.focus);
    else if (ev.type === 'SLICE_STOP' && ev.data?.summary) out.push(ev.data.summary);
  }
  return out;
}

// The pilot's CURRENT attention text = the most recent focus-bearing signal.
export function currentFocusText(recentEvents) {
  const sigs = focusSignals(recentEvents);
  return sigs.length ? sigs[sigs.length - 1] : '';
}

// Domain churn = how many times the focus text changed across the LAST `lookback`
// focus signals. Bounded to a short recent window on purpose: measured over a
// whole active session, churn saturates (every turn re-words its focus), so it
// would read as constant hopping. A short window reflects *current* hopping.
export function churn(recentEvents, lookback = 6) {
  const sigs = focusSignals(recentEvents).map((s) => tokenize(s).sort().join(' ')).slice(-lookback);
  let shifts = 0;
  for (let i = 1; i < sigs.length; i++) if (sigs[i] && sigs[i] !== sigs[i - 1]) shifts++;
  return shifts;
}

// Score a single turn → { tag, distanceScore, signals }.
//   tag: 'toward' | 'lateral' | 'away'
//   distanceScore: 0 (on the goal axis) .. 1 (fully off it)
// Bias-to-silence: no goal declared, or no focus signal yet, → 'toward'
// (never assert drift without evidence — the anti-nag principle).
export function tagTurn(goal, recentEvents, opts = {}) {
  const near = opts.near ?? 0.5;
  const far = opts.far ?? 0.8;
  const churnAway = opts.churnAway ?? 3;
  const gset = goalTokens(goal);
  // How many distinct goal-anchor matches count as fully on-axis. Capped by
  // the goal's own vocabulary so a terse 2-token goal can still be fully met.
  const anchorsFull = Math.min(opts.anchorsFull ?? 4, Math.max(1, gset.size));
  const focusText = currentFocusText(recentEvents);
  const fset = new Set(tokenize(focusText));
  const ch = churn(recentEvents);

  const baseSignals = {
    focusText, churn: ch, goalTokenCount: gset.size, focusTokenCount: fset.size,
  };

  // No goal to drift from, or no evidence of current attention → stay silent.
  if (gset.size === 0) return { tag: 'toward', distanceScore: 0, signals: { ...baseSignals, note: 'no-goal' } };
  if (fset.size === 0) return { tag: 'toward', distanceScore: 0, signals: { ...baseSignals, note: 'no-focus-signal' } };

  // ABSOLUTE anchor count, not a ratio (v1.92.2). The old metric divided the
  // intersection by the focus text's size — so a detailed, honest, on-goal
  // slice summary read as drift (verbosity punished as distance: 5/5 real
  // false positives on 2026-07-03), while the terse were rewarded. What
  // separates on-goal from off-goal in real data is whether the goal's
  // DISTINCTIVE terms appear at all: on-goal texts anchor 2–5 of them,
  // off-goal texts anchor zero.
  const anchorHits = [...fset].filter((t) => gset.has(t)).sort();
  const inter = anchorHits.length;
  const overlap = Math.min(1, inter / anchorsFull); // 0 anchors → 0 · ≥anchorsFull → fully on-axis
  const distanceScore = 1 - overlap;

  // Distance is the PRIMARY signal: a clearly on-goal turn is always 'toward',
  // even amid heavy topic-switching. (Earlier, high churn independently forced
  // 'away', which saturated in any active session — the over-flag / nag-death
  // failure mode.)
  let tag;
  if (distanceScore <= near) tag = 'toward';
  else if (distanceScore >= far) tag = 'away';
  else tag = 'lateral';

  // Churn is only a SECONDARY escalator: a borderline (lateral) turn during
  // genuine recent topic-hopping reads as away. It never overrides goal-proximity.
  if (tag === 'lateral' && ch >= churnAway) tag = 'away';

  return { tag, distanceScore: round2(distanceScore), signals: { ...baseSignals, overlap: round2(overlap), anchors: inter, anchorHits: anchorHits.slice(0, 8) } };
}

// Decide whether the accumulated window earns a flag. Looks at the TRAILING run
// of consecutive non-'toward' tags — a single 'toward' anywhere resets it. This
// is the "sustained, un-returned divergence" rule: one detour is silence; only
// a run of K off-axis turns with no return earns the interrupt.
//   window: array of { tag } (the focus.window projection slot)
//   opts.k: run length that triggers a flag (default 4 — conservative)
export function shouldFlag(window, opts = {}) {
  const k = opts.k ?? 4;
  const w = Array.isArray(window) ? window : [];
  let runs = 0;
  for (let i = w.length - 1; i >= 0; i--) {
    if (w[i] && w[i].tag === 'toward') break;
    runs++;
  }
  const flag = runs >= k;
  return { flag, runs, reason: flag ? `${runs} consecutive turns off the goal axis with no return` : '' };
}
