#!/usr/bin/env node
// worktree-detach — release dispositions merged|abandoned|keep (roadmap #12a
// phase 5). Runs the real detachLaneWorktree against a live git repo.
//
// Pins: merged verifies branch-is-ancestor and refuses when it is not; merged
// refuses a dirty worktree unless --reason overrides; abandoned force-removes;
// keep leaves the checkout + branch on disk while still ending the attachment;
// every path emits a well-shaped WORKTREE_DETACHED and leaves the live set
// empty; and the spine verifies clean throughout.
//
// Skips gracefully if git is unavailable. Exit: 0 OK, 1 assert fail, 2 harness.

import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function git(args, cwd) {
  return new Promise((resolve) => {
    let c;
    try { c = spawn('git', args, { cwd }); } catch (e) { return resolve({ code: -1, err: e.message, out: '' }); }
    let out = '', err = '';
    c.stdout.on('data', (b) => (out += b));
    c.stderr.on('data', (b) => (err += b));
    c.on('close', (code) => resolve({ code, out, err }));
    c.on('error', (e) => resolve({ code: -1, err: e.message, out: '' }));
  });
}
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function setupRepo(base, lanes) {
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  const init = await git(['init', '-b', 'main'], repo);
  if (init.code !== 0) return null;
  await git(['config', 'user.email', 't@t.t'], repo);
  await git(['config', 'user.name', 'T'], repo);
  await mkdir(path.join(repo, '.maddu', 'lanes'), { recursive: true });
  await mkdir(path.join(repo, '.maddu', 'events'), { recursive: true });
  await writeFile(path.join(repo, '.maddu', 'lanes', 'catalog.json'),
    JSON.stringify({ schemaVersion: 1, lanes: lanes.map((id) => ({ id, scope: 'x' })) }, null, 2));
  await writeFile(path.join(repo, 'README.md'), '# t\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-m', 'init'], repo);
  return repo;
}

