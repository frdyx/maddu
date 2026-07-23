// worktree-lock.mjs — atomic-publish mutual-exclusion lock for lane-worktree ops
// (PR-D, v1.114.0). Files-only, Node stdlib, cross-platform.
//
// WHY A NEW PRIMITIVE (not append-lock.mjs)
// ─────────────────────────────────────────
// append-lock.mjs age-reclaims a *bodyless* lock without proving its holder dead
// (append-lock.mjs:150-159): a process that dies after `open('wx')` but before it
// writes its owner record leaves an empty lock that must eventually be reclaimed
// on age alone. That is the right trade for the spine append funnel (a fork is
// caught by `verify`), but it is UNSOUND for a worktree-destroying op: an
// age-reclaim of a *live-but-descheduled* holder would let two writers run a
// destructive `git worktree remove` concurrently, and a crash-before-record would
// otherwise poison a lane forever. So PR-D uses a **publish-atomically** protocol:
//
//   • acquire  = mkdir a private tmp dir, write the FULL owner record INTO it,
//                then rename(tmp → lockPath). The rename is the atomic arbiter,
//                and the published lock dir therefore ALWAYS already contains a
//                complete owner record. A crash before the rename leaves only a
//                disposable tmp dir (never a bodyless published lock), and a
//                *held* lock can ALWAYS be proven-dead-reclaimed because its
//                record is guaranteed present.
//   • reclaim  = a dead SAME-HOST owner is stolen by an ATOMIC QUARANTINE rename
//                (lockPath → lockPath.dead.<deadOwnerId>). The destination is
//                derived from the DEAD owner, so two racing stealers cannot both
//                succeed and a suspended second stealer can never delete the
//                winner's replacement. The tombstone is RETAINED (offline sweep
//                only) — deleting it online would reopen that race.
//   • release  = verify ownership, then rename(lockPath → lockPath.released.<id>)
//                and delete the renamed dir. NEVER rm the published lockPath in
//                place: a recursive in-place delete briefly bodyless-empties the
//                dir, recreating the exact hazard this protocol removes.
//
// Directory rename is used precisely because it never MERGES onto an existing
// destination: POSIX rename onto a non-empty dir fails (ENOTEMPTY/EEXIST) and
// NTFS rename onto any existing dir fails — and our published dir is never empty
// (it always holds owner.json), so a competing publish deterministically fails
// rather than clobbering the incumbent. Windows may surface codes other than
// EEXIST, so a failed publish TESTS lockPath existence rather than matching a
// specific errno.

