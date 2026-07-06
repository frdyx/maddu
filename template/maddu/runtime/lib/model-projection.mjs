// model-projection.mjs (SLM-governance phase 3, plan pln_20260706133422_0f60)
//
// Read-time derivation of the SLM-factory registry from MODEL_* spine events
// (contract 1.1.0). Pure — a function of the event list, zero writes, no
// clock: deriveModels(events) is deterministic and mirrors the verifier's
// derived-stage algorithm (verify.mjs MODEL_* cases): an approved promotion
// sets the checkpoint's stage to its to_stage, a strictly-downward rollback
// sets reverted_to, latest wins, else `experiment`. The verifier remains the
// tamper authority; this projection derives the working registry the CLI
// refuses against (`model promote` stage discipline, release/rollback
// lineage).
//
// Deliberately NOT persisted to .maddu/state (design §3 named models.json;
// build deviation, recorded in the design doc): an unconditional new key in
// the state file would change projection bytes for every existing repo and
// break the byte-identical default path (invariant #1, which outranks the
// placement detail). A persisted registry can ride a deliberate projection
// schema bump later.

export const MODEL_STAGES = ['experiment', 'candidate', 'canary', 'released'];
const ALLOWING = new Set(['allow-once', 'allow-always']);
const lc = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

export function nextStage(stage) {
  return MODEL_STAGES[MODEL_STAGES.indexOf(stage) + 1] ?? null;
}

