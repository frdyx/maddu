#!/usr/bin/env node
// completion-claim-gate (v1.88.0) — the learn-scan heuristic as a warn gate.
//
// Verifies the gate's verdict paths over synthetic spines: quiet history →
// ok; a LIVE hedged-without-proof pattern (≥3 cumulative, ≥1 recent) →
// not-ok with evidence slice ids; hedges WITH observed proof → ok (the JOIN);
// empty/absent spine → ok. Also verifies the merged heavy-suites-recent gate
// (the named 2→1 retirement that freed this gate's slot) keeps both
// sub-checks: stale stress run → not-ok; both current/absent → ok.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const GATE_DIR = join(ROOT, 'template', 'maddu', 'runtime', 'gates', 'builtin');
const LIB_DIR = join(ROOT, 'template', 'maddu', 'runtime', 'lib');

const completionClaim = (await import(pathToFileURL(join(GATE_DIR, 'completion-claim.mjs')).href)).default;
const heavySuites = (await import(pathToFileURL(join(GATE_DIR, 'heavy-suites-recent.mjs')).href)).default;
const spine = await import(pathToFileURL(join(LIB_DIR, 'spine.mjs')).href);

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function tempRepo(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, '.maddu', 'events'), { recursive: true });
  return root;
}

async function appendSliceStop(root, summary, data = {}) {
  await spine.append(root, {
    type: 'SLICE_STOP',
    actor: 'ses_test',
    data: { summary, targets: [], paths: [], gates: [], deliverables: null, ...data },
  });
}

const ctxFor = (root) => ({ repoRoot: root, spine });

async function main() {
  // ── completion-claim: quiet history → ok ──
  {
    const root = await tempRepo('maddu-ccg-quiet-');
    await appendSliceStop(root, 'Done. tests pass.');
    await appendSliceStop(root, 'shipped the parser; gates green.');
    const r = await completionClaim.run(ctxFor(root));
    ok('quiet history → ok', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── completion-claim: 3 recent hedged-without-proof → LIVE, not-ok ──
  {
    const root = await tempRepo('maddu-ccg-live-');
    await appendSliceStop(root, 'wired it up, should work');
    await appendSliceStop(root, 'refactor done, probably fine');
    await appendSliceStop(root, 'handler added, seems to work');
    const r = await completionClaim.run(ctxFor(root));
    ok('3 recent hedged-without-proof → not ok', r.ok === false, r.message);
    ok('evidence carries slice ids', Array.isArray(r.evidence?.sliceIds) && r.evidence.sliceIds.length === 3,
      `got ${r.evidence?.sliceIds?.length}`);
    ok('evidence names the behavior tag', r.evidence?.behavior === 'unverified-completion-claim');
    await rm(root, { recursive: true, force: true });
  }

  // ── completion-claim: hedges WITH observed proof → ok (the JOIN) ──
  {
    const root = await tempRepo('maddu-ccg-proof-');
    for (let i = 0; i < 3; i++) {
      await appendSliceStop(root, 'should work now', {
        deliverables: { declared: 1, verified: 1, missing: [] },
      });
    }
    const r = await completionClaim.run(ctxFor(root));
    ok('hedges with verified deliverables → ok (honest confidence)', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── completion-claim: empty spine → ok, no crash ──
  {
    const root = await tempRepo('maddu-ccg-empty-');
    const r = await completionClaim.run(ctxFor(root));
    ok('empty spine → ok', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── heavy-suites-recent: both absent → ok (skipped) ──
  {
    const root = await tempRepo('maddu-hsr-absent-');
    const r = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: no runs recorded → ok (skipped)', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── heavy-suites-recent: stale stress run → not-ok; current → ok ──
  {
    const root = await tempRepo('maddu-hsr-stale-');
    await mkdir(join(root, '.maddu', 'state'), { recursive: true });
    const staleTs = new Date(Date.now() - 45 * 86400000).toISOString();
    await writeFile(join(root, '.maddu', 'state', 'stress-last-run.json'),
      JSON.stringify({ ts: staleTs, scenarioCount: 5 }));
    const stale = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: 45d-old stress run → not ok', stale.ok === false, stale.message);

    await writeFile(join(root, '.maddu', 'state', 'stress-last-run.json'),
      JSON.stringify({ ts: new Date().toISOString(), scenarioCount: 5 }));
    const fresh = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: fresh stress run → ok', fresh.ok === true, fresh.message);

    // failed upgrade-matrix run flips it back to not-ok
    await writeFile(join(root, '.maddu', 'state', 'upgrade-matrix-last-run.json'),
      JSON.stringify({ ts: new Date().toISOString(), passed: 3, failed: 1 }));
    const badMatrix = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: failed upgrade-matrix run → not ok', badMatrix.ok === false, badMatrix.message);
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\ncompletion-claim-gate: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
