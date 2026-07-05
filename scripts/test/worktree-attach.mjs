#!/usr/bin/env node
// worktree-attach — the real `attachLaneWorktree` flow against a live git repo
// (roadmap #12a, phase 4).
//
// Exercises the actual git-worktree provisioning (not a mock): a temp repo
// with an initial commit, a lane catalog, and a spine. Pins: a real worktree
// appears on disk on the lane branch; the .maddu-state-root pointer is written
// into it (so phase-1 resolveRoots redirects); WORKTREE_ATTACHED lands with the
// frozen shape + a real baseHeadAtAttach; a second attach REUSES rather than
// stacking; a bad slug / non-catalog lane is refused before any git runs; the
// atomic lock dir blocks a concurrent attach; and the whole thing verifies
// clean (no orphan/duplicate/no-claim-ref/reuse warnings).
//
// Skips gracefully if git is unavailable. Exit: 0 OK, 1 assert fail, 2 harness.

import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
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
    // spawn can throw SYNCHRONOUSLY (EPERM on locked-down Windows, sandboxed
    // runs) — catch it so the harness SKIPS via the init check below instead
    // of dying with a harness error. (Codex P2, mirrors git-exec.mjs.)
    let c;
    try { c = spawn('git', args, { cwd }); }
    catch (e) { return resolve({ code: -1, err: e.message, out: '' }); }
    let out = '', err = '';
    c.stdout.on('data', (b) => (out += b));
    c.stderr.on('data', (b) => (err += b));
    c.on('close', (code) => resolve({ code, out, err }));
    c.on('error', (e) => resolve({ code: -1, err: e.message, out: '' }));
  });
}
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function main() {
  const wt = await import(pathToFileURL(path.join(LIB, 'worktrees.mjs')).href);
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const verify = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);

  const base = await mkdtemp(path.join(os.tmpdir(), 'maddu-wtattach-'));
  try {
    const repo = path.join(base, 'repo');
    await mkdir(repo, { recursive: true });
    const init = await git(['init', '-b', 'main'], repo);
    if (init.code !== 0) { console.log('  [SKIP] git unavailable — skipping attach integration test'); console.log('\nworktree-attach: skipped'); process.exit(0); }
    await git(['config', 'user.email', 't@t.t'], repo);
    await git(['config', 'user.name', 'T'], repo);
    await mkdir(path.join(repo, '.maddu', 'lanes'), { recursive: true });
    await mkdir(path.join(repo, '.maddu', 'events'), { recursive: true });
    await writeFile(path.join(repo, '.maddu', 'lanes', 'catalog.json'),
      JSON.stringify({ schemaVersion: 1, lanes: [{ id: 'git-integration', scope: 'x' }] }, null, 2));
    await writeFile(path.join(repo, 'README.md'), '# t\n');
    await git(['add', '-A'], repo);
    await git(['commit', '-m', 'init'], repo);
    const headSha = (await git(['rev-parse', 'HEAD'], repo)).out.trim();

    // ── refusals fire before any git worktree add ──
    let badSlug = false;
    try { await wt.attachLaneWorktree(repo, { lane: '../evil', session: 'ses_1' }); } catch { badSlug = true; }
    ok('bad slug refused before git', badSlug);
    let notInCatalog = false;
    try { await wt.attachLaneWorktree(repo, { lane: 'no-such-lane', session: 'ses_1' }); } catch { notInCatalog = true; }
    ok('non-catalog lane refused', notInCatalog);

    // ── the happy path ──
    const r = await wt.attachLaneWorktree(repo, { lane: 'git-integration', session: 'ses_1', claimEventId: 'evt_x' });
    ok('returns an attachmentId', typeof r.attachmentId === 'string' && r.attachmentId.startsWith('wta_'));
    ok('created a new lane branch', r.created === true && r.reused === false);
    const wtPath = path.join(repo, '.maddu', 'worktrees', 'git-integration');
    ok('worktree directory exists on disk', await exists(wtPath));
    ok('lock dir was cleaned up', !(await exists(wtPath + '.lock')));

    // git registered it, on the lane branch. `git worktree list --porcelain`
    // emits forward-slashed paths even on Windows — normalize both sides.
    const list = (await git(['worktree', 'list', '--porcelain'], repo)).out.replace(/\\/g, '/');
    ok('git registered the worktree', list.includes('.maddu/worktrees/git-integration'));
    const wtBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath)).out.trim();
    ok('worktree is on maddu/lane/git-integration', wtBranch === 'maddu/lane/git-integration');

    // the state-root pointer was written into the worktree
    const pointer = path.join(wtPath, '.maddu-state-root');
    ok('.maddu-state-root pointer written into the worktree', await exists(pointer));
    if (await exists(pointer)) {
      const target = (await readFile(pointer, 'utf8')).trim();
      ok('pointer targets the primary repo', path.resolve(target) === path.resolve(repo));
    } else { ok('pointer targets the primary repo', false); }

    // resolveRoots from inside the worktree redirects state to the primary
    const paths = await import(pathToFileURL(path.join(LIB, 'paths.mjs')).href);
    const roots = await paths.resolveRoots(wtPath, {});
    ok('resolveRoots inside the worktree redirects state to primary',
      path.resolve(roots.stateRoot) === path.resolve(repo) && roots.redirected === true);

    // ── WORKTREE_ATTACHED on the spine, frozen shape, real base head ──
    const events = await spine.readAll(repo);
    const att = events.find((e) => e.type === 'WORKTREE_ATTACHED');
    ok('WORKTREE_ATTACHED emitted', !!att);
    ok('event carries the real baseHeadAtAttach', att?.data?.baseHeadAtAttach === headSha);
    ok('event carries schemaVersion 1 + claimEventId + platform',
      att?.data?.schemaVersion === 1 && att?.data?.claimEventId === 'evt_x' && typeof att?.data?.platform === 'string');

    // ── idempotent reuse: a second attach does not stack ──
    const r2 = await wt.attachLaneWorktree(repo, { lane: 'git-integration', session: 'ses_1', claimEventId: 'evt_y' });
    ok('second attach reuses', r2.reused === true && r2.attachmentId === r.attachmentId);
    const attCount = (await spine.readAll(repo)).filter((e) => e.type === 'WORKTREE_ATTACHED').length;
    ok('no second WORKTREE_ATTACHED appended', attCount === 1);

    // ── live-attachment lookup ──
    const live = await wt.liveAttachmentForLane(repo, 'git-integration');
    ok('liveAttachmentForLane finds it', live?.attachmentId === r.attachmentId);

    // ── the concurrent-attach lock refuses a second in-flight attach ──
    // Simulate a held lock by pre-creating the lock dir on a fresh lane.
    await writeFile(path.join(repo, '.maddu', 'lanes', 'catalog.json'),
      JSON.stringify({ schemaVersion: 1, lanes: [{ id: 'git-integration', scope: 'x' }, { id: 'cockpit-shell', scope: 'y' }] }, null, 2));
    const lock2 = path.join(repo, '.maddu', 'worktrees', 'cockpit-shell.lock');
    await mkdir(lock2, { recursive: true });
    let lockBlocked = false;
    try { await wt.attachLaneWorktree(repo, { lane: 'cockpit-shell', session: 'ses_2' }); } catch (e) { lockBlocked = /in progress/.test(e.message); }
    ok('held lock dir blocks a concurrent attach', lockBlocked);
    await rm(lock2, { recursive: true, force: true });

    // ── Codex P2: the pointer is hidden from git status (not dirty) ──
    const status = (await git(['status', '--porcelain'], wtPath)).out;
    ok('worktree is clean — .maddu-state-root excluded from git status', !/maddu-state-root/.test(status), status.trim());

    // ── Codex P2: a DIFFERENT session cannot silently reuse a live attachment ──
    let crossSessionRefused = false;
    try { await wt.attachLaneWorktree(repo, { lane: 'git-integration', session: 'ses_OTHER' }); }
    catch (e) { crossSessionRefused = /held by ses_1/.test(e.message); }
    ok('cross-session reuse refused (must disposition first)', crossSessionRefused);

    // ── Codex P1: ownership change during provisioning rolls the worktree back ──
    // Fresh lane, ownerCheck returns false → git worktree add happens then is
    // removed, and NO WORKTREE_ATTACHED is emitted.
    const beforeAtt = (await spine.readAll(repo)).filter((e) => e.type === 'WORKTREE_ATTACHED').length;
    let rolledBack = false;
    try { await wt.attachLaneWorktree(repo, { lane: 'cockpit-shell', session: 'ses_3', ownerCheck: async () => false }); }
    catch (e) { rolledBack = /ownership changed/.test(e.message); }
    const afterAtt = (await spine.readAll(repo)).filter((e) => e.type === 'WORKTREE_ATTACHED').length;
    ok('owner-change during provisioning throws + emits no event', rolledBack && afterAtt === beforeAtt);
    ok('rolled-back worktree removed from disk', !(await exists(path.join(repo, '.maddu', 'worktrees', 'cockpit-shell'))));
    // Codex P2: rollback must also delete the branch this attach created, or a
    // retry would check out a stale branch while recording a fresh base head.
    const staleBranch = await git(['rev-parse', '--verify', '--quiet', 'refs/heads/maddu/lane/cockpit-shell'], repo);
    ok('rolled-back attach deleted the branch it created', staleBranch.code !== 0);

    // ── Codex P1 (chain-3): the COMPENSATION path — race lost AFTER the append.
    // ownerCheck passes the early-out (call 1 → true) then fails post-append
    // (call 2 → false), so WORKTREE_ATTACHED lands and is then reconciled by a
    // WORKTREE_DETACHED(orphaned). Converged live set must not contain it.
    let calls = 0;
    const toggling = async () => { calls += 1; return calls === 1; };
    let compensated = false;
    try { await wt.attachLaneWorktree(repo, { lane: 'cockpit-shell', session: 'ses_4', claimEventId: 'evt_z', ownerCheck: toggling }); }
    catch (e) { compensated = /orphaned/.test(e.message); }
    ok('lost-after-append compensates (ATTACHED then DETACHED orphaned)', compensated);
    const evs = await spine.readAll(repo);
    const orphanDet = evs.find((e) => e.type === 'WORKTREE_DETACHED' && e.data?.reason === 'ownership-lost-during-attach');
    ok('a WORKTREE_DETACHED(orphaned) was appended', !!orphanDet);
    const liveNow = await wt.liveAttachmentForLane(repo, 'cockpit-shell');
    ok('converged live set has NO attachment for the lost lane', liveNow === null);
    ok('compensated worktree removed + branch deleted',
      !(await exists(path.join(repo, '.maddu', 'worktrees', 'cockpit-shell')))
      && (await git(['rev-parse', '--verify', '--quiet', 'refs/heads/maddu/lane/cockpit-shell'], repo)).code !== 0);

    // ── the spine verifies clean ──
    const res = await verify.verifySpine(repo);
    const wtIssues = res.issues.filter((i) => i.kind.includes('worktree'));
    ok('spine verifies with zero worktree issues', wtIssues.length === 0, wtIssues.map((i) => i.kind).join(','));

    // clean up git worktrees so temp rm doesn't trip on locked git metadata
    await git(['worktree', 'remove', '--force', wtPath], repo);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nworktree-attach: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err}`); process.exit(2); });
