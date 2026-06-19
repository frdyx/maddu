#!/usr/bin/env node
// cockpit-views-connect (v1.55.0) — the connect-cluster view module (settings +
// trust). renderTrust is a pure-leaf posture page (its own 15s setInterval); it
// needs no ctx. renderSettings registers its panels through ctx.panelFocus and
// honors ?focus= via ctx.paletteFocus/ctx.focusPanelByKeyword. We import under a
// node stub + a never-resolving global fetch so the synchronous page scaffold
// builds while every bridge fetch stays pending; the live fetch→render path is
// covered headlessly by the cockpit-snapshot gate.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

function mkNode(tag) {
  return {
    tag, className: '', innerHTML: '', textContent: '',
    value: '', checked: false, disabled: false,
    attrs: {}, children: [], style: {}, dataset: {}, _l: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.className = v; },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren() { this.children = []; },
    addEventListener(type, fn) { (this._l[type] || (this._l[type] = [])).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createTextNode(text) { return { text, nodeType: 3 }; },
};
globalThis.fetch = () => new Promise(() => {});
if (typeof globalThis.location === 'undefined') {
  Object.defineProperty(globalThis, 'location', { value: { hash: '#/settings' }, configurable: true, writable: true });
}

const m = await import('../../template/maddu/cockpit/cockpit-views-connect.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

ok('exports renderTrust', typeof m.renderTrust === 'function');
ok('exports renderSettings', typeof m.renderSettings === 'function');

// renderTrust — pure, no ctx.
const trustRoot = m.renderTrust();
ok('renderTrust → .view root', trustRoot.className === 'view');
ok('renderTrust → <h2> "Trust"', trustRoot.children[0].tag === 'h2' && trustRoot.children[0].children[0].text === 'Trust');
ok('renderTrust mounts panels', trustRoot.children.filter((c) => c.className === 'panel').length >= 5);

// renderSettings — panels routed through ctx.panelFocus; ?focus honored via ctx.
let panelFocusCalls = 0;
let paletteFocusCalled = false;
const ctx = {
  panelFocus(title, aside, body) { panelFocusCalls++; const n = mkNode('div'); n.className = 'panel'; n.appendChild(body); return n; },
  paletteFocus() { paletteFocusCalled = true; return null; },
  focusPanelByKeyword() {},
};
const setRoot = m.renderSettings(ctx);
ok('renderSettings → .view root', setRoot.className === 'view');
ok('renderSettings → <h2> "Settings"', setRoot.children[0].tag === 'h2' && setRoot.children[0].children[0].text === 'Settings');
ok('renderSettings registers ≥6 panels via ctx.panelFocus', panelFocusCalls >= 6, `${panelFocusCalls} call(s)`);
ok('renderSettings checks ?focus via ctx.paletteFocus', paletteFocusCalled === true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
