#!/usr/bin/env node
// cockpit-views-live (v1.59.0) — interaction fixture for the first live-cluster
// slice (mailbox + tasks + skills). Mirrors the connect fixture: imports the
// module under a node DOM stub + a never-resolving global fetch so the
// synchronous page scaffold builds while every bridge fetch stays pending, then
// asserts the click-wiring Gate B can't see — the ctx.onSpineEvent subscription
// (with event-type filtering) and that the Create actions stamp the POST body
// with ctx.currentSession(). The live fetch→render path is covered by the
// cockpit-snapshot (Gate B) + Playwright gates.
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
    replaceChildren(...kids) { this.children = kids; },
    addEventListener(type, fn) { (this._l[type] || (this._l[type] = [])).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createTextNode(text) { return { text, nodeType: 3 }; },
  getElementById() { return mkNode('div'); }, // workbench reads count/version spans by id
};
const fetchCount = { '/bridge/mailbox-counts': 0, '/bridge/tasks': 0, '/bridge/skills': 0, '/bridge/operations': 0 };
// Queue + Claim Map resolve with canned data so their card/row builders run and
// the click → ctx.openInspector wiring (threaded into the private builders) can
// be exercised. Everything else stays pending so other views render synchronously.
const QUEUE_DATA = { columns: [{ id: 'queue', title: 'Queue', tone: 'accent', hint: 'ready/blocked', items: [{ id: 'q1', label: 'task one', reasonCode: 'queue_ready' }] }] };
const CLAIMS_DATA = { claims: [{ lane: 'lane-a', sessionId: 's1', reasonCode: 'claim_healthy', claimAgeMs: 1000, heartbeatAgeMs: 500 }] };
const CONDUCTOR_DATA = {
  nextCommand: { text: 'claim a lane', reasonCode: 'task_ready', route: 'tasks' },
  kpi: { activeClaims: 1, openApprovals: 0, stuckWorkers: 0, idleSessions: 0, openTasks: 2, lastSliceAgeMs: 1000 },
  board: { now: [{ id: 't1', title: 'Task 1', lane: 'l' }], next: [], waiting: [], done: [] },
  scoreMatrix: [{ lane: 'l', reasonCode: 'lane_active', done: 1, total: 2, progress: 0.5, scope: 'scope' }],
};
function resolved(body) { return Promise.resolve({ ok: true, json: () => Promise.resolve(body) }); }
globalThis.fetch = (url, init) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (path in fetchCount && (!init || !init.method)) fetchCount[path]++;
  if (path === '/bridge/queue' || path === '/bridge/_all/queue') return resolved(QUEUE_DATA);
  if (path === '/bridge/claims') return resolved(CLAIMS_DATA);
  if (path === '/bridge/conductor' || path === '/bridge/_all/conductor') return resolved(CONDUCTOR_DATA);
  return new Promise(() => {});
};

