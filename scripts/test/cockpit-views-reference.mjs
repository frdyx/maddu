#!/usr/bin/env node
// cockpit-views-reference (v1.47.0) — the second extracted VIEW module: the
// "reference" cluster (goal, tools, loops, search, wiki). Four are pure-leaf
// views; renderGoal alone takes a ctx carrying the shell's panelFocus. Unlike
// the backbone views (which defer all I/O to ctx.bindRefresh), these kick off
// their fetch synchronously on render and wire DOM listeners, so we import them
// under a richer node stub + a never-resolving global fetch: the page scaffold
// builds, the listeners attach as no-ops, and the live fetch→render path stays
// covered headlessly by the cockpit-snapshot gate.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

function mkNode(tag) {
  return {
    tag, className: '', innerHTML: '', textContent: '',
    value: '', checked: false, disabled: false,
    attrs: {}, children: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren() { this.children = []; },
    addEventListener() {},
    focus() {},
  };
}
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createTextNode(text) { return { text, nodeType: 3 }; },
};
// Never-resolving fetch: render kicks it off, awaits forever, returns synchronously.
globalThis.fetch = () => new Promise(() => {});
if (typeof globalThis.location === 'undefined') {
  Object.defineProperty(globalThis, 'location', { value: { hash: '' }, configurable: true, writable: true });
}

const m = await import('../../template/maddu/cockpit/cockpit-views-reference.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const VIEWS = ['renderGoal', 'renderTools', 'renderLoops', 'renderSearch', 'renderWiki'];
for (const n of VIEWS) ok(`exports ${n}`, typeof m[n] === 'function');

// h2 text per view (first child after the wrapper div).
const TITLES = {
  renderGoal: 'Goal',
  renderTools: 'Tools',
  renderLoops: 'Loops',
  renderSearch: 'Search',
  renderWiki: 'Wiki',
};

// ctx stub: renderGoal needs panelFocus; record the call and return a panel node.
let panelFocusCalls = 0;
const ctx = {
  panelFocus(title, aside, body) {
    panelFocusCalls++;
    const node = mkNode('div');
    node.className = 'panel';
    node.appendChild(body);
    return node;
  },
};

for (const name of VIEWS) {
  const root = m[name](ctx);
  ok(`${name} → .view root`, root.className === 'view');
  ok(`${name} → <h2> "${TITLES[name]}"`, root.children[0].tag === 'h2' && root.children[0].children[0].text === TITLES[name]);
  // Every view renders a <p> description as the second child.
  ok(`${name} → <p> description`, root.children[1] && root.children[1].tag === 'p');
}

// renderGoal must route its panel through the injected ctx.panelFocus.
ok('renderGoal uses ctx.panelFocus', panelFocusCalls === 1, `${panelFocusCalls} call(s)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
