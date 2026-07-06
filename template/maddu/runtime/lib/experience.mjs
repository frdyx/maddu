// experience.mjs — EXP phases 1+2: read-only spine → normalized experience
// steps + late-bound signals.
//
// A PURE derivation (design: docs/research/exp-experience-protocol-design.md):
//   deriveExperience(events) → { schemaVersion, trajectories, steps, stats }
//
// Laws (all from the Phase-0 design, red-teamed to CLEAN before this build):
//   • Pure function of the event array — no I/O, no clock, no randomness.
//     Step identity is BORROWED from the source event id, never minted, so two
//     runs over the same spine are byte-identical.
//   • Zero writes. The caller reads the spine (spine.readAll) and passes the
//     events in; this module never touches the filesystem.
//   • Trajectory membership is EXPLICIT LINKAGE ONLY: actor === a session id,
//     or data.sessionId / data.session names one. No temporal guessing, no
//     "who held the lane at ts" attribution (deliberately dropped in design —
//     a historical claims timeline would be a new reducer). Everything else
//     is an environment step under the reserved trajectory "env".
//   • Every axis an event doesn't carry is null/[] — no inference, no
//     defaults dressed up as data. Dormant/unknown types degrade to a generic
//     observation step and are counted in stats.unmappedTypes, never dropped
//     silently and never a crash.
//   • SIGNALS are READ-TIME derived (phase 2, design §5) — later evidence
//     attaches to earlier steps with deterministic linkage ONLY:
//       explicit-ref — the evidence names the step's event id
//                      (SLICE_REVIEWED.sliceEventId, TRIGGER_FIRED
//                      .sliceEventId/.sourceEventId, FOCUS_TAGGED.sourceEventId);
//       gate-window  — GATE_RAN binds FORWARD to the NEXT SLICE_STOP, the
//                      autonomy.mjs rule mirrored exactly (sliceId-stamped →
//                      exact match; actor-stamped → same session; unstamped →
//                      whole window; the window resets at every SLICE_STOP);
//       derived      — the learn-scan heuristic (reflect.mjs, clock injected
//                      as null so the result is time-independent) re-run over
//                      the same events, flagging hedged-completion-without-
//                      proof SLICE_STOPs.
//     Signals NEVER alter the step they attach to beyond appending to
//     signals[] — outcome axes stay what the original event said. Aggregate
//     evidence with no per-step linkage (AUTONOMY_SCORED lane rows,
//     DRIFT_FLAGGED) attaches at TRAJECTORY scope via envelope linkage, else
//     env — never guessed onto individual steps. Zero spine writes; slice 2.2
//     (an explicit signal event type) remains UNBUILT — read-time derivation
//     covers every attachment the design's signal table names.

import { scanCompletionClaims } from './reflect.mjs';

export const EXPERIENCE_SCHEMA_VERSION = 1;

// The reserved trajectory id for repo-level (non-session-attributable) steps.
export const ENV_TRAJECTORY = 'env';

// ── type registry: event type → { role, kind } ─────────────────────────────
// Types not listed here take DEFAULT_MAPPING and are tallied in
// stats.unmappedTypes (a dormant type firing later degrades gracefully).
const DEFAULT_MAPPING = { role: 'observation', kind: 'other' };

