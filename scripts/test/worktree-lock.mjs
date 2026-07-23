// Unit tests for the atomic-publish worktree lock (worktree-lock.mjs, PR-D §3.5,
// plan test 13b). Run standalone:
//   node scripts/test/worktree-lock.mjs
//
// Proves the publish-atomically protocol that append-lock.mjs cannot give a
// worktree-destroying op:
//   1. acquire publishes a lockPath dir that ALWAYS carries a full owner record
//      (never a bodyless interval); release removes it and leaves no debris.
//   2. a LIVE holder is never stolen — a finite-wait contender returns a
//      structured lock-busy skip and its OWN tmp is cleaned up (no leak).
//   3. a proven-dead SAME-HOST owner is reclaimed via an atomic .dead.<ownerId>
//      quarantine; the tombstone is RETAINED and a second quarantine to the same
//      name fails (no suspended-stealer double-owner).
//   4. a CROSS-HOST dead owner is never stolen.
//   5. orphan tmp dirs are GC'd ONLY when their encoded same-host pid is proven
//      dead — a live pid's tmp is left untouched (an in-flight publish is safe).
//   6. crash-after-release `.released` debris and a fresh acquire coexist.
//   7. the per-lane lock and the global recovery lock occupy DISJOINT namespaces
//      even for a lane named literally `recover`.

import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, rename } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import {
  acquireWorktreeLock,
  releaseWorktreeLock,
} from '../../template/maddu/runtime/lib/worktree-lock.mjs';
import {
  worktreeLaneLockPath,
  worktreeRecoveryLockPath,
} from '../../template/maddu/runtime/lib/worktrees.mjs';

const HOST = hostname();
const HOST_HASH = createHash('sha256').update(HOST).digest('hex').slice(0, 12);
const DEAD_PID = 2147480000; // effectively never a live pid → ESRCH

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}
async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}
// Fabricate a PUBLISHED lock dir (mkdir + owner.json) as if a holder had crashed
// without releasing — never bodyless, exactly as the real publish leaves it.
async function fabricateHeld(lockPath, { ownerId, pid, host }) {
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'owner.json'),
    JSON.stringify({ ownerId, pid, host, hostHash: HOST_HASH, startedAt: new Date().toISOString() }));
}
async function tmpChildren(lockPath) {
  const parent = dirname(lockPath), base = basename(lockPath);
  let entries = [];
  try { entries = await readdir(parent); } catch {}
  return entries.filter((n) => n.startsWith(`${base}.tmp.`));
}

