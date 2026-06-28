#!/usr/bin/env node
// cockpit-views-focus — the Focus route's node→Inspector entity mapping.
//
// The chart's hit-targets open the shell Inspector via ctx.openInspector(focusEntity(turn)).
// This verifies focusEntity produces the generic entity shape the Inspector
// renders (label/evidence/related), maps the turn's signal math into readable
// evidence, and links to the source heartbeat/slice-stop. (Render + hit-target
// presence is covered byte-exact by cockpit-boot + cockpit-snapshot.)
//
// A tiny document stub lets the module import without a DOM (el() is only called
// at render time, which this fixture does not exercise).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  createTextNode: (t) => ({ text: t }),
};

const { focusEntity } = await import('../../template/maddu/cockpit/cockpit-views-focus.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const turn = {
  id: 'evt_ft4', ts: '2026-06-19T12:00:00Z', tag: 'away', distanceScore: 0.82,
  signals: { focusText: 'billing invoice stripe', overlap: 0.18, churn: 3 },
  sourceEventId: 'evt_hb4',
};

const e = focusEntity(turn);
const ev = (label) => (e.evidence.find((x) => x.label === label) || {}).value;

ok('kind is focus-turn', e.kind === 'focus-turn');
ok('id carried through', e.id === 'evt_ft4');
ok('raw is the turn', e.raw === turn);
ok('label names direction + focus', /AWAY/.test(e.label) && /billing invoice stripe/.test(e.label));
ok('evidence: direction', ev('Direction') === 'AWAY');
ok('evidence: score is 1 - distance', ev('Score (toward)') === '0.18', String(ev('Score (toward)')));
ok('evidence: goal-distance', ev('Goal-distance') === '0.82');
ok('evidence: focus text', ev('Focus') === 'billing invoice stripe');
ok('evidence: overlap as percent', ev('On-goal overlap') === '18%');
ok('evidence: churn', ev('Recent churn') === '3');
ok('related links the source event', e.related.length === 1 && e.related[0].kind === 'event' && e.related[0].id === 'evt_hb4');

// Graceful with a lean window entry (no signals / source).
const lean = focusEntity({ tag: 'toward', distanceScore: 0.1 });
ok('lean turn still maps', lean.kind === 'focus-turn' && lean.related.length === 0 && /TOWARD/.test(lean.label));

console.log('');
console.log(`cockpit-views-focus: ${passed} pass - ${failed} fail`);
process.exit(failed ? 1 : 0);
