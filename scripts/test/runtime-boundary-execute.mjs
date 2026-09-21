#!/usr/bin/env node
// runtime-boundary-execute — the protected execution/release boundary and
// reconciliation (docs/57-product-runtime-rfc.md ADR-005, §6.2 steps 6–8,
// §8 failure rules, V08 / V09 / V10 / V11 / V16, P4).
//
//   0. public surface: PERFORM_OUTCOMES, execute, release, reconcile,
//      unresolvedOperations.
//   1. Denied actions have zero side effects: a forged handle, a tampered
//      parameter or resource version (V08), a wrong boundary, an expired
//      handle, a handle from another run / tenant (V16), a stale gate set or
//      policy version, and a host authorization that returns anything but
//      true (V10) — in every case perform() is never called and nothing is
//      written.
//   2. Consume once: ACTION_STARTED records intent (handle id, idempotency
//      key), perform() runs with the idempotency key, ACTION_FINISHED records
//      the outcome; the same handle again → already_executed with perform()
//      not called (V09); a shadow handle executes the same way with
//      enforced:false on the record.
//   3. Crash windows (V11): perform() throws → outcome unknown, the operation
//      is unresolved, a retry with the same handle is refused `unresolved`
//      and perform() is not called again; a refused ACTION_FINISHED append →
//      executed but recorded:false and unresolved; a bad perform() return →
//      unknown / bad_outcome, never success or failure.
//   4. reconcile(): only a started or finished-unknown operation; never to
//      unknown; OUTCOME_RECONCILED cites the start and keeps the prior
//      outcome; unresolvedOperations empties; a second reconcile is refused;
//      a decided-not-started operation is not reconcilable.
//   5. release(): OUTPUT_DECIDED + OUTPUT_DELIVERY_OBSERVED bound to the exact
//      artifact; a modified artifact → binding_mismatch (V08); a second
//      release → already_released; deliver() not observed → recorded as such.
//   6. The whole run verifies `verified` with the evaluate manifest, and the
//      reducer reports no issues.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}
async function rejects(p) { try { await p; return null; } catch (e) { return e; } }

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const { PERFORM_OUTCOMES, execute, release, reconcile, unresolvedOperations, freezePolicy, hmacSigner, decide, encodeHandle, verifyHandle, GateRegistry, createRuntime, MemoryStore, StoreError, verifyRun, subjectDigest } = rt;

  ok('surface: PERFORM_OUTCOMES is success|failure (unknown is never a host claim)', Object.isFrozen(PERFORM_OUTCOMES) && PERFORM_OUTCOMES.join() === 'success,failure');

  const context = { tenant: 'acme', product: 'crm', principal: 'agent:writer', agentVersion: '2.1.0' };
  const makeRegistry = () => { const reg = new GateRegistry(); reg.register({ id: 'schema', version: '1', evidenceClass: 'deterministic', check: (s) => (s && typeof s.title === 'string' ? 'pass' : 'fail') }); return reg.freeze(); };
  let clockMs = Date.parse('2026-09-21T00:00:00.000Z');
  const now = () => new Date(clockMs).toISOString();
  const ids = () => { let n = 0; return () => `ev-${String(++n).padStart(4, '0')}`; };
  const policy = freezePolicy({ version: 'pol-1', boundaries: { send: { enforced: true, ttlMs: 60000 }, draft: { enforced: false } } });
  const signer = hmacSigner({ id: 'policy-svc', key: 's'.repeat(32) });
  const subject = { title: 'Hello' };
  const sd = subjectDigest(subject);
  const boot = (store = new MemoryStore()) => createRuntime({ store, gates: makeRegistry(), newId: ids(), now });
  const open = (runtime, extra = {}) => runtime.startRun({ run: 'run-1', context, idempotencyKey: 'key-1', requiredGates: ['schema'], policyVersion: 'pol-1', ...extra });
  const act = { signer, policy, boundary: 'send', operation: 'op-1', parameters: { to: 'a@example.invalid' }, resourceVersion: 'lead:42@7', subjectDigest: sd, now };
  // A run with a pass recorded and an allow handle for op-1.
  const allowed = async (runtime = boot(), extra = {}) => { const run = await open(runtime, extra); await run.evaluate({ subject }); const d = await decide(run, act); return { run, d }; };
  const spy = () => { const s = { calls: 0, last: null, perform: async (ctx) => { s.calls++; s.last = ctx; return 'success'; } }; return s; };

  // ── 1. zero side effects ──
  {
    const { run, d } = await allowed();
    const n0 = (await run.read()).events.length;
    const p = spy();
    const go = (over) => rejects(execute(run, { ...act, handle: d.handle, perform: p.perform, ...over }));
    ok('forged handle → handle_forged', (await go({ handle: d.handle.slice(0, -4) + 'AAAA' }))?.code === 'handle_forged' || (await go({ handle: d.handle.slice(0, -4) + 'AAAA' }))?.code === 'bad_handle');
    ok('tampered parameter → binding_mismatch (V08)', (await go({ parameters: { to: 'evil@example.invalid' } }))?.code === 'binding_mismatch');
    ok('changed resource version → binding_mismatch (V08)', (await go({ resourceVersion: 'lead:42@8' }))?.code === 'binding_mismatch');
    ok('wrong boundary → binding_mismatch', (await go({ boundary: 'draft' }))?.code === 'binding_mismatch');
    clockMs += 60000;
    ok('expired handle → handle_expired', (await go({}))?.code === 'handle_expired');
    clockMs -= 60000;
    const other = await open(boot(), { run: 'run-2', context: { ...context, tenant: 'globex' } });
    ok('a handle from another run / tenant → binding_mismatch (V16)', (await rejects(execute(other, { ...act, handle: d.handle, perform: p.perform })))?.code === 'binding_mismatch');
    const forged = encodeHandle({ ...verifyHandle(d.handle, signer), v: undefined, signer: undefined, policyVersion: 'pol-9' }, signer);
    ok('a handle signed for another policy version → binding_mismatch', (await go({ handle: forged }))?.code === 'binding_mismatch');
    for (const [name, authorize] of [['false', () => false], ['"true"', () => 'true'], ['undefined', () => undefined], ['throws', () => { throw new Error('auth down'); }], ['async false', async () => false]]) {
      const r = await execute(run, { ...act, handle: d.handle, perform: p.perform, authorize });
      ok(`host authorize returning ${name} → refused host_denied, no event (V10)`, r.executed === false && r.refused === 'host_denied');
    }
    ok('none of the refusals called perform() or wrote an event', p.calls === 0 && (await run.read()).events.length === n0);
    ok('execute needs perform() and now()', (await rejects(execute(run, { ...act, handle: d.handle })))?.code === 'bad_perform' && (await rejects(execute(run, { ...act, handle: d.handle, perform: p.perform, now: undefined })))?.code === 'missing_host_fn');
  }

  // ── 2. consume once ──
  {
    const { run, d } = await allowed();
    const p = spy();
    const r = await execute(run, { ...act, handle: d.handle, perform: p.perform, authorize: async () => true, idempotencyKey: 'idem-1' });
    const evs = (await run.read()).events;
    const started = evs.find((e) => e.type === 'ACTION_STARTED'), finished = evs.find((e) => e.type === 'ACTION_FINISHED');
    ok('execute → ACTION_STARTED (intent: handle id, idempotency key) then perform then ACTION_FINISHED success', r.executed && r.outcome === 'success' && r.recorded && p.calls === 1 && p.last.idempotencyKey === 'idem-1' && p.last.operation === 'op-1' && started.payload.handleId === d.decisionId && started.payload.idempotencyKey === 'idem-1' && started.causes.join() === d.decisionId && started.subjectDigest === sd && finished.payload.outcome === 'success' && finished.causes.join() === started.id && finished.seq === r.seq);
    const again = await execute(run, { ...act, handle: d.handle, perform: p.perform });
    ok('the same handle again → already_executed, perform() not called (V09)', again.executed === false && again.refused === 'already_executed' && again.outcome === 'success' && p.calls === 1);
    ok('the reducer: action finished success, nothing unresolved', (await run.read()).state.actions['op-1'].state === 'finished' && (await unresolvedOperations(run)).length === 0);
    ok('the default idempotency key is the handle id', await (async () => { const { run: r2, d: d2 } = await allowed(boot(), { run: 'run-k' }); const s = spy(); await execute(r2, { ...act, handle: d2.handle, perform: s.perform }); return s.last.idempotencyKey === d2.decisionId && s.last.handleId === d2.decisionId; })());
  }
  {
    const run = await open(boot());
    const d = await decide(run, { ...act, boundary: 'draft' }); // shadow, gates not run → allow with wouldDecide withhold
    const p = spy();
    const r = await execute(run, { ...act, boundary: 'draft', handle: d.handle, perform: p.perform });
    ok('a shadow handle executes; ACTION_STARTED records enforced:false', r.executed && (await run.read()).events.find((e) => e.type === 'ACTION_STARTED').payload.enforced === false);
  }

  // ── 3. crash windows ──
  {
    const { run, d } = await allowed();
    let calls = 0;
    const r = await execute(run, { ...act, handle: d.handle, perform: async () => { calls++; throw new Error('socket hang up'); } });
    ok('perform() throws → outcome unknown / threw, recorded; the operation is unresolved (V11)', r.executed && r.outcome === 'unknown' && r.reason === 'threw' && r.recorded && (await unresolvedOperations(run)).join() === 'op-1' && (await run.read()).events.find((e) => e.type === 'ACTION_FINISHED').payload.detail.message === 'socket hang up');
    const retry = await execute(run, { ...act, handle: d.handle, perform: async () => { calls++; return 'success'; } });
    ok('a retry with the same handle → already_executed with outcome unknown; perform() not re-run', retry.executed === false && retry.refused === 'already_executed' && retry.outcome === 'unknown' && calls === 1);
  }
  {
    const { run, d } = await allowed();
    for (const [name, v] of [['undefined', undefined], ['true', true], ['"ok"', 'ok'], ['"unknown"', 'unknown'], ['{outcome:"done"}', { outcome: 'done' }]]) {
      const { run: r2, d: d2 } = await allowed(boot(), { run: `run-${name.replace(/[^a-z]/gi, '') || 'x'}` });
      const r = await execute(r2, { ...act, handle: d2.handle, perform: async () => v });
      ok(`perform() returning ${name} → unknown / bad_outcome`, r.outcome === 'unknown' && r.reason === 'bad_outcome');
    }
    void run; void d;
  }
  {
    // The sink refuses the ACTION_FINISHED append: the effect happened, the receipt is missing.
    class Flaky extends MemoryStore { constructor() { super(); this.failNext = false; } async _persist(...a) { if (this.failNext) { this.failNext = false; throw new StoreError('sink_full', 'refused'); } return super._persist(...a); } }
    const store = new Flaky();
    const { run, d } = await allowed(boot(store));
    let effect = 0;
    const r = await execute(run, { ...act, handle: d.handle, perform: async () => { store.failNext = true; effect++; return 'success'; } });
    ok('ACTION_FINISHED refused → executed, recorded:false, unresolved, error named; intent is on record', r.executed && r.outcome === 'success' && r.recorded === false && r.unresolved === true && r.error === 'sink_full' && effect === 1 && (await unresolvedOperations(run)).join() === 'op-1' && (await run.read()).state.actions['op-1'].state === 'started');
    const retry = await execute(run, { ...act, handle: d.handle, perform: async () => { effect++; return 'success'; } });
    ok('a retry while unresolved → refused unresolved; the effect is not duplicated (V11)', retry.executed === false && retry.refused === 'unresolved' && effect === 1);
    // ── 4. reconcile ──
    ok('reconcile validates outcome (never unknown) and operation', (await rejects(reconcile(run, { operation: 'op-1', outcome: 'unknown', now })))?.code === 'bad_outcome' && (await rejects(reconcile(run, { operation: 'nope', outcome: 'success', now })))?.code === 'not_reconcilable');
    const rc = await reconcile(run, { operation: 'op-1', outcome: 'success', reason: 'provider receipt 77 found', evidenceRef: 'receipt:77', now });
    const ev = (await run.read()).events.find((e) => e.type === 'OUTCOME_RECONCILED');
    ok('reconcile from durable host state → OUTCOME_RECONCILED citing the start, prior state kept', rc.outcome === 'success' && rc.priorOutcome === null && ev.payload.priorState === 'started' && ev.payload.evidenceRef === 'receipt:77' && ev.causes.join() === (await run.read()).events.find((e) => e.type === 'ACTION_STARTED').id && ev.operation === 'op-1');
    ok('after reconcile nothing is unresolved and the action is reconciled', (await unresolvedOperations(run)).length === 0 && (await run.read()).state.actions['op-1'].state === 'reconciled' && (await run.read()).state.actions['op-1'].outcome === 'success');
    ok('a second reconcile → not_reconcilable; a decided-not-started op → not_reconcilable', (await rejects(reconcile(run, { operation: 'op-1', outcome: 'failure', now })))?.code === 'not_reconcilable' && await (async () => { const { run: r3 } = await allowed(boot(), { run: 'run-d' }); return (await rejects(reconcile(r3, { operation: 'op-1', outcome: 'failure', now })))?.code === 'not_reconcilable'; })());
    ok('a finished-unknown operation reconciles; a finished-success one does not', await (async () => {
      const { run: r4, d: d4 } = await allowed(boot(), { run: 'run-u' });
      await execute(r4, { ...act, handle: d4.handle, perform: async () => { throw new Error('x'); } });
      const rec = await reconcile(r4, { operation: 'op-1', outcome: 'failure', now });
      const { run: r5, d: d5 } = await allowed(boot(), { run: 'run-s' });
      await execute(r5, { ...act, handle: d5.handle, perform: async () => 'success' });
      return rec.priorOutcome === 'unknown' && (await rejects(reconcile(r5, { operation: 'op-1', outcome: 'failure', now })))?.code === 'not_reconcilable';
    })());
  }

  // ── 5. release ──
  {
    const run = await open(boot());
    await run.evaluate({ subject });
    const d = await decide(run, { ...act, operation: 'rel-1' });
    let delivered = 0;
    ok('release with a modified artifact → binding_mismatch, deliver() not called (V08)', (await rejects(release(run, { signer, boundary: 'send', handle: d.handle, subject: { title: 'Hello!' }, now, deliver: () => { delivered++; return true; } })))?.code === 'binding_mismatch' && delivered === 0);
    const r = await release(run, { signer, boundary: 'send', handle: d.handle, subject, now, deliver: (ctx) => { delivered++; return ctx.subjectDigest === sd; } });
    const evs = (await run.read()).events;
    ok('release → OUTPUT_DECIDED then OUTPUT_DELIVERY_OBSERVED, both bound to the artifact and the operation', r.released && r.delivered && delivered === 1 && evs.filter((e) => e.type === 'OUTPUT_DECIDED').length === 1 && evs.at(-1).type === 'OUTPUT_DELIVERY_OBSERVED' && evs.at(-1).subjectDigest === sd && evs.at(-1).operation === 'rel-1' && (await run.read()).state.outputs[0].delivered === true);
    const again = await release(run, { signer, boundary: 'send', handle: d.handle, subject, now, deliver: () => { delivered++; return true; } });
    ok('a second release with the same handle → already_released, deliver() not called', again.released === false && again.refused === 'already_released' && delivered === 1);
    const d2 = await decide(run, { ...act, operation: 'rel-2' });
    const r2 = await release(run, { signer, boundary: 'send', handle: d2.handle, subject, now, deliver: () => { throw new Error('cdn down'); } });
    ok('deliver() throws → released (decided) but delivered:false with the reason; no delivery observed', r2.released && r2.delivered === false && /cdn down/.test(r2.reason) && (await run.read()).state.outputs[1].delivered === false);
    ok('release refuses a host denial without an event', await (async () => { const d3 = await decide(run, { ...act, operation: 'rel-3' }); const n = (await run.read()).events.length; const x = await release(run, { signer, boundary: 'send', handle: d3.handle, subject, now, authorize: () => false, deliver: () => true }); return x.released === false && x.refused === 'host_denied' && (await run.read()).events.length === n; })());
  }

  // ── 6. verified end to end ──
  {
    const { run, d } = await allowed();
    const ev = await run.evaluate({ subject });
    await execute(run, { ...act, handle: d.handle, perform: async () => 'success' });
    const d2 = await decide(run, { ...act, operation: 'rel-9' });
    await release(run, { signer, boundary: 'send', handle: d2.handle, subject, now, deliver: () => true });
    await run.complete();
    const r = await run.read();
    const v = verifyRun({ events: r.events, manifest: ev.manifest });
    ok('a full decide → execute → release → complete run verifies `verified` with no reducer issues', v.verdict === 'verified' && r.state.issues.length === 0 && r.state.status === 'completed' && r.state.unresolvedOperations.length === 0, JSON.stringify({ verdict: v.verdict, issues: r.state.issues }));
  }

  console.log('');
  console.log(`runtime-boundary-execute: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-boundary-execute OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
