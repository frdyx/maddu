#!/usr/bin/env node
// experience (EXP phase 1) — golden fixture for the pure spine→steps
// derivation in template/maddu/runtime/lib/experience.mjs.
//
// Verifies, on a synthetic mini-spine:
//   • trajectory grouping is EXPLICIT LINKAGE ONLY (actor / data.sessionId /
//     data.session naming a KNOWN session) — everything else lands in "env"
//   • per-kind axis extraction (tool/worker/gate/slice-stop/state) with
//     null/[] where the event is silent — no invented data
//   • unknown/dormant types degrade to observation/other + stats.unmappedTypes
//   • step identity is borrowed from event ids (no minted ids)
//   • determinism: two runs over the same events are byte-identical JSON
//   • zero writes: the module takes an array; nothing here touches .maddu/
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { deriveExperience, ENV_TRAJECTORY, EXPERIENCE_SCHEMA_VERSION } from '../../template/maddu/runtime/lib/experience.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const T = '2026-01-01T00:00:';
const ev = (id, type, actor, lane, data, extra = {}) =>
  ({ v: 1, id, ts: `${T}${String(evSeq++).padStart(2, '0')}.000Z`, type, actor, lane, data, ...extra });
let evSeq = 0;

// ── synthetic mini-spine ────────────────────────────────────────────────────
const EVENTS = [
  // session A opens, claims a lane, tools, gates, slice-stops, closes
  ev('evt_a_reg',   'SESSION_AUTO_REGISTERED', 'ses_a', null, { sessionId: 'ses_a', label: 'Agent A', role: 'implementer', source: 'cli' }),
  ev('evt_a_lane',  'LANE_CLAIMED',            'ses_a', 'lane-1', { focus: 'build the thing' }),
  ev('evt_a_tool1', 'TOOL_INVOKED',            'ses_a', 'lane-1', { tool: 'git', argv: ['commit', '-m', 'x'], mode: null }),
  ev('evt_a_tool2', 'TOOL_COMPLETED',          'ses_a', 'lane-1', { tool: 'git', argv: ['commit', '-m', 'x'], exitCode: 0, durationMs: 42 }),
  ev('evt_a_gate',  'GATE_RAN',                null,    null,     { gateId: 'spine-integrity', ok: true, severity: 'critical', durationMs: 7, status: 'pass' }),
  ev('evt_a_stop',  'SLICE_STOP',              'ses_a', 'lane-1', { summary: 'built the thing', learnings: ['x works'], targets: ['a.mjs'], gates: ['spine-integrity'], deliverables: ['a.mjs'] }),
  ev('evt_a_close', 'SESSION_CLOSED',          'ses_a', null,     { handoff: null }),

  // session B: registered but linked only via data.sessionId on a worker
  ev('evt_b_reg',   'SESSION_REGISTERED',      'ses_b', null, { label: 'Agent B', role: 'reviewer' }),
  ev('evt_b_wrk',   'WORKER_SPAWNED',          null,    null, { id: 'w1', command: 'node', args: ['x.mjs'], pid: 1, runtime: 'claude', log: 'l', sessionId: 'ses_b' }),
  ev('evt_b_wex',   'WORKER_EXITED',           null,    null, { id: 'w1', exitCode: 0, runtime: 'claude', sessionId: 'ses_b' }),

  // environment: no linkage (actor null / unknown), incl. a session-shaped id
  // that was NEVER registered — must NOT create a trajectory
  ev('evt_env_audit', 'AUDIT_REPORT',          null,      null, { scope: 'framework', counts: {}, checks: [] }),
  ev('evt_env_ghost', 'TOOL_REFUSED',          'ses_ghost', null, { tool: 'bash', argv: ['rm'], reason: 'dangerous-form', detail: 'no' }),

  // dormant/unknown type — degrades, never crashes
  ev('evt_env_new',  'SOME_FUTURE_TYPE',       null, null, { anything: 1 }),

  // refusal → outcome refused
  ev('evt_a2_ref',  'TOOL_REFUSED',            'ses_a', null, { tool: 'install', argv: ['left-pad'], reason: 'allowlist', detail: 'nope' }),

  // ── phase-2 signal sources ────────────────────────────────────────────────
  // Review names evt_a_stop explicitly (explicit-ref).
  ev('evt_sig_rev',  'SLICE_REVIEWED', null, null, { sliceEventId: 'evt_a_stop', verdict: 'CLEAN', findingsCount: 0, reviewerRuntime: 'codex', reviewPath: 'x.md' }),
  // Trigger names evt_a_stop via sliceEventId (explicit-ref).
  ev('evt_sig_trig', 'TRIGGER_FIRED',  null, null, { triggerId: 'post-stop-review', reason: 'slice', sliceEventId: 'evt_a_stop' }),
  // Focus tag names the tool step (explicit-ref).
  ev('evt_sig_foc',  'FOCUS_TAGGED',   null, null, { tag: 'toward', distanceScore: 0.2, signals: {}, sourceEventId: 'evt_a_tool2' }),
  // A hedged, proof-less second slice-stop for session A → learn-scan derived
  // signal. NOTE: it also closes the open gate window (empty — no gates since
  // evt_a_stop... except the ones below land AFTER it, staying trailing).
  ev('evt_a_stop2',  'SLICE_STOP',     'ses_a', 'lane-1', { summary: 'this should work now, done I think', learnings: [], targets: [], gates: [], deliverables: [] }),
  // Aggregate evidence with no per-step linkage → trajectory-level signals.
  ev('evt_sig_auto', 'AUTONOMY_SCORED', null, null, { schemaVersion: 1, asOf: 'x', attribution: 'x', configHash: 'x', totalSlices: 2, lanes: [{ lane: 'lane-1' }] }),
  ev('evt_sig_drift','DRIFT_FLAGGED',  'ses_a', null, { cleared: false, choice: null, reason: '2 away turns', runs: 2, menu: ['swap'], deterministic: true, enriched: false }),
  // A trailing gate AFTER the last SLICE_STOP — must stay unattached + counted.
  ev('evt_gate_tail','GATE_RAN',       null, null, { gateId: 'tail-gate', ok: false, severity: 'warn', durationMs: 1, status: 'fail' }),
];