async function main() {
  console.log('worktree-lock: atomic-publish protocol units');

  // 1. Happy path — publish carries a record; release is clean (no debris).
  {
    const dir = await mkdtemp(join(tmpdir(), 'maddu-wtlock-happy-'));
    const lockPath = join(dir, 'lane.lock');
    const lock = await acquireWorktreeLock(lockPath);
    ok(lock.acquired, 'acquire succeeds on a free path');
    ok(await isDir(lockPath), 'published lockPath is a directory');
    const rec = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
    ok(rec.ownerId === lock.ownerId, 'published lock ALWAYS carries a full owner record (never bodyless)');
    await lock.release();
    ok(!(await exists(lockPath)), 'release removes the published lockPath');
    const parent = await readdir(dir);
    ok(!parent.some((n) => n.includes('.released.')), 'release leaves no .released debris on the happy path');
    ok((await tmpChildren(lockPath)).length === 0, 'no tmp dirs left after a clean acquire/release');
    await rm(dir, { recursive: true, force: true });
  }

  // 2. Live holder is never stolen — finite wait → structured lock-busy; the
  //    contender cleans up its OWN tmp dir (no leak while its pid stays live).
  {
    const dir = await mkdtemp(join(tmpdir(), 'maddu-wtlock-live-'));
    const lockPath = join(dir, 'lane.lock');
    const held = await acquireWorktreeLock(lockPath);
    const busy = await acquireWorktreeLock(lockPath, { maxWaitMs: 200 });
    ok(!busy.acquired && busy.reason === 'lock-busy', 'a live holder is not stolen — finite wait returns lock-busy');
    ok((await tmpChildren(lockPath)).length === 0, 'a timed-out contender deletes its OWN tmp dir (no leak, pid still live)');
    ok(await isDir(lockPath), 'the live holder still holds the lock after the contender skips');
    await held.release();
    const after = await acquireWorktreeLock(lockPath, { maxWaitMs: 1000 });
    ok(after.acquired, 'a fresh acquire proceeds once the live holder releases');
    if (after.acquired) await after.release();
    await rm(dir, { recursive: true, force: true });
  }

  // 3. Proven-dead SAME-HOST owner reclaimed via atomic quarantine; tombstone
  //    retained; a second quarantine to the same .dead name fails (no double-owner).
  {
    const dir = await mkdtemp(join(tmpdir(), 'maddu-wtlock-dead-'));
    const lockPath = join(dir, 'lane.lock');
    await fabricateHeld(lockPath, { ownerId: 'DEAD-OWNER', pid: DEAD_PID, host: HOST });
    const lock = await acquireWorktreeLock(lockPath, { maxWaitMs: 3000 });
    ok(lock.acquired, 'a proven-dead same-host owner is reclaimed');
    const tomb = `${lockPath}.dead.DEAD-OWNER`;
    ok(await isDir(tomb), 'the dead owner is atomically quarantined to .dead.<ownerId>');
    const tombRec = JSON.parse(await readFile(join(tomb, 'owner.json'), 'utf8'));
    ok(tombRec.ownerId === 'DEAD-OWNER', 'the tombstone RETAINS the dead owner record (offline sweep only)');
    // A suspended second stealer targeting the SAME tombstone name must fail —
    // it can neither move nor delete the live replacement.
    let secondQuarantineFailed = false;
    try { await rename(lockPath, tomb); } catch { secondQuarantineFailed = true; }
    ok(secondQuarantineFailed, 'a second quarantine to the retained .dead name fails (no suspended-stealer double-owner)');
    ok(await isDir(lockPath), 'the winner still holds the live replacement lock');
    if (lock.acquired) await lock.release();
    await rm(dir, { recursive: true, force: true });
  }

  // 4. Cross-host dead owner is NEVER stolen (times out busy, no tombstone).
  {
    const dir = await mkdtemp(join(tmpdir(), 'maddu-wtlock-xhost-'));
    const lockPath = join(dir, 'lane.lock');
    await fabricateHeld(lockPath, { ownerId: 'OTHER-HOST', pid: DEAD_PID, host: `${HOST}-somewhere-else` });
    const busy = await acquireWorktreeLock(lockPath, { maxWaitMs: 200 });
    ok(!busy.acquired && busy.reason === 'lock-busy', 'a cross-host dead owner is never auto-stolen');
    ok(!(await exists(`${lockPath}.dead.OTHER-HOST`)), 'no tombstone is minted for a cross-host owner');
    await rm(dir, { recursive: true, force: true });
  }

  // 5. GC sweeps orphan tmp dirs ONLY for a proven-dead same-host pid; a live
  //    pid's tmp (and a cross-host tmp) is left untouched.
  {
    const dir = await mkdtemp(join(tmpdir(), 'maddu-wtlock-gc-'));
    const lockPath = join(dir, 'lane.lock');
    const base = basename(lockPath);
    const deadOrphan = join(dir, `${base}.tmp.${HOST_HASH}.${DEAD_PID}.deadowner`);
    const liveOrphan = join(dir, `${base}.tmp.${HOST_HASH}.${process.pid}.liveowner`);
    const xhostOrphan = join(dir, `${base}.tmp.deadbeefcafe.${DEAD_PID}.xhostowner`);
    for (const o of [deadOrphan, liveOrphan, xhostOrphan]) {
      await mkdir(o, { recursive: true });
      await writeFile(join(o, 'owner.json'), '{}');
    }
    // A live holder forces the acquire into its wait loop, where GC runs.
    const held = await acquireWorktreeLock(lockPath);
    const busy = await acquireWorktreeLock(lockPath, { maxWaitMs: 300 });
    ok(!busy.acquired, 'GC scenario: contender skips a live holder');
    ok(!(await exists(deadOrphan)), 'a proven-dead same-host orphan tmp is GC\'d');
    ok(await exists(liveOrphan), 'a LIVE same-host pid\'s tmp is NOT swept (in-flight publish safe)');
    ok(await exists(xhostOrphan), 'a cross-host orphan tmp is NOT swept (never pid-probe another host)');
    await held.release();
    await rm(dir, { recursive: true, force: true });
  }

  // 6. Crash-after-release `.released` debris is inert — a fresh acquire ignores it.
  {
    const dir = await mkdtemp(join(tmpdir(), 'maddu-wtlock-released-'));
    const lockPath = join(dir, 'lane.lock');
    const debris = `${lockPath}.released.someowner`;
    await mkdir(debris, { recursive: true });
    await writeFile(join(debris, 'owner.json'), '{}');
    const lock = await acquireWorktreeLock(lockPath, { maxWaitMs: 500 });
    ok(lock.acquired, 'a fresh acquire proceeds past leftover .released debris');
    ok(await exists(debris), '.released debris is inert (left for the offline sweep)');
    if (lock.acquired) await lock.release();
    await rm(dir, { recursive: true, force: true });
  }

  // 7. Disjoint namespaces — the recovery lock never aliases a lane named `recover`.
  {
    const root = '/repo/root';
    const laneLock = worktreeLaneLockPath(root, 'recover');
    const recoveryLock = worktreeRecoveryLockPath(root);
    ok(laneLock !== recoveryLock, 'the `recover` lane lock and the global recovery lock are different paths');
    ok(dirname(laneLock) !== dirname(recoveryLock), 'they live in disjoint directories (no self-deadlock)');
    ok(laneLock.includes('worktree-lanes') && recoveryLock.includes('worktree-recovery'),
      'namespaces are worktree-lanes/ vs worktree-recovery/');
  }

  console.log(`worktree-lock: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
