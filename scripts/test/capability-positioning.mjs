#!/usr/bin/env node
// capability-positioning — the honest opt-in frame (roadmap #12 / F4).
//
// Pure over the _tiers `layer` tags + a spine: classify core vs orchestration,
// detect whether orchestration was reached (signature events fired), and build
// the always-advisory verdict that replaces "orchestration=0=dead". Also asserts
// the SHIPPED _tiers manifest has every verb layered (no unclassified).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import {
  classifyLayers, orchestrationReach, positioningVerdict, LAYERS, ORCHESTRATION_SIGNATURES,
} from '../../template/maddu/runtime/lib/capability-positioning.mjs';
import tiers from '../../commands/_tiers.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const sample = {
  orient: { layer: 'core' }, lane: { layer: 'core' }, coordinator: { layer: 'orchestration' },
  team: { layer: 'orchestration' }, mystery: { tier: 'read-only' }, // no layer
};

// ── classifyLayers ──
const cl = classifyLayers(sample);
ok('core verbs collected', cl.core.join() === 'lane,orient', cl.core.join());
ok('orchestration verbs collected', cl.orchestration.join() === 'coordinator,team', cl.orchestration.join());
ok('unclassified caught', cl.unclassified.join() === 'mystery', cl.unclassified.join());
ok('LAYERS is the closed vocabulary', LAYERS.join() === 'core,orchestration');

// ── orchestrationReach ──
const noOrch = orchestrationReach([{ type: 'SLICE_STOP' }, { type: 'GATE_RAN' }]);
ok('no orchestration events → not reached', noOrch.firedAny === false && noOrch.reached.size === 0);
const someOrch = orchestrationReach([{ type: 'COORDINATOR_STARTED' }, { type: 'TEAM_OPENED' }, { type: 'SLICE_STOP' }]);
ok('coordinator + team signatures detected', someOrch.firedAny === true && someOrch.reached.has('coordinator') && someOrch.reached.has('team'));
ok('prefix match, not exact', orchestrationReach([{ type: 'PIPELINE_COMPLETED' }]).reached.has('pipeline'));
ok('rate is reached/total', Math.abs(someOrch.rate - 2 / Object.keys(ORCHESTRATION_SIGNATURES).length) < 1e-9, String(someOrch.rate));

// ── positioningVerdict: always advisory, never a fail ──
const reached = positioningVerdict({ tiers: sample, events: [{ type: 'COORDINATOR_STARTED' }] });
ok('verdict ok is always true', reached.ok === true);
ok('reached frame names the reached verb', reached.firedAny && reached.message.includes('reached here') && reached.message.includes('coordinator'));
const cold = positioningVerdict({ tiers: sample, events: [{ type: 'SLICE_STOP' }] });
ok('cold install framed opt-in, NOT dead', cold.firedAny === false && /opt-in/.test(cold.message) && !/dead/.test(cold.message), cold.message);

// ── the SHIPPED _tiers manifest: every verb layered, 4 orchestration ──
const shipped = classifyLayers(tiers);
ok('shipped manifest has zero unclassified verbs', shipped.unclassified.length === 0, shipped.unclassified.join());
ok('shipped orchestration layer is the 4-verb cluster', shipped.orchestration.join() === 'coordinator,loop,pipeline,team', shipped.orchestration.join());
ok('shipped core layer is the substrate majority', shipped.core.length >= 50, String(shipped.core.length));

console.log('');
console.log(`capability-positioning: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('capability-positioning OK');
process.exit(0);
