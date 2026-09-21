// runtime/core/reduce.mjs — pure, deterministic reduction of one run's events
// into run state (docs/57-product-runtime-rfc.md §7.2, V03, P2).
//
// Same input → byte-identical canonical output (no clock, no randomness, no
// I/O). The reducer never repairs: a gap, a broken link, a duplicate sequence
// or a second terminal event is reported as an issue and the run's status is
// `incomplete`/`invalid`, never quietly "completed". `unknown` and
// `incomplete` are explicit outcomes, not absences.

import { validateEnvelope, eventDigest, isTerminalType } from './envelope.mjs';
import { canonicalEncode } from './canonical.mjs';

export const RUN_STATUS = Object.freeze(['open', 'completed', 'failed', 'cancelled', 'incomplete', 'invalid']);

const TERMINAL_STATUS = { RUN_COMPLETED: 'completed', RUN_FAILED: 'failed', RUN_CANCELLED: 'cancelled' };

// events: the run's events in stored order. Returns a plain object; call
// canonicalEncode(reduceRun(events)) to get the byte-stable form (V03).
export function reduceRun(events) {
  const list = Array.isArray(events) ? events : [];
  const issues = [];
  const push = (code, seq, message) => issues.push({ code, seq: seq == null ? null : seq, message });
  const state = {
    run: null, status: 'open', started: false, terminal: null, lastSeq: 0, head: null, count: list.length,
    identity: null, types: {}, checks: {}, actions: {}, approvals: {}, outputs: [], unresolvedOperations: [], issues,
  };
  let prevDigest = null;
  let expectedSeq = 1;
  for (const ev of list) {
    const v = validateEnvelope(ev);
    if (!v.ok) { push('invalid_event', ev && ev.seq, v.errors.map((e) => `${e.path} ${e.code}`).join('; ')); continue; }
    if (state.run === null) { state.run = ev.run; state.identity = { tenant: ev.tenant, product: ev.product, principal: ev.principal, agentVersion: ev.agentVersion, field: ev.field || null }; }
    else if (ev.run !== state.run) { push('foreign_run', ev.seq, `event belongs to run ${ev.run}, not ${state.run}`); continue; }
    else if (ev.tenant !== state.identity.tenant || ev.product !== state.identity.product || ev.principal !== state.identity.principal || ev.agentVersion !== state.identity.agentVersion) {
      push('identity_drift', ev.seq, 'identity tuple changed within the run');
    }
    if (ev.seq !== expectedSeq) push(ev.seq < expectedSeq ? 'sequence_replay' : 'sequence_gap', ev.seq, `expected seq ${expectedSeq}, saw ${ev.seq}`);
    if (ev.prev !== prevDigest) push('chain_broken', ev.seq, 'prev does not commit to the preceding event');
    if (state.terminal) push('after_terminal', ev.seq, `event after terminal ${state.terminal.type}`);
    expectedSeq = Math.max(expectedSeq, ev.seq) + 1;
    state.lastSeq = Math.max(state.lastSeq, ev.seq);
    prevDigest = eventDigest(ev);
    state.head = prevDigest;
    state.types[ev.type] = (state.types[ev.type] || 0) + 1;
    const p = ev.payload;
    switch (ev.type) {
      case 'RUN_STARTED': if (state.started) push('double_start', ev.seq, 'RUN_STARTED twice'); state.started = true; break;
      case 'CHECK_FINISHED': state.checks[p.gateId] = { result: p.result, subjectDigest: ev.subjectDigest, seq: ev.seq, producer: ev.producer.kind }; break;
      case 'ACTION_PROPOSED': state.actions[ev.operation] = { state: 'proposed', seq: ev.seq }; break;
      case 'ACTION_DECIDED': state.actions[ev.operation] = { ...(state.actions[ev.operation] || {}), state: 'decided', decision: p.decision, seq: ev.seq }; break;
      case 'ACTION_STARTED': {
        const a = state.actions[ev.operation];
        if (!a || a.decision !== 'allow') push('action_without_allow', ev.seq, `operation ${ev.operation} started without an allow decision`);
        state.actions[ev.operation] = { ...(a || {}), state: 'started', seq: ev.seq };
        break;
      }
      case 'ACTION_FINISHED': state.actions[ev.operation] = { ...(state.actions[ev.operation] || {}), state: 'finished', outcome: p.outcome, seq: ev.seq }; break;
      case 'OUTCOME_RECONCILED': {
        const a = state.actions[ev.operation];
        if (!a) push('reconcile_unknown_operation', ev.seq, `no such operation ${ev.operation}`);
        state.actions[ev.operation] = { ...(a || {}), state: 'reconciled', outcome: p.outcome, reconciledAt: ev.seq, priorOutcome: a ? a.outcome : null };
        break;
      }
      case 'APPROVAL_REQUESTED': state.approvals[ev.id] = { state: 'requested', seq: ev.seq }; break;
      case 'APPROVAL_DECIDED': { const r = p.requestId; if (!r || !state.approvals[r]) push('orphan_approval', ev.seq, 'decision for an unknown request'); else if (state.approvals[r].state === 'decided') push('duplicate_approval', ev.seq, `request ${r} decided twice`); state.approvals[r] = { state: 'decided', decision: p.decision, seq: ev.seq }; break; }
      case 'OUTPUT_DECIDED': state.outputs.push({ seq: ev.seq, decision: p.decision, subjectDigest: ev.subjectDigest || null, delivered: false }); break;
      case 'OUTPUT_DELIVERY_OBSERVED': { const o = state.outputs.find((x) => x.subjectDigest && x.subjectDigest === ev.subjectDigest && !x.delivered); if (o) o.delivered = true; else push('delivery_without_decision', ev.seq, 'delivery observed for an undecided or unknown output'); break; }
      default: break;
    }
    if (isTerminalType(ev.type) && !state.terminal) state.terminal = { type: ev.type, seq: ev.seq, outcome: p.outcome || null };
  }
  for (const [op, a] of Object.entries(state.actions)) {
    if (a.state === 'started' || (a.outcome === 'unknown' && a.state !== 'reconciled')) state.unresolvedOperations.push(op);
  }
  if (issues.some((i) => ['invalid_event', 'foreign_run', 'sequence_replay', 'chain_broken', 'after_terminal', 'double_start'].includes(i.code))) state.status = 'invalid';
  else if (!state.started || issues.some((i) => i.code === 'sequence_gap')) state.status = 'incomplete';
  else if (state.terminal) state.status = TERMINAL_STATUS[state.terminal.type];
  else state.status = 'open';
  return state;
}

export function reduceRunCanonical(events) {
  return canonicalEncode(reduceRun(events), { maxBytes: 8 * 1024 * 1024 });
}
