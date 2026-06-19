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
const fetchCount = { '/bridge/mailbox-counts': 0, '/bridge/tasks': 0, '/bridge/skills': 0 };
globalThis.fetch = (url, init) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (path in fetchCount && (!init || !init.method)) fetchCount[path]++;
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
