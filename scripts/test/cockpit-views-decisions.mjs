#!/usr/bin/env node
// cockpit-views-decisions — the Decision ledger's pure display helpers.
//
// humanAge turns the bridge-stamped ageMs into "Xm ago"; categoryColor maps a
// decision category to its accent token. Render + the tamper-detection header are
// covered byte-exact by cockpit-boot + cockpit-snapshot against the canned
// /bridge/decisions fixture; this locks the pure mappings.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  createTextNode: (t) => ({ text: t }),
};

const { humanAge, categoryColor } = await import('../../template/maddu/cockpit/cockpit-views-decisions.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

ok('seconds bucket', humanAge(5000) === '5s ago');
ok('minutes bucket', humanAge(120000) === '2m ago');
ok('hours bucket', humanAge(7200000) === '2h ago');
ok('days bucket', humanAge(172800000) === '2d ago');
ok('missing → empty', humanAge(null) === '' && humanAge(-1) === '');

ok('intent color', categoryColor('intent') === 'var(--m-accent-2)');
ok('decision color', categoryColor('decision') === 'var(--m-accent)');
ok('gate color (danger)', categoryColor('gate') === 'var(--m-danger)');
ok('outcome color (ok)', categoryColor('outcome') === 'var(--m-ok)');
ok('unknown category → muted', categoryColor('whatever') === 'var(--m-fg-3)' && categoryColor(null) === 'var(--m-fg-3)');

try {
  console.log('');
  console.log(`cockpit-views-decisions: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('cockpit-views-decisions OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
