#!/usr/bin/env node
// cockpit-util (v1.24.0) — the pure leaf utilities extracted from cockpit.js as
// the first slice of decomposing the SPA monolith. cockpit.js can't be tested
// in node (it boots a browser SPA), but these extracted helpers are pure (plus
// el's thin DOM build), so we can import the module with a minimal `document`
// stub and assert behavior is preserved — regression coverage the monolith
// never had, and a guard that the extraction didn't change output.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

// Minimal document stub — el/panel/placeholder are the only DOM users, and they
// only touch createElement/createTextNode/appendChild/setAttribute/className/
// innerHTML. Build a tiny node model that records enough to assert against.
function mkNode(tag) {
  return {
    tag, className: '', innerHTML: '', textContent: '', attrs: {}, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); } },
    parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    get firstChild() { return this.children[0]; },
  };
}
const toastRegion = mkNode('div');
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createTextNode(text) { return { text }; },
  getElementById(id) { return id === 'toast-region' ? toastRegion : null; },
};

const { el, panel, placeholder, formatUptime, formatAge, ageTone, formatTs, compactPath, truncatePathFromLeft, showToast } =
  await import('../../template/maddu/cockpit/cockpit-util.mjs').catch(() =>
    import('../../template/maddu/cockpit/cockpit-util.js'));

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// formatUptime
ok('formatUptime non-number → dash', formatUptime('x') === '—');
ok('formatUptime seconds', formatUptime(5000) === '5s');
ok('formatUptime minutes', formatUptime(5 * 60 * 1000) === '5m');
ok('formatUptime hours+min', formatUptime((2 * 60 + 3) * 60 * 1000) === '2h 3m');
ok('formatUptime days+hours', formatUptime((26) * 60 * 60 * 1000) === '1d 2h');

// formatAge — largest single unit
ok('formatAge null → dash', formatAge(null) === '—');
ok('formatAge seconds', formatAge(5000) === '5s');
ok('formatAge minutes', formatAge(5 * 60 * 1000) === '5m');
ok('formatAge hours', formatAge(3 * 60 * 60 * 1000) === '3h');
ok('formatAge days', formatAge(2 * 24 * 60 * 60 * 1000) === '2d');

// ageTone — semantic tone by recency
ok('ageTone null → neutral', ageTone(null) === 'neutral');
ok('ageTone fresh → ok', ageTone(30 * 60 * 1000) === 'ok');
ok('ageTone few hours → accent', ageTone(2 * 60 * 60 * 1000) === 'accent');
ok('ageTone same day → warn', ageTone(12 * 60 * 60 * 1000) === 'warn');
ok('ageTone stale → danger', ageTone(48 * 60 * 60 * 1000) === 'danger');

// formatTs — ISO → "YYYY-MM-DD HH:MM:SSZ"
ok('formatTs empty → dash', formatTs('') === '—');
ok('formatTs normalizes ISO', formatTs('2026-06-19T12:00:00.000Z') === '2026-06-19 12:00:00Z');
ok('formatTs unparseable → unchanged', formatTs('not-a-date') === 'not-a-date');

// truncatePathFromLeft
ok('truncate short path unchanged', truncatePathFromLeft('abc', 40) === 'abc');
ok('truncate long path keeps tail', truncatePathFromLeft('x'.repeat(50), 10) === '…' + 'x'.repeat(9));
ok('truncate non-string → dash', truncatePathFromLeft(null) === '—');

// compactPath
ok('compactPath short → as-is', compactPath('C:/repo') === 'C:/repo');
ok('compactPath long → root/…/tail', compactPath('C:/a/b/c/repo') === 'C:/…/repo');
ok('compactPath backslashes normalized', compactPath('C:\\a\\b\\c\\repo') === 'C:/…/repo');

// el / panel / placeholder (DOM build via the stub)
const node = el('div', { class: 'x', 'data-id': '7', html: '<b>h</b>' }, ['t', el('span', {}, [])]);
ok('el sets tag', node.tag === 'div');
ok('el sets className from class', node.className === 'x');
ok('el sets plain attribute', node.attrs['data-id'] === '7');
ok('el sets innerHTML from html', node.innerHTML === '<b>h</b>');
ok('el appends a text node for a string child', node.children[0].text === 't');
ok('el appends a node child', node.children[1].tag === 'span');
ok('el skips null children', el('div', {}, ['a', null, 'b']).children.length === 2);

const p = panel('Title', 'aside', el('div', {}, []));
ok('panel wraps in .panel', p.className === 'panel');
ok('panel head holds title', p.children[0].children[0].children[0].text === 'Title');

const empty = placeholder('Nothing', 'soon');
ok('placeholder is an empty-state', empty.className === 'empty-state');

// showToast — appends a .toast into #toast-region (no-op without a region).
toastRegion.children = [];
showToast('hello', 'ok');
ok('showToast appends a toast node', toastRegion.children.length === 1);
ok('showToast sets the toast text', toastRegion.children[0].textContent === 'hello');
ok('showToast tags the level class', toastRegion.children[0].classList._s.has('ok'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
