#!/usr/bin/env node
// runtime-lifecycle-checks — the gate registry, the bounded check runner and
// the frozen gate set / manifest binding (docs/57-product-runtime-rfc.md §7.3,
// V06 / V07 / V08, P3).
//
//   0. public surface (maddu/runtime): the P3 vocabulary and constructors.
//   1. registry: validation, duplicate id, frozen registry, implementation
//      digest from source (same declaration + same source → same digest; a
//      changed body or version → a different digest), explicit digest for an
//      opaque (bound/native) function, undigestable otherwise.
//   2. runGate can never produce `pass` unless the check returned 'pass':
//      throw (sync and async) → error/threw; timeout → timeout; undefined,
//      true, 'PASS', 'ok', {result:'pass '} → error/bad_result; a check that
//      returns 'error'/'unknown' itself → error/bad_result; not_applicable
//      without permission → error; with permission → not_applicable; a late
//      result after a timeout is ignored; cancellation → unknown/cancelled and
//      the check sees an aborted signal; oversized subject → error before the
//      check runs; a non-canonical subject → error/bad_subject.
//   3. gate set + manifest: freezeGateSet fails closed on an unregistered id;
//      the digest is order-independent and changes with any implementation
//      digest; bindManifest's manifestDigest equals verify.mjs's for the same
//      {requiredGates, subjectDigest} and differs for a modified subject (V08);
//      a gate outside the set is refused.
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
function thrown(fn) { try { fn(); return null; } catch (e) { return e; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEX64 = /^[0-9a-f]{64}$/;

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const { EVIDENCE_CLASSES, DEFAULT_BOUND, MAX_TIMEOUT_MS, LifecycleError, GateRegistry, implementationDigest, runGate, isPass, gateSetDigest, freezeGateSet, bindManifest, manifestDigest, subjectDigest, DOMAINS, CHECK_RESULTS } = rt;

  // ── 0. public surface ──
  ok('surface: EVIDENCE_CLASSES labels deterministic, model-judged and human review differently', Object.isFrozen(EVIDENCE_CLASSES) && EVIDENCE_CLASSES.join() === 'deterministic,model_judged,human_review');
  ok('surface: DEFAULT_BOUND is 5 s and 64 KiB; MAX_TIMEOUT_MS is 10 min', Object.isFrozen(DEFAULT_BOUND) && DEFAULT_BOUND.timeoutMs === 5000 && DEFAULT_BOUND.maxSubjectBytes === 64 * 1024 && MAX_TIMEOUT_MS === 600000);
  ok('surface: LifecycleError carries code and detail', (() => { const e = new LifecycleError('x', 'm', { a: 1 }); return e.name === 'LifecycleError' && e.code === 'x' && e.message === 'm' && e.detail.a === 1 && e instanceof Error; })());
  ok('surface: DOMAINS gained GATE and GATE_SET (P3) and ACTION and DECISION (P4), namespaced, all existing domains unchanged', DOMAINS.GATE === 'maddu.runtime.v1/gate' && DOMAINS.GATE_SET === 'maddu.runtime.v1/gate_set' && DOMAINS.ACTION === 'maddu.runtime.v1/action' && DOMAINS.DECISION === 'maddu.runtime.v1/decision' && DOMAINS.EVENT === 'maddu.runtime.v1/event' && DOMAINS.MANIFEST === 'maddu.runtime.v1/manifest' && Object.keys(DOMAINS).length === 9);
  ok('surface: isPass accepts only result pass', isPass({ result: 'pass' }) && !isPass({ result: 'PASS' }) && !isPass({ result: 'fail' }) && !isPass(null) && !isPass('pass'));

  // ── 1. registry ──
  const reg = new GateRegistry();
  const base = { id: 'schema', version: '1.0', evidenceClass: 'deterministic', check: (s) => (s && typeof s.title === 'string' ? 'pass' : 'fail') };
  const g1 = reg.register(base);
  ok('register returns a frozen gate with a sha256 implementation digest and the default bound', Object.isFrozen(g1) && HEX64.test(g1.implementationDigest) && g1.bound.timeoutMs === 5000 && g1.bound.maxSubjectBytes === 65536 && g1.allowNotApplicable === false);
  ok('the digest is reproducible from the declaration and source', implementationDigest({ id: g1.id, version: g1.version, evidenceClass: g1.evidenceClass, bound: g1.bound, allowNotApplicable: false }, base.check.toString()) === g1.implementationDigest);
  const other = new GateRegistry();
  ok('same declaration + same source in another registry → same digest', other.register({ ...base }).implementationDigest === g1.implementationDigest);
  const changedBody = new GateRegistry().register({ ...base, check: (s) => (s ? 'pass' : 'fail') });
  const changedVersion = new GateRegistry().register({ ...base, version: '1.1' });
  const changedBound = new GateRegistry().register({ ...base, bound: { timeoutMs: 10 } });
  ok('a changed body, version or bound under the same id → different digests (V06 detectable)', new Set([g1.implementationDigest, changedBody.implementationDigest, changedVersion.implementationDigest, changedBound.implementationDigest]).size === 4);
  ok('duplicate id → duplicate_gate', thrown(() => reg.register(base))?.code === 'duplicate_gate');
  for (const [name, spec, code] of [
    ['bad id', { ...base, id: 'has space' }, 'bad_gate'],
    ['missing version', { ...base, id: 'v', version: '' }, 'bad_gate'],
    ['unknown evidence class', { ...base, id: 'e', evidenceClass: 'llm' }, 'bad_gate'],
    ['check not a function', { ...base, id: 'c', check: 'pass' }, 'bad_gate'],
    ['timeout out of range', { ...base, id: 't', bound: { timeoutMs: 0 } }, 'bad_bound'],
    ['timeout above max', { ...base, id: 't2', bound: { timeoutMs: MAX_TIMEOUT_MS + 1 } }, 'bad_bound'],
    ['unknown bound key', { ...base, id: 'b', bound: { memoryMb: 1 } }, 'bad_bound'],
    ['unknown spec key', { ...base, id: 'k', scope: 'x' }, 'bad_gate'],
    ['bad explicit digest', { ...base, id: 'd', implementationDigest: 'abc' }, 'bad_gate'],
  ]) ok(`reject: ${name} → ${code}`, thrown(() => reg.register(spec))?.code === code, thrown(() => reg.register(spec))?.code);
  const boundFn = base.check.bind(null);
  ok('a bound function is undigestable without an explicit digest', thrown(() => reg.register({ ...base, id: 'bound', check: boundFn }))?.code === 'undigestable_implementation');
  const explicit = 'a'.repeat(64);
  ok('an explicit implementation digest is accepted for an opaque check', reg.register({ ...base, id: 'bound', check: boundFn, implementationDigest: explicit }).implementationDigest === explicit);
  reg.register({ id: 'aaa', version: '1', evidenceClass: 'human_review', check: () => 'pass' });
  ok('list() is sorted by id; get/has work; size counts', reg.list().map((g) => g.id).join() === 'aaa,bound,schema' && reg.has('schema') && reg.get('schema') === g1 && reg.get('nope') === null && reg.size === 3);
  reg.freeze();
  ok('a frozen registry refuses registration', reg.frozen && thrown(() => reg.register({ ...base, id: 'late' }))?.code === 'registry_frozen');

  // ── 2. runGate ──
  const mk = (check, extra = {}) => new GateRegistry().register({ id: 'g', version: '1', evidenceClass: 'deterministic', check, ...extra });
  const sub = { title: 'ok' };
  ok('pass only when the check returns pass', (await runGate(mk(() => 'pass'), sub)).result === 'pass' && (await runGate(mk(async () => 'pass'), sub)).result === 'pass');
  ok('fail with a reason is carried (clipped to 512)', await runGate(mk(() => ({ result: 'fail', reason: 'x'.repeat(600) })), sub).then((r) => r.result === 'fail' && r.reason.length === 512));
  const threwSync = await runGate(mk(() => { throw new TypeError('boom'); }), sub);
  const threwAsync = await runGate(mk(async () => { throw new Error('later'); }), sub);
  ok('a throwing check → error/threw with name and message, sync and async (V07)', threwSync.result === 'error' && threwSync.reason === 'threw' && threwSync.detail.name === 'TypeError' && threwSync.detail.message === 'boom' && threwAsync.result === 'error' && threwAsync.detail.message === 'later');
  ok('a rejecting non-Error → error/threw', await runGate(mk(() => Promise.reject('nope')), sub).then((r) => r.result === 'error' && r.detail.message === 'nope'));
  for (const [name, v] of [['undefined', undefined], ['true', true], ['1', 1], ['PASS', 'PASS'], ['ok', 'ok'], ['pass with space', 'pass '], ['{result:true}', { result: true }], ['array', ['pass']], ['null', null]]) {
    const r = await runGate(mk(() => v), sub);
    ok(`a check returning ${name} → error/bad_result, never pass`, r.result === 'error' && r.reason === 'bad_result', JSON.stringify(r));
  }
  for (const self of ['error', 'timeout', 'unknown']) {
    ok(`a check may not assign ${self} to itself → error/bad_result`, await runGate(mk(() => self), sub).then((r) => r.result === 'error' && r.reason === 'bad_result'));
  }
  ok('not_applicable without permission → error/not_applicable_not_permitted', await runGate(mk(() => ({ result: 'not_applicable', reason: 'scope' })), sub).then((r) => r.result === 'error' && r.reason === 'not_applicable_not_permitted' && r.detail.checkReason === 'scope'));
  ok('not_applicable with allowNotApplicable → not_applicable', await runGate(mk(() => 'not_applicable', { allowNotApplicable: true }), sub).then((r) => r.result === 'not_applicable'));
  let lateResolved = null;
  const slow = mk((s, ctx) => new Promise((resolve) => { setTimeout(() => { lateResolved = ctx.signal.aborted; resolve('pass'); }, 60); }), { bound: { timeoutMs: 15 } });
  const t0 = await runGate(slow, sub);
  ok('a check over its bound → timeout with the bound named (V07)', t0.result === 'timeout' && t0.reason === 'timeout' && t0.detail.timeoutMs === 15);
  await sleep(80);
  ok('the late pass is ignored and the check saw an aborted signal', lateResolved === true && t0.result === 'timeout');
  const ac = new AbortController();
  let sawAbort = false;
  const cancellable = mk((s, ctx) => new Promise((resolve) => { ctx.signal.addEventListener('abort', () => { sawAbort = true; }); setTimeout(() => resolve('pass'), 100); }), { bound: { timeoutMs: 1000 } });
  const pending = runGate(cancellable, sub, { signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  const c0 = await pending;
  ok('cancellation via the caller signal → unknown/cancelled and the check is told', c0.result === 'unknown' && c0.reason === 'cancelled' && sawAbort);
  ok('an already-aborted signal → unknown/cancelled without running the check', await runGate(mk(() => { throw new Error('ran'); }), sub, { signal: AbortSignal.abort() }).then((r) => r.result === 'unknown' && r.reason === 'cancelled'));
  let ran = false;
  const big = await runGate(mk(() => { ran = true; return 'pass'; }, { bound: { maxSubjectBytes: 32 } }), { text: 'y'.repeat(100) });
  ok('an oversized subject → error/subject_too_large and the check never runs', big.result === 'error' && big.reason === 'subject_too_large' && big.detail.maxSubjectBytes === 32 && !ran);
  ok('a non-canonical subject → error/bad_subject', await runGate(mk(() => 'pass'), { a: undefined }).then((r) => r.result === 'error' && r.reason === 'bad_subject' && r.detail.code === 'undefined_value'));
  ok('the check receives gateId/version/subjectDigest/signal and nothing else', await runGate(mk((s, ctx) => (Object.keys(ctx).sort().join() === 'gateId,signal,subjectDigest,version' && ctx.subjectDigest === 'ab'.repeat(32) && Object.isFrozen(ctx) ? 'pass' : 'fail')), sub, { subjectDigest: 'ab'.repeat(32) }).then((r) => r.result === 'pass'));
  ok('a bad gate object → error/bad_gate', (await runGate(null, sub)).result === 'error' && (await runGate({}, sub)).reason === 'bad_gate');
  ok('every runGate result is in CHECK_RESULTS', [threwSync, threwAsync, t0, c0, big].every((r) => CHECK_RESULTS.includes(r.result)));

  // ── 3. gate set + manifest ──
  const set = freezeGateSet(reg, ['schema', 'aaa', 'schema']);
  ok('freezeGateSet dedups and sorts ids, freezes gates with their digests', Object.isFrozen(set) && set.requiredGates.join() === 'aaa,schema' && set.gates.length === 2 && set.gates[1].implementationDigest === g1.implementationDigest && HEX64.test(set.digest));
  ok('freezeGateSet fails closed on an unregistered id (V06)', thrown(() => freezeGateSet(reg, ['schema', 'ghost']))?.code === 'gate_unregistered');
  ok('freezeGateSet rejects an empty set and a bad registry', thrown(() => freezeGateSet(reg, []))?.code === 'bad_gate_set' && thrown(() => freezeGateSet({}, ['schema']))?.code === 'bad_registry');
  ok('gateSetDigest is order-independent', gateSetDigest([...set.gates].reverse()) === set.digest);
  ok('gateSetDigest changes with any implementation digest', gateSetDigest([set.gates[0], { ...set.gates[1], implementationDigest: changedBody.implementationDigest }]) !== set.digest);
  ok('gateSetDigest rejects a duplicate id and a missing digest', thrown(() => gateSetDigest([set.gates[0], set.gates[0]]))?.code === 'bad_gate_set' && thrown(() => gateSetDigest([{ id: 'x', version: '1', evidenceClass: 'deterministic' }]))?.code === 'bad_gate_set');
  const m = bindManifest(set, sub);
  ok('bindManifest digests the subject and reuses verify.mjs manifestDigest bytes', m.subjectDigest === subjectDigest(sub) && m.manifestDigest === manifestDigest({ requiredGates: ['aaa', 'schema'], subjectDigest: m.subjectDigest }) && m.gateSetDigest === set.digest);
  ok('bindManifest accepts a precomputed subject digest', bindManifest(set, m.subjectDigest).manifestDigest === m.manifestDigest);
  ok('a modified subject binds to a different manifest (V08)', bindManifest(set, { title: 'ok ' }).manifestDigest !== m.manifestDigest);
  ok('a subset of the gate set is allowed; a gate outside it is refused', bindManifest(set, sub, ['schema']).requiredGates.join() === 'schema' && thrown(() => bindManifest(set, sub, ['ghost']))?.code === 'gate_not_in_set');
  ok('a non-canonical subject → bad_subject', thrown(() => bindManifest(set, { a: undefined }))?.code === 'bad_subject');
  ok('a hand-made gate set is refused', thrown(() => bindManifest({ requiredGates: ['schema'] }, sub))?.code === 'bad_gate_set');

  console.log('');
  console.log(`runtime-lifecycle-checks: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-lifecycle-checks OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