const TYPE_MAP = {
  // actions — things an agent did
  TOOL_INVOKED:            { role: 'action',      kind: 'tool' },
  TOOL_COMPLETED:          { role: 'action',      kind: 'tool' },
  TOOL_REFUSED:            { role: 'action',      kind: 'tool' },
  WORKER_SPAWNED:          { role: 'action',      kind: 'worker' },
  WORKER_EXITED:           { role: 'action',      kind: 'worker' },
  WORKER_KILLED:           { role: 'action',      kind: 'worker' },
  WORKER_ENV_FILTERED:     { role: 'action',      kind: 'worker' },
  MAILBOX_SENT:            { role: 'action',      kind: 'other' },

  // outcomes — verdicts the substrate recorded
  GATE_RAN:                { role: 'outcome',     kind: 'gate' },
  TRUST_AUDIT_RAN:         { role: 'outcome',     kind: 'trust' },
  TRUST_VIOLATION_DETECTED:{ role: 'outcome',     kind: 'trust' },
  SECRET_DETECTED_IN_ARGV: { role: 'outcome',     kind: 'trust' },
  IMPORT_REJECTED:         { role: 'outcome',     kind: 'trust' },

  // observations — self-reports and learned artifacts
  SLICE_STOP:              { role: 'observation', kind: 'slice-stop' },
  LEARN_MINED:             { role: 'observation', kind: 'learn' },
  LEARN_JUDGED:            { role: 'observation', kind: 'learn' },
  LEARN_CORRECTION_WRITTEN:{ role: 'observation', kind: 'learn' },
  LEARN_DIGEST_WRITTEN:    { role: 'observation', kind: 'learn' },
  SKILL_CANDIDATE_DETECTED:{ role: 'observation', kind: 'learn' },
  MEMORY_FACT_SUPERSEDED:  { role: 'observation', kind: 'learn' },

  // signal-source events (phase 2 attaches them; as steps they are visible)
  SLICE_REVIEWED:          { role: 'signal',      kind: 'review' },
  FOCUS_TAGGED:            { role: 'signal',      kind: 'focus' },
  DRIFT_FLAGGED:           { role: 'signal',      kind: 'focus' },
  AUTONOMY_SCORED:         { role: 'signal',      kind: 'autonomy' },
  AUTONOMY_RECOMMENDATION: { role: 'signal',      kind: 'autonomy' },

  // state — intent and lifecycle context
  SESSION_REGISTERED:      { role: 'state',       kind: 'session' },
  SESSION_AUTO_REGISTERED: { role: 'state',       kind: 'session' },
  SESSION_HEARTBEAT:       { role: 'state',       kind: 'session' },
  SESSION_CLOSED:          { role: 'state',       kind: 'session' },
  SESSION_AUTO_CLOSED:     { role: 'state',       kind: 'session' },
  SESSION_STALE_DETECTED:  { role: 'state',       kind: 'session' },
  LANE_CLAIMED:            { role: 'state',       kind: 'lane' },
  LANE_RELEASED:           { role: 'state',       kind: 'lane' },
  LANE_CLAIM_FORCED:       { role: 'state',       kind: 'lane' },
  GOAL_DECLARED:           { role: 'state',       kind: 'goal' },
  HANDOFF_SET:             { role: 'state',       kind: 'goal' },
  PHASE_DECLARED:          { role: 'state',       kind: 'goal' },
  PHASE_CLEARED:           { role: 'state',       kind: 'goal' },
  PLAN_CREATED:            { role: 'state',       kind: 'plan' },
  PLAN_REVISED:            { role: 'state',       kind: 'plan' },
  PLAN_PHASE_ADDED:        { role: 'state',       kind: 'plan' },
  PLAN_PHASE_COMPLETED:    { role: 'state',       kind: 'plan' },
  PLAN_PHASE_BLOCKED:      { role: 'state',       kind: 'plan' },
  PLAN_COMPLETED:          { role: 'state',       kind: 'plan' },
  PLAN_CANCELLED:          { role: 'state',       kind: 'plan' },
  COMPACTION_CHECKPOINT:   { role: 'state',       kind: 'session' },
};

// ── per-kind axis extractors (fixed shapes; null where the event is silent) ─

function actionAxis(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'TOOL_INVOKED':
    case 'TOOL_COMPLETED':
    case 'TOOL_REFUSED':
      // argv is already redacted at the spine-write boundary (#219).
      return { tool: d.tool ?? null, argv: Array.isArray(d.argv) ? d.argv : null, mode: d.mode ?? null };
    case 'WORKER_SPAWNED':
      // command/args redacted at the write boundary (#220).
      return { tool: d.runtime ?? null, argv: d.command != null ? [d.command, ...(Array.isArray(d.args) ? d.args.map(String) : [])] : null, mode: 'worker' };
    case 'WORKER_EXITED':
    case 'WORKER_KILLED':
    case 'WORKER_ENV_FILTERED':
      return { tool: d.runtime ?? null, argv: null, mode: 'worker' };
    case 'MAILBOX_SENT':
      return { tool: 'mailbox', argv: null, mode: d.type ?? null };
    default:
      return null;
  }
}

