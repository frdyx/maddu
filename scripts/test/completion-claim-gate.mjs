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

  // audit P3 — heavy-suites-recent now reads VERIFIED spine receipts, not the
  // hand-writable state file. Append a STARTED→RAN pair per kind (ts=now → fresh).
  async function appendVerification(root, kind, { result = 'pass', complete = true, profile = null } = {}) {
    const st = await spine.append(root, { type: 'VERIFICATION_STARTED', data: { kind, profile } });
    await spine.append(root, { type: 'VERIFICATION_RAN', data: { kind, startedId: st.id, profile, complete, result, counts: { pass: 5, fail: result === 'pass' ? 0 : 1, total: 5 } } });
  }

  // ── heavy-suites-recent: both absent → ok (skipped) ──
  {
    const root = await tempRepo('maddu-hsr-absent-');
    const r = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: no receipts → ok (skipped)', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── heavy-suites-recent: fresh passing receipts (both kinds) → ok ──
  {
    const root = await tempRepo('maddu-hsr-fresh-');
    await appendVerification(root, 'stress', { result: 'pass' });
    await appendVerification(root, 'upgrade-matrix', { result: 'pass' });
    const fresh = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: fresh passing receipts → ok', fresh.ok === true, fresh.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── heavy-suites-recent: a failed upgrade-matrix receipt → not-ok ──
  {
    const root = await tempRepo('maddu-hsr-fail-');
    await appendVerification(root, 'stress', { result: 'pass' });
    await appendVerification(root, 'upgrade-matrix', { result: 'fail' });
    const badMatrix = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: failed upgrade-matrix receipt → not ok', badMatrix.ok === false, badMatrix.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── heavy-suites-recent: a dangling stress STARTED (no RAN) → not-ok ──
  {
    const root = await tempRepo('maddu-hsr-dangling-');
    await spine.append(root, { type: 'VERIFICATION_STARTED', data: { kind: 'stress', profile: null } });
    await appendVerification(root, 'upgrade-matrix', { result: 'pass' });
    const dangling = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: dangling stress attempt → not ok', dangling.ok === false, dangling.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── heavy-suites-recent: an upgrade-matrix receipt predating the install → not-ok ──
  {
    const root = await tempRepo('maddu-hsr-preinstall-');
    await appendVerification(root, 'stress', { result: 'pass' });
    await appendVerification(root, 'upgrade-matrix', { result: 'pass' });
    // Mark the install as happening AFTER the receipts (installedAt in the future).
    await writeFile(join(root, 'maddu.json'), JSON.stringify({ installedAt: new Date(Date.now() + 3600000).toISOString() }));
    const r = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: upgrade-matrix ran before current install → not ok', r.ok === false && /predates the current install/.test(r.message), r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── heavy-suites-recent: a legacy last-run file is NOT trusted → not-ok ──
  {
    const root = await tempRepo('maddu-hsr-legacy-');
    await mkdir(join(root, '.maddu', 'state'), { recursive: true });
    await writeFile(join(root, '.maddu', 'state', 'stress-last-run.json'),
      JSON.stringify({ ts: new Date().toISOString(), scenarioCount: 5 }));
    const legacy = await heavySuites.run({ repoRoot: root });
    ok('heavy-suites: legacy last-run.json not trusted → not ok', legacy.ok === false, legacy.message);
    await rm(root, { recursive: true, force: true });
  }

  // audit P3 (Codex R5#2) — recordVerification with a null derive (a --list /
  // no-run mode) emits NO VERIFICATION_RAN receipt (only the STARTED), so a
  // no-run invocation can't fabricate a failed receipt that reds recency.
  {
    const vr = await import(pathToFileURL(join(LIB_DIR, 'verification-recency.mjs')).href);
    const root = await tempRepo('maddu-ccg-nullderive-');
    await vr.recordVerification(root, { spine }, { kind: 'project-test', profile: 'quick', run: async () => 0, derive: () => null });
    const events = await spine.readAll(root);
    const rans = events.filter((e) => e.type === 'VERIFICATION_RAN');
    const starts = events.filter((e) => e.type === 'VERIFICATION_STARTED');
    ok('null derive → STARTED emitted but no RAN receipt', starts.length === 1 && rans.length === 0);
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\ncompletion-claim-gate: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
