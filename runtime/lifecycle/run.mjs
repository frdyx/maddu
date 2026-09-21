// runtime/lifecycle/run.mjs — the run lifecycle over the append store
// (docs/57-product-runtime-rfc.md §6.2, §6.3, §7.2 lifecycle family, V06–V08,
// V11, P3).
//
//   createRuntime({ store, gates, newId, now, producer? })
//     .startRun({ run, context, idempotencyKey, requiredGates, policyVersion?, task? })
//     .openRun(run)
//
// A run opens against a FROZEN gate set (freezeGateSet over the registry at
// start) recorded in RUN_STARTED and stamped on every later event as
// `gateSetDigest`. startRun is idempotent per (run, idempotencyKey): a second
// start with the same key and identity returns the existing run without a
// second RUN_STARTED, a start with a different key is refused
// (`idempotency_mismatch`); a concurrent double start loses the store's
// compare-and-swap and falls into the same rule.
//
// run.evaluate({ subject }) runs the gates SEQUENTIALLY in id order, one
// CHECK_STARTED / CHECK_FINISHED pair per gate, every one bound to the exact
// subject digest, the frozen gate set digest and the gate's frozen
// implementation digest. The result written is the runner's (runGate), or
// `unknown` when the gate is missing from the registry, its implementation
// digest no longer matches the frozen one, or the run was cancelled. If a
// CHECK_STARTED or CHECK_FINISHED append is refused, the outcome for that gate
// is `unknown` / `persist_failed` and the REMAINING gates are not run
// (`not_evaluated`): a check whose evidence cannot be recorded does not
// execute (V07). `passed` is true only when every evaluated gate recorded
// `pass`; it is an input to a decision, not a permission.
//
// Terminal: complete() → RUN_COMPLETED, fail() → RUN_FAILED,
// cancel() → RUN_CANCELLED. cancel() first aborts in-flight checks (their
// result becomes unknown / cancelled) and then appends without a head
// precondition, so a cancellation always lands ahead of whatever the
// evaluation would have written next; the store then refuses the rest
// (`run_terminal`). cancel() on an already-terminal run is a no-op that
// reports the existing terminal.
//
// The host supplies `newId()` and `now()`: nothing here reads a clock or
// generates randomness. Events reach the store only through store.append()
// with `expectedHead` (except cancel, above). A run handle is a single writer:
// after a `head_mismatch` from another writer, call refresh() and retry.

import { CONTRACT, EVENT_TYPES, OUTCOMES, LIMITS, isTerminalType } from '../core/envelope.mjs';
import { reduceRun } from '../core/reduce.mjs';
import { GateRegistry, LifecycleError, runGate } from './checks.mjs';
import { freezeGateSet, bindManifest } from './manifest.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const IDENTITY_KEYS = ['tenant', 'product', 'principal', 'agentVersion'];
// Event types the lifecycle owns; record() refuses them.
const RESERVED_TYPES = Object.freeze(['RUN_STARTED', 'RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED', 'CHECK_STARTED', 'CHECK_FINISHED']);
const ACK_RANK = { buffered: 0, written: 1, durable: 2 };

function isId(v) { return typeof v === 'string' && ID_RE.test(v); }
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}
function weaker(a, b) { if (a === null) return b; if (b === null) return a; return ACK_RANK[a] <= ACK_RANK[b] ? a : b; }

function validateContext(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) throw new LifecycleError('bad_context', 'context must be an object resolved by the host from trusted state');
  for (const k of IDENTITY_KEYS) if (!isId(context[k])) throw new LifecycleError('bad_context', `context.${k} must be a valid id`, { path: `$.${k}` });
  if (context.field !== undefined && !isId(context.field)) throw new LifecycleError('bad_context', 'context.field must be a valid id when present', { path: '$.field' });
  for (const k of Object.keys(context)) if (!IDENTITY_KEYS.includes(k) && k !== 'field') throw new LifecycleError('bad_context', `unknown context key ${k}`, { path: `$.${k}` });
  return Object.freeze(compact({ tenant: context.tenant, product: context.product, principal: context.principal, agentVersion: context.agentVersion, field: context.field }));
}

