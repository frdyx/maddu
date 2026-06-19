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
let authFetches = 0; // count of GET /bridge/auth (fetchAuth), used by the renderAuth test
globalThis.fetch = (url) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (path === '/bridge/auth') authFetches++;
  return new Promise(() => {});
};
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
ok('exports renderAuth', typeof m.renderAuth === 'function');
ok('exports renderImports', typeof m.renderImports === 'function');

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

// ── renderAuth — stream-coupled view: subscribes via ctx.onSpineEvent, filters
// to AUTH_KEY_* events, re-runs its refresh (a GET /bridge/auth) on match only ──
let spineHandler = null;
const authCtx = {
  paletteFocus: () => null,
  focusPanelByKeyword: () => {},
  onSpineEvent: (h) => { spineHandler = h; },
};
const authRoot = m.renderAuth(authCtx);
ok('renderAuth → .view root', authRoot.className === 'view');
ok('renderAuth → <h2> "Auth"', authRoot.children[0].tag === 'h2' && authRoot.children[0].children[0].text === 'Auth');
ok('renderAuth subscribes via ctx.onSpineEvent', typeof spineHandler === 'function');
ok('renderAuth refreshes once on render (GET /bridge/auth)', authFetches === 1, `${authFetches} fetch(es)`);
if (typeof spineHandler === 'function') {
  spineHandler({ detail: { type: 'PLAN_UPDATED' } });
  ok('non-AUTH_KEY_ event is filtered out (no refetch)', authFetches === 1, `${authFetches} fetch(es)`);
  spineHandler({ detail: { type: 'AUTH_KEY_ADDED' } });
  ok('AUTH_KEY_ event triggers a refresh (refetch)', authFetches === 2, `${authFetches} fetch(es)`);
}

// ── renderImports — stream-coupled (IMPORT_* via ctx.onSpineEvent); the submit
// action stamps `by: ctx.currentSession()` (narrow composer-pointer accessor) ──
let impHandler = null;
let currentSessionReads = 0;
const impCtx = {
  onSpineEvent: (h) => { impHandler = h; },
  currentSession: () => { currentSessionReads++; return 'sess-42'; },
};
const impRoot = m.renderImports(impCtx);
ok('renderImports → .view root', impRoot.className === 'view');
ok('renderImports → <h2> "Imports"', impRoot.children[0].tag === 'h2' && impRoot.children[0].children[0].text === 'Imports');
ok('renderImports subscribes via ctx.onSpineEvent', typeof impHandler === 'function');
// The submit button is the 4th compose control; find it by label and click it.
function findButton(node, label, out = []) {
  for (const c of node.children || []) {
    if (c.tag === 'button' && (c.children?.[0]?.text === label)) out.push(c);
    findButton(c, label, out);
  }
  return out;
}
function findByTag(node, tag, out = []) {
  for (const c of node.children || []) {
    if (c.tag === tag) out.push(c);
    findByTag(c, tag, out);
  }
  return out;
}
const submitBtns = findButton(impRoot, 'Submit');
ok('renderImports has a Submit button', submitBtns.length === 1, `${submitBtns.length} found`);
const tas = findByTag(impRoot, 'textarea');
if (submitBtns.length && tas.length) {
  tas[0].value = '{"title":"t","body":"b"}'; // valid JSON so the submit handler reaches the POST body
  const before = currentSessionReads;
  (submitBtns[0]._l.click || []).forEach((fn) => fn());
  ok('Submit stamps by: ctx.currentSession()', currentSessionReads === before + 1, `${currentSessionReads} read(s)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
