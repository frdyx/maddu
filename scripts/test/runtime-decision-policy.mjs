#!/usr/bin/env node
// runtime-decision-policy — decision policy, approval binding and the signed
// single-use handle (docs/57-product-runtime-rfc.md ADR-005, §6.2 steps 5–6,
// V06 / V08 / V09 / V16, P4).
//
//   0. public surface (maddu/runtime): the P4 vocabulary and constructors.
//   1. policy: freezePolicy validates and freezes; per-boundary defaults;
//      digest changes with content. actionDigest binds operation, boundary,
//      parameters and resource version exactly.
//   2. signer + handle: hmacSigner needs ≥32 bytes; encode/verify round trip;
//      a flipped byte, a different key, a different signer id, an edited
//      field, a truncated token and a foreign shape are all refused with
//      nothing trusted (V09).
//   3. decide, enforced boundary: coverage is read from the run's evidence —
//      a caller cannot hand in pass; every non-pass result and a missing gate
//      withholds; a pass for a different subject withholds; the exact
//      ACTION_PROPOSED / ACTION_DECIDED pair is written once per operation;
//      re-deciding the same operation is refused; re-proposing it with
//      different parameters is a binding mismatch (V08); the handle binds
//      run, tenant, principal, operation, boundary, subject, action,
//      resource version, manifest, gate set, policy version and expiry.
//   4. decide, shadow boundary: `allow` with wouldDecide `withhold`,
//      enforced:false, reasons recorded — measured, not hidden.
//   5. approvals: escalate writes one APPROVAL_REQUESTED and no ACTION_DECIDED;
//      a second decide() while pending escalates again without a second
//      request; recordApproval by a human (producer human) once, refused
//      twice, refused after expiry, refused for an unknown request; approval
//      allow → decision allow; approval withhold → withhold; approval bound
//      to a different action digest → withhold; approval expired by the time
//      of decision → withhold (V09).
//   6. refusals: policy version mismatch, unknown boundary, gate outside the
//      set, malformed subject digest, damaged run — nothing written.
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
async function rejects(p) { try { await p; return null; } catch (e) { return e; } }
const HEX64 = /^[0-9a-f]{64}$/;

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const { HANDLE_VERSION, DEFAULT_TTL_MS, MAX_TTL_MS, APPROVAL_DECISIONS, RESERVED_TYPES, freezePolicy, actionDigest, hmacSigner, encodeHandle, verifyHandle, decide, recordApproval, GateRegistry, createRuntime, MemoryStore, LifecycleError, subjectDigest, manifestDigest, canonicalDecode, DOMAINS, digest } = rt;

  // ── 0. surface ──
  ok('surface: HANDLE_VERSION, TTL bounds and APPROVAL_DECISIONS are pinned', HANDLE_VERSION === 'maddu.runtime.decision.v1' && DEFAULT_TTL_MS === 300000 && MAX_TTL_MS === 86400000 && Object.isFrozen(APPROVAL_DECISIONS) && APPROVAL_DECISIONS.join() === 'allow,withhold');
  ok('surface: RESERVED_TYPES covers lifecycle, checks, actions, approvals, outputs and reconcile', Object.isFrozen(RESERVED_TYPES) && RESERVED_TYPES.length === 15 && ['RUN_STARTED', 'CHECK_FINISHED', 'ACTION_DECIDED', 'APPROVAL_DECIDED', 'OUTPUT_DECIDED', 'OUTCOME_RECONCILED'].every((t) => RESERVED_TYPES.includes(t)));

  // ── 1. policy + action digest ──
  const policy = freezePolicy({ version: 'pol-1', boundaries: { send: { enforced: true, requireApproval: true, ttlMs: 60000 }, draft: { enforced: false }, publish: { enforced: true } } });
  ok('freezePolicy freezes, defaults enforced/requireApproval false and ttl 5 min, and digests', Object.isFrozen(policy) && Object.isFrozen(policy.boundaries.draft) && policy.boundaries.draft.enforced === false && policy.boundaries.draft.requireApproval === false && policy.boundaries.draft.ttlMs === DEFAULT_TTL_MS && policy.boundaries.send.ttlMs === 60000 && HEX64.test(policy.digest));
  ok('policy digest changes with content', freezePolicy({ version: 'pol-1', boundaries: { send: { enforced: false } } }).digest !== policy.digest && freezePolicy({ version: 'pol-1', boundaries: { send: { enforced: true, requireApproval: true, ttlMs: 60000 }, draft: {}, publish: { enforced: true } } }).digest === policy.digest);
  for (const [name, p, code] of [['no version', { boundaries: {} }, 'bad_policy'], ['bad boundary name', { version: 'v', boundaries: { 'a b': {} } }, 'bad_policy'], ['unknown boundary key', { version: 'v', boundaries: { a: { mode: 'x' } } }, 'bad_policy'], ['ttl too large', { version: 'v', boundaries: { a: { ttlMs: MAX_TTL_MS + 1 } } }, 'bad_policy'], ['non-boolean enforced', { version: 'v', boundaries: { a: { enforced: 'yes' } } }, 'bad_policy'], ['unknown top key', { version: 'v', boundaries: {}, mode: 'shadow' }, 'bad_policy']]) {
    ok(`freezePolicy rejects ${name}`, thrown(() => freezePolicy(p))?.code === code);
  }
  const act = { operation: 'op-1', boundary: 'send', parameters: { to: 'a@example.invalid', body: 'hi' }, resourceVersion: 'lead:42@7' };
  const ad = actionDigest(act);
  ok('actionDigest is a sha256 over the ACTION domain of the exact binding', HEX64.test(ad) && ad === digest(DOMAINS.ACTION, { operation: 'op-1', boundary: 'send', parameters: act.parameters, resourceVersion: act.resourceVersion }));
  ok('actionDigest changes with any of operation, boundary, a parameter, or resource version', new Set([ad, actionDigest({ ...act, operation: 'op-2' }), actionDigest({ ...act, boundary: 'draft' }), actionDigest({ ...act, parameters: { ...act.parameters, body: 'hi!' } }), actionDigest({ ...act, resourceVersion: 'lead:42@8' })]).size === 5);
  ok('actionDigest treats absent parameters as {} and rejects undefined values / bad ids', actionDigest({ ...act, parameters: undefined }) === actionDigest({ ...act, parameters: {} }) && thrown(() => actionDigest({ ...act, parameters: { x: undefined } }))?.code === 'bad_action' && thrown(() => actionDigest({ ...act, operation: 'a b' }))?.code === 'bad_action' && thrown(() => actionDigest({ ...act, resourceVersion: '' }))?.code === 'bad_action');

  // ── 2. signer + handle ──
  const signer = hmacSigner({ id: 'policy-svc', key: 's'.repeat(32) });
  ok('hmacSigner needs a valid id and ≥32 key bytes', thrown(() => hmacSigner({ id: 'x', key: 'short' }))?.code === 'bad_signer' && thrown(() => hmacSigner({ id: 'a b', key: 's'.repeat(32) }))?.code === 'bad_signer' && hmacSigner({ id: 'k', key: Buffer.alloc(32, 1) }).id === 'k');
  const binding = { id: 'ev-9', run: 'r', tenant: 't', principal: 'u', operation: 'op-1', boundary: 'send', subjectDigest: 'a'.repeat(64), actionDigest: ad, resourceVersion: 'lead:42@7', manifestDigest: 'b'.repeat(64), gateSetDigest: 'c'.repeat(64), policyVersion: 'pol-1', enforced: true, expiresAt: '2026-09-21T00:05:00.000Z' };
  const token = encodeHandle(binding, signer);
  const back = verifyHandle(token, signer);
  ok('encode/verify round trip returns the frozen binding with version and signer', Object.isFrozen(back) && back.v === HANDLE_VERSION && back.signer === 'policy-svc' && back.operation === 'op-1' && back.actionDigest === ad && back.mac === undefined && /^[A-Za-z0-9_-]+$/.test(token));
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  const obj = canonicalDecode(raw);
  const forge = (mutate) => { const o = { ...obj }; mutate(o); return Buffer.from(JSON.stringify(o), 'utf8').toString('base64url'); };
  ok('an edited field → handle_forged (mac covers every field)', (await Promise.all(['operation', 'tenant', 'subjectDigest', 'actionDigest', 'resourceVersion', 'expiresAt', 'enforced', 'policyVersion'].map(async (k) => thrown(() => verifyHandle(forge((o) => { o[k] = k === 'enforced' ? false : k === 'expiresAt' ? '2099-01-01T00:00:00.000Z' : 'x'.repeat(k.endsWith('Digest') ? 64 : 3); }), signer))?.code))).every((c) => c === 'handle_forged'));
  ok('a flipped mac byte → handle_forged', thrown(() => verifyHandle(forge((o) => { o.mac = (o.mac[0] === '0' ? '1' : '0') + o.mac.slice(1); }), signer))?.code === 'handle_forged');
  ok('a different key → handle_forged; a different signer id → handle_forged', thrown(() => verifyHandle(token, hmacSigner({ id: 'policy-svc', key: 'z'.repeat(32) })))?.code === 'handle_forged' && thrown(() => verifyHandle(token, hmacSigner({ id: 'other', key: 's'.repeat(32) })))?.code === 'handle_forged');
  ok('a truncated token, garbage, an array and a foreign shape → bad_handle', thrown(() => verifyHandle(token.slice(0, -10), signer))?.code === 'bad_handle' && thrown(() => verifyHandle('!!!', signer))?.code === 'bad_handle' && thrown(() => verifyHandle(Buffer.from('[1]').toString('base64url'), signer))?.code === 'bad_handle' && thrown(() => verifyHandle(forge((o) => { o.extra = 1; }), signer))?.code === 'bad_handle' && thrown(() => verifyHandle('', signer))?.code === 'bad_handle');
  ok('a handle needs a signer that signs and verifies', thrown(() => encodeHandle(binding, { id: 'x' }))?.code === 'bad_signer' && thrown(() => verifyHandle(token, null))?.code === 'bad_signer');
  ok('the signer that returns a non-mac is refused at encode', thrown(() => encodeHandle(binding, { id: 'bad', sign: () => 'nope', verify: () => true }))?.code === 'bad_signer');

  // ── fixtures for decide ──
  const context = { tenant: 'acme', product: 'crm', principal: 'agent:writer', agentVersion: '2.1.0' };
  const makeRegistry = () => { const reg = new GateRegistry(); reg.register({ id: 'schema', version: '1', evidenceClass: 'deterministic', check: (s) => (s && typeof s.title === 'string' && s.title.length > 0 ? 'pass' : 'fail') }); reg.register({ id: 'tone', version: '1', evidenceClass: 'model_judged', check: (s) => (s.tone === 'throw' ? Promise.reject(new Error('down')) : 'pass') }); return reg.freeze(); };
  let clockMs = Date.parse('2026-09-21T00:00:00.000Z');
  const now = () => new Date(clockMs).toISOString();
  const ids = () => { let n = 0; return () => `ev-${String(++n).padStart(4, '0')}`; };
  const boot = (store = new MemoryStore()) => createRuntime({ store, gates: makeRegistry(), newId: ids(), now });
  const open = (runtime, extra = {}) => runtime.startRun({ run: 'run-1', context, idempotencyKey: 'key-1', requiredGates: ['schema', 'tone'], policyVersion: 'pol-1', ...extra });
  const subject = { title: 'Hello', tone: 'fine' };
  const sd = subjectDigest(subject);
  const base = { signer, policy, boundary: 'publish', operation: 'op-1', parameters: { doc: 7 }, resourceVersion: 'doc:7@3', subjectDigest: sd, now };

  // ── 3. enforced boundary ──
  {
    const run = await open(boot());
    const before = (await run.read()).events.length;
    const d0 = await decide(run, base);
    ok('enforced, no checks yet → withhold with gate_missing per required gate; no handle', d0.decision === 'withhold' && d0.enforced && d0.wouldDecide === 'withhold' && d0.handle === null && d0.reasons.map((r) => r.code).join() === 'gate_missing,gate_missing' && d0.expiresAt === null);
    const evs = (await run.read()).events;
    ok('exactly ACTION_PROPOSED then ACTION_DECIDED for the operation, bound and caused', evs.length === before + 2 && evs[before].type === 'ACTION_PROPOSED' && evs[before].operation === 'op-1' && evs[before].payload.actionDigest === actionDigest(base) && evs[before].subjectDigest === sd && evs[before + 1].type === 'ACTION_DECIDED' && evs[before + 1].causes.join() === evs[before].id && evs[before + 1].payload.decision === 'withhold' && evs[before + 1].payload.manifestDigest === manifestDigest({ requiredGates: ['schema', 'tone'], subjectDigest: sd }));
    ok('re-deciding the same operation → already_decided, nothing written', (await rejects(decide(run, base)))?.code === 'already_decided' && (await run.read()).events.length === before + 2);
    ok('re-proposing the operation with different parameters → binding_mismatch (V08)', (await rejects(decide(run, { ...base, parameters: { doc: 8 } })))?.code === 'binding_mismatch');
  }
  {
    const run = await open(boot());
    const ev = await run.evaluate({ subject });
    ok('fixture: both gates pass for the subject', ev.passed);
    const d = await decide(run, base);
    ok('enforced, all required gates recorded pass for this subject → allow with a handle', d.decision === 'allow' && d.wouldDecide === 'allow' && d.reasons.length === 0 && typeof d.handle === 'string' && d.expiresAt === '2026-09-21T00:05:00.000Z' && d.decisionId && d.approvalRequest === null);
    const h = verifyHandle(d.handle, signer);
    ok('the handle binds run, tenant, principal, operation, boundary, subject, action, resource version, manifest, gate set, policy and expiry', h.id === d.decisionId && h.run === 'run-1' && h.tenant === 'acme' && h.principal === 'agent:writer' && h.operation === 'op-1' && h.boundary === 'publish' && h.subjectDigest === sd && h.actionDigest === actionDigest(base) && h.resourceVersion === 'doc:7@3' && h.manifestDigest === ev.manifestDigest && h.gateSetDigest === run.gateSet.digest && h.policyVersion === 'pol-1' && h.enforced === true && h.expiresAt === d.expiresAt);
    const d2 = await decide(run, { ...base, operation: 'op-2', subjectDigest: subjectDigest({ ...subject, title: 'Hello!' }) });
    ok('a pass recorded for a different subject does not cover a new subject → withhold gate_subject_mismatch (V08)', d2.decision === 'withhold' && d2.reasons.length === 2 && d2.reasons.every((r) => r.code === 'gate_subject_mismatch'), JSON.stringify(d2.reasons));
    const d3 = await decide(run, { ...base, operation: 'op-3', gateIds: ['schema'] });
    ok('a subset of the gate set can be required; the manifest names it', d3.decision === 'allow' && verifyHandle(d3.handle, signer).manifestDigest === manifestDigest({ requiredGates: ['schema'], subjectDigest: sd }));
  }
  {
    const run = await open(boot());
    await run.evaluate({ subject: { title: 'x', tone: 'throw' } });
    const d = await decide(run, { ...base, subjectDigest: subjectDigest({ title: 'x', tone: 'throw' }) });
    ok('a gate that errored is non-passing → withhold naming the gate and result (V06/V07)', d.decision === 'withhold' && d.reasons.length === 1 && d.reasons[0].code === 'gate_not_passed' && d.reasons[0].gate === 'tone' && d.reasons[0].result === 'error');
  }
  {
    // A caller cannot smuggle a pass: decide reads the store, and only run.evaluate writes CHECK_FINISHED.
    const run = await open(boot());
    const e = await rejects(run.record('CHECK_FINISHED', { gateId: 'schema', result: 'pass' }, { subjectDigest: sd }));
    const d = await decide(run, { ...base, evaluation: { passed: true, results: { schema: { result: 'pass' }, tone: { result: 'pass' } } } });
    ok('a caller-supplied pass is never sufficient: record() refuses CHECK_FINISHED and decide() ignores an evaluation object', e?.code === 'reserved_type' && d.decision === 'withhold');
  }

  // ── 4. shadow boundary ──
  {
    const run = await open(boot());
    const d = await decide(run, { ...base, boundary: 'draft' });
    const dec = (await run.read()).events.find((e) => e.type === 'ACTION_DECIDED');
    ok('shadow: decision allow, wouldDecide withhold, enforced false, reasons recorded in the event', d.decision === 'allow' && d.wouldDecide === 'withhold' && d.enforced === false && d.handle !== null && dec.payload.enforced === false && dec.payload.wouldDecide === 'withhold' && dec.payload.reasons.length === 2 && verifyHandle(d.handle, signer).enforced === false);
  }

  // ── 5. approvals ──
  {
    const run = await open(boot());
    await run.evaluate({ subject });
    const b = { ...base, boundary: 'send' };
    const before = (await run.read()).events.length;
    const d1 = await decide(run, b);
    const evs1 = (await run.read()).events;
    ok('requireApproval → escalate, one APPROVAL_REQUESTED bound to the action, no ACTION_DECIDED', d1.decision === 'escalate' && d1.handle === null && typeof d1.approvalRequest === 'string' && evs1.length === before + 2 && evs1.at(-1).type === 'APPROVAL_REQUESTED' && evs1.at(-1).id === d1.approvalRequest && evs1.at(-1).operation === 'op-1' && evs1.at(-1).payload.actionDigest === actionDigest(b) && evs1.at(-1).payload.expiresAt === '2026-09-21T00:01:00.000Z' && evs1.at(-1).payload.coverage === 'passed' && !evs1.some((e) => e.type === 'ACTION_DECIDED'));
    const d2 = await decide(run, b);
    ok('deciding again while pending → escalate again, no second request', d2.decision === 'escalate' && d2.approvalRequest === d1.approvalRequest && (await run.read()).events.length === before + 2);
    ok('recordApproval validates request, approver and decision', (await rejects(recordApproval(run, { requestId: 'nope', approver: 'alice', decision: 'allow', now })))?.code === 'approval_not_found' && (await rejects(recordApproval(run, { requestId: d1.approvalRequest, approver: 'a b', decision: 'allow', now })))?.code === 'bad_approval' && (await rejects(recordApproval(run, { requestId: d1.approvalRequest, approver: 'alice', decision: 'maybe', now })))?.code === 'bad_approval');
    const a = await recordApproval(run, { requestId: d1.approvalRequest, approver: 'alice', decision: 'allow', reason: 'looks fine', now });
    const dec = (await run.read()).events.find((e) => e.id === a.id);
    ok('APPROVAL_DECIDED is written by producer human with requestId, caused by the request, bound to the action', dec.type === 'APPROVAL_DECIDED' && dec.producer.kind === 'human' && dec.producer.id === 'alice' && dec.payload.requestId === d1.approvalRequest && dec.payload.actionDigest === actionDigest(b) && dec.causes.join() === d1.approvalRequest && dec.operation === 'op-1');
    ok('a second approval decision for the same request → approval_decided', (await rejects(recordApproval(run, { requestId: d1.approvalRequest, approver: 'bob', decision: 'withhold', now })))?.code === 'approval_decided');
    const d3 = await decide(run, b);
    const final = (await run.read()).events.find((e) => e.type === 'ACTION_DECIDED');
    ok('after approval allow → decision allow with a handle; ACTION_DECIDED cites the request and the human decision', d3.decision === 'allow' && d3.approvalRequest === d1.approvalRequest && typeof d3.handle === 'string' && final.payload.approval === d1.approvalRequest && final.causes.length === 2 && final.causes.includes(a.id));
    const st = (await run.read()).state;
    ok('the reducer sees the approval requested→decided and the action decided allow', st.approvals[d1.approvalRequest].state === 'decided' && st.approvals[d1.approvalRequest].decision === 'allow' && st.actions['op-1'].state === 'decided' && st.actions['op-1'].decision === 'allow' && st.issues.length === 0);
  }
  {
    const run = await open(boot());
    await run.evaluate({ subject });
    const b = { ...base, boundary: 'send' };
    const d1 = await decide(run, b);
    await recordApproval(run, { requestId: d1.approvalRequest, approver: 'alice', decision: 'withhold', reason: 'no', now });
    const d = await decide(run, b);
    ok('approval withheld → withhold naming the approver (V09)', d.decision === 'withhold' && d.handle === null && d.reasons.some((r) => r.code === 'approval_withheld' && r.by === 'alice'));
  }
  {
    const run = await open(boot());
    await run.evaluate({ subject });
    const b = { ...base, boundary: 'send' };
    const d1 = await decide(run, b);
    clockMs += 61000;
    ok('recordApproval after the request expired → approval_expired', (await rejects(recordApproval(run, { requestId: d1.approvalRequest, approver: 'alice', decision: 'allow', now })))?.code === 'approval_expired');
    clockMs -= 61000;
    await recordApproval(run, { requestId: d1.approvalRequest, approver: 'alice', decision: 'allow', now });
    clockMs += 61000;
    const d = await decide(run, b);
    ok('an approval that expired before the decision → withhold approval_expired (V09)', d.decision === 'withhold' && d.reasons.some((r) => r.code === 'approval_expired'));
    clockMs -= 61000;
  }
  {
    const run = await open(boot());
    await run.evaluate({ subject });
    const b = { ...base, boundary: 'send' };
    const d1 = await decide(run, b);
    await recordApproval(run, { requestId: d1.approvalRequest, approver: 'alice', decision: 'allow', now });
    ok('the approval cannot be re-pointed at changed parameters → binding_mismatch on the proposal', (await rejects(decide(run, { ...b, parameters: { doc: 99 } })))?.code === 'binding_mismatch');
  }

  // ── 6. refusals ──
  {
    const run = await open(boot());
    await run.evaluate({ subject });
    const n0 = (await run.read()).events.length;
    ok('policy version mismatch → policy_mismatch', (await rejects(decide(run, { ...base, policy: freezePolicy({ version: 'pol-2', boundaries: { publish: { enforced: true } } }) })))?.code === 'policy_mismatch');
    ok('unknown boundary → unknown_boundary', (await rejects(decide(run, { ...base, boundary: 'delete' })))?.code === 'unknown_boundary');
    ok('gate outside the frozen set → gate_not_in_set', (await rejects(decide(run, { ...base, gateIds: ['ghost'] })))?.code === 'gate_not_in_set');
    ok('malformed subject digest → bad_subject; unfrozen policy → bad_policy; bad signer → bad_signer; no now → missing_host_fn', (await rejects(decide(run, { ...base, subjectDigest: 'abc' })))?.code === 'bad_subject' && (await rejects(decide(run, { ...base, policy: { version: 'pol-1', boundaries: {} } })))?.code === 'bad_policy' && (await rejects(decide(run, { ...base, signer: {} })))?.code === 'bad_signer' && (await rejects(decide(run, { ...base, now: undefined })))?.code === 'missing_host_fn');
    ok('a run opened without a policy version cannot be decided', (await rejects(decide(await open(boot(), { run: 'run-np', policyVersion: undefined }), base)))?.code === 'policy_mismatch');
    ok('refusals write nothing', (await run.read()).events.length === n0);
    ok('decide() takes a Run', (await rejects(decide({}, base)))?.code === 'bad_run' && (await rejects(decide({}, base))) instanceof LifecycleError);
  }

  console.log('');
  console.log(`runtime-decision-policy: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-decision-policy OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
