#!/usr/bin/env node
// runtime-core-envelope-reduce — the `maddu.runtime.v1` envelope, the pure
// reducer and the six-dimension verifier (docs/57-product-runtime-rfc.md
// §7.2–7.4, V03/V06/V07/V08, P2).
//
//   1. validateEnvelope: a well-formed event passes; each defect is reported
//      under its pinned code and path; app.* types are namespaced.
//   2. reduceRun: a clean run reduces to `completed`; a sequence gap →
//      `incomplete`; a broken prev, a replayed seq, an event after the terminal,
//      a foreign run or a double start → `invalid`; action lifecycle and
//      unresolved operations; identity drift is an issue, not a repair.
//   3. determinism: reduceRunCanonical is byte-stable across calls and across
//      a structurally identical copy with different key insertion order.
//   4. verifyRun: verdicts follow the fixed rule; every unsupplied input is
//      reported as not_supplied, never assumed; damage → limited; a manifest
//      gate missing or bound to another subject → invalid.
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
const codes = (v) => v.errors.map((e) => e.code).sort().join(',');
const issueCodes = (s) => s.issues.map((i) => i.code).sort().join(',');

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const { validateEnvelope, eventDigest, payloadDigest, subjectDigest, isTerminalType, reduceRun, reduceRunCanonical, verifyRun, manifestDigest, CONTRACT, EVENT_TYPES, TERMINAL_TYPES, PRODUCER_KINDS, canonicalEncode } = rt;
  const { APP_TYPE_RE, CHECK_RESULTS, OUTCOMES, DECISIONS, LIMITS, RUN_STATUS, DIMENSIONS, STATUSES, VERDICTS } = rt;

  // ── 0. public surface (maddu/runtime) — the vocabularies a consumer codes against ──
  ok('surface: APP_TYPE_RE accepts dotted lower-case and rejects the runtime family', APP_TYPE_RE.test('app.crm.lead_scored') && !APP_TYPE_RE.test('RUN_STARTED') && !APP_TYPE_RE.test('app.'));
  ok('surface: CHECK_RESULTS is the closed six-value set', Object.isFrozen(CHECK_RESULTS) && CHECK_RESULTS.join() === 'pass,fail,error,timeout,not_applicable,unknown');
  ok('surface: OUTCOMES names unknown and incomplete explicitly', Object.isFrozen(OUTCOMES) && OUTCOMES.join() === 'success,failure,unknown,incomplete');
  ok('surface: DECISIONS is allow|withhold|escalate', DECISIONS.join() === 'allow,withhold,escalate');
  ok('surface: LIMITS pins id/string/payload/causes bounds', LIMITS.id === 128 && LIMITS.string === 512 && LIMITS.payloadBytes === 64 * 1024 && LIMITS.causes === 64);
  ok('surface: RUN_STATUS is the closed reducer status set', Object.isFrozen(RUN_STATUS) && RUN_STATUS.join() === 'open,completed,failed,cancelled,incomplete,invalid');
  ok('surface: DIMENSIONS / STATUSES / VERDICTS are the verifier vocabulary', DIMENSIONS.join() === 'bytes,sequence,coverage,producer,witness,availability' && STATUSES.join() === 'pass,fail,not_supplied,limited' && VERDICTS.join() === 'verified,unverified,invalid');

  // Build a chained run deterministically (no clock: fixed ts).
  const SUBJECT = subjectDigest({ artifact: 'report-1', bytes: 'abc' });
  function chain(specs) {
    const out = [];
    let prev = null;
    specs.forEach((spec, i) => {
      const ev = {
        contract: CONTRACT, id: `ev-${i + 1}`, run: 'run-1', ts: '2026-09-21T00:00:00.000Z',
        tenant: 'tenant-a', product: 'prod-x', principal: 'user-1', agentVersion: '1.0.0',
        seq: i + 1, prev, producer: { kind: 'host', id: 'host-1' }, payload: {}, ...spec,
      };
      out.push(ev);
      prev = eventDigest(ev);
    });
    return out;
  }
  const base = () => chain([
    { type: 'RUN_STARTED', payload: { task: 'demo' } },
    { type: 'CHECK_FINISHED', producer: { kind: 'check', id: 'gate-runner' }, subjectDigest: SUBJECT, payload: { gateId: 'lint', result: 'pass' } },
    { type: 'ACTION_PROPOSED', operation: 'op-1', payload: { kind: 'send' } },
    { type: 'ACTION_DECIDED', operation: 'op-1', producer: { kind: 'policy', id: 'pol-1' }, payload: { decision: 'allow' } },
    { type: 'ACTION_STARTED', operation: 'op-1' },
    { type: 'ACTION_FINISHED', operation: 'op-1', payload: { outcome: 'success' } },
    { type: 'OUTPUT_DECIDED', subjectDigest: SUBJECT, payload: { decision: 'allow' } },
    { type: 'OUTPUT_DELIVERY_OBSERVED', subjectDigest: SUBJECT, payload: { channel: 'email' } },
    { type: 'RUN_COMPLETED', payload: { outcome: 'success' } },
  ]);

  // ── 1. envelope ──
  const good = base()[0];
  ok('a well-formed envelope validates', validateEnvelope(good).ok, JSON.stringify(validateEnvelope(good).errors));
  ok('EVENT_TYPES and TERMINAL_TYPES are frozen and terminal ⊂ types', Object.isFrozen(EVENT_TYPES) && TERMINAL_TYPES.every((t) => EVENT_TYPES.includes(t) && isTerminalType(t)) && !isTerminalType('RUN_STARTED'));
  ok('non-object → not_object', codes(validateEnvelope(null)) === 'not_object' && codes(validateEnvelope([])) === 'not_object');
  ok('wrong contract → contract', codes(validateEnvelope({ ...good, contract: 'other' })) === 'contract');
  ok('unknown key → unknown_key', codes(validateEnvelope({ ...good, extra: 1 })) === 'unknown_key');
  ok('missing tenant → missing', codes(validateEnvelope({ ...good, tenant: '' })) === 'missing');
  ok('bad id chars → bad_id', codes(validateEnvelope({ ...good, principal: 'has space' })) === 'bad_id');
  ok('unknown type → bad_type', codes(validateEnvelope({ ...good, type: 'SOMETHING' })) === 'bad_type');
  ok('app.* type is accepted', validateEnvelope({ ...good, type: 'app.crm.lead_scored' }).ok);
  ok('APP type must be lower-case dotted', codes(validateEnvelope({ ...good, type: 'app.Bad' })) === 'bad_type');
  ok('bad ts → bad_ts', codes(validateEnvelope({ ...good, ts: 'yesterday' })) === 'bad_ts');
  ok('seq 0 → bad_seq', codes(validateEnvelope({ ...good, seq: 0 })) === 'bad_seq');
  ok('seq 1 with prev → genesis_prev', codes(validateEnvelope({ ...good, prev: 'a'.repeat(64) })) === 'genesis_prev');
  ok('seq 2 with prev null → missing_prev', codes(validateEnvelope({ ...good, seq: 2 })) === 'missing_prev');
  ok('prev must be hex64 → bad_prev', codes(validateEnvelope({ ...good, seq: 2, prev: 'xyz' })) === 'bad_prev');
  ok('producer kind pinned → bad_producer_kind', codes(validateEnvelope({ ...good, producer: { kind: 'robot', id: 'r' } })) === 'bad_producer_kind' && PRODUCER_KINDS.includes('human'));
  ok('producer unknown key → unknown_key', codes(validateEnvelope({ ...good, producer: { kind: 'host', id: 'h', extra: 1 } })) === 'unknown_key');
  ok('payload must be an object → bad_payload', codes(validateEnvelope({ ...good, payload: [] })) === 'bad_payload');
  ok('payload with undefined → payload_undefined_value at path', (() => { const v = validateEnvelope({ ...good, payload: { a: { b: undefined } } }); return codes(v) === 'payload_undefined_value' && v.errors[0].path === '$.payload.a.b'; })());
  ok('payload over 64 KiB → payload_too_large', codes(validateEnvelope({ ...good, payload: { s: 'x'.repeat(65 * 1024) } })) === 'payload_too_large');
  ok('CHECK_FINISHED needs gateId, result and subjectDigest', codes(validateEnvelope({ ...good, type: 'CHECK_FINISHED', payload: {} })) === 'bad_check_result,missing_gate,missing_subject');
  ok('ACTION_* needs an operation', codes(validateEnvelope({ ...good, type: 'ACTION_STARTED' })) === 'missing_operation');
  ok('ACTION_DECIDED pins the decision vocabulary', codes(validateEnvelope({ ...good, type: 'ACTION_DECIDED', operation: 'o', payload: { decision: 'maybe' } })) === 'bad_decision');
  ok('OUTCOME_RECONCILED pins the outcome vocabulary', codes(validateEnvelope({ ...good, type: 'OUTCOME_RECONCILED', operation: 'o', payload: { outcome: 'meh' } })) === 'bad_outcome');
  ok('subjectDigest must be hex64 → bad_digest', codes(validateEnvelope({ ...good, subjectDigest: 'nope' })) === 'bad_digest');
  ok('causes must be ids → bad_causes', codes(validateEnvelope({ ...good, causes: ['ok', 'not ok'] })) === 'bad_causes');
  ok('eventDigest differs from payloadDigest of the same payload (domain separation)', eventDigest(good) !== payloadDigest(good.payload));
  ok('eventDigest changes when any field changes', eventDigest(good) !== eventDigest({ ...good, ts: '2026-09-21T00:00:01.000Z' }));

  // ── 2. reducer ──
  const clean = base();
  const st = reduceRun(clean);
  ok('clean run → completed, no issues', st.status === 'completed' && st.issues.length === 0, issueCodes(st));
  ok('head equals the last event digest', st.head === eventDigest(clean[clean.length - 1]) && st.lastSeq === 9);
  ok('identity captured from the first event', st.identity.tenant === 'tenant-a' && st.identity.field === null);
  ok('check recorded with subject and producer', st.checks.lint.result === 'pass' && st.checks.lint.subjectDigest === SUBJECT && st.checks.lint.producer === 'check');
  ok('action lifecycle ends finished/success', st.actions['op-1'].state === 'finished' && st.actions['op-1'].outcome === 'success' && st.unresolvedOperations.length === 0);
  ok('output decided then delivered', st.outputs.length === 1 && st.outputs[0].delivered === true);
  ok('terminal recorded', st.terminal.type === 'RUN_COMPLETED' && st.terminal.seq === 9 && st.terminal.outcome === 'success');
  ok('empty input → incomplete (not started)', reduceRun([]).status === 'incomplete' && reduceRun(undefined).status === 'incomplete');

  const gap = base().filter((e) => e.seq !== 3);
  const gs = reduceRun(gap);
  ok('a missing seq → sequence_gap + chain_broken, status invalid (prev cannot link)', gs.status === 'invalid' && /sequence_gap/.test(issueCodes(gs)) && /chain_broken/.test(issueCodes(gs)), issueCodes(gs));
  const truncated = base().slice(0, 5);
  ok('a run cut before its terminal → open', reduceRun(truncated).status === 'open' && reduceRun(truncated).unresolvedOperations.join() === 'op-1');
  const tampered = base(); tampered[1] = { ...tampered[1], payload: { gateId: 'lint', result: 'fail' } };
  const ts2 = reduceRun(tampered);
  ok('tampering one event breaks the next link → invalid', ts2.status === 'invalid' && ts2.issues.some((i) => i.code === 'chain_broken' && i.seq === 3), issueCodes(ts2));
  const replay = base(); replay.splice(3, 0, replay[2]);
  ok('a replayed event → sequence_replay → invalid', reduceRun(replay).status === 'invalid' && /sequence_replay/.test(issueCodes(reduceRun(replay))));
  const after = chain([{ type: 'RUN_STARTED' }, { type: 'RUN_COMPLETED', payload: { outcome: 'success' } }, { type: 'app.late' }]);
  ok('an event after the terminal → after_terminal → invalid', reduceRun(after).status === 'invalid' && /after_terminal/.test(issueCodes(reduceRun(after))));
  const dbl = chain([{ type: 'RUN_STARTED' }, { type: 'RUN_STARTED' }]);
  ok('RUN_STARTED twice → double_start → invalid', /double_start/.test(issueCodes(reduceRun(dbl))) && reduceRun(dbl).status === 'invalid');
  const foreign = base(); foreign[4] = { ...foreign[4], run: 'run-2' };
  ok('an event from another run → foreign_run → invalid', /foreign_run/.test(issueCodes(reduceRun(foreign))));
  const drift = base(); drift[4] = { ...drift[4], principal: 'user-2' };
  ok('identity drift is an issue (chain also breaks, so invalid)', /identity_drift/.test(issueCodes(reduceRun(drift))));
  const noAllow = chain([{ type: 'RUN_STARTED' }, { type: 'ACTION_STARTED', operation: 'op-9' }, { type: 'RUN_COMPLETED', payload: { outcome: 'success' } }]);
  const na = reduceRun(noAllow);
  ok('ACTION_STARTED without allow → action_without_allow, op stays unresolved, status still completed', na.status === 'completed' && /action_without_allow/.test(issueCodes(na)) && na.unresolvedOperations.join() === 'op-9');
  const unknownOutcome = chain([{ type: 'RUN_STARTED' }, { type: 'ACTION_PROPOSED', operation: 'o' }, { type: 'ACTION_DECIDED', operation: 'o', payload: { decision: 'allow' } }, { type: 'ACTION_STARTED', operation: 'o' }, { type: 'ACTION_FINISHED', operation: 'o', payload: { outcome: 'unknown' } }, { type: 'RUN_COMPLETED', payload: { outcome: 'success' } }]);
  ok('outcome unknown stays unresolved until reconciled', reduceRun(unknownOutcome).unresolvedOperations.join() === 'o');
  const reconciled = chain([...unknownOutcome.slice(0, 5).map((e) => (e.operation === undefined ? { type: e.type, payload: e.payload } : { type: e.type, operation: e.operation, payload: e.payload })),{ type: 'OUTCOME_RECONCILED', operation: 'o', payload: { outcome: 'failure' } }, { type: 'RUN_COMPLETED', payload: { outcome: 'success' } }]);
  const rs = reduceRun(reconciled);
  ok('OUTCOME_RECONCILED resolves it and keeps the prior outcome', rs.unresolvedOperations.length === 0 && rs.actions.o.state === 'reconciled' && rs.actions.o.outcome === 'failure' && rs.actions.o.priorOutcome === 'unknown');
  const orphanDelivery = chain([{ type: 'RUN_STARTED' }, { type: 'OUTPUT_DELIVERY_OBSERVED', subjectDigest: SUBJECT, payload: {} }]);
  ok('delivery without a decision is an issue', /delivery_without_decision/.test(issueCodes(reduceRun(orphanDelivery))));
  const approvals = chain([{ type: 'RUN_STARTED' }, { type: 'APPROVAL_REQUESTED', payload: { what: 'send' } }, { type: 'APPROVAL_DECIDED', producer: { kind: 'human', id: 'alice' }, payload: { requestId: 'ev-2', decision: 'allow' } }, { type: 'APPROVAL_DECIDED', producer: { kind: 'human', id: 'bob' }, payload: { requestId: 'ev-2', decision: 'withhold' } }, { type: 'APPROVAL_DECIDED', payload: { requestId: 'nope', decision: 'allow' } }]);
  const ap = reduceRun(approvals);
  ok('approval decided twice and orphan decision are issues', /duplicate_approval/.test(issueCodes(ap)) && /orphan_approval/.test(issueCodes(ap)) && ap.approvals['ev-2'].state === 'decided');

  // ── 3. determinism ──
  const a = reduceRunCanonical(base());
  const reordered = base().map((e) => { const o = {}; for (const k of Object.keys(e).sort().reverse()) o[k] = e[k]; return o; });
  ok('reduceRunCanonical is byte-stable', a === reduceRunCanonical(base()) && a === reduceRunCanonical(reordered));
  ok('canonical state re-encodes identically (no non-canonical values in state)', canonicalEncode(JSON.parse(a)) === a);

  // ── 4. verifier ──
  const manifest = { requiredGates: ['lint'], subjectDigest: SUBJECT };
  const v1 = verifyRun({ events: base(), manifest });
  ok('clean run + manifest → verified; producer and witness reported not_supplied', v1.verdict === 'verified' && v1.dimensions.producer.status === 'not_supplied' && v1.dimensions.witness.status === 'not_supplied' && v1.limits.map((l) => l.dimension).join() === 'producer,witness', JSON.stringify(v1.limits));
  const v2 = verifyRun({ events: base() });
  ok('no manifest → coverage not_supplied → unverified (never assumed)', v2.verdict === 'unverified' && v2.dimensions.coverage.status === 'not_supplied' && v2.manifestDigest === null);
  const v3 = verifyRun({ events: base(), manifest: { requiredGates: ['lint', 'security'] } });
  ok('a required gate with no CHECK_FINISHED → coverage fail → invalid', v3.verdict === 'invalid' && v3.dimensions.coverage.findings.some((f) => f.code === 'gate_missing' && f.gateId === 'security'));
  const v4 = verifyRun({ events: base(), manifest: { requiredGates: ['lint'], subjectDigest: subjectDigest({ other: true }) } });
  ok('a gate passed on a different subject → gate_subject_mismatch → invalid', v4.verdict === 'invalid' && v4.dimensions.coverage.findings[0].code === 'gate_subject_mismatch');
  const failedGate = base(); failedGate.splice(1, 1); const fg = chain([{ type: 'RUN_STARTED' }, { type: 'CHECK_FINISHED', subjectDigest: SUBJECT, payload: { gateId: 'lint', result: 'fail' } }, { type: 'RUN_COMPLETED', payload: { outcome: 'success' } }]);
  ok('a required gate that finished fail → gate_not_passed', verifyRun({ events: fg, manifest }).dimensions.coverage.findings[0].code === 'gate_not_passed');
  const v5 = verifyRun({ events: base(), manifest, damaged: { reason: 'torn_tail', readable: 9, error: 'final line has no newline' } });
  ok('damage → availability limited → unverified even when everything else passes', v5.verdict === 'unverified' && v5.dimensions.availability.status === 'limited');
  const v6 = verifyRun({ events: truncated, manifest });
  ok('an open run → sequence fail (not_terminated) → invalid', v6.verdict === 'invalid' && v6.dimensions.sequence.findings.some((f) => f.code === 'not_terminated'));
  const v7 = verifyRun({ events: tampered, manifest });
  ok('a tampered event → bytes fail → invalid', v7.verdict === 'invalid' && v7.dimensions.bytes.status === 'fail' && v7.dimensions.bytes.findings.some((f) => f.code === 'prev_mismatch'));
  const producers = [{ kind: 'host', id: 'host-1' }, { kind: 'check', id: 'gate-runner' }, { kind: 'policy', id: 'pol-1' }];
  ok('a supplied producer set that covers every producer → pass', verifyRun({ events: base(), manifest, producers }).dimensions.producer.status === 'pass' && verifyRun({ events: base(), manifest, producers }).verdict === 'verified');
  const v8 = verifyRun({ events: base(), manifest, producers: producers.slice(0, 1) });
  ok('an unauthorised producer → producer fail → invalid', v8.verdict === 'invalid' && v8.dimensions.producer.findings.some((f) => f.code === 'producer_unauthorised'));
  ok('a witness is reported unsupported, not verified', verifyRun({ events: base(), manifest, witness: { kind: 'tsa' } }).dimensions.witness.findings[0].code === 'witness_unsupported');
  ok('verifyRun with no input → invalid, not a throw', verifyRun().verdict === 'invalid');
  ok('manifestDigest is order-independent', manifestDigest({ requiredGates: ['b', 'a'] }) === manifestDigest({ requiredGates: ['a', 'b'], subjectDigest: null }) && manifestDigest({ requiredGates: ['a'] }) !== manifestDigest({ requiredGates: ['a'], subjectDigest: SUBJECT }));
  ok('verifyRun result is canonically encodable', typeof canonicalEncode(v1, { maxBytes: 1 << 20 }) === 'string');

  console.log('');
  console.log(`runtime-core-envelope-reduce: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-core-envelope-reduce OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