export class Run {
  constructor(runtime, { run, identity, gateSet, policyVersion, task, head, terminal, resumed }) {
    this._rt = runtime;
    this.id = run;
    this.identity = identity;
    this.gateSet = gateSet;
    this.policyVersion = policyVersion;
    this.task = task;
    this.head = head;
    this.terminal = terminal;
    this.resumed = resumed;
    this._abort = new AbortController();
  }

  get cancelled() { return this._abort.signal.aborted; }

  _draft(type, payload, { operation, causes, subjectDigest, producer, attempt, task } = {}) {
    return compact({
      contract: CONTRACT, id: this._rt._newId(), run: this.id, type, ts: this._rt._now(),
      ...this.identity,
      task: task === undefined ? this.task : task, attempt, operation,
      policyVersion: this.policyVersion, gateSetDigest: this.gateSet.digest, subjectDigest,
      causes, producer: producer || this._rt.producer, payload,
    });
  }

  async _append(draft, { cas = true } = {}) {
    if (this.terminal) throw new LifecycleError('run_terminal', `run ${this.id} ended with ${this.terminal.type} at seq ${this.terminal.seq}`, this.terminal);
    let r;
    try { r = await this._rt.store.append(draft, cas ? { expectedHead: this.head } : {}); } catch (e) {
      // A cancel issued on this handle may have landed ahead of this write;
      // then the honest reason is the terminal, not the moved head.
      if (e && e.code === 'head_mismatch' && this.cancelled) { await this.refresh(); if (this.terminal) throw new LifecycleError('run_terminal', `run ${this.id} ended with ${this.terminal.type} at seq ${this.terminal.seq}`, this.terminal); }
      throw e;
    }
    this.head = r.head;
    if (isTerminalType(draft.type)) this.terminal = { type: draft.type, seq: r.seq };
    return { ...r, id: draft.id };
  }

  // Re-read the run from the store (after a head_mismatch from another writer).
  async refresh() {
    const r = await this._rt.store.readRun(this.id);
    this.head = r.head;
    this.terminal = r.terminal;
    return r;
  }

  // Read the run and reduce it. { events, state, head, damaged, terminal }.
  async read() {
    const r = await this._rt.store.readRun(this.id);
    return { ...r, state: reduceRun(r.events) };
  }

  // A scoped view whose events carry task/attempt ids.
  attempt({ attempt, task } = {}) {
    if (!isId(attempt)) throw new LifecycleError('bad_attempt', 'attempt must be a valid id');
    if (task !== undefined && !isId(task)) throw new LifecycleError('bad_attempt', 'task must be a valid id when present');
    const scope = { attempt, task };
    return Object.freeze({
      run: this, attempt, task: task === undefined ? this.task : task,
      record: (type, payload, opts = {}) => this.record(type, payload, { ...opts, ...scope }),
      evaluate: (opts = {}) => this.evaluate({ ...opts, ...scope }),
    });
  }

  // Record an observation or an app.* event. The lifecycle's own types are
  // reserved. Returns { ack, seq, digest, head, id }.
  record(type, payload = {}, opts = {}) {
    if (typeof type !== 'string' || RESERVED_TYPES.includes(type)) return Promise.reject(new LifecycleError('reserved_type', `${String(type)} is written by the lifecycle, not record()`, { reserved: RESERVED_TYPES }));
    if (opts.subjectDigest !== undefined && !HEX64_RE.test(opts.subjectDigest)) return Promise.reject(new LifecycleError('bad_subject', 'subjectDigest must be a sha256 hex digest'));
    return this._append(this._draft(type, payload, opts));
  }

