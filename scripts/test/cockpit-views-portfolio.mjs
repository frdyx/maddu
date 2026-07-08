#!/usr/bin/env node
// cockpit-views-portfolio — the Portfolio route's display-time age humanizer.
// Render + the cards/needs-human layout are covered byte-exact by cockpit-boot +
// cockpit-snapshot against the canned /bridge/_all/portfolio fixture; the wall
// assembly is covered by scripts/test/portfolio.mjs. This locks the pure mapping.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  createTextNode: (t) => ({ text: t }),
};

const { humanAge } = await import('../../template/maddu/cockpit/cockpit-views-portfolio.js');

let passed = 0, failed = 0;
function ok(name, cond) { console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}`); if (cond) passed++; else failed++; }

ok('seconds bucket', humanAge(5000) === '5s ago');
ok('minutes bucket', humanAge(120000) === '2m ago');
ok('hours bucket', humanAge(7200000) === '2h ago');
ok('days bucket', humanAge(172800000) === '2d ago');
ok('missing → empty', humanAge(null) === '' && humanAge(-1) === '');

try {
  console.log('');
  console.log(`cockpit-views-portfolio: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('cockpit-views-portfolio OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
