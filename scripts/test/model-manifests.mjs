#!/usr/bin/env node
// model-manifests (SLM-governance phase 1) — fixture for the pure manifest
// validators + the 5-step single-read ingest (design: docs/research/
// slm-governance-design.md §4). Proves, against real temp repos:
//   • valid manifests of all five kinds ingest ok; manifestHash is the
//     sha256 of the file bytes; repoRelPath is forward-slash repo-relative.
//   • strict fields: missing required refuses (field named); unknown
//     top-level WARNs without refusing; schemaVersion !== 1 refuses;
//     unknown kind refuses; non-JSON refuses cleanly.
//   • conditional rules: synthetic-without-generator_model, method enum,
//     forCompletion (checkpoint+metrics), stage adjacency, rollback_plan
//     for canary/released, approval-shaped fields WARN in promotion,
//     eval harness_version absent → WARN not refusal.
//   • checkpoint identity: lowercase sha256:<hex> normalization, object and
//     string forms, malformed → null.
//   • secret gate: a key-bearing manifest refuses with the leaf path named,
//     returns nothing partial; a tab-hidden AKIA leaf (the EXP deepRedact
//     JSON-escape shift) is still caught at leaf level.
//   • path safety: symlinked manifest refused; file outside the repo
//     refused after resolution.
//   • determinism: two ingests of the same bytes → deep-equal results.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MANIFEST_KINDS, STAGES, TRAINING_METHODS,
  normalizeCheckpointKey, validateManifest, ingestManifestFile,
} from '../../template/maddu/runtime/lib/model-manifests.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const HEX = 'a'.repeat(64);
const CK = `sha256:${HEX}`;

function validByKind() {
  return {
    'dataset-snapshot': {
      schemaVersion: 1, kind: 'dataset-snapshot', dataset_id: 'tickets-v3',
      source: 'repo:acme/support-dump', license: 'CC-BY-4.0', hash: CK, synthetic: true,
      generator_model: 'local-llm', train_eval_split: { train: CK, eval: `sha256:${'b'.repeat(64)}` },
    },
    'training-run': {
      schemaVersion: 1, kind: 'training-run', run_id: 'run-a', model_id: 'm1',
      base_model: { name: 'base-8b', hash: CK }, method: 'SFT', recipe: { lr: 0.0001 },
      dataset_snapshot: 'tickets-v3', seed: 42, commit: 'abc1234',
    },
    'eval-run': {
      schemaVersion: 1, kind: 'eval-run', eval_id: 'ev-1', checkpoint: CK,
      benchmark: 'swe-bench-verified', harness_version: '1.4.2', pass_rate: 0.312,
      regressions: [{ vs: CK, metric: 'pass_rate', delta: -0.04, critical: true }],
    },
    'promotion': {
      schemaVersion: 1, kind: 'promotion', model_id: 'm1', checkpoint: CK,
      from_stage: 'experiment', to_stage: 'candidate',
    },
    'checkpoint-registration': {
      schemaVersion: 1, kind: 'checkpoint-registration', model_id: 'm1',
      run_id: 'run-a', checkpoint: { uri: 's3://b/ckpt', hash: CK },
    },
  };
}

