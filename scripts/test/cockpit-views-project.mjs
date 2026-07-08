#!/usr/bin/env node
// cockpit-views-project — the Project route's pure display helpers.
//
// humanAge turns the bridge-stamped ageMs into "Xm ago"; trajectoryGlyphs maps
// the Focus Director window into colored up/down/flat marks. Render + layout are
// covered byte-exact by cockpit-boot + cockpit-snapshot against the canned
// /bridge/project-cockpit fixture; this locks the pure mappings.
//
// A tiny document stub lets the module import without a DOM.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  createTextNode: (t) => ({ text: t }),
};

const { humanAge, trajectoryGlyphs } = await import('../../template/maddu/cockpit/cockpit-views-project.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// humanAge buckets
ok('seconds bucket', humanAge(5000) === '5s ago');
ok('minutes bucket', humanAge(120000) === '2m ago');
ok('hours bucket', humanAge(7200000) === '2h ago');
ok('days bucket', humanAge(172800000) === '2d ago');
ok('missing → empty', humanAge(null) === '' && humanAge(-1) === '' && humanAge('x') === '');

// trajectoryGlyphs mapping
const g = trajectoryGlyphs([{ tag: 'toward' }, { tag: 'away' }, { tag: 'lateral' }, { tag: null }, {}]);
ok('toward → up mark, accent', g[0].glyph === '▲' && g[0].color === 'var(--m-accent)');
ok('away → down mark, danger', g[1].glyph === '▼' && g[1].color === 'var(--m-danger)');
ok('lateral → flat mark, warn', g[2].glyph === '▬' && g[2].color === 'var(--m-warn)');
ok('unknown tag → flat mark, muted', g[3].glyph === '▬' && g[3].color === 'var(--m-fg-3)');
ok('missing tag object → flat mark', g[4].glyph === '▬');
ok('non-array input → empty', trajectoryGlyphs(null).length === 0 && trajectoryGlyphs(undefined).length === 0);

try {
  console.log('');
  console.log(`cockpit-views-project: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('cockpit-views-project OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
