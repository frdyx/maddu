#!/usr/bin/env node
// autonomy-score — the earned-autonomy scorer (roadmap #11, phase 2).
//
// Pure-function fixture over synthetic spine events: Wilson math (incl. the
// small-vs-large-sample ordering that motivates the statistic), session-join
// lane attribution, the outcome trichotomy (+neutral), gate-window binding
// (unstamped / actor-stamped / sliceId-stamped), the daily clean-credit cap,
// rung boundaries (all-clean crosses candidate at exactly n=22), dirty-recency
// veto, and byte-identical determinism.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import {
  wilsonLower, scoreAutonomy, classifyOutcomes, thresholdsHash, DEFAULT_THRESHOLDS,
} from '../../template/maddu/runtime/lib/autonomy.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// ── synthetic event builders ──
let seq = 0;
function ts(dayOffset = 0, minute = 0) {
  return new Date(Date.parse('2026-07-01T00:00:00Z') + dayOffset * 86400000 + minute * 60000).toISOString();
}
function evId() { return `evt_test_${String(++seq).padStart(4, '0')}`; }
function session(id, lane, auto = false) {
  return { id: evId(), ts: ts(), type: auto ? 'SESSION_AUTO_REGISTERED' : 'SESSION_REGISTERED', actor: id, lane, data: {} };
}
function claim(sid, lane) {
  return { id: evId(), ts: ts(), type: 'LANE_CLAIMED', actor: sid, lane, data: {} };
}
function gate(data, actor = null) {
  return { id: evId(), ts: ts(), type: 'GATE_RAN', actor, lane: null, data };
}
function slice(sid, { day = 0, minute = 0, summary = 'did the work', declared = 0, verified = 0, missing = [], lane = null, id = null } = {}) {
  return {
    id: id || evId(), ts: ts(day, minute), type: 'SLICE_STOP', actor: sid, lane,
    data: { summary, deliverables: { declared, verified, missing } },
  };
}
function legacySlice(sid, { day = 0, summary = 'old-style stop' } = {}) {
  return { id: evId(), ts: ts(day), type: 'SLICE_STOP', actor: sid, lane: null, data: { summary } };
}

// ── Wilson math ──
ok('wilson(0,0) = 0', wilsonLower(0, 0) === 0);
ok('wilson 9/10 ≈ 0.5958', Math.abs(wilsonLower(9, 10) - 0.59579) < 0.001, String(wilsonLower(9, 10)));
ok('small sample scores below large at same ratio', wilsonLower(3, 3) < wilsonLower(30, 30),
  `${wilsonLower(3, 3).toFixed(4)} < ${wilsonLower(30, 30).toFixed(4)}`);
ok('all-clean n=21 below candidate threshold', wilsonLower(21, 21) < 0.85, wilsonLower(21, 21).toFixed(4));
ok('all-clean n=22 crosses candidate threshold', wilsonLower(22, 22) >= 0.85, wilsonLower(22, 22).toFixed(4));

// ── lane attribution: session join ──
{
  const events = [
    session('ses_a', 'backend'),
    slice('ses_a', { declared: 1, verified: 1 }),
    session('ses_b', null, true),      // auto-registered without a lane
    claim('ses_b', 'cockpit-shell'),   // ...then claims one
    slice('ses_b', { declared: 1, verified: 1 }),
    slice('ses_ghost', { declared: 1, verified: 1 }), // no registration at all
  ];
  const r = scoreAutonomy(events);
  const laneIds = r.lanes.map((l) => l.lane);
  ok('registered session attributes to its lane', laneIds.includes('backend'), laneIds.join(','));
  ok('auto-registered session attributes via LANE_CLAIMED', laneIds.includes('cockpit-shell'));
  ok('unknown session falls to (unattributed)', laneIds.includes('(unattributed)'));
}

