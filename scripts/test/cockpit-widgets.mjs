#!/usr/bin/env node
// cockpit-widgets (v1.35.0) — the widget kit extracted from cockpit.js as a
// cockpit-split slice. cockpit.js itself can't run in node (it boots a browser
// SPA), but the widget kit is pure data→DOM, so we import it with a minimal
// `document` stub (createElement + createElementNS + createTextNode) and assert
// each widget returns the expected node shape. The actual visual render is
// verified by the operator loading the cockpit in a browser; this is the
// regression guard that the extraction preserved structure.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

function mkNode(tag, ns) {
  return {
    tag, ns: ns || null, className: '', innerHTML: '', textContent: '',
    attrs: {}, children: [], style: '',
    classList: { _s: new Set(), add(c) { this._s.add(c); } },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
  };
}
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createElementNS(ns, tag) { return mkNode(tag, ns); },
  createTextNode(text) { return { text }; },
};

const widgets = await import('../../template/maddu/cockpit/cockpit-widgets.js');
const { statusGrid, bar, segBar, donut, sparkline, meter, binByTime } = widgets;

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const EXPECTED = ['statusGrid', 'bar', 'segBar', 'donut', 'sparkline', 'meter', 'binByTime'];
for (const n of EXPECTED) ok(`exports ${n}`, typeof widgets[n] === 'function');

// statusGrid → .widget-grid with one tile per entry.
const grid = statusGrid([{ value: 1, label: 'a' }, { value: 2, label: 'b', tone: 'ok' }]);
ok('statusGrid → .widget-grid', grid.className === 'widget-grid');
ok('statusGrid one tile per entry', grid.children.length === 2);

// bar → .widget-bar; clamps pct.
ok('bar → .widget-bar', bar(0.5, 'x').className === 'widget-bar');

// segBar → .widget-segbar.
ok('segBar → .widget-segbar', segBar([{ label: 'a', value: 3, tone: 'ok' }]).className === 'widget-segbar');

// donut → .widget-donut wrapper containing an <svg> (createElementNS).
const d = donut([{ label: 'a', value: 1, tone: 'ok' }, { label: 'b', value: 1, tone: 'warn' }]);
ok('donut → .widget-donut', d.className === 'widget-donut');
ok('donut contains an svg node', d.children.some((c) => c.tag === 'svg' && c.ns === 'http://www.w3.org/2000/svg'));

// sparkline → an <svg> node.
const sp = sparkline([1, 3, 2, 5]);
ok('sparkline → svg node', sp.tag === 'svg' && sp.ns === 'http://www.w3.org/2000/svg');

// meter → a bar row (delegates to bar()).
ok('meter → .widget-bar', meter(3, 10, 'x').className === 'widget-bar');

// binByTime — pure, no DOM. Buckets length + counting within the window.
ok('binByTime empty → n zeros', JSON.stringify(binByTime([], 5)) === JSON.stringify([0, 0, 0, 0, 0]));
const now = Date.now();
const counts = binByTime(
  [{ t: now - 1000 }, { t: now - 2000 }, { t: now - 60 * 60 * 1000 * 2 }],
  4, 't', 60 * 60 * 1000
);
ok('binByTime returns n buckets', Array.isArray(counts) && counts.length === 4);
ok('binByTime counts in-window events, drops out-of-window', counts.reduce((a, b) => a + b, 0) === 2);
ok('binByTime puts recent events in the last bucket', counts[3] === 2);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