const out = deriveExperience(EVENTS);

// ── shape + versioning ──────────────────────────────────────────────────────
ok('schemaVersion rides top-level and stats', out.schemaVersion === EXPERIENCE_SCHEMA_VERSION && out.stats.schemaVersion === EXPERIENCE_SCHEMA_VERSION);
ok('one step per event (nothing dropped)', out.steps.length === EVENTS.length, `${out.steps.length}/${EVENTS.length}`);
ok('step ids are borrowed event ids', out.steps.every((s, i) => s.stepId === EVENTS[i].id));

// ── trajectory membership ───────────────────────────────────────────────────
const byId = Object.fromEntries(out.steps.map((s) => [s.stepId, s]));
ok('actor linkage → session A', byId.evt_a_tool1.trajectoryId === 'ses_a');
ok('data.sessionId linkage → session B (actor null)', byId.evt_b_wrk.trajectoryId === 'ses_b' && byId.evt_b_wex.trajectoryId === 'ses_b');
ok('GATE_RAN with no linkage → env (no lane guessing)', byId.evt_a_gate.trajectoryId === ENV_TRAJECTORY);
ok('unregistered actor id → env, never a trajectory', byId.evt_env_ghost.trajectoryId === ENV_TRAJECTORY);
ok('audit report → env', byId.evt_env_audit.trajectoryId === ENV_TRAJECTORY);

const trajIds = out.trajectories.map((t) => t.trajectoryId).sort();
ok('trajectories = ses_a, ses_b, env (no ghost)', JSON.stringify(trajIds) === JSON.stringify(['env', 'ses_a', 'ses_b']), trajIds.join(','));
const trajA = out.trajectories.find((t) => t.trajectoryId === 'ses_a');
ok('session A closed with lanes recorded', trajA.status === 'closed' && JSON.stringify(trajA.lanes) === JSON.stringify(['lane-1']));
ok('session B stays open', out.trajectories.find((t) => t.trajectoryId === 'ses_b').status === 'open');

// ── axes ────────────────────────────────────────────────────────────────────
ok('TOOL_COMPLETED: action + ok outcome', byId.evt_a_tool2.action.tool === 'git' && byId.evt_a_tool2.outcome.ok === true && byId.evt_a_tool2.outcome.exitCode === 0 && byId.evt_a_tool2.outcome.durationMs === 42);
ok('TOOL_INVOKED: action, NO outcome', byId.evt_a_tool1.action.tool === 'git' && byId.evt_a_tool1.outcome === null);
ok('TOOL_REFUSED: outcome refused, ok:false', byId.evt_a2_ref.outcome.status === 'refused' && byId.evt_a2_ref.outcome.ok === false);
ok('GATE_RAN: outcome verdict + gateId as observed subject', byId.evt_a_gate.outcome.ok === true && byId.evt_a_gate.outcome.severity === 'critical' && byId.evt_a_gate.observation.summary === 'spine-integrity');
ok('SLICE_STOP: observation axis verbatim', byId.evt_a_stop.observation.summary === 'built the thing' && byId.evt_a_stop.observation.learnings.length === 1 && byId.evt_a_stop.observation.deliverables[0] === 'a.mjs');
ok('WORKER_SPAWNED: worker action shape', byId.evt_b_wrk.action.mode === 'worker' && byId.evt_b_wrk.action.tool === 'claude');
ok('LANE_CLAIMED: state.focus carried', byId.evt_a_lane.state.focus === 'build the thing');
ok('meta keeps raw type + actor', byId.evt_a_gate.meta.type === 'GATE_RAN' && byId.evt_a_tool1.meta.actor === 'ses_a');

// ── phase-2 signals ─────────────────────────────────────────────────────────
const stopSignals = byId.evt_a_stop.signals;
ok('gate-window: GATE_RAN binds FORWARD to the next SLICE_STOP',
  stopSignals.some((s) => s.kind === 'gate' && s.attachedBy === 'gate-window' && s.sourceEventId === 'evt_a_gate' && s.verdict === 'ok'));
