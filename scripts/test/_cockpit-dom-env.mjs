// Shared headless DOM environment for the cockpit verification harness.
//
// cockpit.js is a browser SPA — it wires `els` from getElementById at module
// eval, installs a fetch shim, and boots into an infinite event long-poll. To
// verify it headlessly (no browser binary, no operator refresh) we stand up a
// pure-JS DOM with happy-dom, feed it the real cockpit/index.html scaffold, a
// deterministic fake bridge, and frozen time — then import + boot the actual
// shipped cockpit.js and render every route into a stable DOM we can snapshot.
//
// This file is `_`-prefixed so the self-test runner does NOT discover it as a
// test (runner filter: /^_/). The two gates that consume it — cockpit-boot.mjs
// (Gate A: wiring/load) and cockpit-snapshot.mjs (Gate B: render regression) —
// are the discovered tests.
//
// happy-dom is a devDependency. On a zero-install consumer checkout it is
// absent; loadHappyDom() returns null and each gate prints SKIP + exits 0 so
// `maddu self-test` stays green without it.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const COCKPIT_DIR = join(HERE, '..', '..', 'template', 'maddu', 'cockpit');
export const COCKPIT_ENTRY = join(COCKPIT_DIR, 'cockpit.js');

// A fixed epoch so frozen Date.now() / no-arg new Date() are deterministic.
// Data-driven `new Date(iso)` keeps parsing real fixture timestamps.
const FROZEN_EPOCH = Date.parse('2026-06-19T12:00:00.000Z'); // 1782216000000

export async function loadHappyDom() {
  try {
    return await import('happy-dom');
  } catch {
    return null;
  }
}

// Timers created during boot/render are collected so teardown() can clear them
// — the cockpit's setInterval(fetchBridgeStatus, 15000) would otherwise keep
// Node's event loop alive and the gate would hang instead of exiting.
const _timers = new Set();

function installTimerCollector() {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const h = realSetTimeout(fn, ms, ...rest);
    _timers.add(h);
    return h;
  };
  globalThis.setInterval = (fn, ms, ...rest) => {
    const h = realSetInterval(fn, ms, ...rest);
    _timers.add(h);
    return h;
  };
  return () => {
    for (const h of _timers) { try { realClearTimeout(h); } catch {} try { realClearInterval(h); } catch {} }
    _timers.clear();
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.clearInterval = realClearInterval;
  };
}

let _restoreTimers = null;

// Mirror the browser globals cockpit.js relies on from happy-dom's window onto
// globalThis (cockpit uses bare `document`/`location`/`fetch`/… references).
const MIRRORED = [
  'document', 'location', 'history', 'localStorage', 'sessionStorage', 'navigator',
  'Headers', 'URL', 'URLSearchParams', 'Event', 'CustomEvent', 'EventTarget',
  'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'Text', 'Comment',
  'MutationObserver', 'FormData', 'Blob', 'Request', 'Response', 'getComputedStyle',
  'cancelAnimationFrame', 'CSS',
];

