// runtime/execution/boundary.mjs — the protected execution/release boundary
// and outcome reconciliation (docs/57-product-runtime-rfc.md ADR-005, §6.2
// steps 6–8, §8 failure rules, V08/V09/V10/V11, P4).
//
// execute(run, { handle, signer, boundary, parameters, resourceVersion, now,
//                authorize?, perform, idempotencyKey? })
//   1. verifyHandle: mac, structure. Forged or malformed → refused, nothing
//      written, perform never called.
//   2. Re-bind: the handle's run, tenant, principal, boundary, policy version
//      and gate set must equal this run's; its action digest must equal the
//      digest RECOMPUTED from the parameters and resource version presented
//      NOW (V08: modified arguments → binding_mismatch); it must not have
//      expired by the host's clock.
//   3. Host authorization is authoritative: if `authorize` is given it must
//      return exactly `true`, or the action is refused (`host_denied`) — a
//      runtime allow is never permission (ADR-005, V10).
//   4. Consume: ACTION_STARTED for the operation is the durable intent record
//      AND the handle's single use: the store admits one ACTION_STARTED per
//      operation, so a second execute() with the same handle (or any handle
//      for that operation) is refused with `unresolved` while no finish exists
//      (a crash window: reconcile, never re-perform — V11) or
//      `already_executed` once one does (V09).
//   5. perform({ operation, idempotencyKey, handleId }) is the host's side
//      effect with ITS idempotency key. It returns 'success' | 'failure' or
//      { outcome, reason }. Anything else, or a throw, is `unknown`: after the
//      call the runtime cannot know whether the effect happened, so it says
//      so and never claims failure or rollback.
//   6. ACTION_FINISHED records the outcome. If that append is refused, the
//      effect may have happened and the receipt is missing: the result says
//      recorded:false and the operation stays unresolved for reconcile().
//
// release(run, { handle, signer, boundary, subject, now, authorize?, deliver })
//   The output-release boundary: the same handle verification, plus the
//   artifact presented NOW must re-digest to the handle's subject digest
//   (V08). OUTPUT_DECIDED consumes the operation; deliver() is the host's
//   release; OUTPUT_DELIVERY_OBSERVED records that delivery was observed.
//
// reconcile(run, { operation, outcome, reason?, evidenceRef?, now })
//   Appends OUTCOME_RECONCILED for a started-but-unfinished or
//   finished-unknown operation from durable host state; never rewrites the
//   original and never reconciles to `unknown`.

import { OUTCOMES, LIMITS } from '../core/envelope.mjs';
import { subjectDigest as digestSubject } from '../core/envelope.mjs';
import { CanonicalError } from '../core/canonical.mjs';
import { LifecycleError } from '../lifecycle/checks.mjs';
import { Run } from '../lifecycle/run.mjs';
import { actionDigest, verifyHandle } from './decision.mjs';

export const PERFORM_OUTCOMES = Object.freeze(['success', 'failure']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const clip = (s) => (typeof s === 'string' ? s.slice(0, LIMITS.string) : undefined);
function compact(obj) { const o = {}; for (const [k, v] of Object.entries(obj)) if (v !== undefined) o[k] = v; return o; }
function hostNow(now) {
  if (typeof now !== 'function') throw new LifecycleError('missing_host_fn', 'the host supplies now(); the runtime reads no clock');
  const ts = now();
  const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (Number.isNaN(ms)) throw new LifecycleError('bad_host_ts', 'now() must return an ISO-8601 timestamp');
  return { ts, ms };
}

// Shared: verify and re-bind a handle against this run at this boundary.
function rebind(run, { handle, signer, boundary, nowMs }) {
  if (!(run instanceof Run)) throw new LifecycleError('bad_run', 'a boundary takes a Run handle');
  const h = verifyHandle(handle, signer);
  const mismatch = (code, detail) => new LifecycleError('binding_mismatch', `handle ${h.id} does not bind to this ${code}`, { code, ...detail });
  if (h.run !== run.id) throw mismatch('run', { handle: h.run, run: run.id });
  if (h.tenant !== run.identity.tenant || h.principal !== run.identity.principal) throw mismatch('tenant/principal', { handle: `${h.tenant}/${h.principal}` });
  if (h.boundary !== boundary) throw mismatch('boundary', { handle: h.boundary, boundary });
  if (h.policyVersion !== run.policyVersion) throw mismatch('policy version', { handle: h.policyVersion, run: run.policyVersion });
  if (h.gateSetDigest !== run.gateSet.digest) throw mismatch('gate set', { handle: h.gateSetDigest });
  if (Date.parse(h.expiresAt) <= nowMs) throw new LifecycleError('handle_expired', `handle ${h.id} expired at ${h.expiresAt}`, { expiresAt: h.expiresAt });
  return h;
}

async function hostAuthorizes(authorize, ctx) {
  if (authorize === undefined) return true;
  if (typeof authorize !== 'function') throw new LifecycleError('bad_authorize', 'authorize must be a function when given');
  try { return (await authorize(Object.freeze(ctx))) === true; } catch { return false; }
}

function normaliseOutcome(value) {
  if (typeof value === 'string' && PERFORM_OUTCOMES.includes(value)) return { outcome: value };
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && PERFORM_OUTCOMES.includes(value.outcome)) return compact({ outcome: value.outcome, reason: clip(value.reason) });
  return { outcome: 'unknown', reason: 'bad_outcome' };
}