// deriveModels(events) → {
//   datasets:    Map dataset_id   → { dataset_id, license, synthetic, hash, manifestPath, manifestHash, at, eventId }
//   runs:        Map run_id       → { run_id, model_id, method, dataset_snapshot, startedAt, completedAt, checkpointKey }
//   checkpoints: Map checkpointKey→ { checkpointKey, model_id, uri, run_id, registeredAt, stage }
//   evals:       Map eval_id      → { eval_id, checkpointKey, benchmark, harness_version, pass_rate, at, criticalRegressions, acknowledged }
//   proposals:   Map proposalId   → { proposalId, checkpointKey, from_stage, to_stage, approvalRequestId, at, approved, approvalRef }
//   decisions:   Map approvalId   → decision (first decision wins, as in verify)
//   releases:    Array of { checkpointKey, model_id, rollback_plan, at, eventId }
//   rollbacks:   Array of { checkpointKey, model_id, reverted_to, at, eventId }
// }
export function deriveModels(events) {
  const datasets = new Map();
  const runs = new Map();
  const checkpoints = new Map();
  const evals = new Map();
  const proposals = new Map();
  const decisions = new Map();
  const releases = [];
  const rollbacks = [];

  const stageOf = (ck) => (ck && checkpoints.get(ck)?.stage) || 'experiment';

  for (const ev of events) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'APPROVAL_DECIDED': {
        const aid = d.approvalId;
        if (aid && !decisions.has(aid) && typeof d.decision === 'string') decisions.set(aid, d.decision);
        break;
      }
      case 'MODEL_DATASET_SNAPSHOT_RECORDED':
        if (d.dataset_id) datasets.set(d.dataset_id, {
          dataset_id: d.dataset_id, license: d.license ?? null, synthetic: d.synthetic ?? null,
          hash: d.hash ?? null, manifestPath: d.manifestPath ?? null, manifestHash: d.manifestHash ?? null,
          at: ev.ts, eventId: ev.id,
        });
        break;
      case 'MODEL_TRAINING_RUN_STARTED':
        if (d.run_id) runs.set(d.run_id, {
          run_id: d.run_id, model_id: d.model_id ?? null, method: d.method ?? null,
          dataset_snapshot: d.dataset_snapshot ?? null, startedAt: ev.ts, completedAt: null, checkpointKey: null,
        });
        break;
      case 'MODEL_TRAINING_RUN_COMPLETED': {
        const r = d.run_id ? runs.get(d.run_id) : null;
        if (r) { r.completedAt = ev.ts; r.checkpointKey = lc(d.checkpointKey) ?? null; }
        break;
      }
      case 'MODEL_CHECKPOINT_REGISTERED': {
        const ck = lc(d.checkpointKey);
        if (ck && !checkpoints.has(ck)) checkpoints.set(ck, {
          checkpointKey: ck, model_id: d.model_id ?? null, uri: d.checkpoint?.uri ?? null,
          run_id: d.run_id ?? null, registeredAt: ev.ts, stage: 'experiment',
        });
        break;
      }
      case 'MODEL_EVAL_RAN':
        if (d.eval_id) evals.set(d.eval_id, {
          eval_id: d.eval_id, checkpointKey: lc(d.checkpointKey) ?? null, benchmark: d.benchmark ?? null,
          harness_version: d.harness_version ?? null, pass_rate: d.pass_rate ?? null, at: ev.ts,
          criticalRegressions: 0, acknowledged: false,
        });
        break;
      case 'MODEL_REGRESSION_FOUND': {
        const e = d.eval_id ? evals.get(d.eval_id) : null;
        if (e && d.critical === true) e.criticalRegressions += 1;
        break;
      }
      case 'MODEL_REGRESSION_ACKNOWLEDGED': {
        const e = d.eval_id ? evals.get(d.eval_id) : null;
        if (e) e.acknowledged = true;
        break;
      }
      case 'MODEL_PROMOTION_PROPOSED':
        proposals.set(ev.id, {
          proposalId: ev.id, checkpointKey: lc(d.checkpointKey) ?? null,
          from_stage: d.from_stage ?? null, to_stage: d.to_stage ?? null,
          approvalRequestId: d.approvalRequestId ?? null, at: ev.ts,
          approved: false, approvalRef: null,
        });
        break;
      case 'MODEL_PROMOTION_APPROVED': {
        const p = d.proposalId ? proposals.get(d.proposalId) : null;
        if (!p || p.approved) break;
        // Mirror the verifier's binding: the proposal's own request, an
        // allowing decision, a matching to_stage, and a legal single step
        // from the CURRENT derived stage. Anything else never advances the
        // registry (the verifier flags it; the projection must not follow).
        const bound = d.approval_ref && d.approval_ref === p.approvalRequestId
          && ALLOWING.has(decisions.get(d.approval_ref))
          && d.to_stage === p.to_stage
          && p.checkpointKey && p.to_stage === nextStage(stageOf(p.checkpointKey))
          && p.from_stage === stageOf(p.checkpointKey);
        if (bound) {
          p.approved = true;
          p.approvalRef = d.approval_ref;
          checkpoints.get(p.checkpointKey).stage = p.to_stage;
        }
        break;
      }
      case 'MODEL_RELEASED':
        releases.push({ checkpointKey: lc(d.checkpointKey) ?? null, model_id: d.model_id ?? null, rollback_plan: d.rollback_plan ?? null, at: ev.ts, eventId: ev.id });
        break;
      case 'MODEL_ROLLED_BACK': {
        const ck = lc(d.checkpointKey);
        const cur = stageOf(ck);
        const rt = d.reverted_to === undefined ? 'candidate' : d.reverted_to;
        const ri = MODEL_STAGES.indexOf(rt);
        // Strictly downward only, mirroring verify — a non-downward rollback
        // is flagged there and must not move the registry here.
        if (ck && checkpoints.has(ck) && ri !== -1 && ri < MODEL_STAGES.indexOf(cur)) {
          checkpoints.get(ck).stage = rt;
        }
        rollbacks.push({ checkpointKey: ck ?? null, model_id: d.model_id ?? null, reverted_to: rt, at: ev.ts, eventId: ev.id });
        break;
      }
    }
  }

  return { datasets, runs, checkpoints, evals, proposals, decisions, releases, rollbacks };
}