async function main() {
  const wt = await import(pathToFileURL(path.join(LIB, 'worktrees.mjs')).href);
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const verify = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);
  const liveCount = async (repo) => (await wt.readAttachments(repo)).size;
  const detEvents = async (repo) => (await spine.readAll(repo)).filter((e) => e.type === 'WORKTREE_DETACHED');

  const base = await mkdtemp(path.join(os.tmpdir(), 'maddu-wtdetach-'));
  try {
    const repo = await setupRepo(base, ['git-integration', 'cockpit-shell', 'bridge-server', 'harness']);
    if (!repo) { console.log('  [SKIP] git unavailable'); console.log('\nworktree-detach: skipped'); process.exit(0); }

    // ── merged: branch merged into main → verified, worktree+branch removed ──
    {
      const lane = 'git-integration';
      const a = await wt.attachLaneWorktree(repo, { lane, session: 's1', claimEventId: 'evt_1' });
      // make a commit on the lane branch, then merge it into main so it's an ancestor
      await writeFile(path.join(a.path, 'f.txt'), 'work\n');
      await git(['add', '-A'], a.path);
      await git(['commit', '-m', 'lane work'], a.path);
      await git(['merge', '--no-ff', 'maddu/lane/git-integration', '-m', 'merge'], repo);
      const r = await wt.detachLaneWorktree(repo, { lane, disposition: 'merged', by: 's1' });
      ok('merged: ancestorCheck pass', r.ancestorCheck === 'pass' && r.disposition === 'merged');
      ok('merged: worktree removed from disk', !(await exists(a.path)));
      ok('merged: branch deleted', (await git(['rev-parse', '--verify', '--quiet', 'refs/heads/maddu/lane/git-integration'], repo)).code !== 0);
      ok('merged: live set empty for lane', !(await wt.liveAttachmentForLane(repo, lane)));
      const det = (await detEvents(repo)).find((e) => e.data.disposition === 'merged');
      ok('merged: WORKTREE_DETACHED shape', det?.data?.ancestorCheck === 'pass' && !!det?.data?.integrationHead && det?.data?.schemaVersion === 1);
    }

    // ── merged refused when the lane branch is NOT an ancestor ──
    {
      const lane = 'cockpit-shell';
      const a = await wt.attachLaneWorktree(repo, { lane, session: 's1', claimEventId: 'evt_2' });
      await writeFile(path.join(a.path, 'f.txt'), 'unmerged\n');
      await git(['add', '-A'], a.path);
      await git(['commit', '-m', 'not merged'], a.path);
      let refused = false;
      try { await wt.detachLaneWorktree(repo, { lane, disposition: 'merged', by: 's1' }); }
      catch (e) { refused = /not merged into/.test(e.message); }
      ok('merged refused when branch is not an ancestor', refused);
      ok('refusal left the attachment live + worktree present', !!(await wt.liveAttachmentForLane(repo, lane)) && await exists(a.path));
      // clean up with abandoned
      await wt.detachLaneWorktree(repo, { lane, disposition: 'abandoned', by: 's1' });
    }

    // ── abandoned: dirty worktree force-removed, work discarded ──
    {
      const lane = 'bridge-server';
      const a = await wt.attachLaneWorktree(repo, { lane, session: 's1', claimEventId: 'evt_3' });
      await writeFile(path.join(a.path, 'dirty.txt'), 'uncommitted\n'); // dirty, untracked
      const r = await wt.detachLaneWorktree(repo, { lane, disposition: 'abandoned', by: 's1' });
      ok('abandoned: dirtyAtDetach recorded', r.dirty === true && r.disposition === 'abandoned');
      ok('abandoned: worktree removed despite dirt', !(await exists(a.path)));
      ok('abandoned: branch deleted', (await git(['rev-parse', '--verify', '--quiet', 'refs/heads/maddu/lane/bridge-server'], repo)).code !== 0);
      ok('abandoned: live set empty', !(await wt.liveAttachmentForLane(repo, lane)));
    }

    // ── keep: attachment ends but checkout + branch stay on disk ──
    {
      const lane = 'harness';
      const a = await wt.attachLaneWorktree(repo, { lane, session: 's1', claimEventId: 'evt_4' });
      const r = await wt.detachLaneWorktree(repo, { lane, disposition: 'keep', by: 's1' });
      ok('keep: disposition normalized to kept', r.disposition === 'kept');
      ok('keep: worktree LEFT on disk', await exists(a.path));
      ok('keep: branch LEFT on disk', (await git(['rev-parse', '--verify', '--quiet', 'refs/heads/maddu/lane/harness'], repo)).code === 0);
      ok('keep: attachment no longer live', !(await wt.liveAttachmentForLane(repo, lane)));
      // clean the kept worktree so temp rm doesn't trip
      await git(['worktree', 'remove', '--force', a.path], repo);
    }

    // ── merged + dirty: refused without --reason, allowed with it ──
    {
      // reuse git-integration lane (its prior attachment was merged-detached).
      const lane = 'git-integration';
      const a = await wt.attachLaneWorktree(repo, { lane, session: 's1', claimEventId: 'evt_5' });
      await writeFile(path.join(a.path, 'g.txt'), 'committed\n');
      await git(['add', '-A'], a.path);
      await git(['commit', '-m', 'more lane work'], a.path);
      await git(['merge', '--no-ff', 'maddu/lane/git-integration', '-m', 'merge2'], repo);
      // now dirty it with an uncommitted change
      await writeFile(path.join(a.path, 'uncommitted.txt'), 'dirty\n');
      let dirtyRefused = false;
      try { await wt.detachLaneWorktree(repo, { lane, disposition: 'merged', by: 's1' }); }
      catch (e) { dirtyRefused = /uncommitted changes/.test(e.message); }
      ok('merged + dirty refused without --reason', dirtyRefused);
      ok('refusal preserved the attachment', !!(await wt.liveAttachmentForLane(repo, lane)));
      const r = await wt.detachLaneWorktree(repo, { lane, disposition: 'merged', reason: 'ci artifacts, safe to drop', by: 's1' });
      ok('merged + dirty allowed with --reason (records dirtyAtDetach)', r.dirty === true && r.ancestorCheck === 'pass');
      const det = (await detEvents(repo)).find((e) => e.data.reason === 'ci artifacts, safe to drop');
      ok('override reason recorded on the detach event', !!det);
    }

    // ── invalid disposition + no-live-attachment errors ──
    let badDisp = false;
    try { await wt.detachLaneWorktree(repo, { lane: 'harness', disposition: 'bogus' }); } catch { badDisp = true; }
    ok('invalid disposition throws', badDisp);
    let noLive = false;
    try { await wt.detachLaneWorktree(repo, { lane: 'git-integration', disposition: 'keep' }); } catch (e) { noLive = /no live worktree/.test(e.message); }
    ok('no-live-attachment throws', noLive);

    // ── Codex P1: detach deletes the CURRENT-root path, NEVER the spine-
    // persisted att.pathAbs. Craft a live attachment whose pathAbs points at a
    // DECOY outside the repo: after detach the real current-root worktree is
    // gone and the decoy is untouched — which would FAIL if detach still used
    // att.pathAbs. Build it with a real git worktree + a hand-written
    // WORKTREE_ATTACHED carrying the decoy pathAbs.
    {
      const lane = 'cockpit-shell';
      const relPath = '.maddu/worktrees/cockpit-shell';
      const realPath = path.join(repo, '.maddu', 'worktrees', 'cockpit-shell');
      await git(['worktree', 'add', '-b', 'maddu/lane/cockpit-shell', realPath], repo);
      const decoy = path.join(base, 'DECOY-outside-repo');
      await mkdir(decoy, { recursive: true });
      await writeFile(path.join(decoy, 'sentinel.txt'), 'must survive\n');
      await spine.append(repo, {
        type: 'WORKTREE_ATTACHED', lane,
        data: {
          schemaVersion: 1, attachmentId: 'wta_decoy', claimEventId: 'evt_d',
          lane, session: 's1', pathRepoRel: relPath,
          pathAbs: decoy, // <-- the trap: a stale absolute path outside the repo
          branchRef: 'refs/heads/maddu/lane/cockpit-shell', baseRef: 'refs/heads/main',
          baseHeadAtAttach: 'a'.repeat(40), created: true, reused: false, dirty: false,
          gitCommonDir: null, platform: process.platform,
        },
      });
      await wt.detachLaneWorktree(repo, { lane, disposition: 'abandoned', by: 's1' });
      ok('abandoned removed the CURRENT-root worktree', !(await exists(realPath)));
      ok('the stale pathAbs decoy was NOT touched', await exists(path.join(decoy, 'sentinel.txt')));
    }

    // ── Codex P2: git-removal failure aborts BEFORE recording the detach.
    // Simulate by making `git worktree remove` fail: attach, then manually
    // delete the worktree's admin registration so `git worktree remove` errors,
    // and assert no WORKTREE_DETACHED is appended (attachment stays live).
    {
      const lane = 'bridge-server';
      const a = await wt.attachLaneWorktree(repo, { lane, session: 's1', claimEventId: 'evt_p2' });
      // Make the NEXT `git worktree remove` fail: remove the worktree via git
      // now (drops the checkout + admin registration, leaves the branch), so
      // detach's `git worktree remove` errors "is not a working tree".
      await git(['worktree', 'remove', '--force', a.path], repo);
      const detBefore = (await detEvents(repo)).length;
      let aborted = false;
      try { await wt.detachLaneWorktree(repo, { lane, disposition: 'abandoned', by: 's1' }); }
      catch (e) { aborted = /not detached|left intact/.test(e.message); }
      const detAfter = (await detEvents(repo)).length;
      ok('git-removal failure aborts the detach', aborted);
      ok('no WORKTREE_DETACHED recorded on removal failure', detAfter === detBefore);
      ok('attachment stays live after a failed detach', !!(await wt.liveAttachmentForLane(repo, lane)));
      // Operator-side recovery: checkout is already gone, delete the leftover
      // branch and record a manual detach so the fixture ends non-dangling.
      await git(['branch', '-D', 'maddu/lane/bridge-server'], repo);
      await spine.append(repo, { type: 'WORKTREE_DETACHED', lane, data: { schemaVersion: 1, attachmentId: a.attachmentId, lane, pathRepoRel: a.relPath, disposition: 'abandoned', branchHead: null, integrationRef: null, integrationHead: null, ancestorCheck: 'skipped', dirtyAtDetach: false, reason: 'test-recovery' } });
    }

    // ── Codex P2: drive the actual `maddu lane release` CLI — the fixed gate
    // was in the command, which returned "no active claim" BEFORE reaching the
    // disposition block. Attach (live attachment, NO LANE_CLAIMED → orphaned),
    // then run the real command with --worktree keep + no claim; it must
    // disposition the worktree rather than no-op.
    {
      const lane = 'harness';
      const a = await wt.attachLaneWorktree(repo, { lane, session: 'ghost', claimEventId: 'evt_orphan' });
      ok('orphaned attachment is live before CLI disposition', !!(await wt.liveAttachmentForLane(repo, lane)));
      const BIN = path.resolve(__dirname, '..', '..', 'bin', 'maddu.mjs');
      // Pin the child to the fixture repo (Codex P2): drop MADDU_STATE_ROOT /
      // MADDU_SESSION_ID so an outer env — e.g. running the self-test from
      // INSIDE a lane worktree (now possible!) — can't redirect the spawned
      // `maddu` at the caller's real state and disposition a real worktree.
      // Case-INSENSITIVE filter: Windows env vars ignore case, but a spread of
      // process.env is a case-sensitive object, so a non-canonically-cased
      // `Maddu_State_Root` would survive a plain `delete`.
      const DROP = new Set(['MADDU_STATE_ROOT', 'MADDU_SESSION_ID']);
      const childEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !DROP.has(k.toUpperCase()))
      );
      const r = await new Promise((resolve) => {
        let c;
        try { c = spawn(process.execPath, [BIN, 'lane', 'release', lane, '--worktree', 'keep', '--session', 'cleaner'], { cwd: repo, env: childEnv }); }
        catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
        let out = '', err = '';
        c.stdout.on('data', (b) => (out += b));
        c.stderr.on('data', (b) => (err += b));
        c.on('close', (code) => resolve({ code, out, err }));
        c.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
      });
      ok('CLI orphan-disposition exits 0', r.code === 0, (r.err || '').trim().slice(0, 120));
      // Require the KEEP outcome specifically (Codex P3): "claim already gone"
      // prints for any disposition, so it wouldn't catch keep→abandoned drift.
      ok('CLI reports worktree: kept', /worktree: kept/.test(r.out), r.out.trim().slice(0, 160));
      ok('keep LEFT the checkout on disk', await exists(a.path));
      ok('orphaned attachment no longer live after CLI', !(await wt.liveAttachmentForLane(repo, lane)));
      await git(['worktree', 'remove', '--force', a.path], repo);
    }

    // ── the whole spine verifies clean ──
    const res = await verify.verifySpine(repo);
    const wtIssues = res.issues.filter((i) => i.kind.includes('worktree'));
    ok('spine verifies with zero worktree issues', wtIssues.length === 0, wtIssues.map((i) => i.kind).join(','));
    ok('every disposition produced a detach event', (await detEvents(repo)).length >= 4);
    ok('no attachments left live', (await liveCount(repo)) === 0);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nworktree-detach: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err}`); process.exit(2); });
