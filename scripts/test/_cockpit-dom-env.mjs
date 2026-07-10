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
  } catch (err) {
    // audit P4 — only a GENUINE absence (happy-dom not installed) is a skip;
    // a corrupt/broken happy-dom must propagate as a real harness error, never
    // be silently downgraded to "skipped" (which would read as PASS).
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && /happy-dom/.test(String(err.message || ''))) return null;
    throw err;
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
  '/bridge/orientation': {
    orientation: {
      lastEventId: 'evt_00000042',
      goal: { objective: 'ship the focus director', constraints: [] },
      phase: { name: 'release 2.0', tier: 'strict', setAt: FIXED_TS },
      autonomy: { lane: 'backend', fromRung: 'observe', toRung: 'established', recommendation: 'maintain', muted: true, mutedReason: 'active phase: release 2.0', wilson: 0.72, n: 12, at: FIXED_TS },
      activeSession: { id: 'ses_fixture01' },
      lastSliceStop: { summary: 'SLICE STOP: cockpit fixtures wired' },
      counters: { sessions: 1, slices: 1 },
      openFollowups: [],
    },
  },
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
  '/bridge/experience': {
    schemaVersion: 1,
    stats: {
      schemaVersion: 1, eventCount: 42, stepCount: 30, trajectoryCount: 2, envStepCount: 3,
      byRole: { action: 12, outcome: 8, observation: 9, signal: 1 },
      byKind: { tool: 10, gate: 8, 'slice-stop': 6, other: 6 },
      unmappedTypes: {},
      signalCount: 5,
      signalsByKind: { gate: 3, review: 1, 'learn-scan': 1 },
      signalsByAttachment: { 'gate-window': 3, 'explicit-ref': 1, 'trajectory-scope': 1 },
      unattachedTrailingGates: 1,
      absentByDesign: ['model-output', 'prompt-text', 'token-observations', 'environment-snapshots', 'reward'],
    },
    trajectories: [
      {
        trajectoryId: 'ses_fixture01', label: 'Claude Code — cockpit fixtures', role: 'implementer',
        openedAt: FIXED_TS, closedAt: null, status: 'open',
        steps: 18, stepsByRole: { action: 8, outcome: 6, observation: 4 }, lanes: ['cockpit'],
        firstTs: FIXED_TS, lastTs: FIXED_TS, signals: 4,
        trajectorySignals: [
          { signalId: 'evt_ls01', kind: 'learn-scan', verdict: 'clean', attachedBy: 'trajectory-scope', sourceEventId: 'evt_ss1' },
        ],
      },
      {
        trajectoryId: 'ses_fixture02', label: 'Codex — review pass', role: 'reviewer',
        openedAt: FIXED_TS, closedAt: FIXED_TS, status: 'closed',
        steps: 9, stepsByRole: { action: 4, outcome: 3, observation: 2 }, lanes: ['review'],
        firstTs: FIXED_TS, lastTs: FIXED_TS, signals: 1,
        trajectorySignals: [],
      },
    ],
    recentSignalSteps: [
      {
        stepId: 'evt_ss1', trajectoryId: 'ses_fixture01', kind: 'slice-stop', role: 'observation', ts: FIXED_TS,
        signals: [
          { signalId: 'evt_g01', kind: 'gate', verdict: 'pass', attachedBy: 'gate-window', sourceEventId: 'evt_g01' },
          { signalId: 'evt_rv1', kind: 'review', verdict: 'CLEAN', attachedBy: 'explicit-ref', sourceEventId: 'evt_rv1' },
        ],
      },
    ],
    evolve: {
      noOp: true,
      scanned: {
        events: 42, steps: 30, trajectories: 2, priorCorrections: 10,
        thresholds: { minOccurrences: 3, minScopes: 2 },
        detectors: {
          'tool-correction': { refusalCompletionPairs: 0 },
          'gate-flap': { failOkArcs: 2 },
          'recurring-learning': { recurringLearnings: 0 },
          'uncorrected-gate': { gatesWithFails: 1 },
        },
      },
      recommendations: [
        {
          recId: 'rec_noop_fixture', detector: 'no-op', category: 'no-op',
          summary: 'no recommendation clears the evidence thresholds — the honest output is: change nothing',
          confidence: 1, why: 'Scanned 42 event(s) / 30 step(s): 0 refusal→completion pair(s), 2 gate fail→ok arc(s), 0 recurring learning(s), 1 gate(s) with failures — none reached ≥3 occurrences across ≥2 scopes.',
          draft: null, evidenceCount: 0,
        },
      ],
    },
  },
  '/bridge/model': {
    schemaVersion: 1,
    stats: { datasets: 1, runs: 1, checkpoints: 2, evals: 1, proposals: 2, releases: 1, rollbacks: 1, unacknowledgedCriticalEvals: 1 },
    checkpoints: [
      { checkpointKey: `sha256:${'a'.repeat(64)}`, model_id: 'acme-triage-8b', uri: 's3://bucket/ckpt-a', run_id: 'run-fx-1', registeredAt: FIXED_TS, stage: 'candidate' },
      { checkpointKey: `sha256:${'b'.repeat(64)}`, model_id: 'acme-triage-8b', uri: null, run_id: null, registeredAt: FIXED_TS, stage: 'experiment' },
    ],
    datasets: [
      { dataset_id: 'tickets-v3', license: 'CC-BY-4.0', synthetic: true, hash: `sha256:${'a'.repeat(64)}`, manifestPath: 'models/ds.json', manifestHash: `sha256:${'c'.repeat(64)}`, at: FIXED_TS, eventId: 'evt_mds1' },
    ],
    runs: [
      { run_id: 'run-fx-1', model_id: 'acme-triage-8b', method: 'SFT', dataset_snapshot: 'tickets-v3', startedAt: FIXED_TS, completedAt: FIXED_TS, checkpointKey: `sha256:${'a'.repeat(64)}` },
    ],
    evals: [
      { eval_id: 'ev-fx-1', checkpointKey: `sha256:${'a'.repeat(64)}`, benchmark: 'swe-bench-verified', harness_version: '1.4.2', pass_rate: 0.31, at: FIXED_TS, criticalRegressions: 1, acknowledged: false },
    ],
    proposals: [
      { proposalId: 'evt_mp1', checkpointKey: `sha256:${'a'.repeat(64)}`, from_stage: 'experiment', to_stage: 'candidate', approvalRequestId: 'evt_ar1', at: FIXED_TS, approved: true, approvalRef: 'evt_ar1' },
      { proposalId: 'evt_mp2', checkpointKey: `sha256:${'a'.repeat(64)}`, from_stage: 'candidate', to_stage: 'canary', approvalRequestId: 'evt_ar2', at: FIXED_TS, approved: false, approvalRef: null },
    ],
    releases: [
      { checkpointKey: `sha256:${'a'.repeat(64)}`, model_id: 'acme-triage-8b', rollback_plan: 'repoint the serving alias', at: FIXED_TS, eventId: 'evt_mr1' },
    ],
    rollbacks: [
      { checkpointKey: `sha256:${'a'.repeat(64)}`, model_id: 'acme-triage-8b', reverted_to: 'candidate', at: FIXED_TS, eventId: 'evt_mb1' },
    ],
  },
  '/bridge/oversight': {
    skills: {
      injected: [
        { ts: FIXED_TS, sessionId: 'ses_demo', skillIds: ['brand-voice', 'changelog'], triggers: ['brand'], tags: ['docs'], totalBytes: 2048, ageMs: 300000 },
      ],
      refused: [
        {
          ts: FIXED_TS, sessionId: 'ses_demo', reason: 'unacknowledged-external-refs',
          refused: [
            { id: 'brand-landing.md', provenance: 'imported', reason: 'unacknowledged-external-refs', plain: 'blocked — points off-box to an unreviewed link' },
          ],
          ageMs: 120000,
        },
      ],
      withheldCount: 1,
      emptyState: null,
    },
    focus: { lastTag: 'toward', openFlag: null, goal: 'ship the oversight surface', updatedAt: FIXED_TS },
    verify: { events: 3156, chainIntact: true, counts: { WARN: 0, FAIL: 0 }, contractVersion: '1.3.0' },
  },
  '/bridge/decisions': {
    decisions: [
      { ts: FIXED_TS, id: 'evt_00000009', type: 'GOAL_COMPLETED', category: 'outcome', label: 'goal completed', actor: 'ses_demo', lane: null, provenance: 'ses_demo', auto: false, summary: 'ship the operator plane harvest', sha: 'b156e3d5cf2e', ageMs: 60000 },
      { ts: FIXED_TS, id: 'evt_00000007', type: 'APPROVAL_DECIDED', category: 'decision', label: 'approval decided', actor: 'ses_demo', lane: 'observability', provenance: 'ses_demo', auto: false, summary: 'allow · git — push', sha: '02d12378347a', ageMs: 120000 },
      { ts: FIXED_TS, id: 'evt_00000005', type: 'TRIGGER_FIRED', category: 'decision', label: 'trigger fired', actor: null, lane: null, provenance: 'auto:drift-detected', auto: true, summary: 'drift-detected', sha: 'f75f85af3e7a', ageMs: 240000 },
      { ts: FIXED_TS, id: 'evt_00000003', type: 'GATE_RAN', category: 'gate', label: 'gate', actor: null, lane: null, provenance: 'system', auto: false, summary: 'release-parity fail (delivery)', sha: '0d3cf39d7efc', ageMs: 480000 },
      { ts: FIXED_TS, id: 'evt_00000001', type: 'GOAL_DECLARED', category: 'intent', label: 'goal set', actor: 'system', lane: null, provenance: 'system', auto: false, summary: 'ship the operator plane harvest', sha: '3d387d9d6f26', ageMs: 900000 },
    ],
    total: 19, shown: 5,
    byCategory: { intent: 14, decision: 2, gate: 2, outcome: 1 },
    verify: { events: 3241, chainIntact: true, tampered: 0, contractVersion: '1.3.0' },
  },
  '/bridge/project-cockpit': {
    project: 'maddu',
    phase: null,
    goal: {
      objective: 'ship the operator plane harvest', metCount: 3, verifiable: 4, total: 4,
      percent: 75, allMet: false, evaluatedAt: FIXED_TS,
      conditions: [
        { text: 'buildProjectCockpit exists', verify: 'node -e 0', state: 'met' },
        { text: 'route renders', verify: 'node -e 0', state: 'met' },
        { text: 'golden captured', verify: 'node -e 0', state: 'met' },
        { text: 'merged to main', verify: 'node -e 0', state: 'pending' },
      ],
    },
    focus: {
      lastTag: 'toward', onGoal: 0.9, openFlag: null,
      trajectory: [
        { tag: 'toward', onGoal: 1, ts: FIXED_TS },
        { tag: 'lateral', onGoal: 0.5, ts: FIXED_TS },
        { tag: 'toward', onGoal: 0.9, ts: FIXED_TS },
      ],
    },
    fleet: { total: 3, running: 1, stuck: 0, byStatus: { running: 1, exited: 2 }, active: [{ id: 'wrk_demo', lane: 'observability', status: 'running', ageMs: 30000 }] },
    steeredBy: [{ id: 'ses_demo', role: 'implementer', label: 'maddu', focus: 'operator plane p2', source: 'cli', sinceMs: 600000, beatMs: 45000 }],
    recentSlices: [{ summary: 'SLICE STOP: project cockpit builder + route. Action: fused focus + success + fleet. Targets: bridge-builders.mjs, cockpit-views-project.js. Gates: Playwright 51, audit 16. Learnings: - type-narrow every field - cached success no spawn. Reason: harvest phase 2.', lane: 'observability', ageMs: 120000 }],
    lastEventId: 'evt_00000009',
  },
  '/bridge/_all/portfolio': {
    cards: [
      { workspace_id: 'snyggare', workspace_label: 'snyggare', project: 'snyggare', goal: 'ship the client site', percent: 40, metCount: 2, total: 5, allMet: false, onGoal: 0.3, lastTag: 'away', driftFlag: { reason: '5 turns off-axis', runs: 5 }, openApprovals: 1, running: 1, stuck: 1, activeSessions: 1, lastSliceAgeMs: 300000, lastSliceSummary: 'SLICE STOP: hero section', hasHandoff: true },
      { workspace_id: 'maddu', workspace_label: 'maddu', project: 'maddu', goal: 'ship the operator plane harvest', percent: 100, metCount: 4, total: 4, allMet: true, onGoal: 1, lastTag: 'toward', driftFlag: null, openApprovals: 0, running: 0, stuck: 0, activeSessions: 1, lastSliceAgeMs: 120000, lastSliceSummary: 'SLICE STOP: portfolio wall', hasHandoff: true },
    ],
    needsHuman: [
      { workspace_id: 'snyggare', workspace_label: 'snyggare', kind: 'drift', detail: '5 turns off-axis', runs: 5 },
      { workspace_id: 'snyggare', workspace_label: 'snyggare', kind: 'approvals', count: 1, detail: '1 approval(s) pending' },
      { workspace_id: 'snyggare', workspace_label: 'snyggare', kind: 'stuck', count: 1, detail: '1 stuck worker(s)' },
    ],
    workspaceCount: 2,
    errors: [],
  },
  '/bridge/digest': {
    range: { sinceId: 'evt_00000001', lastEventId: 'evt_00000009', newEventCount: 12 },
    headline: 'While you were away: 2 slices landed, gates green. 1 approval needs you; goal 3/4 met.',
    sliceStops: [
      { ts: FIXED_TS, lane: 'observability', summary: 'SLICE STOP: digest builder + bridge route. Action: added buildDigest + /bridge/digest. Targets: bridge-builders.mjs, server.js. Gates: self-test 144, audit 16. Learnings: - reused readSince - bridge reads cache. Next actions: - project cockpit. Reason: approved plan.', ageMs: 300000 },
      { ts: FIXED_TS, lane: 'cockpit-shell', summary: 'SLICE STOP: digest cockpit view', ageMs: 600000 },
    ],
    sliceStopCount: 2,
    drift: [],
    driftCount: 0,
    gates: { ran: 4, failed: 0, failing: [] },
    needsYou: [
      { approvalId: 'evt_00000007', tool: 'git', action: 'push', summary: 'push feat/operator-plane-p1-digest', ageMs: 90000 },
    ],
    goal: { objective: 'ship the operator plane harvest', metCount: 3, total: 4, allMet: false, evaluatedAt: FIXED_TS },
    focus: { lastTag: 'toward', openFlag: null },
    empty: false,
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