export async function installDom() {
  const happy = await loadHappyDom();
  if (!happy) return null;
  const { Window } = happy;
  const window = new Window({ url: 'http://127.0.0.1:4177/#/conductor' });
  const { document } = window;

  // Build the cockpit scaffold from the REAL index.html (drift-proof) — strip
  // the module <script> so we control when cockpit.js is imported.
  const indexHtml = await readFile(join(COCKPIT_DIR, 'index.html'), 'utf8');
  const bodyInner = indexHtml
    .replace(/^[\s\S]*<body>/i, '')
    .replace(/<\/body>[\s\S]*$/i, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  document.body.innerHTML = bodyInner;

  // Mirror browser globals. Some Node globals (e.g. navigator) are getter-only
  // on globalThis, so fall back to defineProperty.
  const mirror = (name, value) => {
    try { globalThis[name] = value; }
    catch { try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); } catch {} }
  };
  mirror('window', window);
  for (const name of MIRRORED) {
    if (window[name] !== undefined) mirror(name, window[name]);
  }

  // Freeze time. Subclass the real Date so no-arg `new Date()` and Date.now()
  // are fixed, while `new Date(iso)` still parses fixture timestamps.
  const RealDate = window.Date || Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FROZEN_EPOCH);
      else super(...args);
    }
    static now() { return FROZEN_EPOCH; }
  }
  globalThis.Date = FrozenDate;
  if (window) window.Date = FrozenDate;

  // requestAnimationFrame → no-op (its callbacks only fire on click/scroll
  // affordances that never run during a plain route render; executing them
  // would add async class toggles and defeat determinism).
  globalThis.requestAnimationFrame = () => 0;
  if (window) window.requestAnimationFrame = () => 0;

  // Stubs for affordances happy-dom may not implement (defensive — none fire
  // during render, but a missing method would throw if a handler ever ran).
  if (!globalThis.CSS || typeof globalThis.CSS.escape !== 'function') {
    globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
    if (window) window.CSS = globalThis.CSS;
  }
  for (const proto of [window.Element && window.Element.prototype]) {
    if (proto && typeof proto.scrollIntoView !== 'function') proto.scrollIntoView = () => {};
  }
  window.prompt = () => null;
  window.confirm = () => false;
  window.alert = () => {};
  window.scrollTo = () => {};
  globalThis.prompt = window.prompt;
  globalThis.confirm = window.confirm;
  globalThis.alert = window.alert;
  globalThis.scrollTo = window.scrollTo;
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  }
  globalThis.matchMedia = window.matchMedia;

  _restoreTimers = installTimerCollector();

  return { window, document };
}

// Deterministic fake bridge. Every /bridge/* request resolves to canned JSON
// with FIXED timestamps/ids. The event long-poll (/bridge/events/wait) hangs
// (never resolves) so streamLoop parks on its first await instead of spinning.
// Unknown endpoints resolve to an empty `{}` envelope: cockpit renderers guard
// with `data.X || []`/`|| {}`, so they fall through to their deterministic
// empty-state DOM — which still anchors a move-refactor (the same render fn
// produces byte-identical output before and after relocation).
const FIXED_TS = '2026-06-19T12:00:00Z';

const CANNED = {
  '/bridge/status': {
    bridge: 'maddu', ok: true,
    version: '1.37.0-harness', uptimeMs: 3_600_000,
    workspaceId: 'maddu', repoRoot: '/repo/maddu',
    frameworkLayout: 'source',
    governance: { mode: 'standard' }, mode: 'standard',
    host: '127.0.0.1', port: 4177,
  },
  '/bridge/_workspaces': { legacy: true },
  '/bridge/events/poll': { lastEventId: 'evt_00000000', events: [] },
  '/bridge/focus': {
    enabled: true,
    goal: { objective: 'ship the focus director' },
    focus: {
      lastTag: 'away',
      window: [
        { tag: 'toward', distanceScore: 0.18, ts: FIXED_TS },
        { tag: 'toward', distanceScore: 0.30, ts: FIXED_TS },
        { tag: 'lateral', distanceScore: 0.55, ts: FIXED_TS },
        { tag: 'away', distanceScore: 0.82, ts: FIXED_TS },
        { tag: 'away', distanceScore: 0.91, ts: FIXED_TS },
      ],
      openFlag: { reason: '2 consecutive turns off the goal axis with no return', runs: 2, menu: ['swap', 'revert', 'continue'], at: FIXED_TS },
      updatedAt: FIXED_TS,
    },
    turns: [
      { id: 'evt_ft1', ts: FIXED_TS, tag: 'toward', distanceScore: 0.18, signals: { focusText: 'focus director tagger', overlap: 0.82, churn: 0 }, sourceEventId: 'evt_hb1' },
      { id: 'evt_ft2', ts: FIXED_TS, tag: 'toward', distanceScore: 0.30, signals: { focusText: 'cockpit route trajectory', overlap: 0.70, churn: 1 }, sourceEventId: 'evt_hb2' },
      { id: 'evt_ft3', ts: FIXED_TS, tag: 'lateral', distanceScore: 0.55, signals: { focusText: 'director gradient palette', overlap: 0.45, churn: 2 }, sourceEventId: 'evt_hb3' },
      { id: 'evt_ft4', ts: FIXED_TS, tag: 'away', distanceScore: 0.82, signals: { focusText: 'billing invoice stripe', overlap: 0.18, churn: 3 }, sourceEventId: 'evt_hb4' },
      { id: 'evt_ft5', ts: FIXED_TS, tag: 'away', distanceScore: 0.91, signals: { focusText: 'stripe webhook retry', overlap: 0.09, churn: 4 }, sourceEventId: 'evt_ss1' },
    ],
  },
};

