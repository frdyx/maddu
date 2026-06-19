#!/usr/bin/env node
// cockpit-views-inspect (v1.49.0) — the first "inspect-heavy" view module. Its
// rows are clickable triggers that open the shell Inspector via ctx.openInspector.
// Unlike the pure render-only fixtures, this one verifies the INTERACTION seam:
// it feeds a canned /bridge/learning response, lets the async refresh build the
// findings list, then fires the row's click handler and asserts the injected
// ctx.openInspector was invoked with the finding descriptor. A node stub records
// event listeners so the click can be replayed headlessly.
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
    dispatchEvent(evt) { (this._l[evt && evt.type] || []).forEach((fn) => fn(evt)); return true; },
    querySelector(sel) { return queryOne(this, sel); },
    querySelectorAll() { return []; },
  };
}
// Minimal `.class` / tag matcher over the stub tree (depth-first).
function matches(node, sel) {
  if (!node || typeof node !== 'object') return false;
  if (sel.startsWith('.')) return String(node.className || '').split(/\s+/).includes(sel.slice(1));
  return node.tag === sel;
}
function queryOne(node, sel) {
  for (const c of node.children || []) {
    if (matches(c, sel)) return c;
    const deep = queryOne(c, sel);
    if (deep) return deep;
  }
  return null;
}
function findByClass(node, cls, out = []) {
  for (const c of node.children || []) {
    if (String(c.className || '').split(/\s+/).includes(cls)) out.push(c);
    findByClass(c, cls, out);
  }
  return out;
}

globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createElementNS(ns, tag) { return mkNode(tag); },
  createTextNode(text) { return { text, nodeType: 3 }; },
};
if (typeof globalThis.location === 'undefined') {
  Object.defineProperty(globalThis, 'location', { value: { hash: '#/workflows' }, configurable: true, writable: true });
}
const CANNED_LEARNING = {
  count: 1, byKind: { rule: 1 }, byLane: { harness: 1 },
  facts: [{ id: 'f1', kind: 'rule', text: 'always branch first', ts: '2026-01-01T00:00:00Z', tags: ['a', 'b'], source: { event: 'evt-1' } }],
};
const CANNED_PROJECTION = {
  activeSessions: [{ id: 'sess-1', label: 'Claude', role: 'implementer', status: 'active', focus: 'refactor', lastHeartbeatAt: '2026-01-01T00:00:00Z', workspaceId: 'maddu' }],
  claims: [{ sessionId: 'sess-1', lane: 'harness' }],
  sliceStops: [{ actor: 'sess-1', ts: '2026-01-01T00:00:00Z', learnings: [], summary: 'extracted agents' }],
};
globalThis.fetch = (url) => {
  if (String(url).includes('/bridge/learning')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => CANNED_LEARNING });
  }
  if (String(url).includes('/bridge/projection')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => CANNED_PROJECTION });
  }
  return new Promise(() => {});
};

const m = await import('../../template/maddu/cockpit/cockpit-views-inspect.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

ok('exports renderLearning', typeof m.renderLearning === 'function');
ok('exports renderTeams', typeof m.renderTeams === 'function');
ok('exports renderWorkflows', typeof m.renderWorkflows === 'function');
ok('exports renderRoadmap', typeof m.renderRoadmap === 'function');
ok('exports renderAgents', typeof m.renderAgents === 'function');

let inspected = null;
const ctx = { openInspector: (entity) => { inspected = entity; } };
const root = m.renderLearning(ctx);
ok('renderLearning → .view root', root.className === 'view');
ok('renderLearning → <h2> "Learning"', root.children[0].tag === 'h2' && root.children[0].children[0].text === 'Learning');

// Let the async refresh (canned fetch) settle, then click the first finding row.
await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setTimeout(r, 0));

const rows = findByClass(root, 'learning-row');
ok('renders one finding row from canned data', rows.length === 1, `${rows.length} row(s)`);
if (rows.length) {
  const clicks = rows[0]._l.click || [];
  ok('finding row has a click handler', clicks.length === 1);
  if (clicks.length) {
    clicks[0]();
    ok('row click invokes ctx.openInspector', inspected && inspected.kind === 'finding' && inspected.id === 'f1',
      inspected ? `kind=${inspected.kind} id=${inspected.id}` : 'not called');
  }
}

// ── renderTeams — lane card opens the Inspector via ctx.openInspector ──────
let teamInspected = null;
let focusCalled = false;
const teamCtx = {
  fetchLanes: async () => ({ catalog: { lanes: [{ id: 'harness', scope: 'maddu/', policy: { zones: ['a'], leaseSeconds: 60, handoffRule: 'auto' } }] } }),
  fetchProjection: async () => ({
    claims: [{ lane: 'harness', sessionId: 's1', focus: 'refactor' }],
    sliceStops: [{ lane: 'harness', ts: '2026-01-01T00:00:00Z', summary: 'extracted teams' }],
    activeSessions: [{ id: 's1', label: 'Claude' }],
  }),
  openInspector: (entity) => { teamInspected = entity; },
  paletteFocus: () => null,
  focusPanelByKeyword: () => { focusCalled = true; },
};
const teamRoot = m.renderTeams(teamCtx);
ok('renderTeams → .view root', teamRoot.className === 'view');
ok('renderTeams → <h2> "Teams"', teamRoot.children[0].tag === 'h2' && teamRoot.children[0].children[0].text === 'Teams');