const m = await import('../../template/maddu/cockpit/cockpit-views-live.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function findButton(node, label, out = []) {
  for (const c of node.children || []) {
    if (c.tag === 'button' && c.children?.[0]?.text === label) out.push(c);
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

ok('exports renderMailbox', typeof m.renderMailbox === 'function');
ok('exports renderTasks', typeof m.renderTasks === 'function');
ok('exports renderSkills', typeof m.renderSkills === 'function');
ok('exports renderOperations', typeof m.renderOperations === 'function');
ok('exports renderSwarm', typeof m.renderSwarm === 'function');
ok('exports renderEvents', typeof m.renderEvents === 'function');
ok('exports renderApprovals', typeof m.renderApprovals === 'function');
ok('exports renderOrientation', typeof m.renderOrientation === 'function');
ok('exports renderGates', typeof m.renderGates === 'function');
ok('exports renderReviews', typeof m.renderReviews === 'function');
ok('exports renderDashboard', typeof m.renderDashboard === 'function');
ok('exports renderQueueBoard', typeof m.renderQueueBoard === 'function');
ok('exports renderClaimMap', typeof m.renderClaimMap === 'function');
ok('exports renderChats', typeof m.renderChats === 'function');
ok('exports renderWorkbench', typeof m.renderWorkbench === 'function');
ok('exports renderConductor', typeof m.renderConductor === 'function');

// ── renderMailbox — MAILBOX_* via ctx.onSpineEvent; render fires a counts GET ──
{
  let spine = null;
  const ctx = { onSpineEvent: (h) => { spine = h; }, currentSession: () => 's', paletteFocus: () => null, focusPanelByKeyword: () => {} };
  const root = m.renderMailbox(ctx);
  ok('renderMailbox → .view root', root.className === 'view');
  ok('renderMailbox → <h2> "Mailbox"', root.children[0].children[0].text === 'Mailbox');
  ok('renderMailbox subscribes via ctx.onSpineEvent', typeof spine === 'function');
  ok('renderMailbox loads counts on render (GET /bridge/mailbox-counts)', fetchCount['/bridge/mailbox-counts'] === 1, `${fetchCount['/bridge/mailbox-counts']}`);
  if (typeof spine === 'function') {
    spine({ detail: { type: 'TASK_CREATED' } });
    ok('mailbox: unrelated event filtered (no reload)', fetchCount['/bridge/mailbox-counts'] === 1);
    spine({ detail: { type: 'MAILBOX_MESSAGE' } });
    ok('mailbox: MAILBOX_ event reloads counts', fetchCount['/bridge/mailbox-counts'] === 2);
  }
}

// ── renderTasks — TASK_* via ctx.onSpineEvent; Create stamps createdBy: currentSession() ──
{
  let spine = null, sessReads = 0, paletteAsked = false;
  const ctx = {
    onSpineEvent: (h) => { spine = h; },
    currentSession: () => { sessReads++; return 'sess-t'; },
    paletteFocus: () => { paletteAsked = true; return null; },
    focusPanelByKeyword: () => {},
  };
  const root = m.renderTasks(ctx);
  ok('renderTasks → .view root', root.className === 'view');
  ok('renderTasks → <h2> "Tasks"', root.children[0].children[0].text === 'Tasks');
  ok('renderTasks subscribes via ctx.onSpineEvent', typeof spine === 'function');
  ok('renderTasks refreshes on render (GET /bridge/tasks)', fetchCount['/bridge/tasks'] === 1, `${fetchCount['/bridge/tasks']}`);
  if (typeof spine === 'function') {
    spine({ detail: { type: 'SKILL_ADDED' } });
    ok('tasks: unrelated event filtered (no refetch)', fetchCount['/bridge/tasks'] === 1);
    spine({ detail: { type: 'TASK_CREATED' } });
    ok('tasks: TASK_ event triggers refetch', fetchCount['/bridge/tasks'] === 2);
  }
  const inputs = findByTag(root, 'input');
  const createBtn = findButton(root, 'Create');
  if (inputs.length && createBtn.length) {
    inputs[0].value = 'ship it';
    const before = sessReads;
    (createBtn[0]._l.click || []).forEach((fn) => fn());
    ok('tasks Create stamps createdBy: ctx.currentSession()', sessReads === before + 1, `${sessReads} read(s)`);
  }
}

// ── renderSkills — SKILL_* via ctx.onSpineEvent; reads ctx.paletteFocus on
// render; Create stamps by: currentSession() ──
{
  let spine = null, sessReads = 0, paletteAsked = false;
  const ctx = {
    onSpineEvent: (h) => { spine = h; },
    currentSession: () => { sessReads++; return 'sess-k'; },
    paletteFocus: () => { paletteAsked = true; return null; },
    focusPanelByKeyword: () => {},
  };
  const root = m.renderSkills(ctx);
  ok('renderSkills → .view root', root.className === 'view');
  ok('renderSkills → <h2> "Skills"', root.children[0].children[0].text === 'Skills');
  ok('renderSkills reads ctx.paletteFocus on render', paletteAsked === true);
  ok('renderSkills subscribes via ctx.onSpineEvent', typeof spine === 'function');
  ok('renderSkills refreshes on render (GET /bridge/skills)', fetchCount['/bridge/skills'] === 1, `${fetchCount['/bridge/skills']}`);
  if (typeof spine === 'function') {
    spine({ detail: { type: 'TASK_CREATED' } });
    ok('skills: unrelated event filtered (no refetch)', fetchCount['/bridge/skills'] === 1);
    spine({ detail: { type: 'SKILL_CREATED' } });
    ok('skills: SKILL_ event triggers refetch', fetchCount['/bridge/skills'] === 2);
  }
  const inputs = findByTag(root, 'input');
  const createBtn = findButton(root, 'Create');
  if (inputs.length && createBtn.length) {
    inputs[0].value = 'New skill';
    const before = sessReads;
    (createBtn[0]._l.click || []).forEach((fn) => fn());
    ok('skills Create stamps by: ctx.currentSession()', sessReads === before + 1, `${sessReads} read(s)`);
  }
}

// ── renderOperations — SLICE_STOP via ctx.onSpineEvent; registers palette panels
// via ctx.panelFocus; reads ctx.fetchProjection + ctx.fetchMemory on render ──
{
  let spine = null, panelCalls = 0, projReads = 0, memReads = 0;
  const ctx = {
    onSpineEvent: (h) => { spine = h; },
    panelFocus(title, aside, body, opts) { panelCalls++; const n = mkNode('div'); n.className = 'panel'; if (body) n.appendChild(body); return n; },
    fetchProjection: () => { projReads++; return new Promise(() => {}); },
    fetchMemory: () => { memReads++; return new Promise(() => {}); },
    currentSession: () => 's',
  };
  const root = m.renderOperations(ctx);
  ok('renderOperations → .view root', root.className === 'view');
  ok('renderOperations → <h2> "Operations"', root.children[0].children[0].text === 'Operations');
  ok('renderOperations registers panels via ctx.panelFocus (≥4)', panelCalls >= 4, `${panelCalls} call(s)`);
  ok('renderOperations subscribes via ctx.onSpineEvent', typeof spine === 'function');
  ok('renderOperations reads ctx.fetchProjection on render', projReads === 1, `${projReads}`);
  ok('renderOperations reads ctx.fetchMemory on render', memReads === 1, `${memReads}`);
  if (typeof spine === 'function') {
    spine({ detail: { type: 'TASK_CREATED' } });
    ok('operations: non-SLICE_STOP filtered (no re-read)', projReads === 1, `${projReads}`);
    spine({ detail: { type: 'SLICE_STOP' } });
    ok('operations: SLICE_STOP triggers refresh (re-read)', projReads === 2, `${projReads}`);
  }
}

// ── renderSwarm — static read; one Promise.all over ctx.fetchLanes +
// ctx.fetchProjection; NO stream subscription (ctx has no onSpineEvent) ──
{
  let laneReads = 0, projReads = 0;
  const ctx = {
    fetchLanes: () => { laneReads++; return new Promise(() => {}); },
    fetchProjection: () => { projReads++; return new Promise(() => {}); },
  };
  const root = m.renderSwarm(ctx);
  ok('renderSwarm → .view root', root.className === 'view');
  ok('renderSwarm → <h2> "Swarm"', root.children[0].children[0].text === 'Swarm');
  ok('renderSwarm reads ctx.fetchLanes on render', laneReads === 1, `${laneReads}`);
  ok('renderSwarm reads ctx.fetchProjection on render', projReads === 1, `${projReads}`);
}

// ── renderEvents — live stream view: subscribes via ctx.onSpineEvent and appends
// each matching row; Pause/Resume toggles the shared long-poll flag through
// ctx.isStreamPaused/toggleStreamPause (never touches the stream singleton) ──
{
  let spine = null, pausedReads = 0, toggles = 0, paused = false;
  const ctx = {
    onSpineEvent: (h) => { spine = h; },
    isStreamPaused: () => { pausedReads++; return paused; },
    toggleStreamPause: () => { toggles++; paused = !paused; return paused; },
  };
  const root = m.renderEvents(ctx);
  ok('renderEvents → .view root', root.className === 'view');
  ok('renderEvents → <h2> "Events"', root.children[0].children[0].text === 'Events');
  ok('renderEvents reads ctx.isStreamPaused on render (button label)', pausedReads >= 1, `${pausedReads}`);
  ok('renderEvents subscribes via ctx.onSpineEvent', typeof spine === 'function');
  const pauseBtn = findButton(root, 'Pause')[0];
  ok('renderEvents renders a Pause button', !!pauseBtn);
  if (pauseBtn) {
    (pauseBtn._l.click || []).forEach((fn) => fn());
    ok('Pause click toggles via ctx.toggleStreamPause', toggles === 1, `${toggles}`);
    ok('Pause click relabels to "Resume"', pauseBtn.textContent === 'Resume', pauseBtn.textContent);
  }
  if (typeof spine === 'function') {
    let threw = false;
    try { spine({ detail: { type: 'SESSION_REGISTERED', ts: '2026-06-20T00:00:00.000Z' } }); }
    catch { threw = true; }
    ok('renderEvents live-appends a matching event without throwing', threw === false);
  }
}

// ── renderApprovals — scope-aware (ctx.scopePill), registers palette panels via
// ctx.panelFocus, reads ctx.fetchApprovals on render, APPROVAL_* via
// ctx.onSpineEvent (fetchApprovals stays in cockpit.js, shared with workbench) ──
{
  let spine = null, panelCalls = 0, apReads = 0;
  const ctx = {
    scopePill: () => null,
    panelFocus(title, aside, body, opts) { panelCalls++; const n = mkNode('div'); n.className = 'panel'; if (body) n.appendChild(body); return n; },
    fetchApprovals: () => { apReads++; return new Promise(() => {}); },
    onSpineEvent: (h) => { spine = h; },
  };
  const root = m.renderApprovals(ctx);
  ok('renderApprovals → .view root', root.className === 'view');
  ok('renderApprovals → <h2> "Approvals"', root.children[0].children[0].text === 'Approvals');
  ok('renderApprovals registers panels via ctx.panelFocus (≥5)', panelCalls >= 5, `${panelCalls} call(s)`);
  ok('renderApprovals reads ctx.fetchApprovals on render', apReads === 1, `${apReads}`);
  ok('renderApprovals subscribes via ctx.onSpineEvent', typeof spine === 'function');
  if (typeof spine === 'function') {
    spine({ detail: { type: 'TASK_CREATED' } });
    ok('approvals: non-APPROVAL_ event filtered (no refetch)', apReads === 1, `${apReads}`);
    spine({ detail: { type: 'APPROVAL_DECIDED' } });
    ok('approvals: APPROVAL_ event triggers refetch', apReads === 2, `${apReads}`);
  }
}

// ── renderOrientation / renderGates / renderReviews — clean read-only ledger
// views: ctx.panelFocus palette panel(s) + debounced ctx.onSpineEvent refresh
// (no filtering). The subscription fires through onSpineEvent; the handler is
// debounced (setTimeout) so we assert it's wired + doesn't throw on fire. ──
for (const [name, title, minPanels] of [
  ['renderOrientation', 'Orientation', 2],
  ['renderGates', 'Gates', 1],
  ['renderReviews', 'Reviews', 1],
]) {
  let spine = null, panelCalls = 0;
  const ctx = {
    panelFocus(t, aside, body, opts) { panelCalls++; const n = mkNode('div'); n.className = 'panel'; if (body) n.appendChild(body); return n; },
    onSpineEvent: (h) => { spine = h; },
  };
  const root = m[name](ctx);
  ok(`${name} → .view root`, root.className === 'view');
  ok(`${name} → <h2> "${title}"`, root.children[0].children[0].text === title);
  ok(`${name} registers ≥${minPanels} panel(s) via ctx.panelFocus`, panelCalls >= minPanels, `${panelCalls}`);
  ok(`${name} subscribes via ctx.onSpineEvent`, typeof spine === 'function');
  if (typeof spine === 'function') {
    let threw = false;
    try { spine({ detail: { type: 'GATE_RAN' } }); } catch { threw = true; }
    ok(`${name} handles a spine event without throwing`, threw === false);
  }
}

// ── renderDashboard — scope-aware headline overview: paints from the cached
// bridge snapshot via ctx.bridgeStatus/bridgeOk, scopes its async fetches via
// ctx.scopedUrl, registers a scope pill. No stream sub, no inspector. ──
{
  let statusReads = 0, okReads = 0, scopedReads = 0, scopePillCalls = 0;
  const ctx = {
    scopePill: () => { scopePillCalls++; return null; },
    scopedUrl: (route, base) => { scopedReads++; return base; },
    rerender: () => {},
    bridgeStatus: () => { statusReads++; return { counts: {}, version: '1.0', host: '127.0.0.1', port: 4177, uptimeMs: 0, repoRoot: '/r', stateDir: '.maddu/' }; },
    bridgeOk: () => { okReads++; return true; },
  };
  const root = m.renderDashboard(ctx);
  ok('renderDashboard → .view root', root.className === 'view');
  ok('renderDashboard → <h2> "Dashboard"', root.children[0].children[0].text === 'Dashboard');
  ok('renderDashboard registers a scope pill via ctx.scopePill', scopePillCalls === 1);
  ok('renderDashboard reads ctx.bridgeStatus on render', statusReads >= 1, `${statusReads}`);
  ok('renderDashboard reads ctx.bridgeOk on render', okReads >= 1, `${okReads}`);
  ok('renderDashboard scopes its projection fetch via ctx.scopedUrl', scopedReads >= 1, `${scopedReads}`);
}

// Find the first node whose className contains `token` (optionally excluding one).
function findByClassToken(node, token, exclude = null, found = []) {
  for (const c of node.children || []) {
    const cls = (c.className || '').split(/\s+/);
    if (cls.includes(token) && (!exclude || !cls.includes(exclude))) found.push(c);
    findByClassToken(c, token, exclude, found);
  }
  return found;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── renderQueueBoard — scope-aware (ctx.scopePill/scopedUrl), debounced
// ctx.onSpineEvent, card click → ctx.openInspector (threaded into the private
// renderQueueCard builder). Canned /bridge/queue lets a card render + be clicked. ──
{
  let spine = null, scopePillCalls = 0, scopedReads = 0, inspects = 0;
  const ctx = {
    scopePill: () => { scopePillCalls++; return null; },
    scopedUrl: (route, base) => { scopedReads++; return base; },
    onSpineEvent: (h) => { spine = h; },
    openInspector: () => { inspects++; },
  };
  const root = m.renderQueueBoard(ctx);
  ok('renderQueueBoard → .view root', root.className === 'view');
  ok('renderQueueBoard → <h2> "Queue Board"', root.children[0].children[0].text === 'Queue Board');
  ok('renderQueueBoard registers a scope pill via ctx.scopePill', scopePillCalls === 1);
  ok('renderQueueBoard scopes its fetch via ctx.scopedUrl', scopedReads >= 1, `${scopedReads}`);
  ok('renderQueueBoard subscribes via ctx.onSpineEvent', typeof spine === 'function');
  await tick(); await tick();
  const card = findByClassToken(root, 'queue-card')[0];
  ok('renderQueueBoard renders a queue card from canned data', !!card);
  if (card) {
    (card._l.click || []).forEach((fn) => fn());
    ok('queue card click opens Inspector via ctx.openInspector', inspects === 1, `${inspects}`);
  }
}

// ── renderClaimMap — debounced ctx.onSpineEvent, row click → ctx.openInspector
// (threaded into the private renderClaimsTable builder). Canned /bridge/claims. ──
{
  let spine = null, inspects = 0;
  const ctx = { onSpineEvent: (h) => { spine = h; }, openInspector: () => { inspects++; } };
  const root = m.renderClaimMap(ctx);
  ok('renderClaimMap → .view root', root.className === 'view');
  ok('renderClaimMap → <h2> "Claim Map"', root.children[0].children[0].text === 'Claim Map');
  ok('renderClaimMap subscribes via ctx.onSpineEvent', typeof spine === 'function');
  await tick(); await tick();
  const row = findByClassToken(root, 'claims-row', 'claims-row-head')[0];
  ok('renderClaimMap renders a claims row from canned data', !!row);
  if (row) {
    (row._l.click || []).forEach((fn) => fn());
    ok('claims row click opens Inspector via ctx.openInspector', inspects === 1, `${inspects}`);
  }
}

// ── renderChats — sessions roster: a single ctx.fetchProjection read rendered
// as session panels. No stream sub, no composer, no inspector. ──
{
  let projReads = 0;
  const ctx = { fetchProjection: () => { projReads++; return new Promise(() => {}); } };
  const root = m.renderChats(ctx);
  ok('renderChats → .view root', root.className === 'view');
  ok('renderChats → <h2> "Chats"', root.children[0].children[0].text === 'Chats');
  ok('renderChats reads ctx.fetchProjection on render', projReads === 1, `${projReads}`);
}

// ── renderWorkbench — the 3-pane operator cockpit (composer-free). Reads via
// ctx.fetch* + ctx.refreshStatus, live via ctx.onSpineEvent, and tears down its
// 8s slow-tick setInterval via ctx.onRouteLeave. ──
{
  let spine = null, leaveFn = null;
  let lanes = 0, proj = 0, status = 0;
  const ctx = {
    fetchLanes: () => { lanes++; return new Promise(() => {}); },
    fetchProjection: () => { proj++; return new Promise(() => {}); },
    fetchMemory: () => new Promise(() => {}),
    fetchApprovals: () => new Promise(() => {}),
    refreshStatus: () => { status++; return new Promise(() => {}); },
    bridgeStatus: () => ({ counts: {}, version: '1', uptimeMs: 0 }),
    onSpineEvent: (h) => { spine = h; },
    onRouteLeave: (fn) => { leaveFn = fn; },
  };
  const root = m.renderWorkbench(ctx);
  ok('renderWorkbench → .view root', root.className === 'view');
  ok('renderWorkbench → no title chrome (first child is <p>)', root.children[0].tag === 'p');
  ok('renderWorkbench reads ctx.fetchLanes on render', lanes >= 1, `${lanes}`);
  ok('renderWorkbench reads ctx.fetchProjection on render', proj >= 1, `${proj}`);
  ok('renderWorkbench refreshes status via ctx.refreshStatus', status >= 1, `${status}`);
  ok('renderWorkbench subscribes via ctx.onSpineEvent', typeof spine === 'function');
  ok('renderWorkbench registers an interval teardown via ctx.onRouteLeave', typeof leaveFn === 'function');
  if (typeof leaveFn === 'function') {
    let threw = false;
    try { leaveFn(); } catch { threw = true; } // clearInterval(slow) — must not throw
    ok('renderWorkbench route-leave cleanup runs without throwing', threw === false);
  }
}

// ── renderConductor — command-control surface. Scope-aware (ctx.scopePill/
// scopedUrl), ctx.panelFocus panels, debounced ctx.onSpineEvent. Canned
// /bridge/conductor lets the board + score matrix render; their card/row clicks
// reach ctx.openInspector (threaded into the private builders). ──
{
  let spine = null, scopePillCalls = 0, panelCalls = 0, scopedReads = 0, inspects = 0;
  const ctx = {
    scopePill: () => { scopePillCalls++; return null; },
    scopedUrl: (route, base) => { scopedReads++; return base; },
    panelFocus(t, aside, body, opts) { panelCalls++; const n = mkNode('div'); n.className = 'panel'; if (body) n.appendChild(body); return n; },
    onSpineEvent: (h) => { spine = h; },
    openInspector: () => { inspects++; },
  };
  const root = m.renderConductor(ctx);
  ok('renderConductor → .view root', root.className === 'view');
  ok('renderConductor → <h2> "Conductor"', root.children[0].children[0].text === 'Conductor');
  ok('renderConductor registers a scope pill via ctx.scopePill', scopePillCalls === 1);
  ok('renderConductor registers panels via ctx.panelFocus (≥5)', panelCalls >= 5, `${panelCalls}`);
  ok('renderConductor scopes its fetch via ctx.scopedUrl', scopedReads >= 1, `${scopedReads}`);
  ok('renderConductor subscribes via ctx.onSpineEvent', typeof spine === 'function');
  await tick(); await tick(); await tick();
  const card = findByClassToken(root, 'board-card')[0];
  ok('renderConductor renders a board card from canned data', !!card);
  const scoreRow = findByClassToken(root, 'score-row')[0];
  ok('renderConductor renders a score-matrix row from canned data', !!scoreRow);
  if (card) {
    (card._l.click || []).forEach((fn) => fn());
    ok('board card click opens Inspector via ctx.openInspector', inspects === 1, `${inspects}`);
  }
  if (scoreRow) {
    const before = inspects;
    (scoreRow._l.click || []).forEach((fn) => fn());
    ok('score row click opens Inspector via ctx.openInspector', inspects === before + 1, `${inspects}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
