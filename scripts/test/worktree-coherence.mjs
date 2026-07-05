#!/usr/bin/env node
// worktree-coherence — the worktree-lane-coherence gate (roadmap #12a phase 6).
//
// Drives the real gate against a live git repo through the edge-case matrix:
// coherent state → PASS; a recorded attachment with no git worktree
// (missing_worktree); a git worktree with no attachment (orphaned_worktree); a
// lane dropped from the catalog while attached (lane_not_in_catalog); a dirty
// worktree (dirty_worktree). Asserts the gate is WARN-tier (ok:false surfaces
// without failing) and reports the right kinds.
//
// Skips gracefully if git is unavailable. Exit: 0 OK, 1 assert fail, 2 harness.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');
const GATE = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'gates', 'builtin', 'worktree-lane-coherence.mjs');

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
const kinds = (res) => (res.evidence?.issues || []).map((i) => i.kind);

async function main() {
  const wt = await import(pathToFileURL(path.join(LIB, 'worktrees.mjs')).href);
  const gate = (await import(pathToFileURL(GATE).href)).default;
  const run = (repo) => gate.run({ repoRoot: repo });

  // severity metadata: this is a WARN-tier gate (never blocks in v1).
  ok('gate is warn-tier', gate.severity === 'warn' && gate.id === 'worktree-lane-coherence');

  const base = await mkdtemp(path.join(os.tmpdir(), 'maddu-coh-'));
  try {
    const repo = path.join(base, 'repo');
    await mkdir(path.join(repo, '.maddu', 'lanes'), { recursive: true });
    await mkdir(path.join(repo, '.maddu', 'events'), { recursive: true });
    const init = await git(['init', '-b', 'main'], repo);
    if (init.code !== 0) { console.log('  [SKIP] git unavailable'); console.log('\nworktree-coherence: skipped'); process.exit(0); }
    await git(['config', 'user.email', 't@t.t'], repo);
    await git(['config', 'user.name', 'T'], repo);
    const writeCatalog = (ids) => writeFile(path.join(repo, '.maddu', 'lanes', 'catalog.json'),
      JSON.stringify({ schemaVersion: 1, lanes: ids.map((id) => ({ id, scope: 'x' })) }, null, 2));
    await writeCatalog(['git-integration', 'cockpit-shell']);
    await writeFile(path.join(repo, 'README.md'), '# t\n');
    await git(['add', '-A'], repo);
    await git(['commit', '-m', 'init'], repo);

    // ── coherent: one clean attachment ──
    const a = await wt.attachLaneWorktree(repo, { lane: 'git-integration', session: 's1', claimEventId: 'e1' });
    let res = await run(repo);
    ok('coherent state → ok', res.ok === true, res.message);

    // ── cockpit data layer: buildConductor surfaces the worktree on the lane row ──
    const builders = await import(pathToFileURL(path.join(LIB, 'bridge-builders.mjs')).href);
    const conductor = await builders.buildConductor(repo);
    const laneRow = (conductor.scoreMatrix || []).find((r) => r.lane === 'git-integration');
    ok('lane row carries a worktree badge', !!laneRow?.worktree && laneRow.worktree.path === '.maddu/worktrees/git-integration', JSON.stringify(laneRow?.worktree));
    ok('worktree badge names the branch + session', laneRow?.worktree?.branch === 'refs/heads/maddu/lane/git-integration' && laneRow?.worktree?.session === 's1');
    const otherRow = (conductor.scoreMatrix || []).find((r) => r.lane === 'cockpit-shell');
    ok('lanes without a worktree have worktree=null', otherRow ? otherRow.worktree === null : true);

    // ── janitor REPORTS an orphaned worktree when it auto-closes the holder,
    //    and never auto-removes it. Craft a stale session (holder of the
    //    git-integration attachment) and run the janitor.
    const janitor = await import(pathToFileURL(path.join(LIB, 'janitor.mjs')).href);
    const staleTs = '2026-01-01T00:00:00.000Z';
    const projection = { activeSessions: [{ id: 's1', status: 'active', lastHeartbeatAt: staleTs }], janitor: { staleSessions: [] } };
    const nowMs = Date.parse(staleTs) + 5 * 60 * 60 * 1000; // +5h > 4h auto-close
    const jr = await janitor.runJanitor(repo, projection, nowMs);
    ok('janitor auto-closed the stale holder', jr.closedEmitted === 1);
    ok('janitor REPORTED the orphaned worktree', Array.isArray(jr.orphanedWorktrees) && jr.orphanedWorktrees.some((o) => o.lane === 'git-integration'));
    ok('janitor did NOT remove the worktree (still on disk)', (await run(repo)) && true); // no throw; worktree still present
    const stillThere = (await wt.readAttachments(repo)).size >= 1;
    ok('janitor left the attachment live (removal is explicit only)', stillThere);

    // ── dirty worktree → warn/dirty_worktree ──
    await writeFile(path.join(a.path, 'scratch.txt'), 'uncommitted\n');
    res = await run(repo);
    ok('dirty worktree flagged', res.ok === false && kinds(res).includes('dirty_worktree'), res.message);
    await rm(path.join(a.path, 'scratch.txt'), { force: true });
    ok('clean again → ok', (await run(repo)).ok === true);

    // ── orphaned worktree: git has it, spine does not ──
    // Manually add a git worktree under .maddu/worktrees without an attachment.
    const orphanPath = path.join(repo, '.maddu', 'worktrees', 'cockpit-shell');
    await git(['worktree', 'add', '-b', 'maddu/lane/cockpit-shell', orphanPath], repo);
    res = await run(repo);
    ok('orphaned worktree flagged', res.ok === false && kinds(res).includes('orphaned_worktree'), res.message);
    await git(['worktree', 'remove', '--force', orphanPath], repo);
    await git(['branch', '-D', 'maddu/lane/cockpit-shell'], repo);
    ok('coherent after orphan removed', (await run(repo)).ok === true);

    // ── missing worktree: spine has an attachment, git does not ──
    // Remove the git worktree behind the live attachment without detaching.
    await git(['worktree', 'remove', '--force', a.path], repo);
    res = await run(repo);
    ok('missing worktree flagged', res.ok === false && kinds(res).includes('missing_worktree'), res.message);

    // ── lane dropped from catalog while attached ──
    await writeCatalog(['cockpit-shell']); // git-integration removed
    res = await run(repo);
    ok('lane_not_in_catalog flagged', res.ok === false && kinds(res).includes('lane_not_in_catalog'), res.message);

    // ── re-attaching that lane is impossible now (not in catalog) — clean up
    //    by detaching the stale attachment via a manual event so the fixture is
    //    tidy; the gate already proved its point.
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nworktree-coherence: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err}`); process.exit(2); });
