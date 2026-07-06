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
ok('signals empty everywhere (phase 1)', out.steps.every((s) => Array.isArray(s.signals) && s.signals.length === 0));
ok('meta keeps raw type + actor', byId.evt_a_gate.meta.type === 'GATE_RAN' && byId.evt_a_tool1.meta.actor === 'ses_a');

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
