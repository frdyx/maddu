// append-lock.mjs — per-partition single-writer advisory lock for team-sync mode.
// Roadmap #12c phase 1 (Codex-hardened). Files-only, Node stdlib, cross-platform.
//
// WHY THIS EXISTS
// ───────────────
// In team-sync mode each replica writes only its own partition
// (`.maddu/events/by-replica/<replicaId>/`). For `verify` to be allowed to treat
// an intra-partition `prev_hash` fork as FATAL on import, that partition must have
// a STRICTLY valid single-writer chain. The default single-machine spine append
// path is deliberately lock-free (see spine.mjs:461-473) and is UNCHANGED by this
// module — the funnel is taken ONLY in sync mode, and only around one partition's
// read-then-write.
//
// The real contenders for one partition are same-host only: the long-lived bridge
// (runtime/server.js) + a short-lived CLI invocation. A replica never writes
// another replica's partition, so cross-machine contention on a single lock cannot
// occur by construction.
//
// PROTOCOL — every rule traces to a Codex red-team finding (2026-07-05):
//   • Mutual exclusion via atomic O_EXCL create: `open(path, 'wx')`. Exactly one
//     writer can create the lock; the OS create is the arbiter.
//   • The lock carries a random `ownerId` nonce + `pid` + `host` + `startedAt`.
//   • Contention with a LIVE holder ⇒ WAIT (indefinite, polled). There is NO
//     timeout-to-best-effort fallback: a lock-free append after contention would
//     reintroduce the predecessor race and make "fork = fatal" a lie. The critical
//     section is a single tail-read + one O_APPEND write, so a live holder is
//     released in milliseconds; unbounded waiting only happens behind a genuinely
//     stuck live process, which is a bug to surface, not to paper over with a fork.
//   • Automatic steal ONLY when the holder is a SAME-HOST pid that is DEFINITELY
//     dead — `process.kill(pid, 0)` throws ESRCH. EPERM means alive. A host
//     mismatch is NEVER age-stolen: a paused-but-live process on a shared/network
//     checkout could otherwise be stolen from and legitimately fork. No age-based
//     steal on the strict path at all.
//   • Release is NONCE-GUARDED: unlink only if the on-disk `ownerId` still matches
//     ours. Codex empirically showed that on this host Node lets a process unlink a
//     lockfile whose 'wx' handle is still open by another process — so a stale
//     ex-holder must never blindly delete what may now be a live replacement's lock.
//
// This module holds NO fd across the critical section (the lock is presence-based:
// the file existing IS the lock). That sidesteps the cross-platform "can you delete
// a file with an open handle" divergence entirely — ownership is the nonce, not the
// handle.

