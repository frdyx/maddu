#!/usr/bin/env node
// model-command (SLM-governance phase 3) — fixture for `maddu model` through
// the REAL CLI in real temp repos (design: docs/research/slm-governance-design.md §6).
//
// Proves:
//   • the full factory flow end-to-end: dataset snapshot → train start/
//     complete → checkpoint register → eval record (+ critical regression →
//     MODEL_REGRESSION_FOUND) → regression ack → 3-step promotion ride →
//     release → rollback — and the resulting spine passes `verifySpine` with
//     ZERO model-family issues (the CLI can only write what verify blesses);
//   • the approval ride: APPROVAL_REQUESTED is appended BEFORE the proposal
//     and the proposal carries its evt_ id; default is exit-0 pending with
//     respond+confirm instructions; --confirm refuses without an allowing
//     decision, refuses a second approve, and refuses a STALE proposal;
//   • B1 stage-key invariants: an allow-always policy on
//     `model promote:experiment->candidate` auto-approves ONLY that
//     transition — a policy on the canary/released tool keys never
//     auto-advances (the cascade is not consulted above candidate);
//   • command-level lineage refusals mirror verifier FAILs: unknown dataset,
//     unknown/duplicate run, duplicate checkpoint/eval, from_stage lie,
//     release below released, rollback of never-released, non-downward
//     --reverted-to;
//   • governance surfaces: unknown flag exit 2; secret-bearing manifest
//     refused (no partial event); regression ack demands --reason.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'bin', 'maddu.mjs');
const LIB = join(HERE, '..', '..', 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function run(repo, args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const runJson = (repo, args) => {
  const r = run(repo, [...args, '--json']);
  let body = null;
  try { body = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  return { ...r, body };
};

const HEXA = 'a'.repeat(64), HEXB = 'b'.repeat(64);
const CK = `sha256:${HEXA}`;

async function newRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-modelcmd-'));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await mkdir(join(repo, 'models'), { recursive: true });
  return repo;
}
async function writeManifest(repo, name, obj) {
  const p = join(repo, 'models', name);
  await writeFile(p, JSON.stringify(obj, null, 2));
  return `models/${name}`;
}
const M = {
  dataset: { schemaVersion: 1, kind: 'dataset-snapshot', dataset_id: 'ds1', source: 'repo:x', license: 'MIT', hash: CK, synthetic: false, train_eval_split: { train: CK, eval: `sha256:${HEXB}` } },
  train: { schemaVersion: 1, kind: 'training-run', run_id: 'r1', model_id: 'm1', base_model: { name: 'base', hash: CK }, method: 'SFT', recipe: { lr: 1e-4 }, dataset_snapshot: 'ds1', seed: 7, commit: 'abc1234' },
  trainDone: null, // filled below
  ckpt: { schemaVersion: 1, kind: 'checkpoint-registration', model_id: 'm1', run_id: 'r1', checkpoint: { uri: 's3://b/ckpt', hash: CK } },
  evalR: { schemaVersion: 1, kind: 'eval-run', eval_id: 'e1', checkpoint: CK, benchmark: 'swe-bench', harness_version: '1.0', pass_rate: 0.31, regressions: [{ vs: CK, metric: 'pass_rate', delta: -0.05, critical: true }] },
  promo: (from, to, extra = {}) => ({ schemaVersion: 1, kind: 'promotion', model_id: 'm1', checkpoint: CK, from_stage: from, to_stage: to, ...extra }),
};
M.trainDone = { ...M.train, checkpoint: { uri: 's3://b/ckpt', hash: CK }, metrics: { loss: 0.9 } };

// promote (pending) → respond allow-once → confirm. Returns proposal id.
function rideStep(repo, manifestRel) {
  const p = runJson(repo, ['model', 'promote', manifestRel]);
  if (!p.body?.pending) throw new Error(`ride step not pending: ${p.stdout} ${p.stderr}`);
  const resp = run(repo, ['approval', 'respond', '--id', p.body.approvalRequestId, '--decision', 'allow-once']);
  if (resp.code !== 0) throw new Error(`approval respond failed: ${resp.stderr}`);
  const c = runJson(repo, ['model', 'promote', '--confirm', p.body.proposalId]);
  if (!c.body?.ok) throw new Error(`confirm failed: ${c.stdout} ${c.stderr}`);
  return p.body;
}

async function main() {
  const repos = [];
  try {
    console.log('model-command: full factory flow through the real CLI');
    const repo = await newRepo(); repos.push(repo);
    const dsRel = await writeManifest(repo, 'ds.json', M.dataset);
    const trRel = await writeManifest(repo, 'train.json', M.train);
    const tdRel = await writeManifest(repo, 'train-done.json', M.trainDone);
    const ckRel = await writeManifest(repo, 'ckpt.json', M.ckpt);
    const evRel = await writeManifest(repo, 'eval.json', M.evalR);

    // lineage refusal BEFORE the dataset exists
    ok('train start before dataset snapshot refuses (exit 1)', run(repo, ['model', 'train', 'start', trRel]).code === 1);

    let r = runJson(repo, ['model', 'dataset', 'snapshot', dsRel]);
    ok('dataset snapshot ok with pinned manifestHash', r.body?.ok === true && /^sha256:[0-9a-f]{64}$/.test(r.body.manifestHash));

    ok('train start ok', runJson(repo, ['model', 'train', 'start', trRel]).body?.ok === true);
    ok('duplicate run_id refused', run(repo, ['model', 'train', 'start', trRel]).code === 1);
    ok('train complete requires forCompletion shape (bare manifest refused)', run(repo, ['model', 'train', 'complete', trRel]).code === 1);
    r = runJson(repo, ['model', 'train', 'complete', tdRel]);
    ok('train complete ok with normalized checkpointKey', r.body?.checkpointKey === CK);

    ok('checkpoint register ok', runJson(repo, ['model', 'checkpoint', 'register', ckRel]).body?.ok === true);
    ok('duplicate checkpoint refused', run(repo, ['model', 'checkpoint', 'register', ckRel]).code === 1);

    r = runJson(repo, ['model', 'eval', 'record', evRel]);
    ok('eval record ok and emits one MODEL_REGRESSION_FOUND', r.body?.ok === true && r.body.criticalRegressions === 1 && r.body.regressionEvents.length === 1);
    ok('duplicate eval_id refused', run(repo, ['model', 'eval', 'record', evRel]).code === 1);
    ok('regression ack without --reason refuses', run(repo, ['model', 'regression', 'ack', 'e1']).code === 1);
    ok('regression ack unknown eval refuses', run(repo, ['model', 'regression', 'ack', 'ghost', '--reason', 'x']).code === 1);
    ok('regression ack with a secret-shaped reason refuses', run(repo, ['model', 'regression', 'ack', 'e1', '--reason', 'key AKIAIOSFODNN7EXAMPLE']).code === 1);
    ok('regression ack ok', runJson(repo, ['model', 'regression', 'ack', 'e1', '--reason', 'accepted benchmark drift']).body?.ok === true);
    ok('duplicate dataset_id refused (unique per repo)', run(repo, ['model', 'dataset', 'snapshot', dsRel]).code === 1);
    // read surfaces
    {
      const l = runJson(repo, ['model', 'list', 'datasets']);
      ok('list datasets returns the recorded dataset', l.body?.ok === true && l.body.datasets.length === 1 && l.body.datasets[0].dataset_id === 'ds1');
      const s = runJson(repo, ['model', 'status', '--model', 'ghost-model']);
      ok('status --model filters checkpoint detail', s.body?.ok === true && s.body.checkpoints_detail.length === 0);
    }

    console.log('model-command: the approval ride');
    // from_stage lie refused before anything is emitted
    const lieRel = await writeManifest(repo, 'lie.json', M.promo('candidate', 'canary'));
    ok('from_stage lie refused against the derived stage', run(repo, ['model', 'promote', lieRel]).code === 1);

    const p1Rel = await writeManifest(repo, 'p1.json', M.promo('experiment', 'candidate'));
    const pend = runJson(repo, ['model', 'promote', p1Rel]);
    ok('promote defaults to exit-0 pending with both ids', pend.code === 0 && pend.body?.pending === true && !!pend.body.proposalId && !!pend.body.approvalRequestId);

    // spine order: the request rides BEFORE the proposal and is referenced by it
    {
      const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
      const events = await spine.readAll(repo);
      const reqIdx = events.findIndex((e) => e.id === pend.body.approvalRequestId);
      const propIdx = events.findIndex((e) => e.id === pend.body.proposalId);
      ok('APPROVAL_REQUESTED appended before MODEL_PROMOTION_PROPOSED', reqIdx !== -1 && propIdx !== -1 && reqIdx < propIdx);
      ok('proposal carries its own approvalRequestId', events[propIdx].data.approvalRequestId === pend.body.approvalRequestId);
      ok('request tool key is stage-keyed', events[reqIdx].data.tool === 'model promote:experiment->candidate');
    }

    ok('confirm without a decision refuses with the respond instruction', run(repo, ['model', 'promote', '--confirm', pend.body.proposalId]).code === 1);
    run(repo, ['approval', 'respond', '--id', pend.body.approvalRequestId, '--decision', 'allow-once']);
    ok('confirm after allow emits the approval', runJson(repo, ['model', 'promote', '--confirm', pend.body.proposalId]).body?.ok === true);
    ok('second confirm refused (one approve per proposal)', run(repo, ['model', 'promote', '--confirm', pend.body.proposalId]).code === 1);

    console.log('model-command: release, rollback, verify');
    const relRel = await writeManifest(repo, 'rel.json', M.promo('canary', 'released', { rollback_plan: 'repoint the alias' }));
    ok('release below released stage refused', run(repo, ['model', 'release', relRel]).code === 1);
    // complete the ladder: candidate→canary, canary→released
    rideStep(repo, await writeManifest(repo, 'p2.json', M.promo('candidate', 'canary', { rollback_plan: 'repoint the alias' })));
    rideStep(repo, relRel); // canary→released rides the release manifest
    ok('status shows the checkpoint at released', runJson(repo, ['model', 'status']).body?.checkpoints_detail?.[0]?.stage === 'released');
    ok('release ok at released stage', runJson(repo, ['model', 'release', relRel]).body?.ok === true);
    ok('rollback --reverted-to released refused (never re-elevates)', run(repo, ['model', 'rollback', relRel, '--reverted-to', 'released']).code === 1);
    r = runJson(repo, ['model', 'rollback', relRel]);
    ok('rollback defaults to candidate', r.body?.reverted_to === 'candidate');
    ok('rollback of never-released refuses', (await (async () => {
      const other = await newRepo(); repos.push(other);
      const rr = await writeManifest(other, 'rel.json', M.promo('canary', 'released', { rollback_plan: 'x' }));
      return run(other, ['model', 'rollback', rr]).code;
    })()) === 1);

    // the whole CLI-written spine passes the verifier with zero model issues
    {
      const verify = await import(pathToFileURL(join(LIB, 'verify.mjs')).href);
      const res = await verify.verifySpine(repo);
      const modelIssues = res.issues.filter((i) => i.kind.includes('model'));
      ok('CLI-written spine verifies with zero model-family issues', modelIssues.length === 0, modelIssues.map((i) => i.kind).join(','));
    }

    console.log('model-command: B1 stage-key invariants (auto-decide)');
    {
      const repo2 = await newRepo(); repos.push(repo2);
      await writeManifest(repo2, 'ds.json', M.dataset);
      await writeManifest(repo2, 'train.json', M.train);
      await writeManifest(repo2, 'train-done.json', M.trainDone);
      await writeManifest(repo2, 'ckpt.json', M.ckpt);
      run(repo2, ['model', 'dataset', 'snapshot', 'models/ds.json']);
      run(repo2, ['model', 'train', 'start', 'models/train.json']);
      run(repo2, ['model', 'train', 'complete', 'models/train-done.json']);
      run(repo2, ['model', 'checkpoint', 'register', 'models/ckpt.json']);
      // standing allow-always on BOTH the candidate and canary tool keys
      run(repo2, ['approval', 'policy', '--tool', 'model promote:experiment->candidate', '--decision', 'allow-always']);
      run(repo2, ['approval', 'policy', '--tool', 'model promote:candidate->canary', '--decision', 'allow-always']);
      const c1Rel = await writeManifest(repo2, 'c1.json', M.promo('experiment', 'candidate'));
      const a1 = runJson(repo2, ['model', 'promote', c1Rel]);
      ok('policy auto-approves experiment->candidate (cascade consulted)', a1.body?.ok === true && !a1.body.pending && a1.body.to_stage === 'candidate');
      const c2Rel = await writeManifest(repo2, 'c2.json', M.promo('candidate', 'canary', { rollback_plan: 'repoint the alias' }));
      const a2 = runJson(repo2, ['model', 'promote', c2Rel]);
      ok('policy on the canary key NEVER auto-advances (no cascade above candidate)', a2.body?.pending === true, JSON.stringify(a2.body));
    }

    console.log('model-command: governance surfaces');
    {
      const repo3 = await newRepo(); repos.push(repo3);
      ok('unknown flag exits 2', run(repo3, ['model', 'status', '--force']).code === 2);
      const secRel = await writeManifest(repo3, 'sec.json', { ...M.dataset, dedup_policy: 'AKIAIOSFODNN7EXAMPLE' });
      const sec = run(repo3, ['model', 'dataset', 'snapshot', secRel]);
      ok('secret-bearing manifest refused', sec.code === 1);
      const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
      ok('refusal wrote nothing to the spine', (await spine.readAll(repo3)).length === 0);
      // stale confirm: proposal for a checkpoint that then moved
      const repo4 = await newRepo(); repos.push(repo4);
      await writeManifest(repo4, 'ds.json', M.dataset);
      await writeManifest(repo4, 'train.json', M.train);
      await writeManifest(repo4, 'train-done.json', M.trainDone);
      await writeManifest(repo4, 'ckpt.json', M.ckpt);
      run(repo4, ['model', 'dataset', 'snapshot', 'models/ds.json']);
      run(repo4, ['model', 'train', 'start', 'models/train.json']);
      run(repo4, ['model', 'train', 'complete', 'models/train-done.json']);
      run(repo4, ['model', 'checkpoint', 'register', 'models/ckpt.json']);
      const s1 = await writeManifest(repo4, 's1.json', M.promo('experiment', 'candidate'));
      const pA = runJson(repo4, ['model', 'promote', s1]);   // proposal A pending
      const pB = runJson(repo4, ['model', 'promote', s1]);   // proposal B pending (same step)
      run(repo4, ['approval', 'respond', '--id', pA.body.approvalRequestId, '--decision', 'allow-once']);
      run(repo4, ['approval', 'respond', '--id', pB.body.approvalRequestId, '--decision', 'allow-once']);
      runJson(repo4, ['model', 'promote', '--confirm', pA.body.proposalId]); // A lands, stage → candidate
      ok('stale confirm (checkpoint moved since proposal) refused', run(repo4, ['model', 'promote', '--confirm', pB.body.proposalId]).code === 1);
    }

    console.log(`\nmodel-command: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    for (const r of repos) await rm(r, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