ok('explicit-ref: SLICE_REVIEWED attaches to the named slice',
  stopSignals.some((s) => s.kind === 'review' && s.attachedBy === 'explicit-ref' && s.verdict === 'CLEAN' && s.sourceEventId === 'evt_sig_rev'));
ok('explicit-ref: TRIGGER_FIRED attaches via sliceEventId',
  stopSignals.some((s) => s.kind === 'trigger' && s.sourceEventId === 'evt_sig_trig'));
ok('explicit-ref: FOCUS_TAGGED attaches to its sourceEventId step',
  byId.evt_a_tool2.signals.some((s) => s.kind === 'drift' && s.verdict === 'toward' && s.sourceEventId === 'evt_sig_foc'));
ok('derived: learn-scan flags the hedged proof-less stop (and ONLY it)',
  byId.evt_a_stop2.signals.some((s) => s.kind === 'learn-scan' && s.attachedBy === 'derived' && s.verdict === 'hedged-without-proof' && s.signalId === 'derived:learn-scan:evt_a_stop2')
  && !stopSignals.some((s) => s.kind === 'learn-scan'));
ok('signals never alter the step (outcome axis untouched)', byId.evt_a_stop.outcome === null && byId.evt_a_stop.observation.summary === 'built the thing');
ok('signal-source steps carry no self-signals', byId.evt_sig_rev.signals.length === 0 && byId.evt_sig_foc.signals.length === 0);
ok('trailing gate stays unattached + counted', byId.evt_gate_tail.signals.length === 0 && out.stats.unattachedTrailingGates === 1);

// Trajectory-level signals: DRIFT_FLAGGED has actor ses_a → session A;
// AUTONOMY_SCORED has no linkage → env.
const trajA2 = out.trajectories.find((t) => t.trajectoryId === 'ses_a');
const trajEnv = out.trajectories.find((t) => t.trajectoryId === ENV_TRAJECTORY);
ok('DRIFT_FLAGGED attaches at trajectory scope via envelope linkage',
  trajA2.trajectorySignals.some((s) => s.kind === 'drift' && s.attachedBy === 'trajectory-scope' && s.sourceEventId === 'evt_sig_drift'));
ok('AUTONOMY_SCORED with no linkage lands on env trajectory',
  trajEnv.trajectorySignals.some((s) => s.kind === 'autonomy' && s.sourceEventId === 'evt_sig_auto'));
ok('trajectory.signals counts step + trajectory signals (exact)', trajA2.signals === 6, String(trajA2.signals));
ok('stats.signalCount coherent',
  out.stats.signalCount === out.steps.reduce((n, s) => n + s.signals.length, 0)
    + out.trajectories.reduce((n, t) => n + t.trajectorySignals.length, 0));
ok('stats.signalsByAttachment has all three mechanisms',
  out.stats.signalsByAttachment['explicit-ref'] === 3 && out.stats.signalsByAttachment['gate-window'] === 1
  && out.stats.signalsByAttachment.derived === 1 && out.stats.signalsByAttachment['trajectory-scope'] === 2);

// ── unknown types degrade ───────────────────────────────────────────────────
ok('unknown type → observation/other', byId.evt_env_new.role === 'observation' && byId.evt_env_new.kind === 'other');
ok('unknown type counted in unmappedTypes', out.stats.unmappedTypes.SOME_FUTURE_TYPE === 1);
ok('mapped types NOT in unmappedTypes', !('SLICE_STOP' in out.stats.unmappedTypes) && !('TOOL_INVOKED' in out.stats.unmappedTypes));
// AUDIT_REPORT is deliberately NOT in the registry (environment observation
// by default rule) — assert it takes the default mapping AND is counted.
ok('AUDIT_REPORT takes default mapping (observation/other)', byId.evt_env_audit.role === 'observation' && byId.evt_env_audit.kind === 'other');
ok('AUDIT_REPORT counted in unmappedTypes', out.stats.unmappedTypes.AUDIT_REPORT === 1);

// ── stats ───────────────────────────────────────────────────────────────────
ok('stats counts coherent', out.stats.eventCount === EVENTS.length && out.stats.stepCount === EVENTS.length && out.stats.trajectoryCount === 3);
ok('env step count matches', out.stats.envStepCount === out.steps.filter((s) => s.trajectoryId === ENV_TRAJECTORY).length);
ok('absent-by-design axes declared', Array.isArray(out.stats.absentByDesign) && out.stats.absentByDesign.includes('model-output'));

// ── determinism ─────────────────────────────────────────────────────────────
const out2 = deriveExperience(EVENTS);
ok('double-run byte-identical', JSON.stringify(out) === JSON.stringify(out2));

// ── robustness ──────────────────────────────────────────────────────────────
{
  let threw = false;
  let r;
  try { r = deriveExperience([null, {}, { id: 'evt_x', type: null, data: null }, ...EVENTS]); } catch { threw = true; }
  ok('torn/idless/typeless lines tolerated, never a crash', !threw && r.steps.length === EVENTS.length + 1);
  ok('empty input → empty output, not a crash', deriveExperience([]).steps.length === 0 && deriveExperience(undefined).steps.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
