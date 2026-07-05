#!/usr/bin/env node
// worktree-events — WORKTREE_ATTACHED/DETACHED registration + verifier rules
// (roadmap #12a, phase 3).
//
// The event shapes are frozen (schemaVersion 1, contract in the
// competitive-response proposal) and verifier-covered BEFORE any attach code
// exists (phase 4), so no unshaped worktree event can ever land on a spine.
// Pins: registry membership, append acceptance, and the four verifier rules —
// orphan detach (FAIL), duplicate detach (WARN), attach without a claim ref
// (WARN), live-path reuse (WARN) — plus lifecycle correctness (detach frees
// the path; a fresh attach on a freed path is clean) and forward-compat
// (a detach with no attachmentId is not flagged).
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

async function newTmp() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-wt-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}

const attachData = (aid, over = {}) => ({
  schemaVersion: 1, attachmentId: aid, claimEventId: 'evt_20260705000000_c1a1a1',
  lane: 'git-integration', session: 'ses_x',
  pathRepoRel: '.maddu/worktrees/git-integration', pathAbs: '/repo/.maddu/worktrees/git-integration',
  branchRef: 'refs/heads/maddu/lane/git-integration', baseRef: 'refs/heads/main',
  baseHeadAtAttach: 'a'.repeat(40), created: true, reused: false, dirty: false,
  gitCommonDir: '/repo/.git', platform: 'win32', ...over,
});
const detachData = (aid, over = {}) => ({
  schemaVersion: 1, attachmentId: aid, lane: 'git-integration',
  pathRepoRel: '.maddu/worktrees/git-integration', disposition: 'merged',
  branchHead: 'b'.repeat(40), integrationRef: 'refs/heads/main', integrationHead: 'c'.repeat(40),
  ancestorCheck: 'pass', dirtyAtDetach: false, reason: null, ...over,
});

async function main() {
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const verify = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);
  const kinds = (res) => res.issues.map((i) => i.kind);
  const count = (res, k) => res.issues.filter((i) => i.kind === k).length;

  // ── registry ──
  ok('WORKTREE_ATTACHED registered', spine.EVENT_TYPES.WORKTREE_ATTACHED === 'WORKTREE_ATTACHED');
  ok('WORKTREE_DETACHED registered', spine.EVENT_TYPES.WORKTREE_DETACHED === 'WORKTREE_DETACHED');

  // ── well-formed lifecycle: attach → detach → re-attach same path ──
  {
    const tmp = await newTmp();
    try {
      await spine.append(tmp, { type: 'WORKTREE_ATTACHED', lane: 'git-integration', data: attachData('wta_1') });
      await spine.append(tmp, { type: 'WORKTREE_DETACHED', lane: 'git-integration', data: detachData('wta_1') });
      await spine.append(tmp, { type: 'WORKTREE_ATTACHED', lane: 'git-integration', data: attachData('wta_2') });
      const res = await verify.verifySpine(tmp);
      const wt = kinds(res).filter((k) => k.includes('worktree'));
      ok('well-formed attach/detach/re-attach: zero worktree issues', wt.length === 0, wt.join(','));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── orphan detach → FAIL ──
  {
    const tmp = await newTmp();
    try {
      await spine.append(tmp, { type: 'WORKTREE_DETACHED', lane: 'git-integration', data: detachData('wta_ghost') });
      const res = await verify.verifySpine(tmp);
      ok('orphan detach flagged FAIL', count(res, 'orphan_worktree_detach') === 1
        && res.issues.find((i) => i.kind === 'orphan_worktree_detach')?.level === 'FAIL');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── duplicate detach → WARN ──
  {
    const tmp = await newTmp();
    try {
      await spine.append(tmp, { type: 'WORKTREE_ATTACHED', lane: 'git-integration', data: attachData('wta_1') });
      await spine.append(tmp, { type: 'WORKTREE_DETACHED', lane: 'git-integration', data: detachData('wta_1') });
      await spine.append(tmp, { type: 'WORKTREE_DETACHED', lane: 'git-integration', data: detachData('wta_1', { disposition: 'abandoned' }) });
      const res = await verify.verifySpine(tmp);
      ok('duplicate detach flagged WARN', count(res, 'duplicate_worktree_detach') === 1
        && res.issues.find((i) => i.kind === 'duplicate_worktree_detach')?.level === 'WARN');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── attach without claimEventId → WARN orphan attach ──
  {
    const tmp = await newTmp();
    try {
      await spine.append(tmp, { type: 'WORKTREE_ATTACHED', lane: 'git-integration', data: attachData('wta_1', { claimEventId: null }) });
      const res = await verify.verifySpine(tmp);
      ok('attach with no claim ref flagged WARN', count(res, 'worktree_attach_no_claim_ref') === 1);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── live-path reuse → WARN; freed path is clean ──
  {
    const tmp = await newTmp();
    try {
      await spine.append(tmp, { type: 'WORKTREE_ATTACHED', lane: 'git-integration', data: attachData('wta_1') });
      await spine.append(tmp, { type: 'WORKTREE_ATTACHED', lane: 'git-integration', data: attachData('wta_2') }); // same pathRepoRel, wta_1 still live
      const res = await verify.verifySpine(tmp);
      ok('attach on a still-live path flagged WARN', count(res, 'worktree_live_path_reuse') === 1);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── forward-compat: detach with no attachmentId is not flagged ──
  {
    const tmp = await newTmp();
    try {
      await spine.append(tmp, { type: 'WORKTREE_DETACHED', lane: 'git-integration', data: { schemaVersion: 1, disposition: 'orphaned' } });
      const res = await verify.verifySpine(tmp);
      const wt = kinds(res).filter((k) => k.includes('worktree'));
      ok('id-less detach not flagged (forward-compat)', wt.length === 0, wt.join(','));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── the closed registry still rejects unknowns (sanity) ──
  {
    const tmp = await newTmp();
    try {
      let threw = false;
      try { await spine.append(tmp, { type: 'WORKTREE_EXPLODED', data: {} }); } catch { threw = true; }
      ok('append still rejects unregistered types', threw);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  console.log(`\nworktree-events: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err}`); process.exit(2); });