// ── outcome trichotomy + neutral ──
{
  const events = [
    session('s', 'lane-x'),
    slice('s', { declared: 2, verified: 2 }),                        // clean: verified deliverables
    gate({ gateId: 'g', status: 'ok', ok: true }),
    legacySlice('s'),                                                // clean: gate-only proof (legacy event)
    slice('s', { declared: 2, verified: 1, missing: ['gone.md'] }),  // dirty: missing deliverable
    gate({ gateId: 'g', status: 'fail', ok: false, severity: 'critical' }),
    slice('s', { declared: 0 }),                                     // dirty: hard catch in window
    gate({ gateId: 'g', status: 'warn', ok: false, severity: 'warn' }),
    slice('s', { declared: 0 }),                                     // neutral: warn-only window — witnessed, unproven, undamned
    slice('s', { declared: 0 }),                                     // unwitnessed: nothing at all
    slice('s', { summary: 'this should work now', declared: 0 }),    // dirty: hedged claim without proof
    gate({ gateId: 'g', status: 'ok', ok: true }),
    slice('s', { summary: 'should work now', declared: 0 }),         // clean: hedged BUT proven by ok gate
  ];
  const o = classifyOutcomes(events).map((x) => x.outcome);
  ok('verified deliverables → clean', o[0] === 'clean', o[0]);
  ok('legacy slice + ok gate → clean (gate-only proof)', o[1] === 'clean', o[1]);
  ok('missing deliverable → dirty', o[2] === 'dirty', o[2]);
  ok('hard catch in window → dirty', o[3] === 'dirty', o[3]);
  ok('warn-only window → neutral', o[4] === 'neutral', o[4]);
  ok('no evidence → unwitnessed', o[5] === 'unwitnessed', o[5]);
  ok('hedged without proof → dirty', o[6] === 'dirty', o[6]);
  ok('hedged with ok gate → clean (the reflect JOIN)', o[7] === 'clean', o[7]);
  const lane = scoreAutonomy(events).lanes.find((l) => l.lane === 'lane-x');
  ok('counts: 3 clean / 3 dirty / 1 neutral / 1 unwitnessed', lane.clean === 3 && lane.dirty === 3 && lane.neutral === 1 && lane.unwitnessed === 1,
    JSON.stringify({ clean: lane.clean, dirty: lane.dirty, neutral: lane.neutral, unwitnessed: lane.unwitnessed }));
  ok('coverage counts neutral as witnessed', Math.abs(lane.coverage - 7 / 8) < 0.001, String(lane.coverage));
}

// ── gate binding: actor-stamped and sliceId-stamped ──
{
  const events = [
    session('s1', 'lane-a'), session('s2', 'lane-b'),
    gate({ gateId: 'g', status: 'fail', ok: false, severity: 'critical' }, 's2'), // stamped: belongs to s2
    slice('s1', { declared: 0 }),   // s1's window contains only s2's gate → NOT bound → unwitnessed, not dirty
    slice('s2', { id: 'evt_target', declared: 0 }),
  ];
  const o = classifyOutcomes(events);
  ok('actor-stamped gate does not leak into another session\'s slice', o[0].outcome === 'unwitnessed', o[0].outcome);

  const events2 = [
    session('s1', 'lane-a'),
    gate({ gateId: 'g', status: 'ok', ok: true, sliceId: 'evt_wanted' }),
    slice('s1', { id: 'evt_other', declared: 0 }),   // sliceId mismatch → unwitnessed
    gate({ gateId: 'g', status: 'ok', ok: true, sliceId: 'evt_wanted2' }),
    slice('s1', { id: 'evt_wanted2', declared: 0 }), // sliceId match → clean
  ];
  const o2 = classifyOutcomes(events2);
  ok('sliceId-stamped gate binds only its slice', o2[0].outcome === 'unwitnessed' && o2[1].outcome === 'clean',
    `${o2[0].outcome},${o2[1].outcome}`);
}

// ── daily clean-credit cap ──
{
  const events = [session('s', 'farm')];
  for (let i = 0; i < 8; i++) events.push(slice('s', { day: 0, minute: i, declared: 1, verified: 1 }));
  events.push(slice('s', { day: 1, declared: 1, verified: 1 })); // next UTC day
  const lane = scoreAutonomy(events).lanes.find((l) => l.lane === 'farm');
  ok('raw clean count is uncapped', lane.clean === 9, String(lane.clean));
  ok('capped clean = 5/day + 1 next day', lane.cleanCapped === 6, String(lane.cleanCapped));
  ok('n uses the capped count', lane.n === 6, String(lane.n));
}

