#!/usr/bin/env node
// worktree-recovery — the PR-D §3.6 AUTO-finalize path against a live git repo.
//
// Pins (plan tests 3/4/11/12): a crash-after-intent PRESENT instance self-heals
// (removed + terminal, carrying the janitor trigger); an ABSENT instance is NEVER
// auto-terminalized (needsOperator, attachment stays live); a token MISMATCH
// (replaced checkout) is never removed; the rule-#9 gauntlet holds (not-allowed →
// no-op with NO trigger; within cooldown → no-op; a pure no-op round burns no
// cooldown; exactly one TRIGGER_FIRED per finalizing sweep).
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
function ok(name, cond, extra = '') { console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`); if (cond) passed++; else failed++; }
function git(args, cwd) {
  return new Promise((resolve) => {
    let c;
    try { c = spawn('git', args, { cwd }); } catch (e) { return resolve({ code: -1, err: e.message, out: '' }); }
    let out = '', err = '';
    c.stdout.on('data', (b) => (out += b)); c.stderr.on('data', (b) => (err += b));
    c.on('close', (code) => resolve({ code, out, err })); c.on('error', (e) => resolve({ code: -1, err: e.message, out: '' }));
  });
}
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function setup(base, lanes) {
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  const init = await git(['init', '-b', 'main'], repo);
  if (init.code !== 0) return null;
  await git(['config', 'user.email', 't@t.t'], repo);
  await git(['config', 'user.name', 'T'], repo);
  await mkdir(path.join(repo, '.maddu', 'lanes'), { recursive: true });
  await mkdir(path.join(repo, '.maddu', 'events'), { recursive: true });
  await mkdir(path.join(repo, '.maddu', 'config'), { recursive: true });
  await writeFile(path.join(repo, '.maddu', 'lanes', 'catalog.json'),
    JSON.stringify({ schemaVersion: 1, lanes: lanes.map((id) => ({ id, scope: 'x' })) }, null, 2));
  await writeFile(path.join(repo, 'README.md'), '# t\n');
  await git(['add', '-A'], repo); await git(['commit', '-m', 'init'], repo);
  return repo;
}
async function allowTrigger(repo) {
  await writeFile(path.join(repo, '.maddu', 'config', 'triggers.json'), JSON.stringify({ allowed: ['janitor:worktrees'] }, null, 2) + '\n');
}
// Append a durable DETACHING intent as if detach had crashed just after it.
async function seedIntent(spine, repo, att, disposition = 'merged') {
  await spine.append(repo, { type: 'WORKTREE_DETACHING', lane: att.lane, data: {
    schemaVersion: 1, intentId: 'wtd_seed', attachmentId: att.attachmentId, lane: att.lane, pathRepoRel: att.relPath,
    worktreeInstanceId: att.worktreeInstanceId, disposition, integrationRef: 'refs/heads/main', integrationHead: 'cafe',
    branchHead: 'f00d', ancestorCheck: disposition === 'merged' ? 'pass' : 'skipped', dirtyAtDetach: false, reason: null } });
}
const triggerCount = async (spine, repo) => (await spine.readAll(repo)).filter((e) => e.type === 'TRIGGER_FIRED' && e.data?.triggerId === 'janitor:worktrees').length;

async function main() {
  const wt = await import(pathToFileURL(path.join(LIB, 'worktrees.mjs')).href);
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const ident = await import(pathToFileURL(path.join(LIB, 'worktree-identity.mjs')).href);

  const base = await mkdtemp(path.join(os.tmpdir(), 'maddu-wtrecover-'));
  try {
    const repo = await setup(base, ['alpha', 'beta', 'gamma', 'delta']);
    if (!repo) { console.log('  [SKIP] git unavailable'); console.log('\nworktree-recovery: skipped'); process.exit(77); }

    // ── Test 3: crash-after-intent, instance PRESENT → auto-finalize ──
    {
      const a = await wt.attachLaneWorktree(repo, { lane: 'alpha', session: 's1', claimEventId: 'evt_a' });
      await seedIntent(spine, repo, a);
      ok('before recovery: attachment is live', !!(await wt.liveAttachmentForLane(repo, 'alpha')));
      // Not allowed yet → no-op, NO trigger.
      const noAllow = await wt.recoverPendingDetaches(repo, { nowMs: Date.now() });
      ok('not-allowed → skipped, nothing finalized', noAllow.finalized.length === 0 && noAllow.skipped.some((s) => s.reason === 'not-allowed'));
      ok('not-allowed fired NO trigger', (await triggerCount(spine, repo)) === 0);
      // Allow it → finalize.
      await allowTrigger(repo);
      const r = await wt.recoverPendingDetaches(repo, { nowMs: Date.now() });
      ok('present-instance intent auto-finalized', r.finalized.length === 1 && r.finalized[0].lane === 'alpha');
      ok('checkout removed by recovery', !(await exists(a.path)));
      ok('attachment no longer live after recovery', !(await wt.liveAttachmentForLane(repo, 'alpha')));
      const term = (await spine.readAll(repo)).find((e) => e.type === 'WORKTREE_DETACHED' && e.data.attachmentId === a.attachmentId);
      ok('terminal carries the janitor trigger + token', term?.triggered_by?.id === 'worktrees' && term?.data?.worktreeInstanceId === a.worktreeInstanceId && term?.data?.disposition === 'merged');
      ok('exactly one TRIGGER_FIRED for the finalizing sweep', (await triggerCount(spine, repo)) === 1);
      // Cooldown: an immediate re-run finds no candidate anyway, but assert idempotent no-op.
      const again = await wt.recoverPendingDetaches(repo, { nowMs: Date.now() });
      ok('re-run after finalize is a no-op (nothing left)', again.finalized.length === 0);
      ok('no second TRIGGER_FIRED on the no-op round', (await triggerCount(spine, repo)) === 1);
    }

    // ── Test 4: crash-after-remove, instance ABSENT → needsOperator, no terminal ──
    {
      const a = await wt.attachLaneWorktree(repo, { lane: 'beta', session: 's1', claimEventId: 'evt_b' });
      await seedIntent(spine, repo, a);
      await git(['worktree', 'remove', '--force', a.path], repo); // checkout now ABSENT
      const before = (await spine.readAll(repo)).filter((e) => e.type === 'WORKTREE_DETACHED').length;
      // Past test 3's trigger cooldown so this pass is not short-circuited.
      const r = await wt.recoverPendingDetaches(repo, { nowMs: Date.now() + 3600_000 });
      const after = (await spine.readAll(repo)).filter((e) => e.type === 'WORKTREE_DETACHED').length;
      ok('absent instance → NOT auto-finalized', r.finalized.length === 0);
      ok('absent instance → needsOperator (instance-absent)', r.needsOperator.some((n) => n.lane === 'beta' && n.reason === 'instance-absent'));
      ok('absent instance → NO terminal appended', after === before);
      ok('absent instance → attachment stays live for --recover', !!(await wt.liveAttachmentForLane(repo, 'beta')));
      ok('absent-only round burned NO cooldown (no NEW trigger)', (await triggerCount(spine, repo)) === 1);
    }

    // ── Test 12: token MISMATCH (replaced checkout) → never removed ──
    {
      const a = await wt.attachLaneWorktree(repo, { lane: 'gamma', session: 's1', claimEventId: 'evt_g' });
      await seedIntent(spine, repo, a);
      // A different checkout now sits at the path: overwrite the on-disk token.
      const loc = await ident.worktreeInstanceDir(repo, a.path);
      await writeFile(loc.file, 'A_DIFFERENT_TOKEN_ENTIRELY');
      const trigBefore = await triggerCount(spine, repo);
      const r = await wt.recoverPendingDetaches(repo, { nowMs: Date.now() + 7200_000 });
      ok('token mismatch → NOT finalized', r.finalized.length === 0);
      ok('token mismatch → needsOperator (token-mismatch)', r.needsOperator.some((n) => n.lane === 'gamma' && n.reason === 'token-mismatch'));
      ok('token mismatch → replacement checkout NOT removed', await exists(a.path));
      ok('token-mismatch-only round fired NO trigger (invalid before firing)', (await triggerCount(spine, repo)) === trigBefore);
      await git(['worktree', 'remove', '--force', a.path], repo).catch(() => {});
    }

    // ── Test 11: within-cooldown short-circuits a would-be finalize ──
    {
      const a = await wt.attachLaneWorktree(repo, { lane: 'delta', session: 's1', claimEventId: 'evt_d' });
      await seedIntent(spine, repo, a);
      // A trigger already fired at time 0 (test 3). A nowMs inside the cooldown of
      // that last trigger must skip the whole pass — no finalize despite a present
      // candidate. (Use the last trigger's time as the anchor.)
      const evs = await spine.readAll(repo);
      const lastTrig = evs.filter((e) => e.type === 'TRIGGER_FIRED' && e.data?.triggerId === 'janitor:worktrees').pop();
      const anchorMs = new Date(lastTrig.ts).getTime();
      const within = await wt.recoverPendingDetaches(repo, { nowMs: anchorMs + 1000 }); // 1s < 60s cooldown
      ok('within cooldown → whole pass skipped (present candidate NOT finalized)', within.finalized.length === 0 && within.skipped.some((s) => s.reason === 'cooldown'));
      ok('cooldown skip left the checkout intact', await exists(a.path));
      // Past the cooldown → finalize proceeds.
      const past = await wt.recoverPendingDetaches(repo, { nowMs: anchorMs + wt.WORKTREE_RECOVER_COOLDOWN_MS + 1000 });
      ok('past cooldown → the present candidate finalizes', past.finalized.some((f) => f.lane === 'delta'));
      ok('past-cooldown finalize removed the checkout', !(await exists(a.path)));
    }

    console.log(`\nworktree-recovery: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => { console.error(`harness error: ${err.stack || err}`); process.exit(2); });
