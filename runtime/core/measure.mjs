// runtime/core/measure.mjs — baseline measurements over one run's evidence
// (docs/57-product-runtime-rfc.md §14 metrics, §11 pilot, P5).
//
// Counts only what the evidence states; no rates, no latency (the runtime
// reads no clock), no "coverage %" that would need a denominator the run
// does not carry. would-block vs blocked are distinct: a shadow boundary's
// ACTION_DECIDED with wouldDecide `withhold` counts as wouldBlock, an
// enforced withhold counts as blocked. Unknown outcomes and unresolved
// operations are reported as such. Pure and deterministic.

import { reduceRun } from './reduce.mjs';
import { canonicalEncode } from './canonical.mjs';

export const MEASURE_VERSION = 'maddu.runtime.measure.v1';

const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

export function measureRun(events) {
  const list = Array.isArray(events) ? events : [];
  const state = reduceRun(list);
  const m = {
    version: MEASURE_VERSION,
    run: state.run,
    status: state.status,
    events: list.length,
    evidenceBytes: 0,
    issues: state.issues.length,
    contextReferences: 0,
    modelCalls: zero(['started', 'success', 'failure', 'unknown']),
    checks: zero(['pass', 'fail', 'error', 'timeout', 'not_applicable', 'unknown']),
    gatesEvaluated: Object.keys(state.checks).length,
    decisions: zero(['allow', 'withhold', 'wouldBlock', 'blocked', 'escalated']),
    approvals: zero(['requested', 'allowed', 'withheld', 'pending']),
    actions: zero(['started', 'success', 'failure', 'unknown', 'reconciled', 'unresolved']),
    outputs: zero(['decided', 'delivered']),
  };
  for (const ev of list) {
    if (ev === null || typeof ev !== 'object') continue;
    try { m.evidenceBytes += Buffer.byteLength(canonicalEncode(ev), 'utf8'); } catch { /* counted by the reducer as invalid */ }
    const p = ev.payload || {};
    switch (ev.type) {
      case 'CONTEXT_REFERENCED': m.contextReferences += Array.isArray(p.references) ? p.references.length : 0; break;
      case 'MODEL_CALL_STARTED': m.modelCalls.started++; break;
      case 'MODEL_CALL_FINISHED': if (p.outcome in m.modelCalls && p.outcome !== 'started') m.modelCalls[p.outcome]++; break;
      case 'CHECK_FINISHED': if (p.result in m.checks) m.checks[p.result]++; break;
      case 'ACTION_DECIDED':
        if (p.decision === 'allow') m.decisions.allow++;
        if (p.decision === 'withhold') { m.decisions.withhold++; if (p.enforced) m.decisions.blocked++; }
        if (p.enforced === false && p.wouldDecide === 'withhold') m.decisions.wouldBlock++;
        break;
      case 'APPROVAL_REQUESTED': m.decisions.escalated++; m.approvals.requested++; break;
      case 'APPROVAL_DECIDED': if (p.decision === 'allow') m.approvals.allowed++; else m.approvals.withheld++; break;
      case 'ACTION_STARTED': m.actions.started++; break;
      case 'ACTION_FINISHED': if (p.outcome === 'success' || p.outcome === 'failure' || p.outcome === 'unknown') m.actions[p.outcome]++; break;
      case 'OUTCOME_RECONCILED': m.actions.reconciled++; break;
      case 'OUTPUT_DECIDED': m.outputs.decided++; break;
      case 'OUTPUT_DELIVERY_OBSERVED': m.outputs.delivered++; break;
      default: break;
    }
  }
  m.approvals.pending = Object.values(state.approvals).filter((a) => a.state === 'requested').length;
  m.actions.unresolved = state.unresolvedOperations.length;
  return m;
}