async function consumeRefusal(run, operation, e) {
  if (!e || e.code !== 'duplicate_operation') throw e;
  const r = await run.read();
  const a = r.state.actions[operation] || null;
  if (a && (a.state === 'finished' || a.state === 'reconciled')) return { executed: false, refused: 'already_executed', operation, outcome: a.outcome };
  return { executed: false, refused: 'unresolved', operation, outcome: a ? a.outcome ?? null : null };
}

export async function execute(run, opts = {}) {
  const { signer, boundary, parameters, resourceVersion, authorize, perform, idempotencyKey, attempt, task } = opts;
  if (typeof perform !== 'function') throw new LifecycleError('bad_perform', 'perform must be a function');
  if (idempotencyKey !== undefined && !isId(idempotencyKey)) throw new LifecycleError('bad_idempotency_key', 'idempotencyKey must be a valid id when given');
  const { ms: nowMs } = hostNow(opts.now);
  const h = rebind(run, { handle: opts.handle, signer, boundary, nowMs });
  const ad = actionDigest({ operation: h.operation, boundary, parameters, resourceVersion });
  if (ad !== h.actionDigest) throw new LifecycleError('binding_mismatch', `handle ${h.id} was issued for a different action binding (parameters or resource version changed)`, { code: 'action', handle: h.actionDigest, presented: ad });
  const scope = { attempt, task, operation: h.operation, subjectDigest: h.subjectDigest };
  if (!(await hostAuthorizes(authorize, { operation: h.operation, boundary, parameters, resourceVersion, principal: h.principal, tenant: h.tenant }))) {
    return { executed: false, refused: 'host_denied', operation: h.operation, outcome: null };
  }
  const key = idempotencyKey === undefined ? h.id : idempotencyKey;
  let started;
  try {
    started = await run._append(run._draft('ACTION_STARTED', { boundary, actionDigest: ad, resourceVersion, handleId: h.id, idempotencyKey: key, enforced: h.enforced }, { ...scope, causes: [h.id] }));
  } catch (e) { return consumeRefusal(run, h.operation, e); }
  let out;
  try { out = normaliseOutcome(await perform(Object.freeze({ operation: h.operation, idempotencyKey: key, handleId: h.id, boundary }))); } catch (e) {
    out = { outcome: 'unknown', reason: 'threw', detail: { name: clip(e && e.name ? e.name : 'Error'), message: clip(e && e.message ? e.message : String(e)) } };
  }
  try {
    const fin = await run._append(run._draft('ACTION_FINISHED', compact({ boundary, actionDigest: ad, handleId: h.id, idempotencyKey: key, ...out }), { ...scope, causes: [started.id] }));
    return { executed: true, operation: h.operation, outcome: out.outcome, reason: out.reason ?? null, recorded: true, seq: fin.seq, ack: fin.ack };
  } catch (e) {
    return { executed: true, operation: h.operation, outcome: out.outcome, reason: out.reason ?? null, recorded: false, unresolved: true, error: e && e.code ? e.code : 'append_failed' };
  }
}

