#!/usr/bin/env node
// digest — the "while you were away" headline copy contract (v1.97.0).
//
// buildDigest's integration path (readSince + project + cached success) is
// exercised end-to-end by `maddu orient --digest` and the cockpit golden. This
// locks the pure digestHeadline() copy so a wording change is a deliberate diff.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { digestHeadline } from '../../template/maddu/runtime/lib/bridge-builders.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const EMPTY_GATES = { ran: 0, failed: 0, failing: [] };

function h(over = {}) {
  return digestHeadline({
    sliceStopCount: 0, driftCount: 0, gates: EMPTY_GATES, needsYou: [],
    goal: { objective: null, metCount: null, total: null, allMet: null },
    ...over,
  });
}

// ── nothing happened ──
ok('empty window → "Nothing new"', h().startsWith('Nothing new since you last looked'));

// ── activity sentence ──
ok('slices landed pluralize', h({ sliceStopCount: 3 }).includes('3 slices landed'));
ok('single slice singular', h({ sliceStopCount: 1 }).includes('1 slice landed'));
ok('gates green when ran, none failed', h({ gates: { ran: 5, failed: 0, failing: [] } }).includes('gates green'));
ok('gates failing wins over green', h({ gates: { ran: 5, failed: 2, failing: [] } }).includes('2 gates failing'));
ok('drift flagged surfaces', h({ driftCount: 4 }).includes('drift flagged'));

// ── needs-you / goal sentence ──
ok('open approvals → need you (plural)', h({ needsYou: [{}, {}] }).includes('2 approvals need you'));
ok('single approval → needs you (singular)', h({ needsYou: [{}] }).includes('1 approval needs you'));
ok('all met → close/release nudge', h({ goal: { allMet: true } }).includes('consider closing or releasing'));
ok('partial goal → met/total', h({ goal: { metCount: 3, total: 4, allMet: false } }).includes('goal 3/4 met'));
ok('no second sentence when nothing needs you', h({ sliceStopCount: 1 }).trim().endsWith('landed.'));

// ── combined ──
const full = h({ sliceStopCount: 2, gates: { ran: 4, failed: 0, failing: [] }, needsYou: [{}], goal: { metCount: 3, total: 4, allMet: false } });
ok('combined headline reads as two sentences', full === 'While you were away: 2 slices landed, gates green. 1 approval needs you; goal 3/4 met.');

try {
  console.log('');
  console.log(`digest: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('digest OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
