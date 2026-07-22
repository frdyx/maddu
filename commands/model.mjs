// `maddu model` — SLM-factory governance (phase 3, plan pln_20260706133422_0f60).
//
// Máddu governs the factory, never the factory: every write sub-verb
// validates + hash-pins a host-repo manifest through lib/model-manifests.mjs
// (5-step single-read ingest, refuse-on-hit secret gate, NO skip flag) and
// emits the contract-1.1.0 MODEL_* events. Read sub-verbs derive the
// registry read-time via lib/model-projection.mjs. Design (BINDING):
// docs/research/slm-governance-design.md §6.
//
// Subcommands:
//   dataset snapshot <manifest.json>       → MODEL_DATASET_SNAPSHOT_RECORDED
//   train start <manifest.json>            → MODEL_TRAINING_RUN_STARTED
//   train complete <manifest.json>         → MODEL_TRAINING_RUN_COMPLETED
//   checkpoint register <manifest.json>    → MODEL_CHECKPOINT_REGISTERED
//   eval record <manifest.json>            → MODEL_EVAL_RAN (+ MODEL_REGRESSION_FOUND per critical regression)
//   regression ack <eval-id> --reason "…"  → MODEL_REGRESSION_ACKNOWLEDGED
//   promote <manifest.json> [--wait]       → APPROVAL_REQUESTED first, then MODEL_PROMOTION_PROPOSED
//   promote --confirm <proposal-id>        → MODEL_PROMOTION_APPROVED (only against THAT proposal's allowing decision)
//   release <manifest.json>                → MODEL_RELEASED
//   rollback <manifest.json> [--reverted-to <stage>] → MODEL_ROLLED_BACK (strictly downward)
//   status [--model <id>] · list <datasets|runs|checkpoints|evals|promotions>
//
// Promotion invariants (§6, all four load-bearing): always-on (every
// governance mode); stage-keyed policy tool `model promote:<from>-><to>`;
// auto-decide cascade consulted ONLY for to_stage candidate — canary and
// released always wait for an explicit per-request decision; exact binding
// on confirm. There is no flag that skips the approval.
//
// Command-level lineage refusals mirror the verifier's FAIL rules (never
// create a spine verify would flag); WARN rules warn and proceed.
// Exit: 0 ok/pending, 1 refusal, 2 usage error.

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, resolveSessionId } from './_spine.mjs';
import { resolveLibDir } from './_libroot.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const KNOWN_FLAGS = ['json', 'wait', 'confirm', 'reason', 'reverted-to', 'model', 'session', 'force-list'];
const WAIT_POLL_MS = 500;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;

function usage() {
  console.error('Usage: maddu model <dataset snapshot|train start|train complete|checkpoint register|eval record|regression ack|promote|release|rollback|status|list> [args] [--json]');
  process.exit(2);
}