  // Evaluate the run's gates (or a subset) against one subject.
  async evaluate({ subject, gateIds, attempt, task } = {}) {
    const m = bindManifest(this.gateSet, subject, gateIds);
    const results = {};
    let ack = null;
    let persistFailed = null;
    for (const id of m.requiredGates) {
      const frozen = this.gateSet.gates.find((g) => g.id === id);
      const bound = { gateId: id, version: frozen.version, implementationDigest: frozen.implementationDigest, evidenceClass: frozen.evidenceClass };
      if (persistFailed) { results[id] = { result: 'unknown', reason: 'not_evaluated', detail: { after: persistFailed }, seq: null, recorded: false }; continue; }
      let started;
      try {
        started = await this._append(this._draft('CHECK_STARTED', bound, { attempt, task, subjectDigest: m.subjectDigest }));
        ack = weaker(ack, started.ack);
      } catch (e) {
        persistFailed = e.code || 'append_failed';
        results[id] = { result: 'unknown', reason: 'persist_failed', detail: { stage: 'CHECK_STARTED', code: persistFailed }, seq: null, recorded: false };
        continue;
      }
      let outcome;
      const live = this._rt.gates.get(id);
      if (this.cancelled) outcome = { result: 'unknown', reason: 'cancelled' };
      else if (!live) outcome = { result: 'unknown', reason: 'gate_missing' };
      else if (live.implementationDigest !== frozen.implementationDigest) outcome = { result: 'unknown', reason: 'implementation_mismatch', detail: { frozen: frozen.implementationDigest, registered: live.implementationDigest } };
      else outcome = await runGate(live, subject, { signal: this._abort.signal, subjectDigest: m.subjectDigest });
      const payload = compact({ ...bound, result: outcome.result, reason: outcome.reason, detail: outcome.detail });
      try {
        const fin = await this._append(this._draft('CHECK_FINISHED', payload, { attempt, task, subjectDigest: m.subjectDigest, causes: [started.id], producer: { kind: 'check', id } }));
        ack = weaker(ack, fin.ack);
        results[id] = { ...outcome, seq: fin.seq, recorded: true };
      } catch (e) {
        persistFailed = e.code || 'append_failed';
        results[id] = { result: 'unknown', reason: 'persist_failed', detail: { stage: 'CHECK_FINISHED', code: persistFailed, unrecorded: outcome.result }, seq: null, recorded: false };
      }
    }
    const passed = m.requiredGates.every((id) => results[id].recorded && results[id].result === 'pass');
    return { subjectDigest: m.subjectDigest, gateSetDigest: m.gateSetDigest, manifest: { requiredGates: m.requiredGates, subjectDigest: m.subjectDigest }, manifestDigest: m.manifestDigest, results, passed, ack, head: this.head };
  }

  complete({ outcome = 'success', reason } = {}) {
    if (!OUTCOMES.includes(outcome)) return Promise.reject(new LifecycleError('bad_outcome', `outcome must be one of ${OUTCOMES.join('|')}`));
    return this._append(this._draft('RUN_COMPLETED', compact({ outcome, reason: typeof reason === 'string' ? reason.slice(0, LIMITS.string) : undefined })));
  }

  fail({ outcome = 'failure', reason } = {}) {
    if (!OUTCOMES.includes(outcome) || outcome === 'success') return Promise.reject(new LifecycleError('bad_outcome', 'a failed run cannot carry outcome success'));
    return this._append(this._draft('RUN_FAILED', compact({ outcome, reason: typeof reason === 'string' ? reason.slice(0, LIMITS.string) : undefined })));
  }

  async cancel({ reason } = {}) {
    if (!this._abort.signal.aborted) this._abort.abort();
    if (this.terminal) return { already: true, ...this.terminal };
    const draft = this._draft('RUN_CANCELLED', compact({ outcome: 'incomplete', reason: typeof reason === 'string' ? reason.slice(0, LIMITS.string) : undefined }));
    try {
      return { already: false, ...(await this._append(draft, { cas: false })) };
    } catch (e) {
      if (e && e.code === 'run_terminal') { await this.refresh(); return { already: true, ...this.terminal }; }
      throw e;
    }
  }
}