await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setTimeout(r, 0));

const cards = findByClass(teamRoot, 'team-lane-card');
ok('renders one lane card from canned data', cards.length === 1, `${cards.length} card(s)`);
if (cards.length) {
  const clicks = cards[0]._l.click || [];
  ok('lane card has a click handler', clicks.length === 1);
  if (clicks.length) {
    clicks[0]();
    ok('lane click invokes ctx.openInspector', teamInspected && teamInspected.kind === 'lane' && teamInspected.id === 'harness',
      teamInspected ? `kind=${teamInspected.kind} id=${teamInspected.id}` : 'not called');
  }
}
ok('no palette focus when paletteFocus() is null', focusCalled === false);

// ── renderWorkflows — SVG node opens the Inspector via ctx.openInspector ────
let wfInspected = null;
const wfCtx = { openInspector: (entity) => { wfInspected = entity; } };
const wfRoot = m.renderWorkflows(wfCtx);
ok('renderWorkflows → .view root', wfRoot.className === 'view');
ok('renderWorkflows → <h2> "Workflows"', wfRoot.children[0].tag === 'h2' && wfRoot.children[0].children[0].text === 'Workflows');

const nodes = findByClass(wfRoot, 'workflow-node');
ok('renders all 10 workflow nodes', nodes.length === 10, `${nodes.length} node(s)`);
if (nodes.length) {
  const clicks = nodes[0]._l.click || [];
  ok('workflow node has a click handler', clicks.length === 1);
  if (clicks.length) {
    clicks[0]();
    ok('node click invokes ctx.openInspector', wfInspected && wfInspected.kind === 'workflow-node' && wfInspected.id === 'operator',
      wfInspected ? `kind=${wfInspected.kind} id=${wfInspected.id}` : 'not called');
  }
}

// ── renderRoadmap — slice-index row opens the Inspector via ctx.openInspector ─
let rmInspected = null;
const rmCtx = {
  panelFocus(title, aside, body) { const n = mkNode('div'); n.className = 'panel'; n.appendChild(body); return n; },
  fetchProjection: async () => ({
    sliceStops: [{ id: 's1', ts: '2026-01-01T00:00:00Z', lane: 'harness', summary: 'did x', actor: 'claude', learnings: [], gates: [] }],
  }),
  openInspector: (entity) => { rmInspected = entity; },
};
const rmRoot = m.renderRoadmap(rmCtx);
ok('renderRoadmap → .view root', rmRoot.className === 'view');
ok('renderRoadmap → <h2> "Roadmap"', rmRoot.children[0].tag === 'h2' && rmRoot.children[0].children[0].text === 'Roadmap');

await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setTimeout(r, 0));

const sliceRows = findByClass(rmRoot, 'slice-index-row');
ok('renders one slice-index row from canned data', sliceRows.length === 1, `${sliceRows.length} row(s)`);
if (sliceRows.length) {
  const clicks = sliceRows[0]._l.click || [];
  ok('slice-index row has a click handler', clicks.length === 1);
  if (clicks.length) {
    clicks[0]();
    ok('slice row click invokes ctx.openInspector', rmInspected && rmInspected.kind === 'slice-stop' && rmInspected.id === 's1',
      rmInspected ? `kind=${rmInspected.kind} id=${rmInspected.id}` : 'not called');
  }
}

// ── renderAgents — coworker card opens Inspector; scope toggle → ctx.rerender ─
let agInspected = null;
let rerendered = false;
const agCtx = {
  scopePill: () => null, // single-workspace harness: pill is null
  scopedUrl: (route, base) => base,
  rerender: () => { rerendered = true; },
  openInspector: (entity) => { agInspected = entity; },
  paletteFocus: () => null,
  focusPanelByKeyword: () => {},
};
const agRoot = m.renderAgents(agCtx);
ok('renderAgents → .view root', agRoot.className === 'view');
ok('renderAgents → <h2> "Agents"', agRoot.children[0].tag === 'h2' && agRoot.children[0].children[0].text === 'Agents');

await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setTimeout(r, 0));

const agCards = findByClass(agRoot, 'agent-card');
ok('renders one agent card from canned projection', agCards.length === 1, `${agCards.length} card(s)`);
if (agCards.length) {
  const clicks = agCards[0]._l.click || [];
  ok('agent card has a click handler', clicks.length === 1);
  if (clicks.length) {
    clicks[0]();
    ok('agent card click invokes ctx.openInspector', agInspected && agInspected.kind === 'session' && agInspected.id === 'sess-1',
      agInspected ? `kind=${agInspected.kind} id=${agInspected.id}` : 'not called');
  }
}
ok('ctx.rerender not called on initial render', rerendered === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