function outcomeAxis(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'TOOL_COMPLETED':
      // ok is a CLAIM: with no recorded exit code there is no evidence either
      // way, so ok is null — never a guessed boolean (red-team NIT-4).
      return { ok: typeof d.exitCode === 'number' ? d.exitCode === 0 : null, exitCode: d.exitCode ?? null, status: null, severity: null, durationMs: d.durationMs ?? null };
    case 'TOOL_REFUSED':
      return { ok: false, exitCode: null, status: 'refused', severity: null, durationMs: null };
    case 'WORKER_EXITED':
      // Same evidence rule: a missing/null exitCode is UNKNOWN, not success.
      return { ok: typeof d.exitCode === 'number' ? d.exitCode === 0 : null, exitCode: d.exitCode ?? null, status: null, severity: null, durationMs: null };
    case 'GATE_RAN':
      return { ok: d.ok === true, exitCode: null, status: d.status ?? null, severity: d.severity ?? null, durationMs: d.durationMs ?? null };
    case 'TRUST_VIOLATION_DETECTED':
    case 'SECRET_DETECTED_IN_ARGV':
    case 'IMPORT_REJECTED':
      return { ok: false, exitCode: null, status: 'violation', severity: 'critical', durationMs: null };
    case 'TRUST_AUDIT_RAN':
      return { ok: (d.violations ?? 0) === 0, exitCode: null, status: null, severity: null, durationMs: null };
    default:
      return null;
  }
}

function observationAxis(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'SLICE_STOP':
      return {
        summary: d.summary ?? null,
        learnings: Array.isArray(d.learnings) ? d.learnings : [],
        targets: Array.isArray(d.targets) ? d.targets : [],
        deliverables: Array.isArray(d.deliverables) ? d.deliverables : [],
      };
    case 'GATE_RAN':
      // gateId is the observed subject — the step's outcome axis carries the
      // verdict; consumers needing more re-read the raw event by stepId.
      return { summary: d.gateId ?? null, learnings: [], targets: [], deliverables: [] };
    case 'SLICE_REVIEWED':
      return { summary: d.verdict ?? null, learnings: [], targets: [], deliverables: [] };
    case 'LEARN_CORRECTION_WRITTEN':
      return { summary: d.correction?.text ?? d.fact?.text ?? null, learnings: [], targets: [], deliverables: [] };
    default:
      return null;
  }
}

function stateAxis(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'GOAL_DECLARED':      return { goal: d.objective ?? null, focus: null, phase: null };
    case 'PHASE_DECLARED':     return { goal: null, focus: null, phase: d.name ?? null };
    case 'PHASE_CLEARED':      return { goal: null, focus: null, phase: null };
    case 'SESSION_HEARTBEAT':  return { goal: null, focus: d.focus ?? null, phase: null };
    case 'LANE_CLAIMED':
    case 'LANE_CLAIM_FORCED':  return { goal: null, focus: d.focus ?? null, phase: null };
    default:
      return null;
  }
}

// ── session collection (two-pass: linkage must hold across the whole spine) ─