import { mkdir, writeFile, readFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';

const HOST = hostname();
// A short, filename-safe digest of the host so a tmp/lock name can encode which
// host minted it (only same-host owners are ever pid-probed or GC'd).
const HOST_HASH = createHash('sha256').update(HOST).digest('hex').slice(0, 12);

const POLL_MS = 25;
const WAIT_LOG_EVERY = Math.max(1, Math.round(1000 / POLL_MS)); // ~1s
export const WORKTREE_LOCK_WAIT_MS = defaultWaitMs();

// Finite by construction (unlike append-lock's Infinity default): a wedged
// worktree op must degrade to a structured skip, never hang a janitor sweep or
// an interactive `lane release`. Env can tune it; a garbage value falls back.
function defaultWaitMs() {
  const raw = Number(process.env.MADDU_WORKTREE_LOCK_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

function nonce() {
  return randomBytes(12).toString('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// true  = alive, or exists-but-not-ours (EPERM) — NEVER steal/GC.
// false = proven dead (ESRCH) — safe to steal/GC if same-host.
// null  = unknowable (bad pid) — treat as "do not touch".
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    if (e && e.code === 'EPERM') return true;
    return null;
  }
}

const MISSING = Symbol('lock-missing');

// Read the published owner record. Returns:
//   MISSING          — lockPath does not exist (rename failed for another reason)
//   { record: null } — dir exists but the record is unreadable/torn (retry)
//   { record: {...} } — the held owner record
async function readOwner(lockPath) {
  try {
    const st = await lstat(lockPath);
    if (!st.isDirectory()) return { record: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return MISSING;
    throw e;
  }
  try {
    const txt = await readFile(join(lockPath, 'owner.json'), 'utf8');
    if (!txt.trim()) return { record: null };
    return { record: JSON.parse(txt) };
  } catch {
    return { record: null };
  }
}

// Steal a lock ONLY when its holder is a same-host, proven-dead pid, via an
// atomic quarantine rename whose destination is derived from the DEAD owner id.
// Returns true iff we moved the incumbent aside (caller then re-publishes). The
// tombstone is retained; deleting it online would let a suspended second stealer
// win a collision and delete the live replacement.
async function tryQuarantineDead(lockPath, rec) {
  if (!rec || rec.host !== HOST) return false;       // cross-host: never auto-steal
  if (pidAlive(rec.pid) !== false) return false;     // only PROVEN-dead
  if (!rec.ownerId) return false;
  try {
    await rename(lockPath, `${lockPath}.dead.${rec.ownerId}`);
    return true;
  } catch {
    return false; // another contender quarantined first, or it changed under us
  }
}

// Sweep orphan tmp dirs left by a crash-before-publish — but ONLY those minted by
// a same-host pid we can PROVE dead. Never age-reclaims: a live-but-descheduled
// acquirer's tmp (its pid still alive) is left untouched, so an in-flight publish
// is never destroyed under it.
async function gcOrphanTmps(parent, base) {
  let entries;
  try { entries = await readdir(parent); } catch { return; }
  const prefix = `${base}.tmp.`;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    // <hostHash>.<pid>.<ownerId> — all three fields are dot-free (hex / digits).
    const parts = name.slice(prefix.length).split('.');
    if (parts.length < 3) continue;
    const [hh, pidStr] = parts;
    if (hh !== HOST_HASH) continue;                  // only same host
    const pid = Number(pidStr);
    if (pidAlive(pid) !== false) continue;           // only PROVEN-dead
    try { await rm(join(parent, name), { recursive: true, force: true }); } catch {}
  }
}

async function rmTmp(tmpPath) {
  try { await rm(tmpPath, { recursive: true, force: true }); } catch {}
}

// Acquire the lock via publish-atomically. Returns
//   { acquired: true, ownerId, release }  — held; call release() when done
//   { acquired: false, reason: 'lock-busy', holder }  — a LIVE holder held it
//     past maxWaitMs (structured skip; our own tmp is already cleaned up).
// Any non-contention error (the rename failed for a reason other than an existing
// lockPath) rethrows AFTER deleting our own unpublished tmp dir.
export async function acquireWorktreeLock(lockPath, { maxWaitMs = WORKTREE_LOCK_WAIT_MS, onWait = null } = {}) {
  const ownerId = nonce();
  const parent = dirname(lockPath);
  const base = basename(lockPath);
  const tmpPath = `${lockPath}.tmp.${HOST_HASH}.${process.pid}.${ownerId}`;

  await mkdir(parent, { recursive: true });
  await mkdir(tmpPath, { recursive: true });         // private, unpublished
  try {
    await writeFile(
      join(tmpPath, 'owner.json'),
      JSON.stringify({ ownerId, pid: process.pid, host: HOST, hostHash: HOST_HASH, startedAt: new Date().toISOString() }),
    );
    let waited = 0;
    for (;;) {
      try {
        await rename(tmpPath, lockPath);             // ATOMIC publish
        return { acquired: true, ownerId, release: () => releaseWorktreeLock(lockPath, ownerId) };
      } catch (e) {
        const held = await readOwner(lockPath);
        if (held === MISSING) throw e;               // not a contention failure
        const reclaimed = held.record ? await tryQuarantineDead(lockPath, held.record) : false;
        await gcOrphanTmps(parent, base);
        if (reclaimed) continue;                     // incumbent quarantined — republish now
        const elapsed = waited * POLL_MS;
        if (elapsed >= maxWaitMs) {
          await rmTmp(tmpPath);                       // structured skip: clean own tmp
          return { acquired: false, reason: 'lock-busy', holder: held.record || null };
        }
        if (onWait && waited % WAIT_LOG_EVERY === 0) onWait({ waitedMs: elapsed, holder: held.record || null });
        waited++;
        await sleep(POLL_MS);
      }
    }
  } catch (e) {
    // Non-contention abort (write failure, unexpected rename errno): never leave
    // our own tmp behind — proven-dead-only GC would never collect a live PID's.
    await rmTmp(tmpPath);
    throw e;
  }
}

// Release ONLY our own lock, atomically: verify ownership, rename the published
// dir aside, then delete the renamed dir. NEVER rm the published lockPath in
// place (that would bodyless-empty it mid-delete). A crash between the rename and
// the delete leaves harmless `.released.<ownerId>` debris (offline sweep).
export async function releaseWorktreeLock(lockPath, ownerId) {
  const held = await readOwner(lockPath);
  if (held === MISSING || !held.record || held.record.ownerId !== ownerId) return;
  const releasedPath = `${lockPath}.released.${ownerId}`;
  try {
    await rename(lockPath, releasedPath);
  } catch {
    return; // stolen/replaced under us — never touch another owner's lock
  }
  try { await rm(releasedPath, { recursive: true, force: true }); } catch { /* harmless debris */ }
}

// Convenience: run `fn` while holding the lock. Returns
//   { acquired: true, value }   — fn ran (its result in `value`); lock released
//   { acquired: false, reason } — the lock was busy; fn did NOT run
// A callback exception propagates (the lock is still released first).
export async function withWorktreeLock(lockPath, fn, opts = {}) {
  const lock = await acquireWorktreeLock(lockPath, opts);
  if (!lock.acquired) return lock;
  try {
    const value = await fn(lock);
    return { acquired: true, value };
  } finally {
    await lock.release();
  }
}