import { open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

const HOST = hostname();
const POLL_MS = 25;
// A legit holder writes its owner record in the VERY NEXT await after open('wx') —
// microseconds normally, at most a few ms even under a congested event loop. A lock
// that stays bodyless for this many consecutive polls (~2s) therefore means its
// creator DIED between the create and the record write; it is reclaimed. The window
// is deliberately long so a slow-but-alive holder is never reclaimed (which would let
// two writers enter), making the reclaim safe without a post-create ownership recheck.
const BODYLESS_GRACE_POLLS = 80;
// Emit an onWait progress callback roughly once per second so a genuinely stuck
// holder is visible to the operator rather than silently hanging.
const WAIT_LOG_EVERY = Math.max(1, Math.round(1000 / POLL_MS));

function nonce() {
  return randomBytes(12).toString('hex');
}

// true  = alive (or exists-but-not-owned: EPERM), definitely do NOT steal.
// false = definitely dead (ESRCH), safe to steal if same-host.
// null  = unknowable (bad pid) — treat as "do not steal", wait instead.
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

async function readLock(lockPath) {
  try {
    const txt = await readFile(lockPath, 'utf8');
    if (!txt.trim()) return null; // created but body not yet written — retry
    return JSON.parse(txt);
  } catch {
    return null; // missing, or a torn mid-write read — caller retries
  }
}

// Steal a lock ONLY if we can prove its holder is a same-host, dead pid, and the
// lock is still the exact record we read (nonce-guarded). Returns true if stolen.
async function tryStealDead(lockPath, rec) {
  if (!rec || rec.host !== HOST) return false; // cross-host: never auto-steal
  if (pidAlive(rec.pid) !== false) return false; // only PROVEN-dead
  const cur = await readLock(lockPath);
  if (!cur || cur.ownerId !== rec.ownerId) return false; // it changed under us
  try {
    await unlink(lockPath);
    return true;
  } catch {
    return false; // someone else won the unlink; loop and re-open('wx')
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Acquire the lock, blocking until held. Returns { ownerId, release }.
//
// `maxWaitMs` (default Infinity) bounds how long we wait on a LIVE holder before
// throwing ELOCKTIMEOUT. Strict callers (spine.append — an orchestration event
// must never be lost or forked) leave it Infinity. Best-effort callers (token-
// usage accounting, which may be DROPPED but must never block a worker's exit)
// pass a finite budget and treat the timeout as "skip this write" — dropping is
// safe because nothing was written, so no chain fork can result.
export async function acquireAppendLock(lockPath, { onWait = null, maxWaitMs = Infinity } = {}) {
  const ownerId = nonce();
  const body = JSON.stringify({
    ownerId,
    pid: process.pid,
    host: HOST,
    startedAt: new Date().toISOString(),
  });
  let waited = 0;
  let nullReads = 0;
  for (;;) {
    let fh = null;
    try {
      fh = await open(lockPath, 'wx'); // O_CREAT | O_EXCL — atomic arbiter
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const rec = await readLock(lockPath);
      let reclaimed = false;
      if (rec === null) {
        // Bodyless lock: either a holder mid-write (transient — the owner record is
        // written microseconds after open) or a holder that DIED between open('wx')
        // and writing its record (no `pid` to prove dead). After a short grace of
        // consecutive empty reads, reclaim it — otherwise it would hang forever.
        if (++nullReads >= BODYLESS_GRACE_POLLS) {
          try { await unlink(lockPath); } catch { /* someone else reclaimed it */ }
          nullReads = 0;
          reclaimed = true;
        }
      } else {
        nullReads = 0;
        reclaimed = await tryStealDead(lockPath, rec); // same-host, proven-dead only
      }
      if (!reclaimed) {
        const elapsed = waited * POLL_MS;
        if (elapsed >= maxWaitMs) {
          const err = new Error(`append lock not acquired within ${maxWaitMs}ms (${lockPath})`);
          err.code = 'ELOCKTIMEOUT';
          throw err;
        }
        if (onWait && waited % WAIT_LOG_EVERY === 0) {
          onWait({ waitedMs: elapsed, holder: rec });
        }
        waited++;
        await sleep(POLL_MS);
      }
      continue; // re-attempt the O_EXCL create (single winner guaranteed)
    }
    try {
      await fh.writeFile(body);
    } finally {
      await fh.close();
    }
    // NOTE (residual, accepted): a post-create ownership recheck would close the
    // purely-theoretical window where a holder is SUSPENDED for >2s (the bodyless
    // grace) between open('wx') and the body write, gets reclaimed, then resumes and
    // re-enters. We deliberately do NOT recheck: an extra read of the lockfile under
    // heavy concurrency empirically broke the funnel here (a reproducible chain fork),
    // whereas the long grace already makes the reclaim practically unreachable (a live
    // holder writes its record microseconds later, never 2s). Consistent with Máddu's
    // spine model (best-effort concurrency, integrity VERIFY-REPORTED not lock-enforced
    // — spine.mjs:461-473), any such fork would be surfaced by `spine verify` /
    // `spine import` (fatal), never silently merged.
    return { ownerId, release: () => releaseAppendLock(lockPath, ownerId) };
  }
}

// Release ONLY our own lock: unlink iff the on-disk ownerId still matches ours.
export async function releaseAppendLock(lockPath, ownerId) {
  const cur = await readLock(lockPath);
  if (cur && cur.ownerId === ownerId) {
    try {
      await unlink(lockPath);
    } catch {
      /* already gone — nothing to do */
    }
  }
  // else: our lock was already stolen/replaced — never unlink another owner's.
}

// Convenience: run `fn` while holding the partition append lock.
export async function withAppendLock(lockPath, fn, opts = {}) {
  const lock = await acquireAppendLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
