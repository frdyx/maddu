#!/usr/bin/env node
// SLM-governance p2 — verifier rules for the MODEL_ event family
// (contract 1.1.0; design docs/research/slm-governance-design.md §5).
//
// Proves on real temp spines through spine.append + verifySpine:
//   • a complete, honest factory chain (dataset → train → checkpoint → eval
//     → three approved promotions → release → rollback) verifies with ZERO
//     model-family issues — including the derived-stage walk across
//     approvals and the rollback stage reset;
//   • every referential rule fires on its violation, by issue kind:
//     orphan_model_training_run / orphan_model_run_completed /
//     orphan_model_checkpoint (WARN) / orphan_model_eval (WARN) /
//     model_eval_harness_unpinned (WARN) / orphan_model_regression /
//     orphan_model_regression_ack / model_regression_ack_unreasoned;
//   • the promotion-integrity rules are tamper-detecting: a manifest-declared
//     from_stage lie (model_stage_mismatch), a stage skip vs the DERIVED
//     stage (model_stage_skip), an unbound proposal
//     (model_promotion_unbound), a forged approve for an unknown proposal
//     (orphan_model_promotion_approved), an allow borrowed from another
//     proposal (model_approval_ref_mismatch), a denied decision
//     (model_promotion_unapproved), a second approve
//     (duplicate_model_promotion_approved);
//   • release/rollback discipline: release without the derived released
//     stage (model_release_unapproved), release without rollback_plan
//     (model_release_no_rollback_plan), rollback without a release
//     (orphan_model_rollback).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const CK = `sha256:${'a'.repeat(64)}`;
const MANIFEST = { manifestPath: 'models/m.json', manifestHash: `sha256:${'c'.repeat(64)}` };

async function newTmp() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-modelverify-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}

