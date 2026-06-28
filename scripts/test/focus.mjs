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
  ok('goalTokens spans objective+success+constraints', goalTokens(GOAL).has('director') && goalTokens(GOAL).has('deterministic') && goalTokens(GOAL).has('cheap'));

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

  const partial = tagTurn(GOAL, [hb('director drift tagger versus gradient palette swatches today')]);
  ok('partial overlap → lateral', partial.tag === 'lateral', JSON.stringify(partial));

  // --- churn is a bounded, SECONDARY signal (anti-saturation calibration) ---
  const churny = [hb('tagger director drift'), hb('database migrations'), hb('css gradient'), hb('payment webhook')];
  ok('churn counts recent domain shifts', churn(churny) === 3, `churn=${churn(churny)}`);
  // A clearly on-goal turn stays 'toward' even after heavy topic-hopping —
  // churn must NOT override goal-proximity (the over-flag failure mode).
  const onGoalAfterHopping = [hb('database migrations'), hb('css gradient'), hb('payment webhook'), hb('the deterministic tagger for pilot drift director')];
  ok('on-goal turn stays toward despite churn', tagTurn(GOAL, onGoalAfterHopping).tag === 'toward', JSON.stringify(tagTurn(GOAL, onGoalAfterHopping)));
  // A borderline (lateral) turn amid hopping escalates to away…
  const lateralHopping = [hb('billing invoice'), hb('stripe webhook'), hb('css gradient'), hb('director drift gradient palette swatches')];
  ok('lateral + high churn escalates to away', tagTurn(GOAL, lateralHopping).tag === 'away', JSON.stringify(tagTurn(GOAL, lateralHopping)));
  // …but the SAME lateral focus, held steady, stays lateral (low churn).
  const lateralStable = [hb('director drift gradient palette swatches'), hb('director drift gradient palette swatches')];
  ok('lateral + low churn stays lateral', tagTurn(GOAL, lateralStable).tag === 'lateral', JSON.stringify(tagTurn(GOAL, lateralStable)));

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