export default async function model(argv) {
  const { flags, positional } = parseFlags(argv);
  for (const k of Object.keys(flags)) {
    if (!KNOWN_FLAGS.includes(k)) {
      console.error(`model: unknown flag --${k} (the approval ride and secret gate have no skip flags; supported: ${KNOWN_FLAGS.map((f) => '--' + f).join(' ')})`);
      process.exit(2);
    }
  }
  const json = flags.json === true;
  const lib = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(lib.paths);
  const dir = await resolveLibDir();
  const manifests = await import(pathToFileURL(join(dir, 'model-manifests.mjs')).href);
  const projection = await import(pathToFileURL(join(dir, 'model-projection.mjs')).href);
  // Fail-soft on unrelated resolver errors, but a malformed EXPLICIT --session
  // (PR-B) must surface, not silently become an anonymous null actor.
  const sid = await resolveSessionId(repoRoot, flags, lib.sessionActive)
    .catch((e) => { if (e && e.code === 'INVALID_EXPLICIT_ID') throw e; return null; });

  const emit = (type, data) => lib.spine.append(repoRoot, { type, actor: sid || null, data: { schemaVersion: 1, ...data } });
  const registry = async () => projection.deriveModels(await lib.spine.readAll(repoRoot));
  const refuse = (msg) => {
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`model: ${msg}`);
    process.exit(1);
  };
  const done = (obj, human) => {
    if (json) console.log(JSON.stringify({ ok: true, ...obj }));
    else console.log(human);
    return 0;
  };
  const ingest = async (file, opts = {}) => {
    if (!file || file === true) usage();
    const r = await manifests.ingestManifestFile(repoRoot, file, opts);
    for (const w of r.warnings || []) console.error(`model: warning: ${w}`);
    if (!r.ok) refuse(r.errors.join('; '));
    return r;
  };

  const [group, subOrArg, arg2] = positional;

  // ── promote --confirm rides without a manifest ──
  if (group === 'promote' && flags.confirm) {
    const pid = flags.confirm === true ? subOrArg : flags.confirm;
    if (!pid || pid === true) usage();
    const events = await lib.spine.readAll(repoRoot);
    const reg = projection.deriveModels(events);
    const p = reg.proposals.get(pid);
    if (!p) refuse(`unknown proposal ${pid}`);
    if (events.some((e) => e.type === 'MODEL_PROMOTION_APPROVED' && e.data?.proposalId === pid)) {
      refuse(`proposal ${pid} already has a MODEL_PROMOTION_APPROVED — one approve per proposal`);
    }
    const decision = p.approvalRequestId ? reg.decisions.get(p.approvalRequestId) : undefined;
    if (!['allow-once', 'allow-always'].includes(decision)) {
      refuse(`proposal ${pid} has no allowing decision for its own request ${p.approvalRequestId ?? '(none)'} (decision: ${decision ?? 'none'}) — respond with: maddu approval respond --id ${p.approvalRequestId} --decision allow-once`);
    }
    // The proposal must still be the legal next step — a stale confirm after
    // the checkpoint moved is refused, never emitted-then-flagged.
    const cur = reg.checkpoints.get(p.checkpointKey)?.stage || 'experiment';
    if (p.from_stage !== cur || p.to_stage !== projection.nextStage(cur)) {
      refuse(`proposal ${pid} is stale: checkpoint ${p.checkpointKey} is now at ${cur}, proposal was ${p.from_stage} -> ${p.to_stage}`);
    }
    const ev = await emit('MODEL_PROMOTION_APPROVED', {
      proposalId: pid, approval_ref: p.approvalRequestId,
      model_id: reg.checkpoints.get(p.checkpointKey)?.model_id ?? null,
      checkpointKey: p.checkpointKey, to_stage: p.to_stage,
    });
    return done({ event: ev.id, proposalId: pid, to_stage: p.to_stage },
      `promotion approved: ${p.checkpointKey} -> ${p.to_stage} (${ev.id})`);
  }

  // ── gates install (phase 4): the operator starter pack ──
  if (group === 'gates' && subOrArg === 'install') {
    const { readdir, readFile, writeFile, mkdir } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const srcDir = join(dir, '..', 'gates', 'model-pack');
    let files;
    try { files = (await readdir(srcDir)).filter((f) => f.endsWith('.mjs')).sort(); }
    catch { refuse(`starter pack source not found at ${srcDir} — is the framework runtime installed?`); }
    const destDir = join(repoRoot, '.maddu', 'gates');
    const manifestPath = join(destDir, '.model-pack-manifest.json');
    let installedHashes = {};
    try { installedHashes = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
    const sha = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

    const plan = [];
    for (const f of files) {
      const srcBuf = await readFile(join(srcDir, f));
      const srcHash = sha(srcBuf);
      let destBuf = null;
      try { destBuf = await readFile(join(destDir, f)); } catch {}
      if (destBuf === null) { plan.push({ file: f, action: 'install', srcBuf, srcHash }); continue; }
      const destHash = sha(destBuf);
      if (destHash === srcHash) { plan.push({ file: f, action: 'current', srcHash }); continue; }
      // Differs from the shipped source: only refresh when the on-disk copy
      // still matches what WE installed (recorded in the pack manifest) —
      // an operator-edited gate is never overwritten.
      if (installedHashes[f] && destHash === installedHashes[f]) plan.push({ file: f, action: 'refresh', srcBuf, srcHash });
      else plan.push({ file: f, action: 'skip-modified', srcHash });
    }

    if (flags['force-list'] === true) {
      return done(
        { dryRun: true, plan: plan.map(({ file, action }) => ({ file, action })) },
        plan.map((p) => `  ${p.action.padEnd(13)} ${p.file}`).join('\n'),
      );
    }
    await mkdir(destDir, { recursive: true });
    for (const p of plan) {
      if (p.action === 'install' || p.action === 'refresh') await writeFile(join(destDir, p.file), p.srcBuf);
      if (p.action !== 'skip-modified') installedHashes[p.file] = p.srcHash;
    }
    await writeFile(manifestPath, JSON.stringify(installedHashes, null, 2) + '\n');
    const counts = plan.reduce((a, p) => { a[p.action] = (a[p.action] || 0) + 1; return a; }, {});
    const skipped = plan.filter((p) => p.action === 'skip-modified').map((p) => p.file);
    return done(
      { counts, skipped, gatesDir: '.maddu/gates' },
      `model gate pack: ${counts.install || 0} installed · ${counts.refresh || 0} refreshed · ${counts.current || 0} current · ${counts['skip-modified'] || 0} skipped (operator-edited${skipped.length ? ': ' + skipped.join(', ') : ''})\n  gates live in .maddu/gates/ — YOURS to edit; pin as required with \`maddu ci pin\``,
    );
  }

  if (group === 'dataset' && subOrArg === 'snapshot') {
    const r = await ingest(arg2);
    if (r.kind !== 'dataset-snapshot') refuse(`expected a dataset-snapshot manifest, got ${r.kind}`);
    const m = r.manifest;
    const reg = await registry();
    if (reg.datasets.has(m.dataset_id)) refuse(`dataset_id ${m.dataset_id} already recorded (unique per repo, design §4.1) — snapshot under a new id`);
    const ev = await emit('MODEL_DATASET_SNAPSHOT_RECORDED', {
      manifestPath: r.repoRelPath, manifestHash: r.manifestHash,
      dataset_id: m.dataset_id, source: m.source, license: m.license, hash: m.hash, synthetic: m.synthetic,
    });
    return done({ event: ev.id, dataset_id: m.dataset_id, manifestHash: r.manifestHash },
      `dataset snapshot recorded: ${m.dataset_id} (${ev.id}, ${r.manifestHash.slice(0, 18)}…)`);
  }

  if (group === 'train' && (subOrArg === 'start' || subOrArg === 'complete')) {
    const completing = subOrArg === 'complete';
    const r = await ingest(arg2, completing ? { forCompletion: true } : {});
    if (r.kind !== 'training-run') refuse(`expected a training-run manifest, got ${r.kind}`);
    const m = r.manifest;
    const reg = await registry();
    if (!completing) {
      if (!reg.datasets.has(m.dataset_snapshot)) refuse(`dataset_snapshot ${m.dataset_snapshot} has no MODEL_DATASET_SNAPSHOT_RECORDED — record it first`);
      if (reg.runs.has(m.run_id)) refuse(`run_id ${m.run_id} already started`);
      const ev = await emit('MODEL_TRAINING_RUN_STARTED', {
        manifestPath: r.repoRelPath, manifestHash: r.manifestHash,
        run_id: m.run_id, model_id: m.model_id, method: m.method,
        dataset_snapshot: m.dataset_snapshot, base_model: m.base_model, seed: m.seed, commit: m.commit,
      });
      return done({ event: ev.id, run_id: m.run_id }, `training run started: ${m.run_id} (${ev.id})`);
    }
    if (!reg.runs.has(m.run_id)) refuse(`run_id ${m.run_id} has no MODEL_TRAINING_RUN_STARTED — start it first`);
    if (reg.runs.get(m.run_id).completedAt) refuse(`run_id ${m.run_id} already completed`);
    const ck = manifests.normalizeCheckpointKey(m.checkpoint);
    const ev = await emit('MODEL_TRAINING_RUN_COMPLETED', {
      manifestPath: r.repoRelPath, manifestHash: r.manifestHash,
      run_id: m.run_id, model_id: m.model_id, checkpoint: m.checkpoint, checkpointKey: ck, metrics: m.metrics,
    });
    return done({ event: ev.id, run_id: m.run_id, checkpointKey: ck }, `training run completed: ${m.run_id} -> ${ck} (${ev.id})`);
  }

  if (group === 'checkpoint' && subOrArg === 'register') {
    const r = await ingest(arg2);
    if (r.kind !== 'checkpoint-registration') refuse(`expected a checkpoint-registration manifest, got ${r.kind}`);
    const m = r.manifest;
    const reg = await registry();
    const ck = manifests.normalizeCheckpointKey(m.checkpoint);
    if (reg.checkpoints.has(ck)) refuse(`checkpoint ${ck} already registered`);
    if (m.run_id && !reg.runs.get(m.run_id)?.completedAt) {
      console.error(`model: warning: run_id ${m.run_id} has no MODEL_TRAINING_RUN_COMPLETED (foreign/imported checkpoints may omit run_id)`);
    }
    const data = {
      manifestPath: r.repoRelPath, manifestHash: r.manifestHash,
      model_id: m.model_id, checkpoint: m.checkpoint, checkpointKey: ck,
    };
    if (m.run_id) data.run_id = m.run_id;
    const ev = await emit('MODEL_CHECKPOINT_REGISTERED', data);
    return done({ event: ev.id, checkpointKey: ck }, `checkpoint registered: ${ck} (${ev.id})`);
  }

  if (group === 'eval' && subOrArg === 'record') {
    const r = await ingest(arg2);
    if (r.kind !== 'eval-run') refuse(`expected an eval-run manifest, got ${r.kind}`);
    const m = r.manifest;
    const reg = await registry();
    const ck = manifests.normalizeCheckpointKey(m.checkpoint);
    if (reg.evals.has(m.eval_id)) refuse(`eval_id ${m.eval_id} already recorded`);
    if (!reg.checkpoints.has(ck)) console.error(`model: warning: checkpoint ${ck} is not registered — lineage will read as orphaned (WARN) in spine verify`);
    const data = {
      manifestPath: r.repoRelPath, manifestHash: r.manifestHash,
      eval_id: m.eval_id, checkpointKey: ck, benchmark: m.benchmark, pass_rate: m.pass_rate,
    };
    if (m.harness_version) data.harness_version = m.harness_version;
    if (Array.isArray(m.regressions)) data.regressions = m.regressions;
    const ev = await emit('MODEL_EVAL_RAN', data);
    const critical = (m.regressions || []).filter((x) => x.critical === true);
    const regressionEvents = [];
    for (const reg2 of critical) {
      const rd = { eval_id: m.eval_id, checkpointKey: ck, metric: reg2.metric, delta: reg2.delta, critical: true };
      if (reg2.vs) rd.vs = manifests.normalizeCheckpointKey(reg2.vs);
      regressionEvents.push((await emit('MODEL_REGRESSION_FOUND', rd)).id);
    }
    return done({ event: ev.id, eval_id: m.eval_id, criticalRegressions: critical.length, regressionEvents },
      `eval recorded: ${m.eval_id} pass_rate=${m.pass_rate}${critical.length ? ` — ${critical.length} CRITICAL regression(s) recorded; acknowledge with: maddu model regression ack ${m.eval_id} --reason "…"` : ''} (${ev.id})`);
  }

  if (group === 'regression' && subOrArg === 'ack') {
    const evalId = arg2;
    if (!evalId || evalId === true) usage();
    const reason = flags.reason;
    if (typeof reason !== 'string' || reason.trim() === '') refuse('--reason "…" is required — the recorded judgment is the point');
    // The reason lands on the append-only spine; a pasted credential would be
    // permanent. Same canonical gate as manifests, refuse-on-hit.
    const { redactText } = await import(pathToFileURL(join(dir, 'secret-scan.mjs')).href);
    if (redactText(reason).text !== reason) refuse('--reason contains a secret-shaped value — remove it; there is no skip flag');
    const reg = await registry();
    const e = reg.evals.get(evalId);
    if (!e) refuse(`unknown eval_id ${evalId}`);
    if (e.criticalRegressions === 0) refuse(`eval ${evalId} has no critical regressions to acknowledge`);
    const ev = await emit('MODEL_REGRESSION_ACKNOWLEDGED', { eval_id: evalId, reason });
    return done({ event: ev.id, eval_id: evalId }, `regression(s) acknowledged for ${evalId} (${ev.id})`);
  }

  if (group === 'promote') {
    const r = await ingest(subOrArg);
    if (r.kind !== 'promotion') refuse(`expected a promotion manifest, got ${r.kind}`);
    const m = r.manifest;
    const reg = await registry();
    const ck = manifests.normalizeCheckpointKey(m.checkpoint);
    if (!reg.checkpoints.has(ck)) refuse(`checkpoint ${ck} is not registered`);
    const cur = reg.checkpoints.get(ck).stage;
    if (m.from_stage !== cur) refuse(`from_stage ${m.from_stage} is a claim the spine contradicts — derived stage of ${ck} is ${cur}`);
    if (m.to_stage !== projection.nextStage(cur)) refuse(`to_stage ${m.to_stage} is not the single forward step from ${cur}`);

    // The ride (§6): request FIRST (ids are minted at append), stage-keyed
    // tool, cascade only for candidate, then the proposal carrying the id.
    const tool = `model promote:${m.from_stage}->${m.to_stage}`;
    const req = await lib.spine.append(repoRoot, {
      type: 'APPROVAL_REQUESTED', actor: sid || null,
      data: { tool, action: null, payload: { model_id: m.model_id, checkpointKey: ck, from_stage: m.from_stage, to_stage: m.to_stage, manifestHash: r.manifestHash }, summary: `promote ${m.model_id} ${m.from_stage} -> ${m.to_stage}` },
    });
    let decision = null;
    if (m.to_stage === 'candidate' && lib.approvals?.maybeAutoDecide) {
      const auto = await lib.approvals.maybeAutoDecide(repoRoot, req);
      if (auto?.decided) decision = auto.event?.data?.decision ?? null;
    }
    const prop = await emit('MODEL_PROMOTION_PROPOSED', {
      manifestPath: r.repoRelPath, manifestHash: r.manifestHash,
      model_id: m.model_id, checkpointKey: ck, from_stage: m.from_stage, to_stage: m.to_stage,
      approvalRequestId: req.id,
    });

    const approveNow = async () => {
      const ev = await emit('MODEL_PROMOTION_APPROVED', {
        proposalId: prop.id, approval_ref: req.id, model_id: m.model_id, checkpointKey: ck, to_stage: m.to_stage,
      });
      return done({ event: ev.id, proposalId: prop.id, approvalRequestId: req.id, decision, to_stage: m.to_stage },
        `promotion approved: ${ck} -> ${m.to_stage} (${ev.id}, decision ${decision})`);
    };
    if (decision && decision.startsWith('allow')) return approveNow();
    if (decision) refuse(`promotion denied by standing policy (${decision})`);

    if (flags.wait === true) {
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const events = await lib.spine.readAll(repoRoot);
        const dec = events.find((e) => e.type === 'APPROVAL_DECIDED' && e.data?.approvalId === req.id);
        if (dec) {
          decision = dec.data.decision;
          if (['allow-once', 'allow-always'].includes(decision)) return approveNow();
          refuse(`promotion denied (${decision})`);
        }
        await new Promise((res) => setTimeout(res, WAIT_POLL_MS));
      }
      refuse(`approval wait timed out — respond with: maddu approval respond --id ${req.id} --decision allow-once, then: maddu model promote --confirm ${prop.id}`);
    }
    return done({ pending: true, proposalId: prop.id, approvalRequestId: req.id },
      `promotion proposed (pending): ${ck} ${m.from_stage} -> ${m.to_stage}\n  approve:  maddu approval respond --id ${req.id} --decision allow-once\n  confirm:  maddu model promote --confirm ${prop.id}`);
  }

  if (group === 'release') {
    const r = await ingest(subOrArg);
    if (r.kind !== 'promotion') refuse(`expected the released-promotion manifest, got ${r.kind}`);
    const m = r.manifest;
    const reg = await registry();
    const ck = manifests.normalizeCheckpointKey(m.checkpoint);
    if ((reg.checkpoints.get(ck)?.stage || 'experiment') !== 'released') {
      refuse(`checkpoint ${ck} derived stage is ${reg.checkpoints.get(ck)?.stage || 'experiment'} — release requires an approved promotion to released`);
    }
    if (typeof m.rollback_plan !== 'string' || m.rollback_plan.trim() === '') refuse('rollback_plan is required to release');
    const ev = await emit('MODEL_RELEASED', {
      manifestPath: r.repoRelPath, manifestHash: r.manifestHash,
      model_id: m.model_id, checkpointKey: ck, rollback_plan: m.rollback_plan,
    });
    return done({ event: ev.id, checkpointKey: ck }, `released: ${ck} (${ev.id})`);
  }

  if (group === 'rollback') {
    const r = await ingest(subOrArg);
    if (r.kind !== 'promotion') refuse(`expected the released-promotion manifest, got ${r.kind}`);
    const m = r.manifest;
    const reg = await registry();
    const ck = manifests.normalizeCheckpointKey(m.checkpoint);
    if (!reg.releases.some((x) => x.checkpointKey === ck)) refuse(`checkpoint ${ck} has no MODEL_RELEASED — nothing to roll back`);
    const cur = reg.checkpoints.get(ck)?.stage || 'experiment';
    const rt = flags['reverted-to'] === undefined || flags['reverted-to'] === true ? 'candidate' : flags['reverted-to'];
    const ladder = projection.MODEL_STAGES;
    if (ladder.indexOf(rt) === -1 || ladder.indexOf(rt) >= ladder.indexOf(cur)) {
      refuse(`--reverted-to ${rt} must be a stage strictly below the derived stage ${cur} — a rollback never re-elevates`);
    }
    const ev = await emit('MODEL_ROLLED_BACK', {
      manifestPath: r.repoRelPath, manifestHash: r.manifestHash,
      model_id: m.model_id, checkpointKey: ck, reverted_to: rt,
    });
    return done({ event: ev.id, checkpointKey: ck, reverted_to: rt }, `rolled back: ${ck} -> ${rt} (${ev.id})`);
  }

  if (group === 'status' || group === 'list') {
    const reg = await registry();
    if (group === 'status') {
      const modelFilter = typeof flags.model === 'string' ? flags.model : null;
      const cps = [...reg.checkpoints.values()].filter((c) => !modelFilter || c.model_id === modelFilter);
      const summary = {
        datasets: reg.datasets.size, runs: reg.runs.size, checkpoints: reg.checkpoints.size,
        evals: reg.evals.size, proposals: reg.proposals.size,
        releases: reg.releases.length, rollbacks: reg.rollbacks.length,
        unacknowledgedCriticalEvals: [...reg.evals.values()].filter((e) => e.criticalRegressions > 0 && !e.acknowledged).length,
        checkpoints_detail: cps.map((c) => ({ checkpointKey: c.checkpointKey, model_id: c.model_id, stage: c.stage })),
      };
      return done(summary, [
        `model registry — ${summary.datasets} dataset(s) · ${summary.runs} run(s) · ${summary.checkpoints} checkpoint(s) · ${summary.evals} eval(s)`,
        ...cps.map((c) => `  ${c.stage.padEnd(10)} ${c.checkpointKey.slice(0, 22)}…  ${c.model_id ?? ''}`),
        summary.unacknowledgedCriticalEvals ? `  ⚠ ${summary.unacknowledgedCriticalEvals} eval(s) carry unacknowledged critical regressions` : '',
      ].filter(Boolean).join('\n'));
    }
    const what = subOrArg;
    const views = {
      datasets: () => [...reg.datasets.values()],
      runs: () => [...reg.runs.values()],
      checkpoints: () => [...reg.checkpoints.values()],
      evals: () => [...reg.evals.values()],
      promotions: () => [...reg.proposals.values()],
    };
    if (!views[what]) usage();
    const rows = views[what]();
    return done({ [what]: rows }, rows.length ? rows.map((x) => `  ${JSON.stringify(x)}`).join('\n') : `(no ${what})`);
  }

  usage();
}