function collectSessions(events) {
  const sessions = new Map(); // id → { trajectoryId, label, role, openedAt, closedAt, status }
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue; // torn line — reader already reported it
    if (ev.type === 'SESSION_REGISTERED' || ev.type === 'SESSION_AUTO_REGISTERED') {
      // Registration identity = ev.actor ONLY — the exact key projections.mjs
      // uses (sessions.set(ev.actor, …)), so the two reducers can never
      // disagree on who is a session (red-team NIT-3).
      const id = ev.actor || null;
      if (!id) continue;
      // Re-registration of the same id keeps the first openedAt (spine order).
      const cur = sessions.get(id);
      if (!cur) {
        sessions.set(id, {
          trajectoryId: id,
          label: ev.data?.label ?? null,
          role: ev.data?.role ?? null,
          openedAt: ev.ts ?? null,
          closedAt: null,
          status: 'open',
        });
      }
    } else if (ev.type === 'SESSION_CLOSED' || ev.type === 'SESSION_AUTO_CLOSED') {
      const id = ev.actor || ev.data?.sessionId || null; // projections.mjs resolution
      const s = id ? sessions.get(id) : null;
      if (s) { s.closedAt = ev.ts ?? null; s.status = 'closed'; }
    }
  }
  return sessions;
}

// Explicit-linkage resolution (design §3): actor, then data.sessionId, then
// data.session — each only counts when it names a KNOWN session.
function trajectoryOf(ev, sessionIds) {
  if (ev.actor && sessionIds.has(ev.actor)) return ev.actor;
  const d = ev.data || {};
  if (typeof d.sessionId === 'string' && sessionIds.has(d.sessionId)) return d.sessionId;
  if (typeof d.session === 'string' && sessionIds.has(d.session)) return d.session;
  return ENV_TRAJECTORY;
}

// ── the derivation ──────────────────────────────────────────────────────────

