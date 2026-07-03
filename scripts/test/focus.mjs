#!/usr/bin/env node
// focus — deterministic trajectory tagger (Focus Director, slice tagger).
//
// Verifies the pure tagger: goal/attention overlap drives toward/lateral/away,
// churn escalates, bias-to-silence holds (no goal / no signal → toward), and
// shouldFlag fires only on a sustained, un-returned run of off-axis turns.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { tagTurn, shouldFlag, tokenize, goalTokens, churn } from '../../template/maddu/runtime/lib/focus.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const GOAL = {
  objective: 'ship the focus director that tags pilot drift against the declared goal',
  success: [{ text: 'deterministic tagger emits toward lateral away', verify: null }],
  constraints: ['cheap worker only writes the flag'],
};

function hb(focus) { return { type: 'SESSION_HEARTBEAT', data: { focus } }; }

function main() {
  // --- tokenize / goalTokens basics ---
  ok('tokenize drops stopwords + short', !tokenize('the and a director drift').includes('the') && tokenize('director drift').includes('director'));
  ok('tokenize stems inflections to a shared form', tokenize('scored scoring score').every((t) => t === 'scor')
    && tokenize('verified')[0] === tokenize('verify')[0], JSON.stringify(tokenize('scored scoring score verify verified')));
  // v1.92.2: success-condition texts are verification commands whose generic
  // vocabulary ("fixture", "green") matched off-goal maintenance work — the
  // goal axis is objective + constraints ONLY.
  ok('goalTokens spans objective+constraints', goalTokens(GOAL).has('director') && goalTokens(GOAL).has('cheap'));
  ok('goalTokens excludes success-condition text', !goalTokens(GOAL).has('deterministic'));

  // --- bias to silence ---
  ok('no goal → toward', tagTurn(null, [hb('anything at all')]).tag === 'toward');
  ok('no focus signal → toward', tagTurn(GOAL, []).tag === 'toward');
  ok('no focus note set', tagTurn(GOAL, []).signals.note === 'no-focus-signal');

  // --- on-axis vs off-axis ---
  const onAxis = tagTurn(GOAL, [hb('working on the deterministic tagger for pilot drift director')]);
  ok('goal-aligned attention → toward', onAxis.tag === 'toward', JSON.stringify(onAxis));
  ok('toward has low distance', onAxis.distanceScore < 0.5, `dist=${onAxis.distanceScore}`);

  const offAxis = tagTurn(GOAL, [hb('redesigning the marketing landing page hero gradient animation')]);
  ok('unrelated attention → away', offAxis.tag === 'away', JSON.stringify(offAxis));
  ok('away has high distance', offAxis.distanceScore > 0.75, `dist=${offAxis.distanceScore}`);

  const partial = tagTurn(GOAL, [hb('director gradient palette swatches today')]);
  ok('single anchor → lateral', partial.tag === 'lateral', JSON.stringify(partial));

  // --- churn is a bounded, SECONDARY signal (anti-saturation calibration) ---
  const churny = [hb('tagger director drift'), hb('database migrations'), hb('css gradient'), hb('payment webhook')];
  ok('churn counts recent domain shifts', churn(churny) === 3, `churn=${churn(churny)}`);
  // A clearly on-goal turn stays 'toward' even after heavy topic-hopping —
  // churn must NOT override goal-proximity (the over-flag failure mode).
  const onGoalAfterHopping = [hb('database migrations'), hb('css gradient'), hb('payment webhook'), hb('the deterministic tagger for pilot drift director')];
  ok('on-goal turn stays toward despite churn', tagTurn(GOAL, onGoalAfterHopping).tag === 'toward', JSON.stringify(tagTurn(GOAL, onGoalAfterHopping)));
  // A borderline (lateral) turn amid hopping escalates to away…
  const lateralHopping = [hb('billing invoice'), hb('stripe webhook'), hb('css gradient'), hb('director gradient palette swatches')];
  ok('lateral + high churn escalates to away', tagTurn(GOAL, lateralHopping).tag === 'away', JSON.stringify(tagTurn(GOAL, lateralHopping)));
  // …but the SAME lateral focus, held steady, stays lateral (low churn).
  const lateralStable = [hb('director gradient palette swatches'), hb('director gradient palette swatches')];
  ok('lateral + low churn stays lateral', tagTurn(GOAL, lateralStable).tag === 'lateral', JSON.stringify(tagTurn(GOAL, lateralStable)));

  // --- regression: the 2026-07-03 real false positives (v1.92.2) ---
  // Verbose, honest, squarely-on-goal slice summaries read as 'away' (0.85–0.99)
  // under the old inter/focusSize ratio — verbosity punished as distance. The
  // absolute-anchor metric must tag them toward, while the doctor detour (a
  // TRUE positive: off-goal maintenance during the same goal) stays away.
  const REAL_GOAL = {
    objective: 'Ship earned autonomy (maddu autonomy, roadmap #11): Wilson-scored recommend-only trust ladder over the verified record',
    success: [
      { text: 'per-lane score+rung JSON exits 0' },
      { text: 'all green incl. autonomy fixture' },
      { text: '16+/0 with charter row for autonomy' },
    ],
    constraints: [],
  };
  const verbose = tagTurn(REAL_GOAL, [hb('Phase 2 COMPLETE (earned autonomy): pure scoring engine template/maddu/runtime/lib/autonomy.mjs + fixture autonomy-score (34/34) shipped as PR #212, CI green. Implements the merged proposal verbatim. Self-test 106/106, audit 16/0.')]);
  ok('REGRESSION: verbose on-goal slice summary → toward', verbose.tag === 'toward', JSON.stringify({ tag: verbose.tag, d: verbose.distanceScore, anchors: verbose.signals.anchors }));
  const verbose2 = tagTurn(REAL_GOAL, [hb('Phase 5 COMPLETE + PLAN COMPLETE (earned autonomy, roadmap #11): docs sweep shipped as PR #215 — docs/47-earned-autonomy.md, index row+blurb, cli-reference section, README earned-autonomy row.')]);
  ok('REGRESSION: docs-sweep on-goal summary → toward', verbose2.tag === 'toward', JSON.stringify({ tag: verbose2.tag, anchors: verbose2.signals.anchors }));
  const detour = tagTurn(REAL_GOAL, [hb('v1.91.2 built + PR #210 open (CI green): doctor global-binary-currency check (source repo WARN/INFO/PASS vs checkout version) + direction-aware consumer framework-version WARN + fixture doctor-global-currency 11/0.')]);
  ok('REGRESSION: true off-goal detour still away (success-text vocabulary no longer matches)', detour.tag === 'away', JSON.stringify({ tag: detour.tag, anchors: detour.signals.anchors }));
  const unrelated = tagTurn(REAL_GOAL, [hb('Investigated Loopia SSH deploy for snyggare kalkyl page; DNS subdomain created in control panel')]);
  ok('REGRESSION: unrelated work → away', unrelated.tag === 'away', JSON.stringify({ tag: unrelated.tag, anchors: unrelated.signals.anchors }));
  ok('signals carry anchors + hits for legibility', typeof verbose.signals.anchors === 'number' && Array.isArray(verbose.signals.anchorHits));

  // --- shouldFlag: sustained, un-returned run ---
  const W = (...tags) => tags.map((tag) => ({ tag }));
  ok('4 away → flag', shouldFlag(W('away', 'away', 'away', 'away')).flag === true);
  ok('flag reports run length (toward resets)', shouldFlag(W('toward', 'away', 'away', 'away', 'away')).runs === 4);
  ok('lateral counts as off-axis in run', shouldFlag(W('lateral', 'away', 'away', 'away', 'away')).runs === 5);
  ok('toward in trailing run → no flag', shouldFlag(W('away', 'away', 'toward', 'lateral')).flag === false);
  ok('3 off-axis < K → no flag', shouldFlag(W('toward', 'lateral', 'away', 'lateral')).flag === false);
  ok('4 lateral → flag (lateral counts)', shouldFlag(W('lateral', 'lateral', 'lateral', 'lateral')).flag === true);
  ok('custom k respected', shouldFlag(W('away', 'away'), { k: 2 }).flag === true);
  ok('empty window → no flag', shouldFlag([]).flag === false);
}

try {
  main();
  console.log('');
  console.log(`focus: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('focus OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
