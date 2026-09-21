#!/usr/bin/env node
// runtime-lifecycle-run — the run lifecycle over the append store
// (docs/57-product-runtime-rfc.md §6.2 / §6.3, V06 / V07 / V08 / V11, P3).
//
//   0. public surface: createRuntime validates its host functions; Run is
//      the handle class.
//   1. start / resume: RUN_STARTED carries the frozen gate set; same key →
//      resumed without a second RUN_STARTED; different key → idempotency_
//      mismatch; two concurrent starts → exactly one RUN_STARTED; openRun
//      resumes by id; an unknown id is run_not_found.
//   2. evaluate: one CHECK_STARTED/CHECK_FINISHED per gate in id order, bound
//      to the subject digest, gate set digest and implementation digest,
//      producer `check` on the finish, causes → the start id; passed only
//      when every gate recorded pass; the produced run verifies `verified`
//      with the returned manifest; a modified subject fails coverage (V08);
//      byte-identical events from identical host inputs (V03).
//   3. V06 / V07 in the lifecycle: gate missing from the live registry →
//      unknown/gate_missing; same id, changed implementation → unknown/
//      implementation_mismatch — in both cases the check does not run; a
//      changed gate set under the same idempotency key → idempotency_mismatch;
//      throw / timeout / bad result recorded as such; a refused CHECK_FINISHED
//      append → unknown/persist_failed and the remaining gates are
//      not_evaluated without running.
//   4. cancellation: cancel() mid-check → the check sees abort, its result is
//      unknown/cancelled, RUN_CANCELLED is the terminal, the late
//      CHECK_FINISHED is refused (run_terminal) and reported unrecorded; a
//      second cancel is a no-op reporting the terminal; complete/fail/record
//      after a terminal are refused.
//   5. attempts, record(), terminals and FileStore ack.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}
function thrown(fn) { try { fn(); return null; } catch (e) { return e; } }
async function rejects(p) { try { await p; return null; } catch (e) { return e; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX64 = /^[0-9a-f]{64}$/;

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const { createRuntime, Run, GateRegistry, MemoryStore, FileStore, StoreError, LifecycleError, verifyRun, reduceRun, subjectDigest, canonicalEncode, CHECK_RESULTS } = rt;

  const context = { tenant: 'acme', product: 'crm', principal: 'agent:writer', agentVersion: '2.1.0', field: 'sales' };
  const hostIds = () => { let n = 0; return () => `ev-${String(++n).padStart(4, '0')}`; };
  const now = () => '2026-09-21T00:00:00.000Z';
  const makeRegistry = (overrides = {}) => {
    const reg = new GateRegistry();
    reg.register({ id: 'schema', version: '1', evidenceClass: 'deterministic', check: (s) => (s && typeof s.title === 'string' && s.title.length > 0 ? 'pass' : 'fail') });
    reg.register({ id: 'tone', version: '1', evidenceClass: 'model_judged', bound: { timeoutMs: 50 }, check: (s) => (s.tone === 'slow' ? new Promise((r) => setTimeout(() => r('pass'), 200)) : s.tone === 'throw' ? Promise.reject(new Error('judge down')) : s.tone === 'weird' ? 'PASS' : 'pass') });
    for (const [id, spec] of Object.entries(overrides)) { if (spec === null) continue; reg.register({ id, version: '1', evidenceClass: 'deterministic', ...spec }); }
    return reg.freeze();
  };
  const boot = ({ store = new MemoryStore(), gates = makeRegistry(), newId = hostIds() } = {}) => createRuntime({ store, gates, newId, now });
  const start = (runtime, extra = {}) => runtime.startRun({ run: 'run-1', context, idempotencyKey: 'key-1', requiredGates: ['tone', 'schema'], policyVersion: 'pol-3', ...extra });

  // ── 0. surface ──
  ok('surface: createRuntime requires a store, a GateRegistry, newId() and now()', thrown(() => createRuntime({}))?.code === 'bad_store' && thrown(() => createRuntime({ store: new MemoryStore() }))?.code === 'bad_registry' && thrown(() => createRuntime({ store: new MemoryStore(), gates: makeRegistry() }))?.code === 'missing_host_fn' && thrown(() => createRuntime({ store: new MemoryStore(), gates: makeRegistry(), newId: () => 'a' }))?.code === 'missing_host_fn');
  ok('surface: producer must be a host producer', thrown(() => createRuntime({ store: new MemoryStore(), gates: makeRegistry(), newId: () => 'a', now, producer: { kind: 'model', id: 'x' } }))?.code === 'bad_producer');
  const runtime = boot();
  ok('surface: describe() names the contract, the store and the frozen registry', runtime.describe().contract === 'maddu.runtime.v1' && runtime.describe().store.kind === 'memory' && runtime.describe().gates === 2 && runtime.describe().gatesFrozen === true && Object.isFrozen(runtime));

  // ── 1. start / resume ──
  const run = await start(runtime);
  ok('startRun returns a Run with head, gate set and identity; not resumed', run instanceof Run && HEX64.test(run.head) && run.resumed === false && run.gateSet.requiredGates.join() === 'schema,tone' && run.identity.field === 'sales' && run.terminal === null);
  const first = (await run.read()).events[0];
  ok('RUN_STARTED carries the idempotency key, the frozen gates and gateSetDigest/policyVersion', first.type === 'RUN_STARTED' && first.payload.idempotencyKey === 'key-1' && first.payload.requiredGates.join() === 'schema,tone' && first.payload.gates.every((g) => HEX64.test(g.implementationDigest)) && first.gateSetDigest === run.gateSet.digest && first.policyVersion === 'pol-3' && first.producer.kind === 'host');
  const again = await start(runtime);
  ok('same run + same key → resumed, no second RUN_STARTED', again.resumed === true && again.head === run.head && (await run.read()).state.types.RUN_STARTED === 1);
  ok('same run + different key → idempotency_mismatch', (await rejects(start(runtime, { idempotencyKey: 'key-2' })))?.code === 'idempotency_mismatch');
  ok('same run + different identity → idempotency_mismatch', (await rejects(start(runtime, { context: { ...context, principal: 'agent:other' } })))?.code === 'idempotency_mismatch');
  ok('same run + different gate set → idempotency_mismatch (V06)', (await rejects(start(runtime, { requiredGates: ['schema'] })))?.code === 'idempotency_mismatch');
  const opened = await runtime.openRun('run-1');
  ok('openRun resumes by id with the frozen gate set and writes nothing', opened.resumed && opened.gateSet.digest === run.gateSet.digest && opened.policyVersion === 'pol-3' && (await opened.read()).events.length === 1);
  ok('openRun on an unknown run → run_not_found', (await rejects(runtime.openRun('nope')))?.code === 'run_not_found');
  {
    const r2 = boot();
    const [a, b] = await Promise.all([start(r2, { run: 'run-c' }), start(r2, { run: 'run-c' })]);
    ok('two concurrent starts → exactly one RUN_STARTED, one fresh and one resumed', (await a.read()).state.types.RUN_STARTED === 1 && [a.resumed, b.resumed].sort().join() === 'false,true' && a.head === b.head);
  }
  for (const [name, extra, code] of [['bad run id', { run: 'no spaces' }, 'bad_run'], ['bad context', { context: { tenant: 't' } }, 'bad_context'], ['unknown context key', { context: { ...context, role: 'admin' } }, 'bad_context'], ['bad key', { idempotencyKey: '' }, 'bad_idempotency_key'], ['unregistered gate', { run: 'run-x', requiredGates: ['ghost'] }, 'gate_unregistered'], ['empty gate set', { run: 'run-x', requiredGates: [] }, 'bad_gate_set'], ['bad task', { run: 'run-x', task: 'a b' }, 'bad_task']]) {
    ok(`startRun rejects ${name} → ${code}`, (await rejects(start(runtime, extra)))?.code === code);
  }

  // ── 2. evaluate ──
  const subject = { title: 'Hello', tone: 'fine' };
  const ev = await run.evaluate({ subject });
  ok('evaluate: passed with both gates pass, recorded, ack buffered', ev.passed === true && ev.results.schema.result === 'pass' && ev.results.tone.result === 'pass' && ev.results.schema.recorded && ev.ack === 'buffered' && ev.head === run.head);
  const evs = (await run.read()).events;
  ok('evaluate: CHECK_STARTED/CHECK_FINISHED per gate in id order', evs.slice(1).map((e) => `${e.type}:${e.payload.gateId}`).join() === 'CHECK_STARTED:schema,CHECK_FINISHED:schema,CHECK_STARTED:tone,CHECK_FINISHED:tone');
  const fin = evs[2];
  ok('CHECK_FINISHED binds subject digest, gate set digest, implementation digest, version, class; producer check; causes → start id', fin.subjectDigest === subjectDigest(subject) && fin.gateSetDigest === run.gateSet.digest && fin.payload.implementationDigest === run.gateSet.gates[0].implementationDigest && fin.payload.version === '1' && fin.payload.evidenceClass === 'deterministic' && fin.producer.kind === 'check' && fin.producer.id === 'schema' && fin.causes.join() === evs[1].id && evs[1].producer.kind === 'host');
  ok('evaluate returns the manifest and manifestDigest bound to the subject', ev.manifest.requiredGates.join() === 'schema,tone' && ev.manifest.subjectDigest === subjectDigest(subject) && HEX64.test(ev.manifestDigest) && ev.subjectDigest === ev.manifest.subjectDigest);
  await run.complete({ outcome: 'success' });
  const full = await run.read();
  const v = verifyRun({ events: full.events, manifest: ev.manifest });
  ok('the produced run verifies `verified` with the returned manifest (only producer/witness not_supplied)', v.verdict === 'verified' && v.limits.map((l) => l.dimension).join() === 'producer,witness' && full.state.status === 'completed', JSON.stringify(v.limits));
  const tampered = verifyRun({ events: full.events, manifest: { requiredGates: ['schema', 'tone'], subjectDigest: subjectDigest({ ...subject, title: 'Hello!' }) } });
  ok('a modified subject fails coverage: nothing reusable (V08)', tampered.verdict === 'invalid' && tampered.dimensions.coverage.findings.every((f) => f.code === 'gate_subject_mismatch') && tampered.dimensions.coverage.findings.length === 2);
  {
    const s1 = new MemoryStore(), s2 = new MemoryStore();
    const a = await start(boot({ store: s1 })); await a.evaluate({ subject }); await a.complete();
    const b = await start(boot({ store: s2 })); await b.evaluate({ subject }); await b.complete();
    ok('identical host inputs → byte-identical event streams (V03)', canonicalEncode((await s1.readRun('run-1')).events) === canonicalEncode((await s2.readRun('run-1')).events) && a.head === b.head);
  }
  ok('evaluate refuses a gate outside the frozen set and a non-canonical subject', (await rejects(run.evaluate({ subject, gateIds: ['ghost'] })))?.code === 'gate_not_in_set' && (await rejects(run.evaluate({ subject: { x: undefined } })))?.code === 'bad_subject');

  // ── 3. V06 / V07 ──
  {
    const store = new MemoryStore();
    const a = await start(boot({ store }));
    // Redeploy: registry without `tone`, and `schema` with a changed body under the same id.
    const redeployed = new GateRegistry();
    redeployed.register({ id: 'schema', version: '1', evidenceClass: 'deterministic', check: () => 'pass' });
    let toneRan = false;
    const later = createRuntime({ store, gates: redeployed.freeze(), newId: hostIds(), now });
    const resumed = await later.openRun('run-1');
    const e = await resumed.evaluate({ subject });
    ok('V06: gate missing from the live registry → unknown/gate_missing, recorded', e.results.tone.result === 'unknown' && e.results.tone.reason === 'gate_missing' && e.results.tone.recorded && !toneRan);
    ok('V06: same id, changed implementation → unknown/implementation_mismatch, the new code never runs', e.results.schema.result === 'unknown' && e.results.schema.reason === 'implementation_mismatch' && e.results.schema.detail.frozen === a.gateSet.gates[0].implementationDigest && e.results.schema.detail.registered !== e.results.schema.detail.frozen && e.passed === false);
    const vv = verifyRun({ events: (await resumed.read()).events, manifest: e.manifest });
    ok('V06: the verifier reports both gates not passed', vv.dimensions.coverage.status === 'fail' && vv.dimensions.coverage.findings.map((f) => f.code).join() === 'gate_not_passed,gate_not_passed');
    ok('V06: a start under the same key against the redeployed registry → idempotency_mismatch', (await rejects(later.startRun({ run: 'run-1', context, idempotencyKey: 'key-1', requiredGates: ['schema'] })))?.code === 'idempotency_mismatch');
  }
  {
    const a = await start(boot());
    const slow = await a.evaluate({ subject: { title: 'x', tone: 'slow' } });
    const thr = await a.evaluate({ subject: { title: 'x', tone: 'throw' } });
    const weird = await a.evaluate({ subject: { title: 'x', tone: 'weird' } });
    ok('V07: timeout / throw / bad result recorded as timeout / error / error, never pass', slow.results.tone.result === 'timeout' && thr.results.tone.result === 'error' && thr.results.tone.reason === 'threw' && thr.results.tone.detail.message === 'judge down' && weird.results.tone.result === 'error' && weird.results.tone.reason === 'bad_result' && ![slow, thr, weird].some((r) => r.passed));
    const st = (await a.read()).state;
    ok('V07: the reducer sees the last CHECK_FINISHED per gate with its non-pass result', st.checks.tone.result === 'error' && st.checks.schema.result === 'pass' && Object.values(st.checks).every((c) => CHECK_RESULTS.includes(c.result)));
  }
  {
    // A sink that refuses the 4th append (the first CHECK_FINISHED after RUN_STARTED, schema START, schema FINISH... count below).
    class FlakySink extends MemoryStore { constructor(failAt) { super(); this.failAt = failAt; this.n = 0; } async _persist(...a) { this.n++; if (this.n === this.failAt) throw new StoreError('sink_full', 'evidence sink refused the write'); return super._persist(...a); } }
    const store = new FlakySink(3); // 1 RUN_STARTED, 2 CHECK_STARTED schema, 3 CHECK_FINISHED schema ← refused
    let toneRan = false;
    const gates = makeRegistry({ tone: null });
    const reg = new GateRegistry();
    reg.register({ id: 'schema', version: '1', evidenceClass: 'deterministic', check: () => 'pass' });
    reg.register({ id: 'tone', version: '1', evidenceClass: 'deterministic', check: () => { toneRan = true; return 'pass'; } });
    void gates;
    const a = await createRuntime({ store, gates: reg.freeze(), newId: hostIds(), now }).startRun({ run: 'run-f', context, idempotencyKey: 'k', requiredGates: ['schema', 'tone'] });
    const e = await a.evaluate({ subject });
    ok('V07: a refused CHECK_FINISHED → unknown/persist_failed naming the code and the unrecorded result', e.results.schema.result === 'unknown' && e.results.schema.reason === 'persist_failed' && e.results.schema.detail.code === 'sink_full' && e.results.schema.detail.unrecorded === 'pass' && e.results.schema.recorded === false);
    ok('V07: the remaining gate is not_evaluated and its check never ran; passed is false', e.results.tone.result === 'unknown' && e.results.tone.reason === 'not_evaluated' && !toneRan && e.passed === false);
    const st = (await a.read()).state;
    ok('V07: the store holds RUN_STARTED and the CHECK_STARTED only; the run is still open and its head is consistent', st.count === 2 && st.status === 'open' && a.head === st.head && Object.keys(st.checks).length === 0);
    ok('V07: the handle keeps working after the sink recovers', (await a.evaluate({ subject })).passed === true && (await a.read()).state.checks.schema.result === 'pass');
  }

  // ── 4. cancellation ──
  {
    let sawAbort = false;
    const reg = new GateRegistry();
    reg.register({ id: 'long', version: '1', evidenceClass: 'human_review', bound: { timeoutMs: 5000 }, check: (s, ctx) => new Promise((resolve) => { ctx.signal.addEventListener('abort', () => { sawAbort = true; }); setTimeout(() => resolve('pass'), 150); }) });
    const store = new MemoryStore();
    const a = await createRuntime({ store, gates: reg.freeze(), newId: hostIds(), now }).startRun({ run: 'run-k', context, idempotencyKey: 'k', requiredGates: ['long'] });
    const pending = a.evaluate({ subject });
    await sleep(20);
    const c = await a.cancel({ reason: 'operator stop' });
    const e = await pending;
    ok('cancel mid-check → RUN_CANCELLED appended, the check told, result unknown/cancelled and unrecorded (run_terminal)', c.already === false && a.terminal.type === 'RUN_CANCELLED' && a.cancelled && sawAbort && e.results.long.result === 'unknown' && e.results.long.detail.unrecorded === 'unknown' && e.results.long.detail.code === 'run_terminal' && e.results.long.recorded === false && e.passed === false, JSON.stringify(e.results));
    const st = (await a.read()).state;
    ok('the run reduces to cancelled with RUN_STARTED, CHECK_STARTED, RUN_CANCELLED and no CHECK_FINISHED', st.status === 'cancelled' && st.count === 3 && st.terminal.type === 'RUN_CANCELLED' && st.terminal.outcome === 'incomplete' && !st.types.CHECK_FINISHED);
    const c2 = await a.cancel();
    ok('a second cancel is a no-op reporting the terminal', c2.already === true && c2.type === 'RUN_CANCELLED' && (await a.read()).state.count === 3);
    ok('complete / fail / record / evaluate after the terminal → run_terminal', (await rejects(a.complete()))?.code === 'run_terminal' && (await rejects(a.fail()))?.code === 'run_terminal' && (await rejects(a.record('app.note', {})))?.code === 'run_terminal' && (await a.evaluate({ subject })).results.long.reason === 'persist_failed');
    ok('a resumed handle of a cancelled run sees the terminal', (await runtime.openRun('run-1')).terminal.type === 'RUN_COMPLETED' && (await createRuntime({ store, gates: reg, newId: hostIds(), now }).openRun('run-k')).terminal.type === 'RUN_CANCELLED');
  }

  // ── 5. attempts, record, terminals, FileStore ──
  {
    const a = await start(boot({ newId: hostIds() }), { run: 'run-a', task: 'task-9' });
    const att = a.attempt({ attempt: 'att-1' });
    const r = await att.record('MODEL_CALL_STARTED', { model: 'synthetic' });
    const e = await att.evaluate({ subject });
    const evs = (await a.read()).events;
    ok('attempt() scopes task/attempt onto recorded and check events', r.seq === 2 && evs[1].attempt === 'att-1' && evs[1].task === 'task-9' && evs[2].attempt === 'att-1' && evs[2].type === 'CHECK_STARTED' && e.passed);
    ok('record() refuses the lifecycle\'s own types and a bad subject digest', (await rejects(a.record('RUN_COMPLETED', {})))?.code === 'reserved_type' && (await rejects(a.record('CHECK_FINISHED', {})))?.code === 'reserved_type' && (await rejects(a.record('app.x', {}, { subjectDigest: 'zz' })))?.code === 'bad_subject');
    ok('record() writes app.* and observation events with operation/causes/subjectDigest through the store', (await a.record('app.crm.send_proposed', { kind: 'send' }, { operation: 'op-1', causes: [r.id], subjectDigest: e.subjectDigest })).seq === 7 && (await rejects(a.record('app.crm.send_proposed', {}, { operation: 'op-1' })))?.code === 'duplicate_operation');
    ok('record() refuses the decision, approval, output and reconcile families too (P4 owns them)', (await Promise.all(['ACTION_PROPOSED', 'ACTION_DECIDED', 'ACTION_STARTED', 'APPROVAL_REQUESTED', 'APPROVAL_DECIDED', 'OUTPUT_DECIDED', 'OUTCOME_RECONCILED'].map((t) => rejects(a.record(t, {}, { operation: 'op-x' }))))).every((e) => e?.code === 'reserved_type'));
    ok('attempt() validates ids', thrown(() => a.attempt({}))?.code === 'bad_attempt' && thrown(() => a.attempt({ attempt: 'x', task: ' ' }))?.code === 'bad_attempt');
    ok('fail() refuses outcome success; complete() refuses an unknown outcome', (await rejects(a.fail({ outcome: 'success' })))?.code === 'bad_outcome' && (await rejects(a.complete({ outcome: 'great' })))?.code === 'bad_outcome');
    await a.fail({ reason: 'x'.repeat(600), outcome: 'unknown' });
    const st = (await a.read()).state;
    ok('fail() → RUN_FAILED with the outcome and a clipped reason; the run is failed', st.status === 'failed' && st.terminal.outcome === 'unknown' && (await a.read()).events.at(-1).payload.reason.length === 512);
    ok('a stale handle (another writer moved the head) gets head_mismatch and refresh() recovers', await (async () => {
      const store = new MemoryStore();
      const rtA = boot({ store }); const h1 = await start(rtA, { run: 'run-s' });
      const h2 = await rtA.openRun('run-s');
      await h1.record('app.a', {});
      const e = await rejects(h2.record('app.b', {}));
      await h2.refresh();
      return e?.code === 'head_mismatch' && (await h2.record('app.b', {})).seq === 3 && (await h1.refresh()).head === h2.head;
    })());
    ok('a bad host id / timestamp is refused before anything is written', (await rejects(createRuntime({ store: new MemoryStore(), gates: makeRegistry(), newId: () => 'bad id', now }).startRun({ run: 'r', context, idempotencyKey: 'k', requiredGates: ['schema'] })))?.code === 'bad_host_id' && (await rejects(createRuntime({ store: new MemoryStore(), gates: makeRegistry(), newId: () => 'a', now: () => 'yesterday' }).startRun({ run: 'r', context, idempotencyKey: 'k', requiredGates: ['schema'] })))?.code === 'bad_host_ts');
  }
  {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-rt-life-'));
    try {
      const store = new FileStore(path.join(tmp, 'runs'));
      const a = await start(boot({ store }), { run: 'tenant:run.7' });
      const e = await a.evaluate({ subject });
      await a.complete();
      ok('FileStore: evaluate reports the weakest ack (durable) and a fresh store instance re-reads a verified run', e.ack === 'durable' && e.passed && await (async () => {
        const fresh = new FileStore(path.join(tmp, 'runs'));
        const r = await fresh.readRun('tenant:run.7');
        return !r.damaged && verifyRun({ events: r.events, manifest: e.manifest }).verdict === 'verified' && r.head === a.head;
      })());
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }
  ok('every result the lifecycle wrote is in CHECK_RESULTS', (await run.read()).events.filter((e) => e.type === 'CHECK_FINISHED').every((e) => CHECK_RESULTS.includes(e.payload.result)));
  ok('LifecycleError and StoreError are distinguishable', new LifecycleError('a', 'b') instanceof Error && !(new LifecycleError('a', 'b') instanceof StoreError));
  void reduceRun;

  console.log('');
  console.log(`runtime-lifecycle-run: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-lifecycle-run OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
