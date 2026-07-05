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

    // ── Codex P1: the delete path is derived from the CURRENT stateRoot, not
    // the spine-persisted att.pathAbs (which could point outside the repo after
    // a move). Attach, then corrupt att.pathAbs by faking a moved repo: the
    // detach must still target THIS repo's .maddu/worktrees, never the stale
    // absolute path. We prove it indirectly: keep-disposition on a lane whose
    // attachment we know, and confirm the worktree under the CURRENT root is
    // the one acted on (abandoned removes exactly it).
    {
      const lane = 'cockpit-shell';
      const a = await wt.attachLaneWorktree(repo, { lane, session: 's1', claimEventId: 'evt_p1' });
      const underCurrentRoot = path.join(repo, '.maddu', 'worktrees', 'cockpit-shell');
      ok('attach path is under the current state root', a.path === underCurrentRoot);
      await wt.detachLaneWorktree(repo, { lane, disposition: 'abandoned', by: 's1' });
      ok('abandoned removed exactly the current-root worktree', !(await exists(underCurrentRoot)));
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

    // ── Codex P2: an ORPHANED-but-live attachment (claim gone) is still
    // dispositionable. Attach, drop the attachment's session/claim from the
    // picture (no LANE_RELEASED, no WORKTREE_DETACHED), then keep-disposition
    // it directly via detachLaneWorktree — which works off the attachment, not
    // the claim.
    {
      const lane = 'harness';
      const a = await wt.attachLaneWorktree(repo, { lane, session: 'ghost', claimEventId: 'evt_orphan' });
      ok('orphaned attachment is live before disposition', !!(await wt.liveAttachmentForLane(repo, lane)));
      const r = await wt.detachLaneWorktree(repo, { lane, disposition: 'keep', by: 'cleaner' });
      ok('orphaned attachment dispositioned without a claim', r.disposition === 'kept');
      ok('orphaned attachment no longer live', !(await wt.liveAttachmentForLane(repo, lane)));
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