export function deriveExperience(events) {
  const evs = Array.isArray(events) ? events : [];
  const sessions = collectSessions(evs);
  const sessionIds = new Set(sessions.keys());

  const steps = [];
  const byRole = {};
  const byKind = {};
  const unmappedTypes = {};
  const stepsByTrajectory = new Map(); // trajectoryId → count + lanes
  let envSteps = 0;

  for (const ev of evs) {
    if (!ev || typeof ev !== 'object' || !ev.id) continue; // torn/foreign line — spine read already reported it
    const mapping = TYPE_MAP[ev.type] || DEFAULT_MAPPING;
    if (!TYPE_MAP[ev.type]) unmappedTypes[ev.type || '(untyped)'] = (unmappedTypes[ev.type || '(untyped)'] || 0) + 1;
    const trajectoryId = trajectoryOf(ev, sessionIds);
    const step = {
      stepId: ev.id,
      trajectoryId,
      lane: ev.lane ?? null,
      ts: ev.ts ?? null,
      role: mapping.role,
      kind: mapping.kind,
      action: actionAxis(ev),
      outcome: outcomeAxis(ev),
      observation: observationAxis(ev),
      state: stateAxis(ev),
      signals: [], // populated by the phase-2 signal pass below
      meta: {
        type: ev.type ?? null,
        actor: ev.actor ?? null,
        triggered_by: ev.triggered_by ?? null,
        schemaVersion: ev.data?.schemaVersion ?? null,
      },
    };
    steps.push(step);
    byRole[step.role] = (byRole[step.role] || 0) + 1;
    byKind[step.kind] = (byKind[step.kind] || 0) + 1;
    if (trajectoryId === ENV_TRAJECTORY) envSteps++;
    const agg = stepsByTrajectory.get(trajectoryId) || { total: 0, byRole: {}, lanes: new Set(), firstTs: step.ts, lastTs: step.ts };
    agg.total++;
    agg.byRole[step.role] = (agg.byRole[step.role] || 0) + 1;
    if (step.lane) agg.lanes.add(step.lane);
    if (step.ts != null) agg.lastTs = step.ts;
    stepsByTrajectory.set(trajectoryId, agg);
  }

  // ── Phase-2 signal pass (design §5) — deterministic linkage only ──────────
  const stepById = new Map(steps.map((s) => [s.stepId, s]));
  const signalsByKind = {};
  const signalsByAttachment = {};
  let stepSignalCount = 0;
  const attach = (step, sig) => {
    step.signals.push(sig);
    stepSignalCount++;
    signalsByKind[sig.kind] = (signalsByKind[sig.kind] || 0) + 1;
    signalsByAttachment[sig.attachedBy] = (signalsByAttachment[sig.attachedBy] || 0) + 1;
  };

  // 1) Explicit references + 2) the gate window, in ONE ordered walk so the
  // window semantics mirror autonomy.mjs classifyOutcomes exactly.
  let windowGates = []; // { step, data, actor } for each GATE_RAN since the previous SLICE_STOP
  for (const ev of evs) {
    if (!ev || typeof ev !== 'object' || !ev.id) continue;
    const d = ev.data || {};
    if (ev.type === 'GATE_RAN') {
      windowGates.push({ id: ev.id, data: d, actor: ev.actor || null }); // || not ??: byte-faithful to autonomy.mjs
      continue;
    }
    if (ev.type === 'SLICE_STOP') {
      const stopStep = stepById.get(ev.id);
      const sid = ev.actor || null;
      // The autonomy binding rule, verbatim: sliceId-stamped gates bind
      // exactly; actor-stamped gates must match this slice's session; legacy
      // unstamped gates attach by window. The window then RESETS — trailing
      // gates with no following SLICE_STOP stay unattached (counted below).
      const bound = windowGates.filter((g) => {
        if (g.data.sliceId != null) return g.data.sliceId === ev.id;
        if (g.actor != null && sid != null) return g.actor === sid;
        return true;
      });
      if (stopStep) {
        for (const g of bound) {
          attach(stopStep, {
            signalId: g.id,
            kind: 'gate',
            verdict: g.data.ok === true ? 'ok' : (g.data.status ?? 'fail'),
            attachedBy: 'gate-window',
            sourceEventId: g.id,
          });
        }
      }
      windowGates = [];
      continue;
    }
    if (ev.type === 'SLICE_REVIEWED' && typeof d.sliceEventId === 'string') {
      const target = stepById.get(d.sliceEventId);
      if (target) attach(target, { signalId: ev.id, kind: 'review', verdict: d.verdict ?? null, attachedBy: 'explicit-ref', sourceEventId: ev.id });
      continue;
    }
    if (ev.type === 'TRIGGER_FIRED') {
      const ref = typeof d.sliceEventId === 'string' ? d.sliceEventId : typeof d.sourceEventId === 'string' ? d.sourceEventId : null;
      const target = ref ? stepById.get(ref) : null;
      if (target) attach(target, { signalId: ev.id, kind: 'trigger', verdict: d.triggerId ?? null, attachedBy: 'explicit-ref', sourceEventId: ev.id });
      continue;
    }
    if (ev.type === 'FOCUS_TAGGED' && typeof d.sourceEventId === 'string') {
      const target = stepById.get(d.sourceEventId);
      if (target) attach(target, { signalId: ev.id, kind: 'drift', verdict: d.tag ?? null, attachedBy: 'explicit-ref', sourceEventId: ev.id });
      continue;
    }
  }
  const unattachedTrailingGates = windowGates.length;

  // 3) Derived: the learn-scan heuristic re-run over the SAME events, clock
  // injected as null (time-independent → deterministic). Flags attach to the
  // SLICE_STOP steps the scan itself names.
  const scan = scanCompletionClaims(evs.filter((e) => e && typeof e === 'object'), { nowMs: null });
  for (const m of scan.matches || []) {
    const target = m.sliceId ? stepById.get(m.sliceId) : null;
    if (target) {
      attach(target, {
        signalId: `derived:learn-scan:${m.sliceId}`,
        kind: 'learn-scan',
        verdict: 'hedged-without-proof',
        attachedBy: 'derived',
        sourceEventId: null,
      });
    }
  }

  // 4) Trajectory-level signals — aggregate evidence with no per-step linkage.
  // Envelope linkage decides the owning trajectory; no linkage → env.
  const trajectorySignalsById = new Map(); // trajectoryId → [signal…]
  const attachTrajectory = (trajectoryId, sig) => {
    const list = trajectorySignalsById.get(trajectoryId) || [];
    list.push(sig);
    trajectorySignalsById.set(trajectoryId, list);
    signalsByKind[sig.kind] = (signalsByKind[sig.kind] || 0) + 1;
    signalsByAttachment[sig.attachedBy] = (signalsByAttachment[sig.attachedBy] || 0) + 1;
  };
  for (const ev of evs) {
    if (!ev || typeof ev !== 'object' || !ev.id) continue;
    const d = ev.data || {};
    if (ev.type === 'AUTONOMY_SCORED') {
      attachTrajectory(trajectoryOf(ev, sessionIds), {
        signalId: ev.id,
        kind: 'autonomy',
        verdict: Array.isArray(d.lanes) ? `${d.lanes.length} lane row(s)` : null,
        attachedBy: 'trajectory-scope',
        sourceEventId: ev.id,
      });
    } else if (ev.type === 'DRIFT_FLAGGED') {
      attachTrajectory(trajectoryOf(ev, sessionIds), {
        signalId: ev.id,
        kind: 'drift',
        verdict: d.cleared === true ? 'cleared' : (d.choice ?? 'flagged'),
        attachedBy: 'trajectory-scope',
        sourceEventId: ev.id,
      });
    }
  }

  // Per-trajectory step-signal counts (spine order preserved throughout).
  const stepSignalsByTrajectory = new Map();
  for (const s of steps) {
    if (s.signals.length) {
      stepSignalsByTrajectory.set(s.trajectoryId, (stepSignalsByTrajectory.get(s.trajectoryId) || 0) + s.signals.length);
    }
  }

  // Trajectory manifest: every session (even step-less ones) + env when used.
  const trajectories = [];
  const manifestFor = (trajectoryId, base) => {
    const agg = stepsByTrajectory.get(trajectoryId) || { total: 0, byRole: {}, lanes: new Set(), firstTs: null, lastTs: null };
    const trajectorySignals = trajectorySignalsById.get(trajectoryId) || [];
    return {
      ...base,
      steps: agg.total,
      stepsByRole: agg.byRole,
      lanes: [...agg.lanes].sort(),
      firstTs: agg.firstTs,
      lastTs: agg.lastTs,
      signals: (stepSignalsByTrajectory.get(trajectoryId) || 0) + trajectorySignals.length,
      trajectorySignals,
    };
  };
  for (const s of sessions.values()) {
    trajectories.push(manifestFor(s.trajectoryId, {
      trajectoryId: s.trajectoryId,
      label: s.label,
      role: s.role,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      status: s.status,
    }));
  }
  if (stepsByTrajectory.has(ENV_TRAJECTORY) || trajectorySignalsById.has(ENV_TRAJECTORY)) {
    trajectories.push(manifestFor(ENV_TRAJECTORY, {
      trajectoryId: ENV_TRAJECTORY,
      label: '(environment — repo-level events with no session linkage)',
      role: null,
      openedAt: null,
      closedAt: null,
      status: 'ambient',
    }));
  }

  return {
    schemaVersion: EXPERIENCE_SCHEMA_VERSION,
    trajectories,
    steps,
    stats: {
      schemaVersion: EXPERIENCE_SCHEMA_VERSION,
      eventCount: evs.length,
      stepCount: steps.length,
      trajectoryCount: trajectories.length,
      envStepCount: envSteps,
      byRole,
      byKind,
      unmappedTypes,
      signalCount: stepSignalCount + [...trajectorySignalsById.values()].reduce((n, l) => n + l.length, 0),
      signalsByKind,
      signalsByAttachment,
      // Gates that accumulated after the last SLICE_STOP have no forward
      // target yet — reported, never silently dropped (design §5).
      unattachedTrailingGates,
      // Axes the paper's schema wants that have NO source in Máddu by design
      // (never inferred): model/reasoning output, prompt text, token-level
      // observations, environment snapshots, scalar rewards.
      absentByDesign: ['model-output', 'prompt-text', 'token-observations', 'environment-snapshots', 'reward'],
    },
  };
}
