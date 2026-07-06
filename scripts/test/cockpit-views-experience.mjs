#!/usr/bin/env node
// cockpit-views-experience — the Experience route's Inspector entity mapping
// + the strict payload shape gate.
//
// Rows open the shell Inspector via ctx.openInspector(trajectoryEntity(t) /
// stepEntity(s)); this verifies both produce the generic entity shape
// (label/evidence/related), surface trajectory-level signals as evidence
// (the P2 NIT), and link signal sources as related events. It also proves
// hasExperienceShape REJECTS the harness's truthy-everywhere proxy envelope
// (the nullProxy lesson: truthiness must never pick a render branch) while
// accepting a real payload. (Render + route presence are covered byte-exact
// by cockpit-boot + cockpit-snapshot; in-browser by cockpit-playwright.)
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  createTextNode: (t) => ({ text: t }),
};

const { trajectoryEntity, stepEntity, hasExperienceShape } =
  await import('../../template/maddu/cockpit/cockpit-views-experience.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// ── trajectoryEntity ─────────────────────────────────────────────────────
const traj = {
  trajectoryId: 'ses_a1', label: 'Claude Code — exp p6', role: 'implementer',
  status: 'open', steps: 18, signals: 4, lanes: ['cockpit', 'docs'],
  firstTs: '2026-07-06T01:00:00Z', lastTs: '2026-07-06T02:00:00Z',
  trajectorySignals: [
    { signalId: 'evt_ls1', kind: 'learn-scan', verdict: 'clean', attachedBy: 'trajectory-scope', sourceEventId: 'evt_ss9' },
  ],
};
const te = trajectoryEntity(traj);
const tev = (label) => (te.evidence.find((x) => x.label === label) || {}).value;

ok('trajectory: kind', te.kind === 'experience-trajectory');
ok('trajectory: id + raw carried', te.id === 'ses_a1' && te.raw === traj);
ok('trajectory: label is the session label', te.label === 'Claude Code — exp p6');
ok('trajectory: role/status/steps/signals evidence', tev('Role') === 'implementer' && tev('Status') === 'open' && tev('Steps') === '18' && tev('Signals') === '4');
ok('trajectory: lanes joined', tev('Lanes') === 'cockpit, docs');
ok('trajectory: span from first/last ts', /2026-07-06T01:00:00Z → 2026-07-06T02:00:00Z/.test(tev('Span')));
ok('trajectory-LEVEL signal surfaced as evidence (P2 NIT)', tev('Trajectory signal · learn-scan') === 'clean');
ok('trajectory: signal source linked as related event', te.related.length === 1 && te.related[0].kind === 'event' && te.related[0].id === 'evt_ss9');

// Lean manifest (env trajectory: nulls everywhere) still maps.
const lean = trajectoryEntity({ trajectoryId: 'env', label: null, role: null, status: 'ambient', steps: 0, signals: 0, lanes: [], trajectorySignals: [] });
ok('trajectory: lean env row maps without throwing', lean.kind === 'experience-trajectory' && lean.label === 'env' && lean.related.length === 0);

// ── stepEntity ───────────────────────────────────────────────────────────
const step = {
  stepId: 'evt_ss1', trajectoryId: 'ses_a1', kind: 'slice-stop', role: 'observation', ts: '2026-07-06T02:00:00Z',
  signals: [
    { signalId: 'evt_g1', kind: 'gate', verdict: 'pass', attachedBy: 'gate-window', sourceEventId: 'evt_g1' },
    { signalId: 'evt_r1', kind: 'review', verdict: 'CLEAN', attachedBy: 'explicit-ref', sourceEventId: 'evt_r1' },
  ],
};
const se = stepEntity(step);
const sev = (label) => (se.evidence.find((x) => x.label === label) || {}).value;

ok('step: kind + id', se.kind === 'experience-step' && se.id === 'evt_ss1');
ok('step: label counts signals', /slice-stop · 2 signal\(s\)/.test(se.label));
ok('step: gate signal evidence names kind + attachment', sev('Signal · gate (gate-window)') === 'pass');
ok('step: review signal evidence', sev('Signal · review (explicit-ref)') === 'CLEAN');
ok('step: both signal sources related', se.related.length === 2 && se.related.every((r) => r.kind === 'event'));
ok('step: signal-less step maps', stepEntity({ stepId: 'evt_x', kind: 'tool', signals: [] }).related.length === 0);

// ── hasExperienceShape: the nullProxy lesson ─────────────────────────────
// A truthy-everywhere chainable proxy (any property → the proxy itself, backed
// by an empty array) mirrors the harness's un-canned envelope. It MUST fail
// the shape gate: stats.eventCount is a proxy, not a number.
function nullProxyLike() {
  const base = [];
  const p = new Proxy(base, { get: (t, k) => (k in t && typeof t[k] === 'function' ? t[k].bind(t) : k === Symbol.iterator ? t[Symbol.iterator].bind(t) : p) });
  return p;
}
ok('shape gate: real payload accepted', hasExperienceShape({ stats: { eventCount: 42 }, trajectories: [] }) === true);
ok('shape gate: truthy proxy envelope REJECTED', hasExperienceShape(nullProxyLike()) === false);
ok('shape gate: null / missing stats rejected', hasExperienceShape(null) === false && hasExperienceShape({ trajectories: [] }) === false);
ok('shape gate: trajectories must be an array', hasExperienceShape({ stats: { eventCount: 1 }, trajectories: {} }) === false);

console.log('');
console.log(`cockpit-views-experience: ${passed} pass - ${failed} fail`);
process.exit(failed ? 1 : 0);
