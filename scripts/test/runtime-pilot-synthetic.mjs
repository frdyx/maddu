#!/usr/bin/env node
// runtime-pilot-synthetic — the standalone synthetic pilot end to end
// (docs/57-product-runtime-rfc.md §11, §12 row P5, V11 / V13 / V14 / V15).
//
// One AI-draft workflow — a summary of a synthetic document for human
// review — against the public maddu/runtime surface with a synthetic
// tenant, a scripted model client, in-memory side effects and a FileStore
// in a disposable directory. Everything simulated is labelled simulated.
//
//   A. Happy path: trusted host context precedes runtime init → context
//      referenced → model call observed (references only) → three gates →
//      shadow draft decision → enforced release escalates → streaming
//      refused before the decision (V13) → human approval → release
//      delivers the exact artifact → CRM side effect crashes after the
//      effect (V11) → retry refused → reconciled from CRM state → complete
//      → verifier verified → receipt exports without redaction, verifies,
//      survives a JSON round trip → a fresh store instance reads the same
//      run → baseline measurements pinned.
//   B. Would-block path: the model echoes the hostile line, an e-mail and an
//      invented claim → no-pii and faithfulness fail → shadow draft allow
//      with wouldDecide withhold → enforced release escalates (the request
//      records coverage not_passed) → a human approves anyway → the decision
//      is still withhold: approval never overrides a failing required gate;
//      no handle, nothing delivered → identity unchanged on every event
//      (V14) → the receipt still exports clean: the e-mail never entered the
//      evidence (the gate reports shape names only) (V15).
//   C. Provider outage: MODEL_CALL_FINISHED failure with the key in the
//      error message minimized (V15); the run fails with outcome
//      incomplete; the receipt says so.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, rm, readFile } from 'node:fs/promises';
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

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const host = await import(pathToFileURL(path.join(__dirname, '__fixtures__', 'runtime-pilot-host.mjs')).href);
  const { createRuntime, FileStore, hmacSigner, referenceContext, observeModelCall, decide, recordApproval, release, execute, reconcile, unresolvedOperations, verifyRun, exportReceipt, verifyReceipt, measureRun, subjectDigest, canonicalEncode } = rt;
  const { SIMULATION_NOTICE, SYNTHETIC_DOCUMENT, PILOT_CONTEXT, createFakeModelClient, createCrm, createOutbox, pilotGates, pilotPolicy } = host;

  ok('the fixture labels itself simulated', /SIMULATED/.test(SIMULATION_NOTICE) && /simulated/.test(PILOT_CONTEXT.product) && /synthetic/.test(PILOT_CONTEXT.agentVersion));

  let clockMs = Date.parse('2026-09-21T09:00:00.000Z');
  const now = () => new Date(clockMs).toISOString();
  const tick = (ms) => { clockMs += ms; };
  const ids = (prefix) => { let n = 0; return () => `${prefix}-${String(++n).padStart(4, '0')}`; };
  const signer = hmacSigner({ id: 'pilot-policy-service', key: 'synthetic-pilot-signing-key-0123456789' });
  const policy = pilotPolicy();
  const gates = pilotGates();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-pilot-'));
  const bodyMarker = 'finished the quarterly review with revenue up';

  try {
    // ── A. happy path ──
    {
      const store = new FileStore(path.join(tmp, 'evidence'));
      // 1. trusted host context precedes runtime init; the model cannot pick it.
      const context = PILOT_CONTEXT;
      const runtime = createRuntime({ store, gates, newId: ids('a'), now, producer: { kind: 'host', id: 'pilot-host' } });
      const run = await runtime.startRun({ run: 'pilot:run:a', context, idempotencyKey: 'pilot-a-1', requiredGates: ['schema', 'no-pii', 'faithfulness'], policyVersion: policy.version, task: 'summarize' });
      ok('A1: run opens under the host context and the frozen gate set', run.identity.tenant === 'acme' && run.gateSet.requiredGates.join() === 'faithfulness,no-pii,schema' && run.policyVersion === 'pilot-pol-1');
      // 2. context selection: references only.
      await referenceContext(run, { references: [{ kind: 'document', ref: SYNTHETIC_DOCUMENT.id, digest: subjectDigest(SYNTHETIC_DOCUMENT.body), bytes: Buffer.byteLength(SYNTHETIC_DOCUMENT.body) }] });
      // 3. the model call, observed by the host.
      const model = createFakeModelClient({ mode: 'good' });
      const mc = await observeModelCall(run, { metadata: { provider: 'synthetic', model: 'fake-summarizer-1', purpose: 'summary' }, invoke: () => model.generateSummary({ document: SYNTHETIC_DOCUMENT }), timeoutMs: 1000 });
      ok('A2: the model call is observed with outcome success and a digest; the host keeps the draft', mc.outcome === 'success' && mc.recorded && typeof mc.output.summary === 'string' && mc.outputDigest === subjectDigest(mc.output) && model.calls.length === 1);
      const text0 = canonicalEncode((await run.read()).events);
      ok('A3: neither the document body nor the summary text is in the evidence (references only)', !text0.includes(bodyMarker) && !text0.includes('SYSTEM NOTE') && !text0.includes(mc.output.summary.slice(0, 30)));
      // 4. gates.
      const ev = await run.evaluate({ subject: mc.output });
      ok('A4: all three gates pass for the exact draft; deterministic and model-judged are labelled apart', ev.passed && ev.subjectDigest === mc.outputDigest && (await run.read()).events.filter((e) => e.type === 'CHECK_FINISHED').map((e) => e.payload.evidenceClass).sort().join() === 'deterministic,deterministic,model_judged');
      // 5. shadow draft decision.
      const dDraft = await decide(run, { signer, policy, boundary: 'draft', operation: 'draft-1', parameters: { kind: 'summary' }, resourceVersion: `draft@${mc.outputDigest.slice(0, 8)}`, subjectDigest: ev.subjectDigest, now });
      ok('A5: the shadow draft boundary decides allow with wouldDecide allow and enforced false', dDraft.decision === 'allow' && dDraft.wouldDecide === 'allow' && dDraft.enforced === false);
      // 6. enforced release: escalate; streaming is refused before the decision (V13).
      const outbox = createOutbox();
      const relArgs = { signer, policy, boundary: 'release', operation: 'release-1', parameters: { channel: 'review-queue' }, resourceVersion: `draft@${mc.outputDigest.slice(0, 8)}`, subjectDigest: ev.subjectDigest, now };
      const d1 = await decide(run, relArgs);
      ok('A6: the enforced release boundary escalates to a human; no handle', d1.decision === 'escalate' && d1.handle === null && typeof d1.approvalRequest === 'string');
      ok('A7 (V13): streaming the draft before the decision is refused; delivery without a handle is refused; nothing delivered', /stream_refused/.test(thrown(() => outbox.stream(mc.output.summary))?.message) && /no_handle/.test(thrown(() => outbox.deliver({ artifact: mc.output }))?.message) && outbox.deliveries.length === 0);
      tick(60000);
      await recordApproval(run, { requestId: d1.approvalRequest, approver: 'reviewer:dana', decision: 'allow', reason: 'labelled acceptance input (simulated)', now });
      const d2 = await decide(run, relArgs);
      const rel = await release(run, { signer, boundary: 'release', handle: d2.handle, subject: mc.output, now, authorize: async () => true, deliver: (ctx) => outbox.deliver({ artifact: mc.output, handleId: ctx.handleId, subjectDigest: ctx.subjectDigest }) });
      ok('A8: after approval the release boundary delivers the exact artifact once, bound to the handle', d2.decision === 'allow' && rel.released && rel.delivered && outbox.deliveries.length === 1 && outbox.deliveries[0].subjectDigest === ev.subjectDigest && outbox.deliveries[0].handleId === d2.decisionId);
      ok('A9: a modified artifact cannot ride the same handle', (await release(run, { signer, boundary: 'release', handle: d2.handle, subject: { ...mc.output, summary: mc.output.summary + '!' }, now, deliver: () => true }).catch((e) => e)).code === 'binding_mismatch' && outbox.deliveries.length === 1);
      // 7. the simulated side effect with a crash after the effect (V11).
      const crm = createCrm();
      const crmArgs = { signer, policy, boundary: 'crm', operation: 'crm-note-1', parameters: { record: 'lead:42', note: 'Q3 summary reviewed' }, resourceVersion: crm.version('lead:42'), subjectDigest: ev.subjectDigest, now };
      const dCrm = await decide(run, crmArgs);
      crm.crashAfterEffect();
      const x1 = await execute(run, { ...crmArgs, handle: dCrm.handle, idempotencyKey: 'crm-note-1-key', authorize: async () => true, perform: ({ idempotencyKey }) => crm.update({ id: 'lead:42', expectedVersion: crmArgs.resourceVersion, note: 'Q3 summary reviewed', idempotencyKey }) });
      ok('A10 (V11): the effect happened, the perform() threw → outcome unknown, the operation is unresolved', x1.executed && x1.outcome === 'unknown' && crm.get('lead:42').notes.length === 1 && (await unresolvedOperations(run)).join() === 'crm-note-1');
      const x2 = await execute(run, { ...crmArgs, handle: dCrm.handle, idempotencyKey: 'crm-note-1-key', perform: ({ idempotencyKey }) => crm.update({ id: 'lead:42', expectedVersion: crmArgs.resourceVersion, note: 'Q3 summary reviewed', idempotencyKey }) });
      ok('A11 (V11): a retry is refused (already_executed with outcome unknown); the CRM note is not duplicated', x2.executed === false && x2.refused === 'already_executed' && x2.outcome === 'unknown' && crm.get('lead:42').notes.length === 1);
      const rc = await reconcile(run, { operation: 'crm-note-1', outcome: crm.wasApplied('crm-note-1-key') ? 'success' : 'failure', reason: 'host idempotency table holds the key', evidenceRef: 'crm:idempotency:crm-note-1-key', now });
      ok('A12 (V11): reconciled from durable host state; nothing unresolved', rc.outcome === 'success' && rc.priorOutcome === 'unknown' && (await unresolvedOperations(run)).length === 0);
      // 8. terminal, verifier, receipt.
      await run.complete({ outcome: 'success' });
      const r = await run.read();
      const v = verifyRun({ events: r.events, manifest: ev.manifest });
      ok('A13: the run verifies `verified` with producer/witness not_supplied; the reducer has no issues', v.verdict === 'verified' && v.limits.map((l) => l.dimension).join() === 'producer,witness' && r.state.issues.length === 0 && r.state.status === 'completed', JSON.stringify(r.state.issues));
      const receipt = exportReceipt({ events: r.events, manifest: ev.manifest, policy, exportedAt: now(), exporter: `synthetic-pilot (${SIMULATION_NOTICE.split(':')[0]})` });
      const vr = verifyReceipt(receipt);
      ok('A14: the receipt exports without redaction, verifies verified, authority unsigned, omissions explicit, exporter labelled simulated', receipt.redactions === 0 && vr.verdict === 'verified' && vr.authority === 'unsigned' && receipt.omissions.join() === 'external_witness,producer_keys,raw_bodies,signature' && /SIMULATED/.test(receipt.exporter));
      const portable = JSON.parse(JSON.stringify(receipt));
      ok('A15: the receipt survives a JSON round trip byte for byte', verifyReceipt(portable).verdict === 'verified' && portable.digest === receipt.digest);
      const fresh = new FileStore(path.join(tmp, 'evidence'));
      const again = await fresh.readRun('pilot:run:a');
      ok('A16: a fresh store instance reads the same run: same head, not damaged, file holds exactly the canonical lines', !again.damaged && again.head === r.head && (await readFile(fresh.pathFor('pilot:run:a'), 'utf8')) === r.events.map((e) => canonicalEncode(e)).join('\n') + '\n');
      const m = measureRun(r.events);
      ok('A17: baseline measurements — 3 checks pass, 3 allows, 1 escalation, 1 approval, 1 action unknown then reconciled, 1 output delivered, 0 would-block, 0 blocked', m.checks.pass === 3 && m.decisions.allow === 3 && m.decisions.escalated === 1 && m.approvals.allowed === 1 && m.actions.unknown === 1 && m.actions.reconciled === 1 && m.actions.unresolved === 0 && m.outputs.delivered === 1 && m.decisions.wouldBlock === 0 && m.decisions.blocked === 0 && m.modelCalls.success === 1 && m.contextReferences === 1, JSON.stringify(m));
      ok('A18: the whole run is byte-deterministic from the host inputs (same ids, clock, scripts → same head)', await (async () => {
        clockMs = Date.parse('2026-09-21T09:00:00.000Z');
        const s2 = new FileStore(path.join(tmp, 'evidence-2'));
        const rt2 = createRuntime({ store: s2, gates, newId: ids('a'), now, producer: { kind: 'host', id: 'pilot-host' } });
        const run2 = await rt2.startRun({ run: 'pilot:run:a', context, idempotencyKey: 'pilot-a-1', requiredGates: ['schema', 'no-pii', 'faithfulness'], policyVersion: policy.version, task: 'summarize' });
        await referenceContext(run2, { references: [{ kind: 'document', ref: SYNTHETIC_DOCUMENT.id, digest: subjectDigest(SYNTHETIC_DOCUMENT.body), bytes: Buffer.byteLength(SYNTHETIC_DOCUMENT.body) }] });
        const mc2 = await observeModelCall(run2, { metadata: { provider: 'synthetic', model: 'fake-summarizer-1', purpose: 'summary' }, invoke: () => createFakeModelClient({ mode: 'good' }).generateSummary({ document: SYNTHETIC_DOCUMENT }), timeoutMs: 1000 });
        const ev2 = await run2.evaluate({ subject: mc2.output });
        return ev2.subjectDigest === ev.subjectDigest && (await run2.read()).events.slice(0, 9).map((e) => e.id).join() === r.events.slice(0, 9).map((e) => e.id).join() && canonicalEncode((await run2.read()).events.slice(0, 9)) === canonicalEncode(r.events.slice(0, 9));
      })());
    }

    // ── B. would-block path ──
    {
      clockMs = Date.parse('2026-09-21T10:00:00.000Z');
      const store = new FileStore(path.join(tmp, 'evidence-b'));
      const runtime = createRuntime({ store, gates, newId: ids('b'), now, producer: { kind: 'host', id: 'pilot-host' } });
      const run = await runtime.startRun({ run: 'pilot:run:b', context: PILOT_CONTEXT, idempotencyKey: 'pilot-b-1', requiredGates: ['schema', 'no-pii', 'faithfulness'], policyVersion: policy.version });
      const mc = await observeModelCall(run, { metadata: { provider: 'synthetic', model: 'fake-summarizer-1' }, invoke: () => createFakeModelClient({ mode: 'inject' }).generateSummary({ document: SYNTHETIC_DOCUMENT }), timeoutMs: 1000 });
      const ev = await run.evaluate({ subject: mc.output });
      ok('B1: the echoed hostile line fails no-pii (an e-mail) and faithfulness; schema passes', !ev.passed && ev.results['no-pii'].result === 'fail' && ev.results['no-pii'].reason === 'shapes: email' && ev.results.faithfulness.result === 'fail' && ev.results.schema.result === 'pass');
      const args = { signer, policy, parameters: { kind: 'summary' }, resourceVersion: 'draft@b', subjectDigest: ev.subjectDigest, now };
      const dDraft = await decide(run, { ...args, boundary: 'draft', operation: 'draft-1' });
      const dRel1 = await decide(run, { ...args, boundary: 'release', operation: 'release-1' });
      const req = (await run.read()).events.find((e) => e.id === dRel1.approvalRequest);
      ok('B2a: shadow draft → allow with wouldDecide withhold (measured); enforced release escalates to a human with coverage not_passed on the request', dDraft.decision === 'allow' && dDraft.wouldDecide === 'withhold' && dRel1.decision === 'escalate' && dRel1.handle === null && req.payload.coverage === 'not_passed');
      await recordApproval(run, { requestId: dRel1.approvalRequest, approver: 'reviewer:dana', decision: 'allow', reason: 'labelled acceptance input (simulated) — approving anyway', now });
      const dRel = await decide(run, { ...args, boundary: 'release', operation: 'release-1' });
      ok('B2b: a human approval cannot override failing required gates: enforced release → withhold, no handle, both failing gates named', dRel.decision === 'withhold' && dRel.handle === null && dRel.wouldDecide === 'withhold' && dRel.reasons.map((r) => r.code).join() === 'gate_not_passed,gate_not_passed', JSON.stringify(dRel.reasons));
      const evs = (await run.read()).events;
      const text = canonicalEncode(evs);
      ok('B3 (V14): every event still carries the host identity; the injected text and the e-mail are in no event', evs.every((e) => e.tenant === 'acme' && e.principal === 'agent:summarizer') && !text.includes('globex') && !text.includes('ops@acme.invalid') && !text.includes('APPROVED'));
      await run.fail({ outcome: 'failure', reason: 'withheld at release' });
      const r = await run.read();
      const receipt = exportReceipt({ events: r.events, manifest: ev.manifest, policy, exportedAt: now(), exporter: 'synthetic-pilot (SIMULATED)' });
      const vr = verifyReceipt(receipt);
      const m = measureRun(r.events);
      ok('B4 (V15): the receipt exports clean (no secret shape reached the evidence) and is invalid on coverage as it should be; measurements show wouldBlock 1, blocked 1, escalated 1, approval allowed 1, nothing delivered', receipt.redactions === 0 && vr.verdict === 'invalid' && vr.dimensions.coverage.findings.length === 2 && m.decisions.wouldBlock === 1 && m.decisions.blocked === 1 && m.decisions.escalated === 1 && m.approvals.allowed === 1 && m.outputs.delivered === 0 && m.status === 'failed', JSON.stringify(m.decisions));
    }

    // ── C. provider outage ──
    {
      clockMs = Date.parse('2026-09-21T11:00:00.000Z');
      const store = new FileStore(path.join(tmp, 'evidence-c'));
      const runtime = createRuntime({ store, gates, newId: ids('c'), now });
      const run = await runtime.startRun({ run: 'pilot:run:c', context: PILOT_CONTEXT, idempotencyKey: 'pilot-c-1', requiredGates: ['schema'], policyVersion: policy.version });
      const mc = await observeModelCall(run, { metadata: { provider: 'synthetic' }, invoke: () => createFakeModelClient({ mode: 'fail' }).generateSummary({ document: SYNTHETIC_DOCUMENT }), timeoutMs: 1000 });
      const fin = (await run.read()).events.at(-1);
      ok('C1 (V15): the outage is a recorded failure and the key in the error message is minimized', mc.outcome === 'failure' && fin.payload.outcome === 'failure' && /\[redacted:/.test(fin.payload.detail.message) && !/sk-fake/.test(fin.payload.detail.message));
      await run.fail({ outcome: 'incomplete', reason: 'no draft: provider unavailable' });
      const r = await run.read();
      const receipt = exportReceipt({ events: r.events, exportedAt: now(), exporter: 'synthetic-pilot (SIMULATED)' });
      const m = measureRun(r.events);
      ok('C2: the run is failed/incomplete, the receipt says so, and there is no task-success credit anywhere (no checks, no decisions)', r.state.status === 'failed' && r.state.terminal.outcome === 'incomplete' && receipt.status === 'failed' && verifyReceipt(receipt).verdict === 'unverified' && m.modelCalls.failure === 1 && m.checks.pass === 0 && m.decisions.allow === 0);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('');
  console.log(`runtime-pilot-synthetic: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-pilot-synthetic OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