function jsonResponse(body) {
  const text = JSON.stringify(body);
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

// Chainable empty-collection proxy for un-canned endpoints. Backed by an empty
// array so length/map/filter/slice/iteration all work; any unknown property
// returns the proxy itself, so `data.open.length`, `data.summary.total`, and
// `for (const x of data.items)` resolve to deterministic empty-state without a
// per-endpoint fixture. (A renderer that calls a STRING method on a proxied
// scalar — e.g. `data.name.toUpperCase()` — still throws; that surfaces in
// Gate A and gets a specific CANNED fixture.)
function nullProxy() {
  const base = [];
  const p = new Proxy(base, {
    get(t, prop) {
      if (typeof prop === 'symbol') return t[prop];
      if (prop === 'then' || prop === 'toJSON') return undefined;
      if (prop in t) return t[prop];
      return p;
    },
  });
  return p;
}

function proxyResponse() {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => nullProxy(),
    text: async () => '{}',
  };
}

export function installFakeBridge(env) {
  const fake = (input, init) => {
    const url = typeof input === 'string'
      ? input
      : (input && (input.href || input.url)) || String(input || '');
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path === '/bridge/events/wait') return new Promise(() => {}); // park forever
    if (Object.prototype.hasOwnProperty.call(CANNED, path)) return Promise.resolve(jsonResponse(CANNED[path]));
    const method = (init && init.method) || 'GET';
    if (method !== 'GET') return Promise.resolve(jsonResponse({ ok: true }));
    return Promise.resolve(proxyResponse()); // permissive chainable empty envelope
  };
  env.window.fetch = fake;
  globalThis.fetch = fake;
  return fake;
}

// After cockpit.js evaluates, its fetch shim has wrapped window.fetch — re-sync
// bare `fetch` to that wrapper so workspace-header injection is exercised.
export function syncFetchShim(env) {
  globalThis.fetch = env.window.fetch;
}

// Drain microtasks + let any 0ms timers / IO settle so async-mutating renderers
// (fetch → replaceChildren) reach their settled DOM before we snapshot.
export async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

// Stable serialization of an element subtree: lowercase tag, SORTED attributes,
// normalized whitespace, volatile timestamps/ids masked (defense in depth — the
// fake bridge already uses fixed values).
function mask(s) {
  return String(s)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?/g, '<TS>')
    .replace(/\b(evt|ses|pln|tsk)_[A-Za-z0-9]+/g, '$1_<ID>');
}

function serializeNode(node, indent) {
  const pad = '  '.repeat(indent);
  if (node.nodeType === 3) {
    const t = mask(node.textContent.replace(/\s+/g, ' ').trim());
    return t ? `${pad}"${t}"` : '';
  }
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  const attrs = Array.from(node.attributes || [])
    .map((a) => [a.name, a.value])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}="${mask(v)}"`)
    .join(' ');
  const open = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
  const kids = Array.from(node.childNodes || [])
    .map((c) => serializeNode(c, indent + 1))
    .filter(Boolean);
  if (!kids.length) return `${pad}${open}`;
  return `${pad}${open}\n${kids.join('\n')}\n${pad}</${tag}>`;
}

export function serialize(node) {
  if (!node) return '<null>';
  return serializeNode(node, 0);
}

// Reset between routes: clear the route view, hash, and persisted prefs so each
// route renders from a clean slate. (#route-view is the per-route snapshot
// target; SUB_REGISTRY/inspector are module-private and never reach that
// subtree, so they need no reset for Gate B.)
export function resetRoute(env) {
  try { env.window.localStorage.clear(); } catch {}
}

export function teardown(env) {
  if (_restoreTimers) { _restoreTimers(); _restoreTimers = null; }
  try { if (env && env.window && typeof env.window.happyDOM?.abort === 'function') env.window.happyDOM.abort(); } catch {}
}
