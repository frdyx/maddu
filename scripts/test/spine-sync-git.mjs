// Roadmap #12c phase 5 — `maddu spine sync` git-transport round-trip. Run:
//   node scripts/test/spine-sync-git.mjs
//
// The phase-5 GATE: TWO REAL git checkouts, disjoint lanes, a `sync` round-trip
// converges to an identical cockpit with ZERO git conflicts. Author-partitioning
// (each replica writes only its own by-replica/<id>/ dir) + `.gitattributes ...
// merge=binary` means the pull can never textually conflict. This drives real
// `git` against real temp repos through a bare "remote", so it also covers the
// pre-push secret gate and the not-sync-mode / no-upstream branches.
//
// Skips cleanly (exit 0) if git is unavailable.

import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRun, gitAvailable } from '../../template/maddu/runtime/lib/git-exec.mjs';
import { syncInit, syncGit } from '../../template/maddu/runtime/lib/spine-sync.mjs';
import { append, ensureSpine, EVENT_TYPES, hashLine } from '../../template/maddu/runtime/lib/spine.mjs';
import { project } from '../../template/maddu/runtime/lib/projections.mjs';

// Plant a secret-bearing event as a RAW chain-valid line in a replica's
// partition, bypassing append() — which redacts every payload at the write
// boundary (central sweep), so a raw on-spine secret is unreachable through
// the API. The pre-push refuse gate under test defends exactly these
// historic/foreign-tool spines.
async function plantRawPartitionEvent(repo, replicaId, { type, actor = null, lane = null, data }) {
  const dir = join(repo, '.maddu', 'events', 'by-replica', replicaId);
  const segs = (await readdir(dir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  const seg = join(dir, segs[segs.length - 1]);
  const lines = (await readFile(seg, 'utf8')).split('\n').filter((l) => l.trim());
  const ts = new Date().toISOString();
  const id = `evt_${ts.replace(/[-:T.Z]/g, '').slice(0, 14)}_${Math.random().toString(16).slice(2, 8)}`;
  const ev = { v: 1, id, ts, type, actor, lane, data,
    prev_hash: lines.length ? hashLine(lines[lines.length - 1]) : null };
  await appendFile(seg, JSON.stringify(ev) + '\n');
  return ev;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

// Configure a fresh checkout so commits succeed headlessly and deterministically.
async function gitConfig(repo) {
  await gitRun(['config', 'user.email', 'test@maddu.local'], repo, 5000);
  await gitRun(['config', 'user.name', 'maddu-test'], repo, 5000);
  await gitRun(['config', 'commit.gpgsign', 'false'], repo, 5000);
}
const claim = (repo, actor, lane) =>
  append(repo, { type: EVENT_TYPES.LANE_CLAIMED, actor, lane, data: { focus: `${actor}-work` } });
const claimsOf = (p) => p.claims.map((c) => `${c.lane}:${c.sessionId}`).sort().join(',');

async function main() {
  console.log('spine-sync-git: two-checkout round-trip');
  if (!(await gitAvailable(process.cwd()).catch(() => false)) && !(await (async () => {
    const t = await mkdtemp(join(tmpdir(), 'maddu-git-probe-'));
    const r = await gitRun(['init', t], t, 5000);
    await rm(t, { recursive: true, force: true });
    return r.code === 0;
  })())) {
    console.log('  (git unavailable — skipping)');
    console.log('spine-sync-git: 0/0');
    return;
  }

  // A bare "remote" both checkouts share.
  const remote = await mkdtemp(join(tmpdir(), 'maddu-remote-'));
  await gitRun(['init', '--bare', '-b', 'main', remote], remote, 10000);

  // Checkout A: clone, establish `main` (so B can clone a non-empty branch),
  // opt into sync (migrating a legacy flat claim), then sync → commit + push.
  const repoA = await mkdtemp(join(tmpdir(), 'maddu-A-'));
  await gitRun(['clone', remote, repoA], repoA, 15000);
  await gitConfig(repoA);
  await writeFile(join(repoA, 'README.md'), '# team\n');
  await gitRun(['add', 'README.md'], repoA, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], repoA, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoA, 15000);

  await ensureSpine(repoA);
  await claim(repoA, 'sesA', 'lane-a');            // flat legacy event...
  const initA = await syncInit(repoA);              // ...migrated into by-replica/<A>/
  ok(initA.ok, `A sync init ok (${initA.reason || 'ok'})`);
  const syncA1 = await syncGit(repoA);
  ok(syncA1.ok && syncA1.committed && syncA1.pushed, `A first sync commits + pushes (${syncA1.reason || 'ok'})`);

  // Checkout B: clone (gets A's partition + the templated .gitignore/.gitattributes),
  // opt into sync (mints its OWN replicaId), claim a DISJOINT lane, then sync.
  const repoB = await mkdtemp(join(tmpdir(), 'maddu-B-'));
  await gitRun(['clone', remote, repoB], repoB, 15000);
  await gitConfig(repoB);
  await ensureSpine(repoB);
  const initB = await syncInit(repoB);
  ok(initB.ok && initB.replicaId !== initA.replicaId, `B mints a distinct replicaId (${initB.replicaId} vs ${initA.replicaId})`);
  await claim(repoB, 'sesB', 'lane-b');
  const syncB1 = await syncGit(repoB);
  ok(syncB1.ok && syncB1.committed && syncB1.pulled && syncB1.pushed, `B sync: commit + pull(A) + push (${syncB1.reason || 'ok'})`);
  ok(syncB1.steps.every((s) => s.step !== 'pull' || s.pulled), 'B pull had no conflict');

  // A syncs again → pulls B's partition. Now both checkouts hold both partitions.
  const syncA2 = await syncGit(repoA);
  ok(syncA2.ok && syncA2.pulled, `A second sync pulls B (${syncA2.reason || 'ok'})`);

  // GATE: identical cockpit. Both projections show both disjoint claims, no
  // contention (disjoint lanes never contend), and the claim sets are equal.
  const pA = await project(repoA);
  const pB = await project(repoB);
  ok(claimsOf(pA) === 'lane-a:sesA,lane-b:sesB', `A sees both claims — got ${claimsOf(pA)}`);
  ok(claimsOf(pA) === claimsOf(pB), `A and B converge to an identical cockpit — A=${claimsOf(pA)} B=${claimsOf(pB)}`);
  ok(pA.contentions.length === 0 && pB.contentions.length === 0, 'disjoint lanes → zero contentions on both');
  ok(pA.claims.length === 2, 'both partitions present (2 claims)');

  // Secret gate: an event carrying a secret-shaped value must block the push.
  // Planted RAW (historic-spine simulation) — append() would redact it first.
  await plantRawPartitionEvent(repoA, initA.replicaId, { type: EVENT_TYPES.INBOX_MESSAGE,
    actor: 'sesA', lane: 'lane-a',
    data: { text: 'token ghp_0123456789abcdefghijklmnopqrstuvwxyz' } });
  const syncSecret = await syncGit(repoA);
  ok(!syncSecret.ok && syncSecret.reason === 'secret', `secret in the spine blocks sync (${syncSecret.reason})`);
  ok(!syncSecret.steps.some((s) => s.step === 'push' && s.pushed), 'secret gate short-circuits BEFORE push');

  // Staging isolation: a stray non-segment *.ndjson (which the secret scan does
  // NOT cover) and unrelated user work must NOT be committed by sync. Use repoB
  // (clean, in sync mode). Write a rogue partition file + an unrelated user file
  // and stage the user file, then sync (no new spine events → nothing of ours to
  // commit) and assert neither got committed.
  await writeFile(join(repoB, '.maddu', 'events', 'by-replica', initB.replicaId, 'debug.ndjson'),
    JSON.stringify({ text: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' }) + '\n');
  await writeFile(join(repoB, 'user-work.txt'), 'unrelated\n');
  await gitRun(['add', 'user-work.txt'], repoB, 5000);
  const syncIsolate = await syncGit(repoB);
  ok(syncIsolate.ok && !syncIsolate.committed, `isolation sync: nothing of ours to commit (${syncIsolate.reason || 'ok'})`);
  // ls-tree HEAD = what is actually COMMITTED (unlike ls-files, which also shows
  // the still-staged user-work.txt). Neither file may have been committed by sync.
  const committedTree = await gitRun(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'user-work.txt',
    `.maddu/events/by-replica/${initB.replicaId}/debug.ndjson`], repoB, 5000);
  ok(committedTree.stdout.trim() === '', 'sync committed neither the unrelated staged file nor the stray non-segment ndjson');
  // cleanup so later assertions on repoB's tree stay clean
  await gitRun(['reset', '--', 'user-work.txt'], repoB, 5000);
  await rm(join(repoB, 'user-work.txt'), { force: true });
  await rm(join(repoB, '.maddu', 'events', 'by-replica', initB.replicaId, 'debug.ndjson'), { force: true });

  // git-busy: a repo mid-merge must be refused (sync must not conclude/abort it).
  const busy = await mkdtemp(join(tmpdir(), 'maddu-busy-'));
  await gitRun(['init', '-b', 'main', busy], busy, 10000);
  await gitConfig(busy);
  await writeFile(join(busy, 'f.txt'), 'base\n');
  await gitRun(['add', 'f.txt'], busy, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'base'], busy, 10000);
  await ensureSpine(busy);
  await syncInit(busy);
  // fabricate an in-progress merge marker
  const mergeHead = (await gitRun(['rev-parse', 'HEAD'], busy, 5000)).stdout.trim();
  const gitDir = (await gitRun(['rev-parse', '--git-dir'], busy, 5000)).stdout.trim();
  await writeFile(join(busy, gitDir, 'MERGE_HEAD'), mergeHead + '\n');
  const syncBusy = await syncGit(busy);
  ok(!syncBusy.ok && syncBusy.reason === 'git-busy', `mid-merge repo refused (${syncBusy.reason})`);

  // not-sync-mode: a plain repo with no replica.json refuses the git verb.
  const plain = await mkdtemp(join(tmpdir(), 'maddu-plain-'));
  await gitRun(['init', '-b', 'main', plain], plain, 10000);
  await gitConfig(plain);
  await ensureSpine(plain);
  const syncPlain = await syncGit(plain);
  ok(!syncPlain.ok && syncPlain.reason === 'not-sync-mode', `non-sync repo refused (${syncPlain.reason})`);

  // no-upstream: sync mode but no tracking branch → commits locally, skips net.
  const solo = await mkdtemp(join(tmpdir(), 'maddu-solo-'));
  await gitRun(['init', '-b', 'main', solo], solo, 10000);
  await gitConfig(solo);
  await writeFile(join(solo, 'README.md'), '# solo\n');
  await gitRun(['add', 'README.md'], solo, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], solo, 10000);
  await ensureSpine(solo);
  await syncInit(solo);
  await claim(solo, 'sesS', 'lane-s');
  const syncSolo = await syncGit(solo);
  ok(syncSolo.ok && syncSolo.committed && !syncSolo.hasUpstream && !syncSolo.pushed,
    `no-upstream: commits locally, push skipped (${syncSolo.reason || 'ok'})`);

  // Pre-push audit: an unpushed NON-spine commit must block the push (sync must
  // not publish unrelated user work). Fresh remote+checkout so upstream exists.
  const remote2 = await mkdtemp(join(tmpdir(), 'maddu-remote2-'));
  await gitRun(['init', '--bare', '-b', 'main', remote2], remote2, 10000);
  const repoC = await mkdtemp(join(tmpdir(), 'maddu-C-'));
  await gitRun(['clone', remote2, repoC], repoC, 15000);
  await gitConfig(repoC);
  await writeFile(join(repoC, 'README.md'), '# c\n');
  await gitRun(['add', 'README.md'], repoC, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], repoC, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoC, 15000);
  await ensureSpine(repoC);
  await syncInit(repoC);
  await claim(repoC, 'sesC', 'lane-c');
  // an UNPUSHED user commit touching non-spine paths
  await writeFile(join(repoC, 'src.js'), 'console.log(1)\n');
  await gitRun(['add', 'src.js'], repoC, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'user work'], repoC, 10000);
  const syncUnrelated = await syncGit(repoC);
  ok(!syncUnrelated.ok && syncUnrelated.reason === 'unrelated-commits', `unpushed non-spine commit blocks push (${syncUnrelated.reason})`);
  ok(!syncUnrelated.steps.some((s) => s.step === 'push' && s.pushed), 'unrelated-commits short-circuits before push');
  // The bare remote must NOT have received src.js.
  const remoteHas = await gitRun(['ls-tree', '-r', '--name-only', 'main', '--', 'src.js'], remote2, 5000);
  ok(remoteHas.stdout.trim() === '', 'the unrelated user commit was NOT pushed to the remote');

  // Retry-after-failed-push: a spine-ONLY unpushed commit (as a failed push would
  // leave) must still pass the audit and push. Push the user commit out of the way
  // first, then create a spine-only unpushed commit via push:false, then sync.
  await gitRun(['push'], repoC, 15000); // publish the user commit by hand
  await claim(repoC, 'sesC', 'lane-c2');
  const syncNoPush = await syncGit(repoC, { push: false });
  ok(syncNoPush.ok && syncNoPush.committed && !syncNoPush.pushed, `push:false commits a spine-only commit locally (${syncNoPush.reason || 'ok'})`);
  const syncRetry = await syncGit(repoC);
  ok(syncRetry.ok && syncRetry.pushed, `retry pushes the spine-only unpushed commit (${syncRetry.reason || 'ok'})`);

  // Audit must be per-commit, not a net tree diff: an unrelated file ADDED then
  // DELETED across unpushed commits leaves no net change but its commits would
  // still be published — must be refused.
  await writeFile(join(repoC, 'temp.txt'), 'x\n');
  await gitRun(['add', 'temp.txt'], repoC, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'add temp'], repoC, 10000);
  await rm(join(repoC, 'temp.txt'), { force: true });
  await gitRun(['add', '-A', 'temp.txt'], repoC, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'del temp'], repoC, 10000);
  const syncAddDel = await syncGit(repoC);
  ok(!syncAddDel.ok && syncAddDel.reason === 'unrelated-commits',
    `add-then-delete unrelated commits still blocked (net diff would miss this) (${syncAddDel.reason})`);
  ok((syncAddDel.offending || []).some((c) => c.paths.includes('temp.txt')), 'audit names the add-then-deleted file');
  await gitRun(['push'], repoC, 15000); // clear the unrelated commits by hand

  // A committed NON-segment file under by-replica/ (not a numeric segment) must
  // also be refused — it is not the spine surface and import/verify ignore it.
  await writeFile(join(repoC, '.maddu', 'events', 'by-replica', 'noise.txt'), 'nope\n');
  await gitRun(['add', '-f', '.maddu/events/by-replica/noise.txt'], repoC, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'noise'], repoC, 10000);
  const syncNoise = await syncGit(repoC);
  ok(!syncNoise.ok && syncNoise.reason === 'unrelated-commits',
    `committed non-segment file under by-replica/ blocked (${syncNoise.reason})`);
  await gitRun(['push'], repoC, 15000);

  // Finding-2 guard: a user's OWN unrelated .gitignore commit (after first share)
  // is NOT whitelisted — only THIS run's first-share commit may publish the
  // sync-managed dotfiles. repoC's dotfiles are already tracked+pushed by now.
  await writeFile(join(repoC, '.gitignore'), '\n# user unrelated edit\n*.log\n', { flag: 'a' });
  await gitRun(['add', '.gitignore'], repoC, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'user gitignore edit'], repoC, 10000);
  const syncGi = await syncGit(repoC);
  ok(!syncGi.ok && syncGi.reason === 'unrelated-commits' && (syncGi.offending || []).some((c) => c.paths.includes('.gitignore')),
    `a user's separate .gitignore commit is refused (not whitelisted post-first-share) (${syncGi.reason})`);
  await gitRun(['push'], repoC, 15000);

  // Finding-2 cross-dotfile leak: first-sharing ONE dotfile must NOT whitelist a
  // user's separate commit to the OTHER. Fresh checkout where .gitignore is
  // committed but .gitattributes is not, plus an unrelated .gitignore commit.
  const repoD = await mkdtemp(join(tmpdir(), 'maddu-D-'));
  await gitRun(['init', '-b', 'main', repoD], repoD, 10000);
  await gitConfig(repoD);
  await writeFile(join(repoD, '.gitignore'), 'node_modules/\n');
  await gitRun(['add', '.gitignore'], repoD, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'base gitignore'], repoD, 10000);
  const bareD = await mkdtemp(join(tmpdir(), 'maddu-bareD-'));
  await gitRun(['init', '--bare', '-b', 'main', bareD], bareD, 10000);
  await gitRun(['remote', 'add', 'origin', bareD], repoD, 5000);
  await gitRun(['push', '-u', 'origin', 'main'], repoD, 15000);
  await ensureSpine(repoD);
  await syncInit(repoD); // re-templates .gitignore (tracked) + creates .gitattributes (untracked)
  await claim(repoD, 'sesD', 'lane-d');
  // an unrelated user .gitignore commit
  await writeFile(join(repoD, '.gitignore'), 'node_modules/\n*.tmp\n');
  await gitRun(['add', '.gitignore'], repoD, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'user gitignore change'], repoD, 10000);
  const syncD = await syncGit(repoD);
  ok(!syncD.ok && syncD.reason === 'unrelated-commits' && (syncD.offending || []).some((c) => c.paths.includes('.gitignore')),
    `first-sharing .gitattributes does NOT whitelist a user's .gitignore commit (${syncD.reason})`);

  // Commit-scoped audit — a user's ADD-then-DELETE of an unrelated .gitignore
  // (before sync first-shares its own) must be refused: the audit is per-commit
  // (subject + paths), not per-path, so those user commits are not sync-owned
  // even though they only touch a "spine-managed" dotfile path.
  const remoteE = await mkdtemp(join(tmpdir(), 'maddu-remoteE-'));
  await gitRun(['init', '--bare', '-b', 'main', remoteE], remoteE, 10000);
  const repoE = await mkdtemp(join(tmpdir(), 'maddu-E-'));
  await gitRun(['clone', remoteE, repoE], repoE, 15000);
  await gitConfig(repoE);
  await writeFile(join(repoE, 'README.md'), '# e\n');
  await gitRun(['add', 'README.md'], repoE, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], repoE, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoE, 15000);
  await writeFile(join(repoE, '.gitignore'), 'secret-notes/\n');
  await gitRun(['add', '.gitignore'], repoE, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'user add gitignore'], repoE, 10000);
  await gitRun(['rm', '.gitignore'], repoE, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'user del gitignore'], repoE, 10000);
  await ensureSpine(repoE);
  await syncInit(repoE); // recreates .gitignore untracked
  await claim(repoE, 'sesE', 'lane-e');
  const syncE = await syncGit(repoE);
  ok(!syncE.ok && syncE.reason === 'unrelated-commits',
    `add-then-delete unrelated .gitignore commits are refused (commit-scoped, not path-scoped) (${syncE.reason})`);
  ok((syncE.offending || []).some((c) => /user (add|del) gitignore/.test(c.subject)),
    'audit names the user gitignore commits, not sync-owned');

  // Failed-first-push retry WITH dotfiles: a first-share commit left unpushed
  // (as a failed push would) is sync-owned (spine paths + sync subject), so a
  // retry still passes the audit and pushes.
  const remoteF = await mkdtemp(join(tmpdir(), 'maddu-remoteF-'));
  await gitRun(['init', '--bare', '-b', 'main', remoteF], remoteF, 10000);
  const repoF = await mkdtemp(join(tmpdir(), 'maddu-F-'));
  await gitRun(['clone', remoteF, repoF], repoF, 15000);
  await gitConfig(repoF);
  await writeFile(join(repoF, 'README.md'), '# f\n');
  await gitRun(['add', 'README.md'], repoF, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], repoF, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoF, 15000);
  await ensureSpine(repoF);
  await syncInit(repoF);
  await claim(repoF, 'sesF', 'lane-f');
  const syncFNoPush = await syncGit(repoF, { push: false }); // first-share commit, unpushed
  ok(syncFNoPush.ok && syncFNoPush.committed && !syncFNoPush.pushed, `F first-share commit left unpushed (${syncFNoPush.reason || 'ok'})`);
  const syncFRetry = await syncGit(repoF); // retry: the unpushed first-share commit is sync-owned
  ok(syncFRetry.ok && syncFRetry.pushed, `retry pushes the unpushed first-share commit (dotfiles included) (${syncFRetry.reason || 'ok'})`);

  // An EMPTY non-merge user commit (git commit --allow-empty) touches no paths;
  // it must NOT be misclassified as sync-owned (every([]) is vacuously true).
  await gitRun(['commit', '--allow-empty', '--no-verify', '-m', 'user empty marker'], repoF, 10000);
  const syncEmpty = await syncGit(repoF);
  ok(!syncEmpty.ok && syncEmpty.reason === 'unrelated-commits',
    `empty non-merge user commit is refused (not vacuously owned) (${syncEmpty.reason})`);
  await gitRun(['push'], repoF, 15000);

  // A commit that DELETES a segment file must be refused (sync only appends; a
  // deletion erases remote history and can slip past import if it leaves no gap).
  // repoF is synced/clean now. Add a 2nd segment so deleting the 1st leaves a gap-
  // free... instead, add then delete the SAME new segment path is not a real
  // segment; use the real one: git rm an existing tracked segment.
  const fRid = (await gitRun(['ls-files', '--', '.maddu/events/by-replica'], repoF, 5000)).stdout
    .split('\n').map((s) => s.trim()).filter((p) => /\/\d{12}\.ndjson$/.test(p));
  if (fRid.length) {
    await gitRun(['rm', fRid[0]], repoF, 5000);
    await gitRun(['commit', '--no-verify', '-m', 'user delete segment'], repoF, 10000);
    const syncDel = await syncGit(repoF);
    // Refused before push — by import (a gap-creating deletion) or, for a
    // no-gap deletion, by the audit's segment-D rule. Either way, never pushed.
    ok(!syncDel.ok && (syncDel.reason === 'import-failed' || syncDel.reason === 'unrelated-commits'),
      `a segment DELETION is refused before push (${syncDel.reason})`);
    ok(!syncDel.steps.some((s) => s.step === 'push' && s.pushed), 'segment deletion never reaches push');
    await gitRun(['reset', '--hard', 'HEAD~1'], repoF, 5000); // undo for cleanliness
  } else { ok(true, 'segment-deletion test skipped (no tracked segment found)'); }

  // A rename whose SOURCE is a non-spine file must be refused: --no-renames shows
  // the source as a delete so it is not hidden behind the segment destination.
  const remoteG = await mkdtemp(join(tmpdir(), 'maddu-remoteG-'));
  await gitRun(['init', '--bare', '-b', 'main', remoteG], remoteG, 10000);
  const repoG = await mkdtemp(join(tmpdir(), 'maddu-G-'));
  await gitRun(['clone', remoteG, repoG], repoG, 15000);
  await gitConfig(repoG);
  await writeFile(join(repoG, 'payload.ndjson'), JSON.stringify({ v: 1, id: 'x', ts: '2026-01-01T00:00:00Z', type: 'LANE_CLAIMED', data: {} }) + '\n');
  await gitRun(['add', 'payload.ndjson'], repoG, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init payload'], repoG, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoG, 15000);
  await ensureSpine(repoG);
  await syncInit(repoG);
  await claim(repoG, 'sesG', 'lane-g');
  // rename payload.ndjson into a segment-shaped path (a fabricated 2nd partition)
  await mkdir(join(repoG, '.maddu', 'events', 'by-replica', 'rep_leak'), { recursive: true });
  await gitRun(['mv', 'payload.ndjson', '.maddu/events/by-replica/rep_leak/000000000001.ndjson'], repoG, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'user rename to segment'], repoG, 10000);
  const syncRename = await syncGit(repoG);
  ok(!syncRename.ok && syncRename.reason === 'unrelated-commits',
    `a rename with a non-spine source is refused (--no-renames exposes the source) (${syncRename.reason})`);

  // Finding-3: a pre-existing UNTRACKED .gitignore with the user's own rules must
  // NOT be published on first share — flagged via uncommittedMeta, not committed.
  const remoteH = await mkdtemp(join(tmpdir(), 'maddu-remoteH-'));
  await gitRun(['init', '--bare', '-b', 'main', remoteH], remoteH, 10000);
  const repoH = await mkdtemp(join(tmpdir(), 'maddu-H-'));
  await gitRun(['clone', remoteH, repoH], repoH, 15000);
  await gitConfig(repoH);
  await writeFile(join(repoH, 'README.md'), '# h\n');
  await gitRun(['add', 'README.md'], repoH, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], repoH, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoH, 15000);
  // user's own UNTRACKED .gitignore with private rules, BEFORE sync init
  await writeFile(join(repoH, '.gitignore'), 'secret-notes/\nprivate.key\n');
  await ensureSpine(repoH);
  await syncInit(repoH); // appends the maddu block to the user's .gitignore
  await claim(repoH, 'sesH', 'lane-h');
  const syncH = await syncGit(repoH);
  ok(syncH.ok && (syncH.uncommittedMeta || []).includes('.gitignore'),
    `pre-existing untracked .gitignore with user rules is NOT published (flagged) (${syncH.reason || 'ok'})`);
  const hasGi = await gitRun(['ls-tree', '-r', '--name-only', 'main', '--', '.gitignore'], remoteH, 5000);
  ok(hasGi.stdout.trim() === '', "the user's .gitignore rules were not pushed to the remote");

  // Segment MODIFICATION must be a pure APPEND: a truncation (deleting tail
  // events) leaves a valid shorter chain import would pass, so the audit checks
  // the parent blob is a byte-prefix of the new blob. Build a 2-event segment,
  // truncate to 1 event, commit → refused.
  const remoteI = await mkdtemp(join(tmpdir(), 'maddu-remoteI-'));
  await gitRun(['init', '--bare', '-b', 'main', remoteI], remoteI, 10000);
  const repoI = await mkdtemp(join(tmpdir(), 'maddu-I-'));
  await gitRun(['clone', remoteI, repoI], repoI, 15000);
  await gitConfig(repoI);
  await writeFile(join(repoI, 'README.md'), '# i\n');
  await gitRun(['add', 'README.md'], repoI, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], repoI, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoI, 15000);
  await ensureSpine(repoI);
  await syncInit(repoI);
  await claim(repoI, 'sesI', 'lane-i1');
  await claim(repoI, 'sesI', 'lane-i2'); // 2 chained events in one segment
  const syncI1 = await syncGit(repoI); // legit append (M, prefix) is owned + pushed
  ok(syncI1.ok && syncI1.pushed, `legit 2-event segment append syncs (${syncI1.reason || 'ok'})`);
  // segment path is tracked only after sync committed it
  const iRid = (await gitRun(['ls-files', '--', '.maddu/events/by-replica'], repoI, 5000)).stdout
    .split('\n').map((s) => s.trim()).filter((p) => /\/\d{12}\.ndjson$/.test(p));
  // now TRUNCATE the segment to its first event and commit
  const segAbs = join(repoI, iRid[0]);
  const lines = (await readFile(segAbs, 'utf8')).split('\n').filter(Boolean);
  await writeFile(segAbs, lines[0] + '\n');
  await gitRun(['add', iRid[0]], repoI, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'user truncate segment'], repoI, 10000);
  const syncTrunc = await syncGit(repoI);
  ok(!syncTrunc.ok && (syncTrunc.reason === 'unrelated-commits' || syncTrunc.reason === 'import-failed'),
    `a segment TRUNCATION (non-append modify) is refused before push (${syncTrunc.reason})`);
  ok(!syncTrunc.steps.some((s) => s.step === 'push' && s.pushed), 'segment truncation never reaches push');

  // Marker-spoof: a user's untracked .gitignore that plants a fake BEGIN marker
  // must NOT be first-shared — the exact-block match (not stripping) rejects it.
  const remoteJ = await mkdtemp(join(tmpdir(), 'maddu-remoteJ-'));
  await gitRun(['init', '--bare', '-b', 'main', remoteJ], remoteJ, 10000);
  const repoJ = await mkdtemp(join(tmpdir(), 'maddu-J-'));
  await gitRun(['clone', remoteJ, repoJ], repoJ, 15000);
  await gitConfig(repoJ);
  await writeFile(join(repoJ, 'README.md'), '# j\n');
  await gitRun(['add', 'README.md'], repoJ, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], repoJ, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoJ, 15000);
  // untracked .gitignore with a PLANTED fake BEGIN marker + a private path
  await writeFile(join(repoJ, '.gitignore'), '# BEGIN MADDU SYNC (#12c team-sync partitions) — do not edit\nprivate.key\n');
  await ensureSpine(repoJ);
  await syncInit(repoJ); // appends the real block
  await claim(repoJ, 'sesJ', 'lane-j');
  const syncJ = await syncGit(repoJ);
  ok(syncJ.ok && (syncJ.uncommittedMeta || []).includes('.gitignore'),
    `a marker-spoofed untracked .gitignore is NOT first-shared (${syncJ.reason || 'ok'})`);
  const jHasGi = await gitRun(['ls-tree', '-r', '--name-only', 'main', '--', '.gitignore'], remoteJ, 5000);
  ok(jHasGi.stdout.trim() === '', 'the spoofed .gitignore (with private.key) was not pushed');

  // Forged FOREIGN partition: a hand-authored segment under another replicaId's
  // dir is not this checkout's own partition and must be refused (peers' arrive
  // via pull, already on the remote). Reuse repoI (synced, in sync mode).
  await mkdir(join(repoI, '.maddu', 'events', 'by-replica', 'rep_forged'), { recursive: true });
  await writeFile(join(repoI, '.maddu', 'events', 'by-replica', 'rep_forged', '000000000001.ndjson'),
    JSON.stringify({ v: 1, id: 'evt_20260706000000_f0f0f0', ts: '2026-07-06T00:00:00.000Z', type: 'LANE_CLAIMED', actor: 'ses-forged', lane: 'lane-forged', data: {}, prev_hash: null }) + '\n');
  await gitRun(['reset', '--hard', 'origin/main'], repoI, 5000); // clean slate on the synced branch
  await gitRun(['add', '-f', '.maddu/events/by-replica/rep_forged/000000000001.ndjson'], repoI, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'user forged partition'], repoI, 10000);
  const syncForged = await syncGit(repoI);
  ok(!syncForged.ok && (syncForged.reason === 'unrelated-commits' || syncForged.reason === 'import-failed'),
    `a forged foreign partition is refused before push (${syncForged.reason})`);
  ok(!syncForged.steps.some((s) => s.step === 'push' && s.pushed), 'forged partition never reaches push');

  // Dotfile subject-spoof: a commit titled with our canonical sync subject that
  // MODIFIES a tracked .gitignore with user content must be refused — ownership
  // is content-based (status A + exact managed block), not subject-based.
  const remoteK = await mkdtemp(join(tmpdir(), 'maddu-remoteK-'));
  await gitRun(['init', '--bare', '-b', 'main', remoteK], remoteK, 10000);
  const repoK = await mkdtemp(join(tmpdir(), 'maddu-K-'));
  await gitRun(['clone', remoteK, repoK], repoK, 15000);
  await gitConfig(repoK);
  await writeFile(join(repoK, 'README.md'), '# k\n');
  await gitRun(['add', 'README.md'], repoK, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], repoK, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoK, 15000);
  await ensureSpine(repoK);
  const initK = await syncInit(repoK); // fresh .gitignore/.gitattributes
  await claim(repoK, 'sesK', 'lane-k');
  const syncK1 = await syncGit(repoK); // first-shares the fresh dotfiles (now tracked)
  ok(syncK1.ok && syncK1.pushed, `K first sync pushes (${syncK1.reason || 'ok'})`);
  // now a spoofed commit under our subject that injects user content into .gitignore
  await writeFile(join(repoK, '.gitignore'), (await readFile(join(repoK, '.gitignore'), 'utf8')) + 'private.key\n');
  await gitRun(['add', '.gitignore'], repoK, 5000);
  await gitRun(['commit', '--no-verify', '-m', `maddu spine sync (${initK.replicaId})`], repoK, 10000);
  const syncSpoof = await syncGit(repoK);
  ok(!syncSpoof.ok && syncSpoof.reason === 'unrelated-commits',
    `a subject-spoofed .gitignore MODIFY is refused (content-based ownership) (${syncSpoof.reason})`);

  // Explicit-refspec push: even with `push.default matching` (which a bare
  // `git push` would honor to publish ALL matching branches), sync pushes ONLY
  // HEAD:<upstream-branch>. An unrelated unpushed `feature` branch stays local.
  const remoteL = await mkdtemp(join(tmpdir(), 'maddu-remoteL-'));
  await gitRun(['init', '--bare', '-b', 'main', remoteL], remoteL, 10000);
  const repoL = await mkdtemp(join(tmpdir(), 'maddu-L-'));
  await gitRun(['clone', remoteL, repoL], repoL, 15000);
  await gitConfig(repoL);
  await gitRun(['config', 'push.default', 'matching'], repoL, 5000);
  await writeFile(join(repoL, 'README.md'), '# l\n');
  await gitRun(['add', 'README.md'], repoL, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'init'], repoL, 10000);
  await gitRun(['push', '-u', 'origin', 'main'], repoL, 15000);
  // an unrelated feature branch with a leak, tracking origin (so `matching` would push it)
  await gitRun(['checkout', '-b', 'feature'], repoL, 5000);
  await writeFile(join(repoL, 'leak.txt'), 'secret work\n');
  await gitRun(['add', 'leak.txt'], repoL, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'feature leak'], repoL, 10000);
  await gitRun(['push', '-u', 'origin', 'feature'], repoL, 15000); // establish tracking
  await writeFile(join(repoL, 'leak2.txt'), 'more secret\n');
  await gitRun(['add', 'leak2.txt'], repoL, 5000);
  await gitRun(['commit', '--no-verify', '-m', 'feature leak 2 (unpushed)'], repoL, 10000);
  await gitRun(['checkout', 'main'], repoL, 5000);
  await ensureSpine(repoL);
  await syncInit(repoL);
  await claim(repoL, 'sesL', 'lane-l');
  const syncL = await syncGit(repoL);
  ok(syncL.ok && syncL.pushed, `L sync pushes main (${syncL.reason || 'ok'})`);
  const featLeak = await gitRun(['ls-tree', '-r', '--name-only', 'feature', '--', 'leak2.txt'], remoteL, 5000);
  ok(featLeak.stdout.trim() === '', "sync did NOT publish the unrelated feature branch's unpushed commit");

  // Pending marker present → refuse with 'sync-init-in-progress' (even with a
  // committed replica.json), and it takes precedence over other reasons.
  const pend = await mkdtemp(join(tmpdir(), 'maddu-pend-'));
  await gitRun(['init', '-b', 'main', pend], pend, 10000);
  await gitConfig(pend);
  await ensureSpine(pend);
  await syncInit(pend);
  await writeFile(join(pend, '.maddu', 'config', 'replica.pending.json'), JSON.stringify({ replicaId: 'x' }) + '\n');
  const syncPend = await syncGit(pend);
  ok(!syncPend.ok && syncPend.reason === 'sync-init-in-progress', `pending marker refuses sync (${syncPend.reason})`);

  for (const d of [remote, repoA, repoB, plain, solo, busy, remote2, repoC, pend, repoD, bareD, remoteE, repoE, remoteF, repoF, remoteG, repoG, remoteH, repoH, remoteI, repoI, remoteJ, repoJ, remoteK, repoK, remoteL, repoL]) await rm(d, { recursive: true, force: true });

  console.log(`spine-sync-git: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
