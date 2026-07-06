#!/usr/bin/env node
// model-gate-pack (SLM-governance phase 4) — fixture for the operator
// starter pack + `maddu model gates install` (design §7).
//
// Proves:
//   • install mechanics: 12 gates land in .maddu/gates/ marker-stamped;
//     second install is idempotent (all `current`); an operator-EDITED gate
//     is never overwritten (skip-modified + content preserved) while a
//     pack upgrade path (dest == previously-installed hash) refreshes;
//     --force-list is a pure dry run (no writes);
//   • discovery: discoverGates surfaces all 12 as __source operator —
//     builtin count (and thus the 72/72 budget) untouched;
//   • empty-spine posture: on a spine with zero MODEL events every pack
//     gate passes with a nothing-to-check message (installing the pack
//     never reds a non-factory repo);
//   • honest SKIP: in a repo WITHOUT the installed runtime, the two
//     runtime-resolving gates (dataset-manifest-no-secrets,
//     no-critical-regression) SKIP with an explicit message — never ok-by-
//     silence, never a crash;
//   • behavior, per gate, on crafted spines/manifests: license-unknown,
//     unpinned hash, unlabeled synthetic, divergent split declarations,
//     declared contamination (source contains benchmark + train==eval
//     hash), unpinned training config, unpinned harness (warn), critical
//     regression on a candidate checkpoint fails then PASSES after `ack`,
//     budget overrun (opt-in config), incomplete candidate provenance,
//     missing rollback plan, post-ingest secret edit caught.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm, readFile, writeFile, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BIN = join(ROOT, 'bin', 'maddu.mjs');
const LIB = join(ROOT, 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function run(repo, args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) { return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }; }
}
const runJson = (repo, args) => { const r = run(repo, [...args, '--json']); try { r.body = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { r.body = null; } return r; };

const HEXA = 'a'.repeat(64), HEXB = 'b'.repeat(64);
const CK = `sha256:${HEXA}`;
const MF = { manifestPath: 'models/m.json', manifestHash: `sha256:${'c'.repeat(64)}` };

async function newRepo({ withRuntime = false } = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-gatepack-'));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await mkdir(join(repo, 'models'), { recursive: true });
  if (withRuntime) {
    // A partial copy would hijack resolveLibDir for every command run in
    // this repo — mirror the full runtime, like a real consumer install.
    await cp(join(ROOT, 'template', 'maddu', 'runtime'), join(repo, 'maddu', 'runtime'), { recursive: true });
  }
  return repo;
}

async function main() {
  const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
  const gates = await import(pathToFileURL(join(LIB, 'gates.mjs')).href);
  const repos = [];
  const ap = (repo, type, data) => spine.append(repo, { type, data: { schemaVersion: 1, ...data } });
  const gateResult = async (repo, id) => {
    const r = await gates.runGates(repo, { emitEvents: false, onlyId: id });
    return r.runs[0] ?? null;
  };

  try {
    console.log('model-gate-pack: install mechanics');
    const repo = await newRepo({ withRuntime: true }); repos.push(repo);
    let r = runJson(repo, ['model', 'gates', 'install']);
    ok('install lands 12 gates', r.body?.ok === true && r.body.counts.install === 12, JSON.stringify(r.body?.counts));
    const installedList = await import('node:fs/promises').then((fs) => fs.readdir(join(repo, '.maddu', 'gates')));
    ok('12 .mjs files + pack manifest on disk', installedList.filter((f) => f.endsWith('.mjs')).length === 12 && installedList.includes('.model-pack-manifest.json'));
    const one = await readFile(join(repo, '.maddu', 'gates', 'dataset-license-known.mjs'), 'utf8');
    ok('installed gates are marker-stamped', one.startsWith('// @maddu-model-gates v1'));

    r = runJson(repo, ['model', 'gates', 'install']);
    ok('second install is idempotent (12 current)', r.body?.counts?.current === 12, JSON.stringify(r.body?.counts));

    // operator edit is preserved
    const editedPath = join(repo, '.maddu', 'gates', 'dataset-license-known.mjs');
    const edited = one + '\n// operator tweak\n';
    await writeFile(editedPath, edited);
    r = runJson(repo, ['model', 'gates', 'install']);
    ok('operator-edited gate skipped on reinstall', r.body?.counts?.['skip-modified'] === 1 && r.body.skipped[0] === 'dataset-license-known.mjs');
    ok('operator edit content preserved byte-for-byte', (await readFile(editedPath, 'utf8')) === edited);

    // --force-list is a dry run
    await rm(editedPath);
    const dry = runJson(repo, ['model', 'gates', 'install', '--force-list']);
    ok('--force-list reports the missing gate without writing', dry.body?.dryRun === true
      && dry.body.plan.find((p) => p.file === 'dataset-license-known.mjs')?.action === 'install');
    ok('--force-list wrote nothing', !(await import('node:fs/promises').then((fs) => fs.readdir(join(repo, '.maddu', 'gates')))).includes('dataset-license-known.mjs'));
    runJson(repo, ['model', 'gates', 'install']); // restore for behavior tests

    console.log('model-gate-pack: discovery + empty-spine posture');
    const all = await gates.discoverGates(repo);
    const pack = all.filter((g) => g.__source === 'operator');
    ok('discoverGates surfaces 12 operator gates', pack.length === 12, pack.map((g) => g.id).join(','));
    {
      const res = await gates.runGates(repo, { emitEvents: false });
      const packRuns = res.runs.filter((x) => x.source === 'operator');
      ok('empty spine: all 12 pack gates pass (nothing-to-check)', packRuns.length === 12 && packRuns.every((x) => x.ok === true),
        packRuns.filter((x) => !x.ok).map((x) => x.gateId).join(','));
    }

    console.log('model-gate-pack: honest SKIP without the runtime');
    {
      const bare = await newRepo({ withRuntime: false }); repos.push(bare);
      runJson(bare, ['model', 'gates', 'install']);
      await ap(bare, 'MODEL_DATASET_SNAPSHOT_RECORDED', { ...MF, dataset_id: 'd', source: 's', license: 'MIT', hash: CK, synthetic: false });
      await ap(bare, 'MODEL_EVAL_RAN', { ...MF, eval_id: 'e', checkpointKey: CK, benchmark: 'b', harness_version: '1', pass_rate: 0.1 });
      await ap(bare, 'MODEL_REGRESSION_FOUND', { eval_id: 'e', checkpointKey: CK, metric: 'm', delta: -1, critical: true });
      const noSec = await gateResult(bare, 'dataset-manifest-no-secrets');
      ok('no-secrets SKIPs honestly without the runtime', noSec?.ok === true && /unresolvable|skipped/.test(noSec.message));
      const noReg = await gateResult(bare, 'no-critical-regression');
      ok('no-critical-regression SKIPs honestly without the runtime', noReg?.ok === true && /unresolvable|skipped/.test(noReg.message));
    }

    console.log('model-gate-pack: per-gate behavior on crafted records');
    // license + hash + synthetic + split + contamination
    await ap(repo, 'MODEL_DATASET_SNAPSHOT_RECORDED', { manifestPath: 'models/bad.json', manifestHash: `sha256:${'d'.repeat(64)}`, dataset_id: 'bad-ds', source: 'dump incl. swe-bench cases', license: 'unknown', hash: 'nope', synthetic: true });
    await writeFile(join(repo, 'models', 'bad.json'), JSON.stringify({ kind: 'dataset-snapshot', train_eval_split: { train: CK, eval: CK } }));
    await ap(repo, 'MODEL_DATASET_SNAPSHOT_RECORDED', { manifestPath: 'models/bad.json', manifestHash: `sha256:${'e'.repeat(64)}`, dataset_id: 'bad-ds', source: 'dump', license: 'MIT', hash: CK, synthetic: false });

    ok('license-unknown fails', (await gateResult(repo, 'dataset-license-known'))?.ok === false);
    ok('unpinned dataset hash fails', (await gateResult(repo, 'dataset-hash-pinned'))?.ok === false);
    ok('unlabeled synthetic fails', (await gateResult(repo, 'dataset-synthetic-labeled'))?.ok === false);
    ok('divergent snapshot declarations fail split-frozen', (await gateResult(repo, 'train-eval-split-frozen'))?.ok === false);

    // contamination: checkpoint chain wired to bad-ds + eval on swe-bench + identical split hashes in file
    await ap(repo, 'MODEL_TRAINING_RUN_STARTED', { ...MF, run_id: 'r1', model_id: 'm1', method: 'SFT', dataset_snapshot: 'bad-ds', base_model: { name: 'b' }, seed: 'x', commit: '' });
    await ap(repo, 'MODEL_TRAINING_RUN_COMPLETED', { ...MF, run_id: 'r1', model_id: 'm1', checkpoint: { uri: 'u', hash: CK }, checkpointKey: CK, metrics: {} });
    await ap(repo, 'MODEL_CHECKPOINT_REGISTERED', { ...MF, model_id: 'm1', checkpoint: { uri: 'u', hash: CK }, checkpointKey: CK, run_id: 'r1' });
    await ap(repo, 'MODEL_EVAL_RAN', { manifestPath: 'models/eval.json', manifestHash: `sha256:${'f'.repeat(64)}`, eval_id: 'e1', checkpointKey: CK, benchmark: 'swe-bench', pass_rate: 0.2 });
    await writeFile(join(repo, 'models', 'eval.json'), JSON.stringify({ kind: 'eval-run', latency: { ms: 9000 }, cost: { usd: 2 } }));
    const cont = await gateResult(repo, 'benchmark-contamination-check');
    ok('declared contamination warns (source + identical split)', cont?.ok === false && /declaration-level/.test(cont.message));

    ok('unpinned training config fails', (await gateResult(repo, 'training-config-pinned'))?.ok === false);
    ok('unpinned harness version flags (warn severity)', (await gateResult(repo, 'eval-harness-version-pinned'))?.ok === false);

    // regression on a candidate checkpoint: fail → ack → pass
    await ap(repo, 'MODEL_REGRESSION_FOUND', { eval_id: 'e1', checkpointKey: CK, metric: 'pass_rate', delta: -0.2, critical: true });
    const req = await spine.append(repo, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:experiment->candidate', action: null, payload: null, summary: null } });
    const prop = await ap(repo, 'MODEL_PROMOTION_PROPOSED', { ...MF, model_id: 'm1', checkpointKey: CK, from_stage: 'experiment', to_stage: 'candidate', approvalRequestId: req.id });
    await spine.append(repo, { type: 'APPROVAL_DECIDED', data: { approvalId: req.id, decision: 'allow-once', reason: null, tool: null } });
    await ap(repo, 'MODEL_PROMOTION_APPROVED', { proposalId: prop.id, approval_ref: req.id, model_id: 'm1', checkpointKey: CK, to_stage: 'candidate' });
    ok('unacked critical regression on candidate fails', (await gateResult(repo, 'no-critical-regression'))?.ok === false);
    await ap(repo, 'MODEL_REGRESSION_ACKNOWLEDGED', { eval_id: 'e1', reason: 'accepted drift' });
    ok('acknowledged regression passes (recovery is the ack verb)', (await gateResult(repo, 'no-critical-regression'))?.ok === true);

    // budgets: opt-in
    ok('budgets unconfigured → opt-in pass', (await gateResult(repo, 'latency-cost-budget-met'))?.ok === true);
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'model-budgets.json'), JSON.stringify({ 'swe-bench': { latency_ms_max: 2500, cost_usd_max: 0.5 } }));
    const bud = await gateResult(repo, 'latency-cost-budget-met');
    ok('declared budget overrun flags (warn severity)', bud?.ok === false && /overrun/.test(bud.message));

    // candidate provenance: e1 exists for CK, so provenance needs a gap — dataset lineage broken (bad-ds recorded → present; run completed → present; approval → present; eval → present) — craft a SECOND candidate checkpoint with nothing
    const CK2 = `sha256:${HEXB}`;
    await ap(repo, 'MODEL_CHECKPOINT_REGISTERED', { ...MF, model_id: 'm2', checkpoint: { uri: 'u2', hash: CK2 }, checkpointKey: CK2 });
    const req2 = await spine.append(repo, { type: 'APPROVAL_REQUESTED', data: { tool: 'model promote:experiment->candidate', action: null, payload: null, summary: null } });
    const prop2 = await ap(repo, 'MODEL_PROMOTION_PROPOSED', { ...MF, model_id: 'm2', checkpointKey: CK2, from_stage: 'experiment', to_stage: 'candidate', approvalRequestId: req2.id });
    await spine.append(repo, { type: 'APPROVAL_DECIDED', data: { approvalId: req2.id, decision: 'allow-once', reason: null, tool: null } });
    await ap(repo, 'MODEL_PROMOTION_APPROVED', { proposalId: prop2.id, approval_ref: req2.id, model_id: 'm2', checkpointKey: CK2, to_stage: 'candidate' });
    const cpc = await gateResult(repo, 'candidate-promotion-complete');
    ok('foreign candidate without lineage/eval fails provenance', cpc?.ok === false && /missing/.test(cpc.message));

    // rollback plan: release without one
    await ap(repo, 'MODEL_RELEASED', { ...MF, model_id: 'm1', checkpointKey: CK, rollback_plan: '' });
    ok('release without rollback plan fails', (await gateResult(repo, 'rollback-plan-present'))?.ok === false);

    // contamination check #1 in ISOLATION (p4 red-team SF-2): source contains
    // the benchmark id, split hashes DIFFER — signal must come from the
    // source-substring path alone
    {
      const CKC = `sha256:${'9'.repeat(64)}`;
      await ap(repo, 'MODEL_DATASET_SNAPSHOT_RECORDED', { manifestPath: 'models/cont.json', manifestHash: `sha256:${'8'.repeat(64)}`, dataset_id: 'cont-ds', source: 'tasks mined from swe-bench-extra repos', license: 'MIT', hash: CK, synthetic: false });
      await writeFile(join(repo, 'models', 'cont.json'), JSON.stringify({ kind: 'dataset-snapshot', train_eval_split: { train: CK, eval: `sha256:${HEXB}` } }));
      await ap(repo, 'MODEL_TRAINING_RUN_STARTED', { ...MF, run_id: 'rc', model_id: 'mc', method: 'SFT', dataset_snapshot: 'cont-ds', base_model: { name: 'b', hash: CK }, seed: 1, commit: 'abc' });
      await ap(repo, 'MODEL_TRAINING_RUN_COMPLETED', { ...MF, run_id: 'rc', model_id: 'mc', checkpoint: { uri: 'u', hash: CKC }, checkpointKey: CKC, metrics: {} });
      await ap(repo, 'MODEL_CHECKPOINT_REGISTERED', { ...MF, model_id: 'mc', checkpoint: { uri: 'u', hash: CKC }, checkpointKey: CKC, run_id: 'rc' });
      await ap(repo, 'MODEL_EVAL_RAN', { ...MF, eval_id: 'ec', checkpointKey: CKC.toUpperCase().replace('SHA256', 'sha256'), benchmark: 'swe-bench-extra', harness_version: '1', pass_rate: 0.1 });
      const c1 = await gateResult(repo, 'benchmark-contamination-check');
      ok('contamination check #1 fires in isolation (source substring, distinct splits, cased key)',
        c1?.ok === false && /appears in training dataset cont-ds/.test(c1.message));
    }

    // rollback-plan proposal-level check: a hash-CURRENT canary proposal
    // whose manifest declares no rollback_plan
    {
      const { createHash } = await import('node:crypto');
      const raw = JSON.stringify({ kind: 'promotion', from_stage: 'candidate', to_stage: 'canary' });
      await writeFile(join(repo, 'models', 'noplan.json'), raw);
      const h = `sha256:${createHash('sha256').update(Buffer.from(raw)).digest('hex')}`;
      await ap(repo, 'MODEL_PROMOTION_PROPOSED', { manifestPath: 'models/noplan.json', manifestHash: h, model_id: 'm1', checkpointKey: CK, from_stage: 'candidate', to_stage: 'canary', approvalRequestId: 'evt_x' });
      const rp = await gateResult(repo, 'rollback-plan-present');
      ok('hash-current canary proposal without rollback_plan flagged', rp?.ok === false && /declares no rollback_plan/.test(rp.message));
    }

    // missing recorded manifest → WARN status, never a red (p4 red-team SF-1)
    {
      const warnRepo = await newRepo({ withRuntime: true }); repos.push(warnRepo);
      runJson(warnRepo, ['model', 'gates', 'install']);
      await ap(warnRepo, 'MODEL_DATASET_SNAPSHOT_RECORDED', { manifestPath: 'models/gone.json', manifestHash: `sha256:${'7'.repeat(64)}`, dataset_id: 'gone', source: 's', license: 'MIT', hash: CK, synthetic: false });
      const gone = await gateResult(warnRepo, 'dataset-manifest-no-secrets');
      ok('missing recorded manifest is WARN-status, not a red', gone?.ok === false && gone?.status === 'warn' && /missing from disk/.test(gone.message));
    }

    // post-ingest secret edit caught by the file re-scan
    await writeFile(join(repo, 'models', 'm.json'), JSON.stringify({ kind: 'x', note: 'AKIAIOSFODNN7EXAMPLE' }));
    const sec = await gateResult(repo, 'dataset-manifest-no-secrets');
    ok('post-ingest secret edit caught by the manifest re-scan', sec?.ok === false && /secret-shaped/.test(sec.message));

    console.log(`\nmodel-gate-pack: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    for (const r of repos) await rm(r, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