export async function release(run, opts = {}) {
  const { signer, boundary, subject, authorize, deliver, attempt, task } = opts;
  if (typeof deliver !== 'function') throw new LifecycleError('bad_perform', 'deliver must be a function');
  const { ms: nowMs } = hostNow(opts.now);
  const h = rebind(run, { handle: opts.handle, signer, boundary, nowMs });
  let sd;
  try { sd = digestSubject(subject); } catch (e) { throw new LifecycleError('bad_subject', `artifact cannot be digested: ${e.message}`, e instanceof CanonicalError ? { code: e.code, path: e.path } : undefined); }
  if (sd !== h.subjectDigest) throw new LifecycleError('binding_mismatch', `handle ${h.id} was issued for a different artifact`, { code: 'subject', handle: h.subjectDigest, presented: sd });
  const scope = { attempt, task, operation: h.operation, subjectDigest: sd };
  if (!(await hostAuthorizes(authorize, { operation: h.operation, boundary, subjectDigest: sd, principal: h.principal, tenant: h.tenant }))) {
    return { released: false, refused: 'host_denied', operation: h.operation };
  }
  let decided;
  try {
    decided = await run._append(run._draft('OUTPUT_DECIDED', { decision: 'allow', boundary, handleId: h.id, enforced: h.enforced }, { ...scope, causes: [h.id] }));
  } catch (e) {
    if (!e || e.code !== 'duplicate_operation') throw e;
    return { released: false, refused: 'already_released', operation: h.operation };
  }
  let observed = false;
  let reason;
  try { observed = (await deliver(Object.freeze({ operation: h.operation, handleId: h.id, boundary, subjectDigest: sd }))) === true; } catch (e) { reason = clip(`threw: ${e && e.message ? e.message : String(e)}`); }
  if (!observed) return { released: true, delivered: false, reason: reason ?? 'not_observed', operation: h.operation, recorded: true, seq: decided.seq };
  try {
    const o = await run._append(run._draft('OUTPUT_DELIVERY_OBSERVED', { boundary, handleId: h.id }, { ...scope, causes: [decided.id] }));
    return { released: true, delivered: true, operation: h.operation, recorded: true, seq: o.seq };
  } catch (e) {
    return { released: true, delivered: true, operation: h.operation, recorded: false, error: e && e.code ? e.code : 'append_failed' };
  }
}

export async function reconcile(run, { operation, outcome, reason, evidenceRef, now, attempt, task } = {}) {
  if (!(run instanceof Run)) throw new LifecycleError('bad_run', 'reconcile() takes a Run handle');
  if (!isId(operation)) throw new LifecycleError('bad_action', 'operation must be a valid id');
  if (!OUTCOMES.includes(outcome) || outcome === 'unknown') throw new LifecycleError('bad_outcome', 'a reconciled outcome is success, failure or incomplete — never unknown');
  hostNow(now);
  const r = await run.read();
  const a = r.state.actions[operation];
  if (!a || !['started', 'finished'].includes(a.state)) throw new LifecycleError('not_reconcilable', `operation ${operation} is ${a ? a.state : 'unknown to this run'}; only a started or finished operation reconciles`, { operation, state: a ? a.state : null });
  if (a.state === 'finished' && a.outcome !== 'unknown') throw new LifecycleError('not_reconcilable', `operation ${operation} finished ${a.outcome}; only an unknown outcome reconciles`, { operation, outcome: a.outcome });
  const started = r.events.find((e) => e.type === 'ACTION_STARTED' && e.operation === operation);
  const ev = await run._append(run._draft('OUTCOME_RECONCILED', compact({ outcome, reason: clip(reason), evidenceRef: clip(evidenceRef), priorState: a.state, priorOutcome: a.outcome ?? null }), { attempt, task, operation, subjectDigest: started ? started.subjectDigest : undefined, causes: started ? [started.id] : undefined }));
  return { id: ev.id, seq: ev.seq, operation, outcome, priorOutcome: a.outcome ?? null };
}

export async function unresolvedOperations(run) {
  if (!(run instanceof Run)) throw new LifecycleError('bad_run', 'unresolvedOperations() takes a Run handle');
  return (await run.read()).state.unresolvedOperations.slice();
}
