#!/usr/bin/env node
// cockpit-command-bar (v1.71.0) — interaction fixture for the extracted slash-
// command bar (composer + Ctrl-K palette). Like the inspector fixture it needs a
// real DOM (initComposer/initPalette wire getElementById('composer-input') etc.
// and the palette overlay), so it uses happy-dom with the composer/palette/
// route-view scaffold. It verifies the module's public contract: initCommandBar
// wires without throwing given the shell host accessors, currentSession reads the
// composer pointer, and the ?focus= deep-link helpers the route views consume via
// ctx (paletteFocus / focusPanelByKeyword) behave.
//
// happy-dom is absent on a zero-install consumer checkout → SKIP + exit 0.
//
// Exit codes: 0 = OK (or SKIP), 1 = assertion failed, 2 = harness error.

import { loadHappyDom } from './_cockpit-dom-env.mjs';

const happy = await loadHappyDom();
if (!happy) {
  console.log('  [SKIP] happy-dom not installed (consumer checkout) — command-bar fixture skipped.');
  process.exit(77); // audit P4: reserved SKIP exit (see _self-test-runner SKIP_EXIT_CODE)
}

const { Window } = happy;
const window = new Window({ url: 'http://127.0.0.1:4177/#/mcp?focus=my-server' });
const { document } = window;
document.body.innerHTML = `
  <div id="route-view"></div>
  <textarea id="composer-input"></textarea>
  <div id="composer-suggest" hidden></div>
  <div id="composer-hint"></div>
  <div id="palette" hidden>
    <input id="palette-input" />
    <div id="palette-results"></div>
    <div id="palette-foot-hint"></div>
  </div>
  <div id="palette-scrim"></div>
`;
globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.location = window.location;
globalThis.Event = window.Event;
globalThis.requestAnimationFrame = () => 0; // focusPanelByKeyword schedules a scroll via rAF; no-op it

const m = await import('../../template/maddu/cockpit/cockpit-command-bar.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

ok('exports initCommandBar', typeof m.initCommandBar === 'function');
ok('exports currentSession', typeof m.currentSession === 'function');
ok('exports paletteFocus', typeof m.paletteFocus === 'function');
ok('exports focusPanelByKeyword', typeof m.focusPanelByKeyword === 'function');

// ── ?focus= deep-link contract (the part route views read via ctx) ──
ok('paletteFocus parses ?focus= from the hash (lowercased)', m.paletteFocus() === 'my-server', `${m.paletteFocus()}`);

// focusPanelByKeyword finds a [data-focus] panel under the given root and must
// not throw (it scrolls + flashes it).
const root = document.createElement('div');
const panel = document.createElement('div');
panel.className = 'panel';
panel.setAttribute('data-focus', 'my-server');
root.appendChild(panel);
let threw = false;
try { m.focusPanelByKeyword(root, 'my-server'); } catch { threw = true; }
ok('focusPanelByKeyword handles a matching panel without throwing', threw === false);

// ── currentSession reads the composer pointer (sticky session); null at rest ──
ok('currentSession() is null before any /use', m.currentSession() === null);

// ── initCommandBar wires the composer + palette against the host accessors ──
let routesAsked = 0, subTargetsAsked = 0;
const host = {
  routes: { mcp: { title: 'MCP Registry', group: 'connect', description: '', keywords: '' } },
  isRouteHidden: () => { routesAsked++; return false; },
  allSubTargets: () => { subTargetsAsked++; return []; },
  refreshDataSubTargets: () => Promise.resolve(),
  getWorkspaces: () => [],
  getCurrentWorkspace: () => 'default',
  setActiveWorkspace: () => {},
};
let initThrew = false;
try { m.initCommandBar(host); } catch (e) { initThrew = true; console.log('    init error:', e.message); }
ok('initCommandBar(host) wires composer + palette without throwing', initThrew === false);

// After wiring, typing a slash into the composer should render suggestions
// without throwing (exercises the host-free composer path).
const input = document.getElementById('composer-input');
input.value = '/he';
let inputThrew = false;
try { input.dispatchEvent(new window.Event('input')); } catch { inputThrew = true; }
ok('composer input handler runs without throwing', inputThrew === false);
ok('slash input reveals the suggestion list', document.getElementById('composer-suggest').hidden === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