export function createRuntime({ store, gates, newId, now, producer } = {}) {
  if (store === null || typeof store !== 'object' || typeof store.append !== 'function' || typeof store.readRun !== 'function') throw new LifecycleError('bad_store', 'store must provide append() and readRun()');
  if (!(gates instanceof GateRegistry)) throw new LifecycleError('bad_registry', 'gates must be a GateRegistry');
  if (typeof newId !== 'function') throw new LifecycleError('missing_host_fn', 'the host supplies newId(); the runtime generates no ids');
  if (typeof now !== 'function') throw new LifecycleError('missing_host_fn', 'the host supplies now(); the runtime reads no clock');
  const prod = producer === undefined ? { kind: 'host', id: 'maddu-runtime' } : producer;
  if (prod === null || typeof prod !== 'object' || prod.kind !== 'host' || !isId(prod.id)) throw new LifecycleError('bad_producer', 'producer must be { kind: "host", id }');

  const runtime = {
    store, gates, producer: Object.freeze({ kind: 'host', id: prod.id }),
    _newId() { const id = newId(); if (!isId(id)) throw new LifecycleError('bad_host_id', 'newId() must return a valid id'); return id; },
    _now() { const ts = now(); if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) throw new LifecycleError('bad_host_ts', 'now() must return an ISO-8601 timestamp'); return ts; },

    describe() { return { contract: CONTRACT, eventTypes: EVENT_TYPES.length, store: typeof store.describe === 'function' ? store.describe() : null, gates: gates.size, gatesFrozen: gates.frozen }; },

    // Resume a run that already has a RUN_STARTED; no event is written.
    async openRun(run) {
      if (!isId(run)) throw new LifecycleError('bad_run', 'run must be a valid id');
      const r = await store.readRun(run);
      if (r.damaged) throw new LifecycleError('run_damaged', `run ${run} is damaged (${r.damaged.reason}); it cannot be resumed`, r.damaged);
      const first = r.events[0];
      if (!first || first.type !== 'RUN_STARTED') throw new LifecycleError('run_not_found', `run ${run} has no RUN_STARTED`);
      const identity = validateContext(compact({ tenant: first.tenant, product: first.product, principal: first.principal, agentVersion: first.agentVersion, field: first.field }));
      const gateSet = Object.freeze({ requiredGates: Object.freeze([...first.payload.requiredGates]), gates: Object.freeze(first.payload.gates.map((g) => Object.freeze({ ...g }))), digest: first.gateSetDigest });
      return new Run(runtime, { run, identity, gateSet, policyVersion: first.policyVersion, task: first.task, head: r.head, terminal: r.terminal, resumed: true });
    },

    async startRun({ run, context, idempotencyKey, requiredGates, policyVersion, task } = {}) {
      if (!isId(run)) throw new LifecycleError('bad_run', 'run must be a valid id');
      const identity = validateContext(context);
      if (!isId(idempotencyKey)) throw new LifecycleError('bad_idempotency_key', 'idempotencyKey must be a valid id');
      if (policyVersion !== undefined && (typeof policyVersion !== 'string' || !policyVersion)) throw new LifecycleError('bad_policy_version', 'policyVersion must be a non-empty string when present');
      if (task !== undefined && !isId(task)) throw new LifecycleError('bad_task', 'task must be a valid id when present');
      const gateSet = freezeGateSet(gates, requiredGates);
      const same = (first) => first && first.type === 'RUN_STARTED' && first.payload.idempotencyKey === idempotencyKey && IDENTITY_KEYS.every((k) => first[k] === identity[k]) && (first.field || undefined) === identity.field && first.gateSetDigest === gateSet.digest;
      const resume = (r) => {
        if (r.damaged) throw new LifecycleError('run_damaged', `run ${run} is damaged (${r.damaged.reason})`, r.damaged);
        if (!same(r.events[0])) throw new LifecycleError('idempotency_mismatch', `run ${run} already exists with a different idempotency key, identity or gate set`, { run });
        return new Run(runtime, { run, identity, gateSet, policyVersion: r.events[0].policyVersion, task: r.events[0].task, head: r.head, terminal: r.terminal, resumed: true });
      };
      const existing = await store.readRun(run);
      if (existing.events.length) return resume(existing);
      const handle = new Run(runtime, { run, identity, gateSet, policyVersion, task, head: null, terminal: null, resumed: false });
      const draft = handle._draft('RUN_STARTED', { idempotencyKey, requiredGates: [...gateSet.requiredGates], gates: gateSet.gates.map((g) => ({ ...g })) });
      try {
        await handle._append(draft);
      } catch (e) {
        if (e && e.code === 'head_mismatch') return resume(await store.readRun(run));
        throw e;
      }
      return handle;
    },
  };
  return Object.freeze(runtime);
}
