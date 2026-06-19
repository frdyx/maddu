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
const fetchCount = { '/bridge/schedules': 0, '/bridge/mcp': 0, '/bridge/runtimes': 0 };
globalThis.fetch = (url, init) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (path === '/bridge/auth') authFetches++;
  // The infra views (schedule/mcp/runtimes) refetch via a GET (no init.method).
  if (path in fetchCount && (!init || !init.method)) fetchCount[path]++;
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
ok('exports renderSchedule', typeof m.renderSchedule === 'function');
ok('exports renderMcp', typeof m.renderMcp === 'function');
ok('exports renderRuntimes', typeof m.renderRuntimes === 'function');

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

// ── renderSchedule — scope-aware (ctx.scopePill/scopeIsGlobal/rerender), stream-
// coupled (SCHEDULE_* via ctx.onSpineEvent), Create stamps by: ctx.currentSession() ──
{
  let spine = null, sessReads = 0, rerendered = 0;
  const sctx = {
    scopePill: () => null,            // single-workspace: no pill
    scopeIsGlobal: () => false,
    rerender: () => { rerendered++; },
    currentSession: () => { sessReads++; return 'sess-7'; },
    onSpineEvent: (h) => { spine = h; },
  };
  const root = m.renderSchedule(sctx);
  ok('renderSchedule → .view root', root.className === 'view');
  ok('renderSchedule → <h2> "Schedule"', root.children[0].children[0].text === 'Schedule');
  ok('renderSchedule subscribes via ctx.onSpineEvent', typeof spine === 'function');
  ok('renderSchedule refreshes once on render (GET /bridge/schedules)', fetchCount['/bridge/schedules'] === 1, `${fetchCount['/bridge/schedules']}`);
  if (typeof spine === 'function') {
    spine({ detail: { type: 'PLAN_UPDATED' } });
    ok('schedule: non-SCHEDULE_ event filtered (no refetch)', fetchCount['/bridge/schedules'] === 1);
    spine({ detail: { type: 'SCHEDULE_CREATED' } });
    ok('schedule: SCHEDULE_ event triggers refetch', fetchCount['/bridge/schedules'] === 2);
  }
  const inputs = findByTag(root, 'input');
  const createBtn = findButton(root, 'Create');
  if (inputs.length >= 2 && createBtn.length) {
    inputs[0].value = 'Daily summary'; inputs[1].value = 'every evening at 6pm';
    const before = sessReads;
    (createBtn[0]._l.click || []).forEach((fn) => fn());
    ok('schedule Create stamps by: ctx.currentSession()', sessReads === before + 1, `${sessReads} read(s)`);
  }
}

// ── renderMcp — stream-coupled (MCP_* via ctx.onSpineEvent), Register stamps
// by: ctx.currentSession(); ?focus honored via ctx.paletteFocus ──
{
  let spine = null, sessReads = 0, paletteAsked = false;
  const mctx = {
    paletteFocus: () => { paletteAsked = true; return null; },
    focusPanelByKeyword: () => {},
    currentSession: () => { sessReads++; return 'sess-9'; },
    onSpineEvent: (h) => { spine = h; },
  };
  const root = m.renderMcp(mctx);
  ok('renderMcp → .view root', root.className === 'view');
  ok('renderMcp → <h2> "MCP Registry"', root.children[0].children[0].text === 'MCP Registry');
  ok('renderMcp subscribes via ctx.onSpineEvent', typeof spine === 'function');
  ok('renderMcp refreshes once on render (GET /bridge/mcp)', fetchCount['/bridge/mcp'] === 1, `${fetchCount['/bridge/mcp']}`);
  if (typeof spine === 'function') {
    spine({ detail: { type: 'AUTH_KEY_ADDED' } });
    ok('mcp: non-MCP_ event filtered (no refetch)', fetchCount['/bridge/mcp'] === 1);
    spine({ detail: { type: 'MCP_REGISTERED' } });
    ok('mcp: MCP_ event triggers refetch', fetchCount['/bridge/mcp'] === 2);
  }
  const inputs = findByTag(root, 'input');
  const regBtn = findButton(root, 'Register');
  if (inputs.length && regBtn.length) {
    inputs[0].value = 'my-server';
    const before = sessReads;
    (regBtn[0]._l.click || []).forEach((fn) => fn());
    ok('mcp Register stamps by: ctx.currentSession()', sessReads === before + 1, `${sessReads} read(s)`);
  }
}

// ── renderRuntimes — stream-coupled (RUNTIME_/WORKER_* via ctx.onSpineEvent),
// Register stamps by: ctx.currentSession() ──
{
  let spine = null, sessReads = 0;
  const rctx = {
    paletteFocus: () => null,
    focusPanelByKeyword: () => {},
    currentSession: () => { sessReads++; return 'sess-11'; },
    onSpineEvent: (h) => { spine = h; },
  };
  const root = m.renderRuntimes(rctx);
  ok('renderRuntimes → .view root', root.className === 'view');
  ok('renderRuntimes → <h2> "Runtimes"', root.children[0].children[0].text === 'Runtimes');
  ok('renderRuntimes subscribes via ctx.onSpineEvent', typeof spine === 'function');
  ok('renderRuntimes refreshes once on render (GET /bridge/runtimes)', fetchCount['/bridge/runtimes'] === 1, `${fetchCount['/bridge/runtimes']}`);
  if (typeof spine === 'function') {
    spine({ detail: { type: 'MCP_REGISTERED' } });
    ok('runtimes: unrelated event filtered (no refetch)', fetchCount['/bridge/runtimes'] === 1);
    spine({ detail: { type: 'WORKER_SPAWNED' } });
    ok('runtimes: WORKER_ event triggers refetch', fetchCount['/bridge/runtimes'] === 2);
  }
  const inputs = findByTag(root, 'input');
  const regBtn = findButton(root, 'Register');
  if (inputs.length && regBtn.length) {
    inputs[0].value = 'claude-code';
    const before = sessReads;
    (regBtn[0]._l.click || []).forEach((fn) => fn());
    ok('runtimes Register stamps by: ctx.currentSession()', sessReads === before + 1, `${sessReads} read(s)`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
