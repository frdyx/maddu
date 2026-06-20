#!/usr/bin/env node
// cockpit-inspector (v1.70.0) — interaction fixture for the extracted Inspector
// drawer module. Unlike the leaf/view fixtures (which use a hand-rolled node
// stub), the Inspector builds its drawer via `panelEl.innerHTML = <template>`
// then querySelector('#inspector-body') — so it needs a real HTML parser. We
// stand up happy-dom (the same devDependency the Gate A/B harness uses) with a
// single #app host, import the module, and drive openInspector → tab switch →
// closeInspector, asserting the drawer DOM the route views can't see.
//
// happy-dom is absent on a zero-install consumer checkout → SKIP + exit 0.
//
// Exit codes: 0 = OK (or SKIP), 1 = assertion failed, 2 = harness error.

import { loadHappyDom } from './_cockpit-dom-env.mjs';

const happy = await loadHappyDom();
if (!happy) {
  console.log('  [SKIP] happy-dom not installed (consumer checkout) — Inspector fixture skipped.');
  process.exit(0);
}

const { Window } = happy;
const window = new Window({ url: 'http://127.0.0.1:4177/' });
const { document } = window;
document.body.innerHTML = '<div id="app"></div>';
// Install the globals the module touches.
globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.location = window.location;

const m = await import('../../template/maddu/cockpit/cockpit-inspector.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

ok('exports openInspector', typeof m.openInspector === 'function');
ok('exports closeInspector', typeof m.closeInspector === 'function');

const app = document.getElementById('app');

// ── open with a legacy task entity ──
m.openInspector({ kind: 'task', id: 't1', data: { title: 'Ship it', lane: 'core', owner: 'me', status: 'todo', description: 'do the thing' } });
const panel = document.getElementById('inspector-panel');
ok('openInspector builds the drawer (#inspector-panel in #app)', !!panel && app.contains(panel));
ok('drawer is visible (not hidden)', panel && panel.hidden === false);
ok('app gains the inspector-open class', app.classList.contains('inspector-open'));
ok('title reflects the entity', document.getElementById('inspector-title').textContent === 'Ship it');
const tabBtns = document.getElementById('inspector-tabs').querySelectorAll('button');
ok('renders all 5 tabs', tabBtns.length === 5, `${tabBtns.length}`);
ok('overview tab is active by default', tabBtns[0].className.includes('active') && tabBtns[0].textContent === 'overview');
const body = document.getElementById('inspector-body');
ok('overview body shows the task title value', body.textContent.includes('Ship it') && body.textContent.includes('core'));

// ── switch to the Raw tab ──
const rawBtn = [...tabBtns].find((b) => b.textContent === 'raw');
ok('has a Raw tab', !!rawBtn);
if (rawBtn) {
  rawBtn.click();
  const pre = document.getElementById('inspector-body').querySelector('pre');
  ok('Raw tab renders a <pre> JSON dump', !!pre && pre.textContent.includes('"title": "Ship it"'));
}

// ── close ──
m.closeInspector();
ok('closeInspector hides the drawer', document.getElementById('inspector-panel').hidden === true);
ok('app loses the inspector-open class', !app.classList.contains('inspector-open'));

// ── re-open with a depth-upgrade entity (explicit evidence/actions/related) ──
let ran = false;
m.openInspector({
  kind: 'finding', id: 'f1', label: 'A finding',
  evidence: [{ label: 'severity', value: 'P2' }],
  actions: [{ label: 'Do', run: () => { ran = true; } }],
  related: [{ kind: 'task', id: 't1', label: 'related task' }],
});
ok('re-open uses the entity label for the title', document.getElementById('inspector-title').textContent === 'A finding');
const tabs2 = document.getElementById('inspector-tabs').querySelectorAll('button');
const actionsBtn = [...tabs2].find((b) => b.textContent === 'actions');
actionsBtn.click();
const runBtn = [...document.getElementById('inspector-body').querySelectorAll('button')].find((b) => b.textContent === 'Do');
ok('Actions tab renders the author-supplied action button', !!runBtn);
if (runBtn) { runBtn.click(); ok('clicking the action runs its callback', ran === true); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