// ── rung ladder ──
{
  const thin = [session('s', 'lane-t'), slice('s', { declared: 1, verified: 1 })];
  ok('thin record → observe', scoreAutonomy(thin).lanes[0].rung === 'observe');

  // 22 clean spread over 5 UTC days (cap-safe: 5+5+5+5+2), full coverage.
  const good = [session('s', 'lane-g')];
  for (let i = 0; i < 22; i++) good.push(slice('s', { day: Math.floor(i / 5), minute: i, declared: 1, verified: 1 }));
  const g = scoreAutonomy(good, { nowMs: Date.parse('2026-07-20T00:00:00Z') }).lanes[0];
  ok('22 clean, full coverage → relaxation-candidate', g.rung === 'relaxation-candidate', `${g.rung} wilson=${g.wilson} n=${g.n}`);

  // Same record + a dirty outcome 2 days before nowMs → recency veto → established.
  const vetoed = [...good, slice('s', { day: 17, declared: 1, verified: 0, missing: ['x'] })];
  const v = scoreAutonomy(vetoed, { nowMs: Date.parse('2026-07-20T00:00:00Z') }).lanes[0];
  ok('recent dirty vetoes candidate', v.rung === 'established', `${v.rung} wilson=${v.wilson}`);

  // Same dirty outcome but 20+ days before nowMs → veto expires. Wilson drops
  // (22/23) but stays ≥ .85? 22/23 → check via rung: wilson(22,23)≈0.795 < .85 → established.
  const aged = scoreAutonomy(vetoed, { nowMs: Date.parse('2026-08-30T00:00:00Z') }).lanes[0];
  ok('aged dirty no longer vetoes, but the score itself gates', aged.rung === 'established', `${aged.rung} wilson=${aged.wilson}`);

  // Low coverage keeps a lane at observe no matter the wilson.
  const murky = [session('s', 'lane-m')];
  for (let i = 0; i < 6; i++) murky.push(slice('s', { day: i, declared: 1, verified: 1 }));
  for (let i = 0; i < 8; i++) murky.push(slice('s', { day: 10 + i, declared: 0 })); // unwitnessed pile
  const m = scoreAutonomy(murky).lanes[0];
  ok('coverage < 0.5 → observe despite clean record', m.rung === 'observe', `${m.rung} coverage=${m.coverage}`);
}

// ── determinism + config hash ──
{
  const events = [session('s', 'lane-d'), slice('s', { declared: 1, verified: 1 }), legacySlice('s')];
  const a = JSON.stringify(scoreAutonomy(events, { nowMs: 1234567890 }));
  const b = JSON.stringify(scoreAutonomy(events, { nowMs: 1234567890 }));
  ok('identical inputs → byte-identical output', a === b);
  ok('default thresholds hash is stable', thresholdsHash() === thresholdsHash({}), thresholdsHash());
  ok('overriding a threshold changes the hash', thresholdsHash({ dailyCleanCap: 9 }) !== thresholdsHash());
  ok('schemaVersion pinned at 1', scoreAutonomy(events).schemaVersion === 1);
  ok('no clock leaks: asOf null without nowMs', scoreAutonomy(events).asOf === null);
}

// ── the reducer never feeds on report events ──
{
  const events = [
    session('s', 'lane-r'),
    { id: evId(), ts: ts(), type: 'AUTONOMY_SCORED', actor: null, lane: null, data: { lanes: [] } },
    { id: evId(), ts: ts(), type: 'DOCTOR_REPORT', actor: null, lane: null, data: {} },
    slice('s', { declared: 1, verified: 1 }),
  ];
  const r = scoreAutonomy(events);
  ok('report/meta events are ignored', r.totalSlices === 1 && r.lanes[0].clean === 1);
}

console.log('');
console.log(`autonomy-score: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('autonomy-score OK');
process.exit(0);
