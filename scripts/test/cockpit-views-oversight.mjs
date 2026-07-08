#!/usr/bin/env node
// cockpit-views-oversight — the Oversight route's display-time age humanizer.
//
// The projection stays wall-clock-free; the bridge stamps ageMs at request
// time; the view turns ageMs into "Xm ago". This verifies that pure mapping,
// including graceful handling of missing/invalid input. (Render + the WITHHELD
// hero are covered byte-exact by cockpit-boot + cockpit-snapshot against the
// canned /bridge/oversight fixture.)
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

const { humanAge } = await import('../../template/maddu/cockpit/cockpit-views-oversight.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

ok('seconds bucket', humanAge(5000) === '5s ago', humanAge(5000));
ok('minutes bucket', humanAge(120000) === '2m ago', humanAge(120000));
ok('hours bucket', humanAge(2 * 3600 * 1000) === '2h ago', humanAge(2 * 3600 * 1000));
ok('days bucket', humanAge(3 * 86400 * 1000) === '3d ago', humanAge(3 * 86400 * 1000));
ok('missing → empty', humanAge(undefined) === '' && humanAge(null) === '');
ok('negative → empty', humanAge(-1) === '');
ok('non-number → empty', humanAge('soon') === '');

console.log('');
console.log(`cockpit-views-oversight: ${passed} pass - ${failed} fail`);
process.exit(failed ? 1 : 0);