async function main() {
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const verify = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);
  const ap = (tmp, type, data) => spine.append(tmp, { type, data: { schemaVersion: 1, ...data } });
  const count = (res, kind) => res.issues.filter((i) => i.kind === kind).length;
  const modelIssues = (res) => res.issues.filter((i) => i.kind.includes('model'));
  const tmps = [];

  // shared preamble: dataset → started → completed → checkpoint registered
  async function factoryBase(tmp) {
    await ap(tmp, 'MODEL_DATASET_SNAPSHOT_RECORDED', { ...MANIFEST, dataset_id: 'ds1', source: 's', license: 'MIT', hash: CK, synthetic: false });
    await ap(tmp, 'MODEL_TRAINING_RUN_STARTED', { ...MANIFEST, run_id: 'r1', model_id: 'm1', method: 'SFT', dataset_snapshot: 'ds1', base_model: { name: 'b', hash: CK }, seed: 1, commit: 'abc' });
    await ap(tmp, 'MODEL_TRAINING_RUN_COMPLETED', { ...MANIFEST, run_id: 'r1', model_id: 'm1', checkpoint: { uri: 'u', hash: CK }, checkpointKey: CK, metrics: { loss: 1 } });
    await ap(tmp, 'MODEL_CHECKPOINT_REGISTERED', { ...MANIFEST, model_id: 'm1', checkpoint: { uri: 'u', hash: CK }, checkpointKey: CK, run_id: 'r1' });
  }

  // one full approved promotion step; returns the proposal event
  async function approvedStep(tmp, from, to) {
    const req = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: `model promote:${from}->${to}`, action: null, payload: null, summary: null } });
    const prop = await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, from_stage: from, to_stage: to, approvalRequestId: req.id });
    await spine.append(tmp, { type: 'APPROVAL_DECIDED', data: { approvalId: req.id, decision: 'allow-once', reason: null, tool: null } });
    await ap(tmp, 'MODEL_PROMOTION_APPROVED', { proposalId: prop.id, approval_ref: req.id, model_id: 'm1', checkpointKey: CK, to_stage: to });
    return prop;
  }

  try {
    console.log('model-events-verify: happy path');
    {
      const tmp = await newTmp(); tmps.push(tmp);
      await factoryBase(tmp);
      await ap(tmp, 'MODEL_EVAL_RAN', { ...MANIFEST, eval_id: 'e1', checkpointKey: CK, benchmark: 'swe-bench', harness_version: '1.0', pass_rate: 0.3 });
      await ap(tmp, 'MODEL_REGRESSION_FOUND', { eval_id: 'e1', checkpointKey: CK, metric: 'pass_rate', delta: -0.1, critical: true });
      await ap(tmp, 'MODEL_REGRESSION_ACKNOWLEDGED', { eval_id: 'e1', reason: 'known benchmark drift; accepted' });
      await approvedStep(tmp, 'experiment', 'candidate');
      await approvedStep(tmp, 'candidate', 'canary');
      await approvedStep(tmp, 'canary', 'released');
      await ap(tmp, 'MODEL_RELEASED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, rollback_plan: 'repoint the serving alias to the prior checkpoint' });
      await ap(tmp, 'MODEL_ROLLED_BACK', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, reverted_to: 'candidate' });
      // after rollback the derived stage is candidate again — a fresh
      // candidate->canary proposal must be legal (re-promotion path)
      const req = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:candidate->canary', action: null, payload: null, summary: null } });
      await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, from_stage: 'candidate', to_stage: 'canary', approvalRequestId: req.id });
      const res = await verify.verifySpine(tmp);
      ok('full factory chain verifies with zero model-family issues', modelIssues(res).length === 0,
        modelIssues(res).map((i) => i.kind).join(','));
      ok('derived stage walked through three approvals to released', count(res, 'model_release_unapproved') === 0);
      ok('re-promotion after rollback is legal (stage reset to reverted_to)', count(res, 'model_stage_mismatch') === 0 && count(res, 'model_stage_skip') === 0);
    }

    console.log('model-events-verify: lineage orphans');
    {
      const tmp = await newTmp(); tmps.push(tmp);
      await ap(tmp, 'MODEL_TRAINING_RUN_STARTED', { ...MANIFEST, run_id: 'r1', model_id: 'm1', method: 'SFT', dataset_snapshot: 'ghost', base_model: { name: 'b', hash: CK }, seed: 1, commit: 'abc' });
      await ap(tmp, 'MODEL_TRAINING_RUN_COMPLETED', { ...MANIFEST, run_id: 'r2', model_id: 'm1', checkpoint: { uri: 'u', hash: CK }, checkpointKey: CK, metrics: {} });
      await ap(tmp, 'MODEL_CHECKPOINT_REGISTERED', { ...MANIFEST, model_id: 'm1', checkpoint: { uri: 'u', hash: CK }, checkpointKey: CK, run_id: 'r-ghost' });
      await ap(tmp, 'MODEL_EVAL_RAN', { ...MANIFEST, eval_id: 'e1', checkpointKey: `sha256:${'d'.repeat(64)}`, benchmark: 'b', pass_rate: 0.1 });
      await ap(tmp, 'MODEL_REGRESSION_FOUND', { eval_id: 'ghost-eval', checkpointKey: CK, metric: 'm', delta: -1, critical: true });
      await ap(tmp, 'MODEL_REGRESSION_ACKNOWLEDGED', { eval_id: 'ghost-eval-2', reason: '' });
      const res = await verify.verifySpine(tmp);
      ok('unknown dataset_snapshot → orphan_model_training_run FAIL', count(res, 'orphan_model_training_run') === 1);
      ok('unknown run_id on completion → orphan_model_run_completed FAIL', count(res, 'orphan_model_run_completed') === 1);
      ok('unknown run_id on checkpoint → orphan_model_checkpoint WARN', count(res, 'orphan_model_checkpoint') === 1);
      ok('unregistered checkpoint on eval → orphan_model_eval WARN', count(res, 'orphan_model_eval') === 1);
      ok('missing harness_version → model_eval_harness_unpinned WARN', count(res, 'model_eval_harness_unpinned') === 1);
      ok('regression for unknown eval → orphan_model_regression FAIL', count(res, 'orphan_model_regression') === 1);
      ok('ack for unknown regression → orphan_model_regression_ack FAIL', count(res, 'orphan_model_regression_ack') === 1);
      ok('ack without reason → model_regression_ack_unreasoned FAIL', count(res, 'model_regression_ack_unreasoned') === 1);
    }

    console.log('model-events-verify: promotion integrity (tamper evidence)');
    {
      const tmp = await newTmp(); tmps.push(tmp);
      await factoryBase(tmp);
      // from_stage lie: checkpoint is at experiment, manifest claims canary->released
      const req1 = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:canary->released', action: null, payload: null, summary: null } });
      await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, from_stage: 'canary', to_stage: 'released', approvalRequestId: req1.id });
      // stage skip: honest from_stage but jumps to canary
      const req2 = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:experiment->canary', action: null, payload: null, summary: null } });
      await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, from_stage: 'experiment', to_stage: 'canary', approvalRequestId: req2.id });
      // unbound: no approvalRequestId at all
      await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, from_stage: 'experiment', to_stage: 'candidate' });
      // unregistered checkpoint
      const req3 = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:experiment->candidate', action: null, payload: null, summary: null } });
      await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: `sha256:${'e'.repeat(64)}`, from_stage: 'experiment', to_stage: 'candidate', approvalRequestId: req3.id });
      const res = await verify.verifySpine(tmp);
      ok('declared from_stage lie → model_stage_mismatch FAIL', count(res, 'model_stage_mismatch') === 1);
      ok('stage skip vs derived stage → model_stage_skip FAIL', count(res, 'model_stage_skip') >= 1);
      ok('proposal without request → model_promotion_unbound FAIL', count(res, 'model_promotion_unbound') === 1);
      ok('proposal for unregistered checkpoint → orphan_model_promotion FAIL', count(res, 'orphan_model_promotion') === 1);
    }

    {
      const tmp = await newTmp(); tmps.push(tmp);
      await factoryBase(tmp);
      // legit proposal A with its own allow
      const reqA = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:experiment->candidate', action: null, payload: null, summary: null } });
      const propA = await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, from_stage: 'experiment', to_stage: 'candidate', approvalRequestId: reqA.id });
      await spine.append(tmp, { type: 'APPROVAL_DECIDED', data: { approvalId: reqA.id, decision: 'allow-once', reason: null, tool: null } });
      // forged approve: unknown proposal id
      await ap(tmp, 'MODEL_PROMOTION_APPROVED', { proposalId: 'evt_ghost', approval_ref: reqA.id, model_id: 'm1', checkpointKey: CK, to_stage: 'candidate' });
      // approve A with a BORROWED ref (a different, also-allowed request)
      const reqB = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:experiment->candidate', action: null, payload: null, summary: null } });
      await spine.append(tmp, { type: 'APPROVAL_DECIDED', data: { approvalId: reqB.id, decision: 'allow-always', reason: null, tool: null } });
      await ap(tmp, 'MODEL_PROMOTION_APPROVED', { proposalId: propA.id, approval_ref: reqB.id, model_id: 'm1', checkpointKey: CK, to_stage: 'candidate' });
      // now the honest approve for A…
      await ap(tmp, 'MODEL_PROMOTION_APPROVED', { proposalId: propA.id, approval_ref: reqA.id, model_id: 'm1', checkpointKey: CK, to_stage: 'candidate' });
      // …and a duplicate of it
      await ap(tmp, 'MODEL_PROMOTION_APPROVED', { proposalId: propA.id, approval_ref: reqA.id, model_id: 'm1', checkpointKey: CK, to_stage: 'candidate' });
      // denied proposal C then approved anyway
      const reqC = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:candidate->canary', action: null, payload: null, summary: null } });
      const propC = await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, from_stage: 'candidate', to_stage: 'canary', approvalRequestId: reqC.id });
      await spine.append(tmp, { type: 'APPROVAL_DECIDED', data: { approvalId: reqC.id, decision: 'deny', reason: 'no', tool: null } });
      await ap(tmp, 'MODEL_PROMOTION_APPROVED', { proposalId: propC.id, approval_ref: reqC.id, model_id: 'm1', checkpointKey: CK, to_stage: 'canary' });
      const res = await verify.verifySpine(tmp);
      ok('approve for unknown proposal → orphan_model_promotion_approved FAIL', count(res, 'orphan_model_promotion_approved') === 1);
      ok('borrowed allow from another request → model_approval_ref_mismatch FAIL', count(res, 'model_approval_ref_mismatch') === 1);
      ok('approve against a denied decision → model_promotion_unapproved FAIL', count(res, 'model_promotion_unapproved') === 1);
      ok('second approve of the same proposal → duplicate_model_promotion_approved FAIL', count(res, 'duplicate_model_promotion_approved') === 1);
    }

    console.log('model-events-verify: release & rollback discipline');
    {
      const tmp = await newTmp(); tmps.push(tmp);
      await factoryBase(tmp);
      await approvedStep(tmp, 'experiment', 'candidate');
      // release while only candidate, and with no rollback_plan
      await ap(tmp, 'MODEL_RELEASED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, rollback_plan: '' });
      // rollback of a never-released checkpoint
      await ap(tmp, 'MODEL_ROLLED_BACK', { ...MANIFEST, model_id: 'm1', checkpointKey: `sha256:${'f'.repeat(64)}`, reverted_to: 'candidate' });
      const res = await verify.verifySpine(tmp);
      ok('release without approved released stage → model_release_unapproved FAIL', count(res, 'model_release_unapproved') === 1);
      ok('release without rollback_plan → model_release_no_rollback_plan FAIL', count(res, 'model_release_no_rollback_plan') === 1);
      ok('rollback without release → orphan_model_rollback FAIL', count(res, 'orphan_model_rollback') === 1);
    }

    console.log('model-events-verify: rollback re-elevation + hardening (p2 red-team SF-1/N-2/N-3/N-6)');
    {
      // SF-1 exploit chain: released → rollback(candidate) → rollback(released) → re-release
      const tmp = await newTmp(); tmps.push(tmp);
      await factoryBase(tmp);
      await approvedStep(tmp, 'experiment', 'candidate');
      await approvedStep(tmp, 'candidate', 'canary');
      await approvedStep(tmp, 'canary', 'released');
      await ap(tmp, 'MODEL_RELEASED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, rollback_plan: 'repoint alias' });
      await ap(tmp, 'MODEL_ROLLED_BACK', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, reverted_to: 'candidate' });
      // the forgery: "roll back" UP to released, then release again with no new ride
      await ap(tmp, 'MODEL_ROLLED_BACK', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, reverted_to: 'released' });
      await ap(tmp, 'MODEL_RELEASED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, rollback_plan: 'again' });
      // and an invalid ladder value never silently coerces
      await ap(tmp, 'MODEL_ROLLED_BACK', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, reverted_to: 'production' });
      const res = await verify.verifySpine(tmp);
      ok('upward reverted_to → model_rollback_not_downward FAIL', count(res, 'model_rollback_not_downward') >= 1);
      ok('flagged rollback never moves the stage — the re-release FAILs too', count(res, 'model_release_unapproved') === 1);
      ok('invalid reverted_to value is flagged, not coerced', count(res, 'model_rollback_not_downward') >= 2);
    }
    {
      const tmp = await newTmp(); tmps.push(tmp);
      await factoryBase(tmp);
      // N-2: approved event's to_stage must equal the proposal's
      const req = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:experiment->candidate', action: null, payload: null, summary: null } });
      const prop = await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, from_stage: 'experiment', to_stage: 'candidate', approvalRequestId: req.id });
      await spine.append(tmp, { type: 'APPROVAL_DECIDED', data: { approvalId: req.id, decision: 'allow-once', reason: null, tool: null } });
      await ap(tmp, 'MODEL_PROMOTION_APPROVED', { proposalId: prop.id, approval_ref: req.id, model_id: 'm1', checkpointKey: CK, to_stage: 'released' });
      // N-3: a forged non-vocabulary "allow-…" decision is not a grant
      const req2 = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:experiment->candidate', action: null, payload: null, summary: null } });
      const prop2 = await ap(tmp, 'MODEL_PROMOTION_PROPOSED', { ...MANIFEST, model_id: 'm1', checkpointKey: CK, from_stage: 'experiment', to_stage: 'candidate', approvalRequestId: req2.id });
      await spine.append(tmp, { type: 'APPROVAL_DECIDED', data: { approvalId: req2.id, decision: 'allow-forged', reason: null, tool: null } });
      await ap(tmp, 'MODEL_PROMOTION_APPROVED', { proposalId: prop2.id, approval_ref: req2.id, model_id: 'm1', checkpointKey: CK, to_stage: 'candidate' });
      // N-6: an uppercase-hex checkpointKey reference still resolves lineage
      await ap(tmp, 'MODEL_EVAL_RAN', { ...MANIFEST, eval_id: 'e-case', checkpointKey: CK.toUpperCase().replace('SHA256', 'sha256'), benchmark: 'b', harness_version: '1', pass_rate: 0.5 });
      const res = await verify.verifySpine(tmp);
      ok('approved to_stage differing from proposal → model_approved_stage_mismatch FAIL', count(res, 'model_approved_stage_mismatch') === 1);
      ok('non-vocabulary allow-* decision → model_promotion_unapproved FAIL (exact grant set)', count(res, 'model_promotion_unapproved') === 1);
      ok('uppercase-hex checkpointKey still resolves (read-side lowercase)', count(res, 'orphan_model_eval') === 0);
    }

    console.log(`\nmodel-events-verify: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    for (const t of tmps) await rm(t, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
