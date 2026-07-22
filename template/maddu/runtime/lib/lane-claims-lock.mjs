// Lane-claims serialization lock (PR-C, v1.113.0).
//
// The lane-ownership write path (claim / release / force / auto-claim / janitor
// orphan-reconcile) reads a projection, decides, then appends — a read-decide-
// write transaction that `spine.append` does NOT serialize (it locks only the
// physical write + hash chain, not the decision window above it). Two writers
// could each observe the same pre-state, each decide "OK", and each append. This
// lock serializes that transaction so every ownership decision is made against a
// snapshot that cannot change under it before the matching append lands.
//
// Modeled byte-for-byte on session-lifecycle.withCloseLock (PR-A): the same
// LOCK_FAILED sentinel discipline (returned ONLY for acquisition/timeout — fn
// never ran), the same boolean cbThrew tracking so a callback `throw null` /
// `throw undefined` / `Promise.reject()` propagates instead of masquerading as
// lock contention. An operational error (strict read, reducer, append) must
// never be mistaken for a busy lock, or the fail-open fallbacks meant for
// contention would bypass the transaction on ordinary errors.
//
// GLOBAL LOCK ORDER (extends session-lifecycle's SSOT comment):
//   claude-binding → session-close → lane-claims → active-pointer (leaf)
// The spine's own append lock is innermost and independent. Active-VALIDATING
// ownership writers (claim / force / auto-claim — they gate on session-active)
// take close THEN claims; release and janitor-orphan take claims only. No path
// acquires in reverse.
//
// maxWaitMs is per-call: interactive CLI/bridge mutations use the 3s default;
// the auto-claim hook passes ~0 so a busy lock skips instantly rather than
// stalling the editor (the hook fails open).

import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathsFor } from './paths.mjs';
import { withAppendLock } from './append-lock.mjs';

export const CLAIMS_LOCK_WAIT_MS = 3000;   // interactive default

const LOCK_FAILED = Symbol('claims-lock-failed');

function claimsLockPath(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'lane.claims.lock');
}

// Serialize fn under the lane-claims lock (mkdir first — the lock primitive
// opens its path directly and .maddu/state is rebuildable/possibly absent).
// Returns fn's result, or the LOCK sentinel ONLY for acquisition failure
// (timeout / lock IO): a callback exception PROPAGATES.
export async function withClaimsLock(repoRoot, fn, { maxWaitMs = CLAIMS_LOCK_WAIT_MS } = {}) {
  try {
    await mkdir(pathsFor(repoRoot).statePrjDir, { recursive: true });
  } catch {
    return LOCK_FAILED;
  }
  let cbThrew = false, cbError;
  let result;
  try {
    result = await withAppendLock(claimsLockPath(repoRoot), async () => {
      // Boolean-tracked (not value-truthiness): `throw null` / `throw
      // undefined` / `Promise.reject()` must propagate too.
      try { return await fn(); } catch (e) { cbThrew = true; cbError = e; return undefined; }
    }, { maxWaitMs });
  } catch {
    return LOCK_FAILED;   // acquisition/timeout only — fn never ran
  }
  if (cbThrew) throw cbError;
  return result;
}

export function isClaimsLockFailed(v) { return v === LOCK_FAILED; }
