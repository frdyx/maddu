#!/usr/bin/env node
// reflect-scan (learn scan v1) — read-only completion-claim-without-proof scan.
//
// Verifies the deterministic core: the hedge lexicon + benign allowlist, the
// OBSERVED-proof join (verified deliverable on-event OR a real GATE_RAN ok that
// ran during the slice), that self-reported data.gates/data.targets are NOT
// proof, null/absence safety on pre-schema events, and recency filtering.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import {
  scanCompletionClaims,
  hedgesCompletion,
  BEHAVIOR,
  PROPOSED_NOTE,
} from '../../template/maddu/runtime/lib/reflect.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// ── event builders ──────────────────────────────────────────────────────────
let seq = 0;
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
function ts(offsetMin = 0) { return new Date(T0 + offsetMin * 60000).toISOString(); }
function sliceStop(summary, data = {}, offsetMin = 0) {
  seq++;
  return { id: `evt_ss_${seq}`, type: 'SLICE_STOP', ts: ts(offsetMin), lane: 'harness',
    data: { summary, targets: [], paths: [], gates: [], deliverables: null, ...data } };
}
function gateRan(status = 'ok', offsetMin = 0) {
  seq++;
  return { id: `evt_g_${seq}`, type: 'GATE_RAN', ts: ts(offsetMin),
    data: { gateId: 'some-gate', ok: status === 'ok', status } };
}

function main() {
  // ── hedgesCompletion: lexicon + benign allowlist ──
  ok('hedge: "should work"', hedgesCompletion('SLICE STOP: wired it up. should work.'));
  ok('hedge: "seems to pass"', hedgesCompletion('refactor done, seems to pass the tests'));
  ok('hedge: "probably fine"', hedgesCompletion('tweaked config, probably fine'));
  ok('hedge: "i think it works"', hedgesCompletion('added handler — i think it works now'));
  ok('benign: "should never" (prescriptive)', !hedgesCompletion('note: secrets should never be committed'));
  ok('benign: "next slice should extract"', !hedgesCompletion('done; next slice should extract renderChats'));
  ok('benign: "should be covered by gate"', !hedgesCompletion('this should be covered by the coherence gate'));
  ok('non-hedge: confident "Done."', !hedgesCompletion('Done. tests pass.'));
  ok('empty summary is not a hedge', !hedgesCompletion(''));
  ok('null summary is not a hedge', !hedgesCompletion(null));

  // ── THE JOIN: hedge + no proof = match; hedge + real proof = NOT a match ──
  const joinA = scanCompletionClaims([
    sliceStop('feature added, should work'), // hedge, no proof → MATCH
    sliceStop('feature added, should work', { deliverables: { declared: 1, verified: 1, missing: [] } }), // hedge + verified deliverable → NO match
  ]);
  ok('hedge + no proof → 1 match', joinA.cumulativeCount === 1, `got ${joinA.cumulativeCount}`);
  ok('hedge + verified deliverable → excluded (honest confidence)',
    joinA.matches.every((m) => !m.summary.includes('verified')) && joinA.cumulativeCount === 1);

  // observed GATE_RAN ok during the slice → proof → excluded
  const joinB = scanCompletionClaims([
    gateRan('ok'),
    sliceStop('should work'), // preceded by a real ok gate → proof → NO match
  ]);
  ok('hedge preceded by real GATE_RAN(ok) → excluded', joinB.cumulativeCount === 0, `got ${joinB.cumulativeCount}`);

  // failing gate is NOT proof
  const joinC = scanCompletionClaims([
    gateRan('fail'),
    sliceStop('should work'),
  ]);
  ok('hedge preceded by GATE_RAN(fail) → still a match', joinC.cumulativeCount === 1, `got ${joinC.cumulativeCount}`);

  // ── self-report is NOT proof (the core correction) ──
  const selfReport = scanCompletionClaims([
    // agent typed --gates test --targets src/x.js but NO real gate ran and
    // deliverables was null (e.g. --no-git-diff) → self-report must not count.
    sliceStop('should work', { gates: ['test'], targets: ['src/x.js'], deliverables: null }),
  ]);
  ok('self-reported gates/targets are NOT proof → still a match',
    selfReport.cumulativeCount === 1, `got ${selfReport.cumulativeCount}`);

  // verified===0 (declared but hollow) is NOT proof
  const hollow = scanCompletionClaims([
    sliceStop('should work', { deliverables: { declared: 1, verified: 0, missing: ['src/x.js'] } }),
  ]);
  ok('hollow deliverable (verified 0) is NOT proof → match', hollow.cumulativeCount === 1, `got ${hollow.cumulativeCount}`);

  // ── null / absence safety (pre-schema + odd events must not crash) ──
  const nullSafe = scanCompletionClaims([
    { id: 'e1', type: 'SLICE_STOP', ts: ts(), data: undefined }, // no data at all
    { id: 'e2', type: 'SLICE_STOP', ts: ts() }, // no data key
    { type: 'GATE_RAN' }, // no data on gate
    null, // stray null in the list
    sliceStop('should work'), // → the only match
  ]);
  ok('pre-schema / null events do not crash + still find the real match',
    nullSafe.cumulativeCount === 1, `got ${nullSafe.cumulativeCount}`);
  ok('non-array input returns empty, no throw', scanCompletionClaims(null).cumulativeCount === 0);

  // ── threshold + recency ──
  const now = Date.parse('2026-06-02T00:00:00.000Z');
  const threeRecent = scanCompletionClaims([
    sliceStop('should work', {}, 0),
    sliceStop('probably fine', {}, 10),
    sliceStop('seems to work', {}, 20),
  ], { nowMs: now });
  ok('3 recent hedged-no-proof → crossed', threeRecent.crossed === true && threeRecent.cumulativeCount === 3);

  const twoRecent = scanCompletionClaims([
    sliceStop('should work', {}, 0),
    sliceStop('probably fine', {}, 10),
  ], { nowMs: now });
  ok('2 hedged → below threshold, not crossed', twoRecent.crossed === false && twoRecent.cumulativeCount === 2);

  // stale: 3 matches but all ~6 months old relative to now → not "live"
  const stale = scanCompletionClaims([
    sliceStop('should work', {}, 0),
    sliceStop('probably fine', {}, 10),
    sliceStop('seems to work', {}, 20),
  ], { nowMs: Date.parse('2026-12-01T00:00:00.000Z'), recentDays: 30 });
  ok('3 stale matches (all > 30d old) → cumulative>=3 but NOT crossed (recentCount 0)',
    stale.cumulativeCount === 3 && stale.recentCount === 0 && stale.crossed === false);

  // ── contract surface ──
  ok('behavior tag is the fixed constant', threeRecent.behavior === BEHAVIOR);
  ok('proposedNote is the fixed maddu-authored template', threeRecent.proposedNote === PROPOSED_NOTE);
  ok('proposedNote contains no untrusted summary bytes', !PROPOSED_NOTE.includes('should work.'));

  console.log(`\nreflect-scan: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

try { main(); } catch (e) { console.error('harness error:', e); process.exit(2); }
