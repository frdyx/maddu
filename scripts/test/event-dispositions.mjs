#!/usr/bin/env node
// event-dispositions — the definition-site disposition registry (DD1, #3, F3).
//
// LIVE TEETH: the real registry must stay in 1:1 parity with spine.mjs
// EVENT_TYPES, so `maddu self-test` goes red the moment someone adds an event
// type without a disposition (the recurrence DD1 prevents). Plus synthetic
// cases proving the pure validator catches missing / extra / bad-kind /
// no-reason, and that DORMANT_BY_DESIGN is derived (not hand-maintained).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';
import {
  EVENT_DISPOSITIONS, validateDispositions, dormantByDesignMap, DISP_KINDS,
} from '../../template/maddu/runtime/lib/event-dispositions.mjs';
import { DORMANT_BY_DESIGN } from '../../template/maddu/runtime/lib/insights.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const typeKeys = Object.keys(EVENT_TYPES);

// ── LIVE: the shipped registry validates ──
const live = validateDispositions(typeKeys, EVENT_DISPOSITIONS);
ok('live registry is complete + valid', live.ok,
  `missing=${live.missing.length} extra=${live.extra.length} badKind=${live.badKind.length} noReason=${live.noReason.length}`);
ok('every EVENT_TYPES key is dispositioned', live.missing.length === 0, live.missing.slice(0, 6).join(', '));
ok('no disposition for an unknown type', live.extra.length === 0, live.extra.slice(0, 6).join(', '));
ok('every non-active entry has a reason', live.noReason.length === 0, live.noReason.slice(0, 6).join(', '));
ok('every disp kind is valid', Object.values(EVENT_DISPOSITIONS).every((v) => DISP_KINDS.has(v.disp)));

// ── DORMANT_BY_DESIGN is DERIVED from the registry ──
const derived = dormantByDesignMap(EVENT_DISPOSITIONS);
ok('DORMANT_BY_DESIGN size matches derived', DORMANT_BY_DESIGN.size === derived.size,
  `insights=${DORMANT_BY_DESIGN.size} derived=${derived.size}`);
ok('DORMANT_BY_DESIGN only holds dormant entries',
  [...DORMANT_BY_DESIGN.keys()].every((k) => EVENT_DISPOSITIONS[k]?.disp === 'dormant'));
ok('a known dormant type carries its reason',
  typeof DORMANT_BY_DESIGN.get('SCHEDULE_CREATED') === 'string' && DORMANT_BY_DESIGN.get('SCHEDULE_CREATED').length > 0);
// the F3 dead set is now accepted-dormant, not dead:
ok('former dead type LANE_ADDED is now dormant-with-reason',
  EVENT_DISPOSITIONS.LANE_ADDED?.disp === 'dormant' && !!EVENT_DISPOSITIONS.LANE_ADDED?.reason);

// ── synthetic: validator catches a missing disposition (the core teeth) ──
const missingCase = validateDispositions(['A', 'B'], { A: { disp: 'active' } });
ok('missing disposition → not ok', missingCase.ok === false && missingCase.missing.includes('B'));

// ── synthetic: disposition for an unknown (retired) type ──
const extraCase = validateDispositions(['A'], { A: { disp: 'active' }, GHOST: { disp: 'active' } });
ok('extra/unknown disposition → not ok', extraCase.ok === false && extraCase.extra.includes('GHOST'));

// ── synthetic: dormant without a reason ──
const noReasonCase = validateDispositions(['A'], { A: { disp: 'dormant' } });
ok('dormant without reason → not ok', noReasonCase.ok === false && noReasonCase.noReason.includes('A'));

// ── synthetic: invalid disp kind ──
const badKindCase = validateDispositions(['A'], { A: { disp: 'mystery' } });
ok('invalid disp kind → not ok', badKindCase.ok === false && badKindCase.badKind.includes('A'));

// ── synthetic: a fully valid small registry passes ──
const goodCase = validateDispositions(['A', 'B'], { A: { disp: 'active' }, B: { disp: 'plugin', reason: 'comms' } });
ok('valid small registry → ok', goodCase.ok === true);

console.log('');
console.log(`event-dispositions: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('event-dispositions OK');
process.exit(0);