async function main() {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-manifests-'));
  const outside = await mkdtemp(join(tmpdir(), 'maddu-outside-'));
  await mkdir(join(repo, 'models'), { recursive: true });
  const write = async (name, obj, raw = null) => {
    const p = join(repo, 'models', name);
    await writeFile(p, raw ?? JSON.stringify(obj, null, 2));
    return p;
  };

  try {
    console.log('model-manifests: pure validation');

    // every kind's happy path validates pure
    const valid = validByKind();
    for (const kind of MANIFEST_KINDS) {
      const r = validateManifest(valid[kind]);
      ok(`valid ${kind} passes`, r.ok && r.kind === kind, r.errors.join('; '));
    }

    let r = validateManifest({ ...valid['dataset-snapshot'], dataset_id: undefined });
    ok('missing required field refuses and names it', !r.ok && r.errors.some((e) => e.includes('dataset_id')));

    r = validateManifest({ ...valid['dataset-snapshot'], extra_thing: 1 });
    ok('unknown top-level field WARNs without refusing', r.ok && r.warnings.some((w) => w.includes('extra_thing')));

    r = validateManifest({ ...valid['promotion'], schemaVersion: 2 });
    ok('schemaVersion !== 1 refuses', !r.ok && r.errors.some((e) => e.includes('schemaVersion')));

    r = validateManifest({ schemaVersion: 1, kind: 'weights-blob' });
    ok('unknown kind refuses', !r.ok && r.errors.some((e) => e.includes('kind')));

    r = validateManifest({ ...valid['dataset-snapshot'], generator_model: undefined });
    ok('synthetic without generator_model refuses', !r.ok && r.errors.some((e) => e.includes('generator_model')));

    r = validateManifest({ ...valid['training-run'], method: 'RLHF' });
    ok('method outside the enum refuses', !r.ok && r.errors.some((e) => e.includes(TRAINING_METHODS.join('|'))));

    r = validateManifest(valid['training-run'], { forCompletion: true });
    ok('forCompletion requires checkpoint + metrics', !r.ok
      && r.errors.some((e) => e.includes('checkpoint'))
      && r.errors.some((e) => e.includes('metrics')));

    r = validateManifest({ ...valid['training-run'], checkpoint: { uri: 's3://b/c', hash: CK }, metrics: { loss: 1.2 } }, { forCompletion: true });
    ok('forCompletion with checkpoint + metrics passes', r.ok, r.errors.join('; '));

    const evNoHarness = { ...valid['eval-run'] };
    delete evNoHarness.harness_version;
    r = validateManifest(evNoHarness);
    ok('eval without harness_version passes with WARN (never refusal)', r.ok && r.warnings.some((w) => w.includes('harness_version')));

    r = validateManifest({ ...valid['promotion'], to_stage: 'canary' });
    ok('stage skip refuses (experiment -> canary)', !r.ok && r.errors.some((e) => e.includes('single forward step')));

    r = validateManifest({ ...valid['promotion'], from_stage: 'candidate', to_stage: 'canary' });
    ok('canary without rollback_plan refuses', !r.ok && r.errors.some((e) => e.includes('rollback_plan')));

    r = validateManifest({ ...valid['promotion'], from_stage: 'candidate', to_stage: 'canary', rollback_plan: 'repoint alias' });
    ok('canary with rollback_plan passes', r.ok, r.errors.join('; '));

    r = validateManifest({ ...valid['promotion'], approval_ref: 'evt_x' });
    ok('approval-shaped manifest field WARNs (linkage is event data)', r.ok && r.warnings.some((w) => w.includes('approval_ref')));

    ok('STAGES ladder is the design ladder', STAGES.join(',') === 'experiment,candidate,canary,released');

    console.log('model-manifests: checkpoint identity key');
    ok('uppercase prefix + hex normalizes to canonical lowercase', normalizeCheckpointKey(`SHA256:${HEX.toUpperCase()}`) === CK);
    ok('uppercase HEX (lowercase prefix) normalizes', normalizeCheckpointKey(`sha256:${HEX.toUpperCase()}`) === CK);
    ok('object form ({hash}) accepted', normalizeCheckpointKey({ uri: 'x', hash: CK }) === CK);
    ok('malformed value → null', normalizeCheckpointKey('sha256:zz') === null && normalizeCheckpointKey(42) === null);

    console.log('model-manifests: ingest (path safety, pinning, secret gate)');

    const p1 = await write('ds.json', valid['dataset-snapshot']);
    const i1 = await ingestManifestFile(repo, p1);
    const bytes = JSON.stringify(valid['dataset-snapshot'], null, 2);
    const expectHash = `sha256:${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`;
    ok('valid manifest ingests ok', i1.ok === true, (i1.errors || []).join('; '));
    ok('manifestHash pins the file bytes', i1.manifestHash === expectHash);
    ok('repoRelPath is forward-slash repo-relative', i1.repoRelPath === 'models/ds.json');

    const i1again = await ingestManifestFile(repo, p1);
    ok('ingest is deterministic (same bytes → deep-equal result)', JSON.stringify(i1) === JSON.stringify(i1again));

    const iRel = await ingestManifestFile(repo, 'models/ds.json');
    ok('relative path argument resolves against the repo root', iRel.ok === true && iRel.manifestHash === expectHash);

    const pBad = await write('bad.json', null, '{ not json');
    const iBad = await ingestManifestFile(repo, pBad);
    ok('non-JSON refuses cleanly', !iBad.ok && iBad.errors.some((e) => e.includes('not valid JSON')));

    const iMissing = await ingestManifestFile(repo, join(repo, 'models', 'nope.json'));
    ok('missing file refuses', !iMissing.ok && iMissing.errors.some((e) => e.includes('not found')));

    // secret gate: an AWS-shaped key in a leaf refuses with the path named
    const secret = { ...valid['training-run'], recipe: { note: 'AKIAIOSFODNN7EXAMPLE aws key' } };
    const pSec = await write('secret.json', secret);
    const iSec = await ingestManifestFile(repo, pSec);
    ok('secret-bearing manifest refuses', iSec.ok === false);
    ok('refusal names the leaf path and the no-skip stance', !iSec.ok
      && iSec.errors[0].includes('$.recipe.note') && iSec.errors[0].includes('no skip flag'));
    ok('refusal returns nothing partial (no hash, no manifest)', !('manifestHash' in iSec) && !('manifest' in iSec));

    // deepRedact lesson: tab-prefixed AKIA leaf still caught at leaf level
    const hidden = { ...valid['training-run'], recipe: { note: '\tAKIAIOSFODNN7EXAMPLE' } };
    const pHid = await write('hidden.json', hidden);
    const iHid = await ingestManifestFile(repo, pHid);
    ok('escape-shifted secret leaf still refused (leaf-level sweep)', !iHid.ok && iHid.errors[0].includes('$.recipe.note'));

    // red-team bypass (p1 round 1): secret hiding in a JSON KEY with an
    // escape-shift prefix — dodges the whole-text scan (no word boundary
    // after \t in serialized form) and the value-only leaf walk
    const keySecret = { ...valid['training-run'], recipe: { '\tAKIAIOSFODNN7EXAMPLE': true } };
    const pKey = await write('key-secret.json', keySecret);
    const iKey = await ingestManifestFile(repo, pKey);
    ok('escape-shifted secret in a JSON KEY refused (key sweep)', !iKey.ok && iKey.errors[0].includes('<key:'));
    ok('key-secret refusal never echoes the raw secret', !iKey.ok && !iKey.errors[0].includes('AKIAIOSFODNN7EXAMPLE'));

    // secret key AND secret value: the child path must carry the redacted
    // key segment, never the raw one (p1 round-2 nit)
    const dblSecret = { ...valid['training-run'], recipe: { '\tAKIAIOSFODNN7EXAMPLE': 'AKIAIOSFODNN7EXAMPLE' } };
    const pDbl = await write('double-secret.json', dblSecret);
    const iDbl = await ingestManifestFile(repo, pDbl);
    ok('secret-key + secret-value refusal echoes no raw secret anywhere',
      !iDbl.ok && !iDbl.errors[0].includes('AKIAIOSFODNN7EXAMPLE'));

    // malformed regressions[].vs (present but not a sha256 identity key)
    const badVs = { ...valid['eval-run'], regressions: [{ vs: 'sha256:short', metric: 'pass_rate', delta: -0.1, critical: false }] };
    const rVs = validateManifest(badVs);
    ok('malformed regressions[].vs refuses when present', !rVs.ok && rVs.errors.some((e) => e.includes('regressions[0].vs')));

    // path safety
    const pOut = join(outside, 'out.json');
    await writeFile(pOut, JSON.stringify(valid['promotion']));
    const iOut = await ingestManifestFile(repo, pOut);
    ok('manifest outside the repo refuses', !iOut.ok && iOut.errors.some((e) => e.includes('inside the repo')));

    // parent-directory junction pointing outside the repo (the EXP-P5
    // bypass class; junction creation needs no privileges on win32)
    await symlink(outside, join(repo, 'models', 'jct'), 'junction');
    const iJct = await ingestManifestFile(repo, join(repo, 'models', 'jct', 'out.json'));
    ok('manifest via an out-of-repo parent junction refuses', !iJct.ok
      && iJct.errors.some((e) => e.includes('inside the repo') || e.includes('symlink')));

    // the junction ingested DIRECTLY hits the lstat isSymbolicLink branch —
    // win32-reachable coverage for the refusal the file-symlink case (below)
    // can only exercise with privileges
    const iJctDirect = await ingestManifestFile(repo, join(repo, 'models', 'jct'));
    ok('junction passed directly is refused as a symlink', !iJctDirect.ok
      && iJctDirect.errors.some((e) => e.includes('symlink')));

    let symlinkChecked = false;
    try {
      await symlink(p1, join(repo, 'models', 'link.json'), 'file');
      symlinkChecked = true;
    } catch { /* win32 without dev-mode privileges: cannot create symlinks */ }
    if (symlinkChecked) {
      const iLink = await ingestManifestFile(repo, join(repo, 'models', 'link.json'));
      ok('symlinked manifest refused as such', !iLink.ok && iLink.errors.some((e) => e.includes('symlink')));
    } else {
      console.log('  [SKIP] symlinked manifest refused as such - symlink creation unavailable (win32 privileges)');
    }

    console.log(`\nmodel-manifests: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
