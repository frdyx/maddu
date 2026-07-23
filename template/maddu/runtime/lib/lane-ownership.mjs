// Lane-ownership write transactions (PR-C, v1.113.0).
//
// EVERY lane-ownership mutation goes through the primitives in this module — no
// writer (CLI `lane claim/release/force`, the bridge `/bridge/lanes/*` routes,
// the auto-claim hook, the janitor orphan pass) appends a LANE_CLAIMED /
// LANE_RELEASED / LANE_CLAIM_FORCED outside them. That centralization is what
// scripts/test/lane-writer-census.mjs enforces: a raw ownership append anywhere
// else trips the tripwire. Mirrors session-lifecycle.mjs (PR-A) in shape.
//
// THE DEFECT THIS CLOSES. Each writer used to run project()/reduceClaims →
// decide → append() with NO app-level lock across that window; spine.append
// serializes only the physical write + hash chain, not the read-decide-write
// transaction above it. Two writers could each observe the same pre-state, each
// decide "OK", each append — the decision was already stale when the second
// append landed. Every primitive here takes a FRESH strict snapshot INSIDE the
// held lock and decides mode-aware from ONE ownership fold (ownersOf), so a
// decision cannot be invalidated before its own append lands.
//
// LOCK MODEL (extends the session-lifecycle SSOT order):
//   claude-binding → session-close → lane-claims → active-pointer (leaf)
// Active-VALIDATING writers (claim / force / auto-claim — they gate on the actor
// being an active session) take close THEN claims: a LANE_CLAIMED that lands
// after a concurrent SESSION_CLOSED (which holds the close lock only) would
// orphan, because the close cascade already replayed and reduceClaims never
// re-clears it. Release and the janitor orphan pass take claims ONLY — they do
// not gate on session-active, so they are close-independent.
//
// PARSE-ACCOUNTING (same one rule as PR-A): parseErrors > 0 → REFUSE the
// mutation ('spine-corrupt'); null (replica/sync) → tolerant semantics; 0 →
// full guarantees.
//
// NOT ROLLBACK-ATOMIC (hard rule #2 — append-only). Force, the inactive-cleaning
// claim, and auto-claim append MORE than once inside the one lock and share the
// §3.3a multi-append contract: appends run in a fixed order; the FIRST failure
// STOPS the writer with a { status:'partial', stage, committed } report; success
// is reported ONLY when the terminal LANE_CLAIMED landed. Recovery = re-run,
// which re-snapshots FRESH (never replays a previously-decided release — in
// default mode a stale LANE_RELEASED would evict a newer claimant).
//
// Worktree disposition (release path) holds the claims lock across several Git
// ops by design (§3.5 / open-question 2) — deep two-resource worktree recovery
// is descoped to PR-D.

import { withCloseLock, isLockFailed } from './session-lifecycle.mjs';
import { withClaimsLock, isClaimsLockFailed, CLAIMS_LOCK_WAIT_MS } from './lane-claims-lock.mjs';
import { readAllStrict, append as appendEvent, EVENT_TYPES } from './spine.mjs';
import { readActiveReplicaId } from './spine-append-core.mjs';
import { reduceSessions, ownersOf, foldOwnership } from './projections.mjs';

// Every primitive takes its appender as an injectable seam (default: the real
// spine append), mirroring the `nowMs` seam. Production always uses the default;
// the concurrency/failpoint tests inject a "fail on the Nth append" wrapper to
// exercise the §3.3a partial-transaction contract at EVERY append boundary. The
// literal `append(` call sites are preserved so the lane-writer census still
// recognizes this module as the sole ownership appender.

// One strict snapshot + the session/ownership context, taken INSIDE a held lock.
// { gate:'ok'|'corrupt', events, syncMode, view, activeIds }. gate:'corrupt'
// only for parseErrors > 0; null accounting is tolerant-mode 'ok'.
async function ownershipSnapshotIn(repoRoot, nowMs) {
  const { events, parseErrors } = await readAllStrict(repoRoot);
  if (typeof parseErrors === 'number' && parseErrors > 0) {
    return { gate: 'corrupt', events: null, syncMode: false, view: null, activeIds: null };
  }
  const syncMode = !!(await readActiveReplicaId(repoRoot));
  const view = reduceSessions(events, { nowMs });
  const activeIds = new Set(view.activeSessions.map((s) => s.id));
  return { gate: 'ok', events, syncMode, view, activeIds };
}

// Does `sid` own ANY lane (holder OR superseded) on this snapshot? — the
// auto-claim "already claimed" guard must see superseded owners, which
// reduceClaims (winners only) would hide.
function ownsAnyLane(events, sid, syncMode) {
  const st = foldOwnership(events, { syncMode });
  if (!syncMode) {
    for (const c of st.claims.values()) if (c.sessionId === sid) return true;
    return false;
  }
  for (const owners of st.laneClaims.values()) if (owners.has(sid)) return true;
  return false;
}

// Every owner (holder + superseded) across all lanes on this snapshot — the
// janitor reaps inactive owners at every rank, not just winners.
function allOwners(events, syncMode) {
  const st = foldOwnership(events, { syncMode });
  const out = [];
  if (!syncMode) { for (const c of st.claims.values()) out.push(c); return out; }
  for (const owners of st.laneClaims.values()) for (const o of owners.values()) out.push(o);
  return out;
}

// Run fn under the ownership lock(s). closeLock=true → close→claims (active-
// validating writers); false → claims only. Returns fn's result, or the string
// 'lock' for an acquisition/timeout of EITHER lock (fn never ran). A callback
// exception propagates (an operational error must never masquerade as a busy
// lock). maxWaitMs applies to BOTH locks.
async function withOwnershipLock(repoRoot, { closeLock, maxWaitMs = CLAIMS_LOCK_WAIT_MS }, fn) {
  const inner = () => withClaimsLock(repoRoot, fn, { maxWaitMs });
  const res = closeLock
    ? await withCloseLock(repoRoot, inner, { maxWaitMs })
    : await inner();
  if (isLockFailed(res) || isClaimsLockFailed(res)) return 'lock';
  return res;
}

// ── Claim (non-force) ─────────────────────────────────────────────────────────
// Active-validating. Refuses on ANY active rival owner (both modes; force is the
// sole evictor of active rivals). Otherwise cleans up inactive owners (release
// each, both modes) THEN claims — a §3.3a multi-append critical section.
// { status:'claimed'|'already-claimed'|'unregistered'|'session-closed'|
//   'spine-corrupt'|'partial'|'lock', ... }
export async function claimLaneIn(repoRoot, { sid, lane, focus = null, nowMs = Date.now(), append = appendEvent }) {
  const snap = await ownershipSnapshotIn(repoRoot, nowMs);
  if (snap.gate === 'corrupt') return { status: 'spine-corrupt', event: null };
  const { events, syncMode, view, activeIds } = snap;
  const claimant = view.sessions.find((s) => s.id === sid) || null;
  if (!claimant) return { status: 'unregistered', event: null };
  if (claimant.status !== 'active') return { status: 'session-closed', event: null };

  const own = ownersOf(events, lane, { syncMode });
  const holderId = own.holder ? own.holder.sessionId : null;
  const activeRival = own.owners.find((o) => o.sessionId !== sid && activeIds.has(o.sessionId));
  if (activeRival) return { status: 'already-claimed', event: null, holder: own.holder, rival: activeRival };

  // Inactive-owner cleanup (both modes) — a default new claim would OVERWRITE an
  // orphan so the janitor could never see/release it; release each inactive
  // non-self owner explicitly first.
  const inactiveOthers = own.owners.filter((o) => o.sessionId !== sid && !activeIds.has(o.sessionId));
  const committed = [];
  for (const o of inactiveOthers) {
    try {
      const rel = await append(repoRoot, {
        type: EVENT_TYPES.LANE_RELEASED, actor: o.sessionId, lane,
        data: { reason: 'inactive-owner-cleanup', by: sid },
      });
      committed.push(rel.id);
    } catch (e) {
      return { status: 'partial', stage: 'cleanup-release', committed, holder: holderId, error: e };
    }
  }
  let event;
  try {
    event = await append(repoRoot, {
      type: EVENT_TYPES.LANE_CLAIMED, actor: sid, lane, data: { focus: focus || null },
    });
  } catch (e) {
    return { status: 'partial', stage: 'claim', committed, holder: holderId, error: e };
  }
  return { status: 'claimed', event, cleanupReleases: committed };
}

export async function claimLane(repoRoot, opts) {
  return withOwnershipLock(repoRoot, { closeLock: true }, () => claimLaneIn(repoRoot, opts));
}

// ── Force-claim ────────────────────────────────────────────────────────────────
// The ONE writer allowed to evict active rivals. Active-validating, §3.3a
// critical section: release EVERY current owner ≠ actor (both modes) stamped
// with a shared forceGroup id, then the LANE_CLAIM_FORCED marker, then the claim
// — all carry forceGroup so the force-discipline gate can reconstruct the bundle
// by id (import-stable), not by fragile spine contiguity. `preflight` (optional)
// runs after the snapshot but BEFORE any mutation ({ refuse:true, status } aborts
// clean — e.g. a live worktree on the lane).
// { status:'forced'|'unregistered'|'session-closed'|'spine-corrupt'|'partial'|
//   'refused'|'lock', ... }
export async function forceClaimLaneIn(repoRoot, { sid, lane, focus = null, reason = null, forceGroup, priorHint = null, preflight, nowMs = Date.now(), append = appendEvent }) {
  const snap = await ownershipSnapshotIn(repoRoot, nowMs);
  if (snap.gate === 'corrupt') return { status: 'spine-corrupt', event: null };
  const { events, syncMode, view } = snap;
  const claimant = view.sessions.find((s) => s.id === sid) || null;
  if (!claimant) return { status: 'unregistered', event: null };
  if (claimant.status !== 'active') return { status: 'session-closed', event: null };

  const own = ownersOf(events, lane, { syncMode });
  const holderId = own.holder ? own.holder.sessionId : null;
  if (typeof preflight === 'function') {
    const pf = await preflight({ own, snap });
    if (pf && pf.refuse) return { status: pf.status || 'refused', ...pf };
  }
  // §3.4: an empty (or self-only) lane has nothing to preempt — force degrades
  // to an ordinary claim: NO marker, NO forceGroup, priorSessionId never null.
  // The marker/bundle only exist when a real rival owner is evicted.
  const rivals = own.owners.filter((o) => o.sessionId !== sid);
  if (rivals.length === 0) {
    let event;
    try {
      event = await append(repoRoot, {
        type: EVENT_TYPES.LANE_CLAIMED, actor: sid, lane, data: { focus: focus || null },
      });
    } catch (e) {
      return { status: 'partial', stage: 'claim', committed: [], holder: holderId, error: e };
    }
    return { status: 'claimed', event, prior: null, preempted: [] };
  }
  const prior = holderId || priorHint || null;
  // `committed` accumulates EVERY landed event id (preempt-releases + marker) so a
  // later-boundary failure reports the whole partial bundle for operator recovery.
  const committed = [];
  const preempted = [];
  for (const o of own.owners) {
    if (o.sessionId === sid) continue;
    try {
      const rel = await append(repoRoot, {
        type: EVENT_TYPES.LANE_RELEASED, actor: o.sessionId, lane,
        data: { reason: 'force-claim-preempt', by: sid, forceGroup },
      });
      preempted.push(rel.id); committed.push(rel.id);
    } catch (e) {
      return { status: 'partial', stage: 'preempt-release', committed, holder: holderId, error: e };
    }
  }
  try {
    const marker = await append(repoRoot, {
      type: EVENT_TYPES.LANE_CLAIM_FORCED, actor: sid, lane,
      data: { lane, priorSessionId: prior, by: sid, focus: focus || null, reason: reason ?? null, forceGroup },
    });
    committed.push(marker.id);
  } catch (e) {
    return { status: 'partial', stage: 'marker', committed, holder: holderId, error: e };
  }
  let event;
  try {
    event = await append(repoRoot, {
      type: EVENT_TYPES.LANE_CLAIMED, actor: sid, lane,
      data: { focus: focus || null, forcedFrom: prior, forceGroup },
    });
  } catch (e) {
    return { status: 'partial', stage: 'claim', committed, holder: holderId, error: e };
  }
  return { status: 'forced', event, prior, preempted, forceGroup };
}

export async function forceClaimLane(repoRoot, opts) {
  return withOwnershipLock(repoRoot, { closeLock: true }, () => forceClaimLaneIn(repoRoot, opts));
}

// ── Release ──────────────────────────────────────────────────────────────────
// Claims-only (close-independent). Release iff actor ∈ owners (incl. superseded
// — a superseded owner may withdraw its OWN claim). Optional worktree
// disposition runs IN-lock after the owner re-read, before the release append;
// its authorization is holder-aware (a superseded owner must NOT disposition the
// holder's worktree). `worktree` (optional): { disposition, readLiveAttach(),
// detach(liveAttach) }.
// { status:'released'|'no-owners'|'owned-by-others'|'needs-disposition'|
//   'no-worktree'|'worktree-not-holder'|'worktree-failed'|'worktree-read-failed'|
//   'worktree-only'|'spine-corrupt'|'partial'|'lock', ... }
export async function releaseLaneIn(repoRoot, { sid, lane, worktree = null, nowMs = Date.now(), append = appendEvent }) {
  const snap = await ownershipSnapshotIn(repoRoot, nowMs);
  if (snap.gate === 'corrupt') return { status: 'spine-corrupt', event: null };
  const { events, syncMode, activeIds } = snap;
  const own = ownersOf(events, lane, { syncMode });
  const isOwner = own.owners.some((o) => o.sessionId === sid);
  const holderId = own.holder ? own.holder.sessionId : null;

  // Read the live worktree attachment IN-lock. A read FAILURE fails CLOSED (never
  // release/disposition on an unknown attachment state) — the pre-PR-C code let
  // this read throw and abort; swallowing it to null would release a lane despite
  // a possibly-live worktree. Authorization keys on the ATTACHMENT owner
  // (liveAttach.session — whoever provisioned the checkout), NOT the current
  // claim holder: under team-sync a late-imported earlier claim can supersede the
  // session that attached the worktree, so a holder-based guard would let that
  // session's plain release orphan its own live checkout.
  let liveAttach = null;
  let liveAttachError = false;
  if (worktree && typeof worktree.readLiveAttach === 'function') {
    try { liveAttach = await worktree.readLiveAttach(); } catch { liveAttachError = true; }
  }
  const attachOwner = liveAttach && liveAttach.session ? liveAttach.session : null;
  const ownsAttachment = attachOwner && attachOwner === sid;
  const attachOwnedByOtherActive = attachOwner && attachOwner !== sid && activeIds.has(attachOwner);

  // Worktree disposition branch (§3.5).
  if (worktree && worktree.disposition !== undefined) {
    if (liveAttachError) return { status: 'worktree-read-failed', event: null };
    if (!liveAttach) return { status: 'no-worktree', event: null };
    // The ATTACHMENT owner may disposition its own checkout; an ORPHANED
    // attachment (owner inactive/gone) may be cleaned up by anyone; an
    // attachment owned by ANOTHER ACTIVE session must NOT be yanked (§3.5d).
    if (attachOwnedByOtherActive) {
      return { status: 'worktree-not-holder', event: null, holder: own.holder, attachOwner };
    }
    let detachResult;
    try { detachResult = await worktree.detach(liveAttach); }
    catch (e) { return { status: 'worktree-failed', event: null, error: e }; }
    // Diff-r1 #8: only a COMPLETED disposition frees the claim. A `partial` (git
    // reported removal but the ENOENT postcondition found a survivor, or an append
    // boundary failed) leaves the attachment/worktree live — releasing the claim
    // would strand a live worktree with no owner. Propagate the partial WITHOUT
    // LANE_RELEASED. Only 'detached' / 'already-detached' proceed.
    const dispStatus = detachResult && detachResult.status;
    if (dispStatus && dispStatus !== 'detached' && dispStatus !== 'already-detached') {
      return { status: 'worktree-incomplete', event: null, detachResult, committed: detachResult.committed || [] };
    }
    // Actor holds no claim on the lane → the disposition WAS the cleanup; no
    // LANE_RELEASED (there is nothing of the actor's to release).
    if (!isOwner) return { status: 'worktree-only', event: null, detachResult };
    let event;
    try { event = await append(repoRoot, { type: EVENT_TYPES.LANE_RELEASED, actor: sid, lane, data: {} }); }
    catch (e) { return { status: 'partial', stage: 'release', event: null, committed: [], holder: holderId, error: e, detachResult }; }
    return { status: 'released', event, detachResult };
  }

  // Plain release.
  if (own.owners.length === 0) return { status: 'no-owners', event: null };
  if (!isOwner) return { status: 'owned-by-others', event: null, holder: own.holder };
  // Fail CLOSED on an unreadable attachment state: the actor MIGHT own a live
  // checkout we can't see, so refuse rather than risk orphaning it.
  if (liveAttachError) return { status: 'worktree-read-failed', event: null };
  // Refuse a plain release that would orphan the ACTOR'S OWN live checkout —
  // disposition it first. A live attachment owned by SOMEONE ELSE is untouched
  // by this actor's release, so a superseded owner may withdraw freely (§3.5d).
  // PR-D §3.8: a TARGETED reconcile hook (never a global — it may only touch THIS
  // lane's attachment, under this actor's claims lock) may auto-complete a
  // crash-stranded detach whose PRESENT, token-matched instance can be finalized
  // safely. It fires only for an actor-owned attachment; an absent/intent-less
  // strand is NOT auto-safe and still returns needs-disposition (operator --recover).
  let reconcileEventId = null; // Diff-r1 #11: retained so a release-append failure
  if (ownsAttachment) {          // reports [detachedEvent.id], not [].
    let reconciled = false;
    if (worktree && typeof worktree.reconcileAttachment === 'function') {
      try {
        const rec = await worktree.reconcileAttachment({ lane, attachmentId: liveAttach.attachmentId, worktreeInstanceId: liveAttach.worktreeInstanceId });
        reconciled = !!rec && rec.status === 'finalized';
        if (reconciled) reconcileEventId = rec.eventId || null;
      } catch { reconciled = false; }
    }
    if (!reconciled) return { status: 'needs-disposition', event: null, liveAttach };
    // The stranded detach is now complete (attachment terminalized) — the actor
    // may withdraw its claim. Fall through to the LANE_RELEASED append.
  }
  let event;
  try { event = await append(repoRoot, { type: EVENT_TYPES.LANE_RELEASED, actor: sid, lane, data: {} }); }
  catch (e) { return { status: 'partial', stage: 'release', event: null, committed: reconcileEventId ? [reconcileEventId] : [], holder: holderId, error: e, reconcileEventId }; }
  return { status: 'released', event, reconcileEventId };
}

export async function releaseLane(repoRoot, opts) {
  return withOwnershipLock(repoRoot, { closeLock: false }, () => releaseLaneIn(repoRoot, opts));
}

// ── Auto-claim (rule #9 hook) ──────────────────────────────────────────────────
// Active-validating, near-ZERO wait budget (a busy lock skips instantly rather
// than stalling the editor — the hook fails open). Re-projects IN-lock (ignores
// the caller's stale projection). "Already owns any lane" checks EVERY owner
// (incl. superseded). If the inferred lane has an active rival owner, the caller
// supplies a session-scoped fallback lane. Emits TRIGGER_FIRED + LANE_CLAIMED
// (plus any inactive-owner cleanup releases) under the §3.3a contract.
// { claimed:true, lane, event } | { claimed:false, reason }
export async function autoClaimLaneIn(repoRoot, { sid, lane, fallbackLane, focus = null, triggerId, forPath = null, nowMs = Date.now(), append = appendEvent }) {
  const snap = await ownershipSnapshotIn(repoRoot, nowMs);
  if (snap.gate === 'corrupt') return { claimed: false, reason: 'spine-corrupt' };
  const { events, syncMode, view, activeIds } = snap;
  const sess = view.sessions.find((s) => s.id === sid) || null;
  if (!sess || sess.status !== 'active') return { claimed: false, reason: 'session-not-active' };
  if (ownsAnyLane(events, sid, syncMode)) return { claimed: false, reason: 'already-claimed' };

  const hasActiveRival = (o) => o.owners.some((x) => x.sessionId !== sid && activeIds.has(x.sessionId));
  // Rule #8: if the inferred lane has an active rival owner, fall back to the
  // session-scoped lane.
  let target = lane;
  let own = ownersOf(events, target, { syncMode });
  if (hasActiveRival(own)) {
    target = fallbackLane;
    own = ownersOf(events, target, { syncMode });
  }
  // The SAME active-rival refusal MUST apply to the final target — the fallback
  // lane (`auto/<sid>`) can also be independently owned (e.g. a manual claim on
  // it). Never evict (default) or knowingly-lose (sync) from the hook: skip.
  if (hasActiveRival(own)) return { claimed: false, reason: 'target-taken' };
  const holderId = own.holder ? own.holder.sessionId : null;
  const inactiveOthers = own.owners.filter((o) => o.sessionId !== sid && !activeIds.has(o.sessionId));

  const firedAt = new Date(nowMs).toISOString();
  const committed = [];
  try {
    const trig = await append(repoRoot, {
      type: EVENT_TYPES.TRIGGER_FIRED, actor: sid,
      data: { triggerId, lane: target, forPath },
    });
    committed.push(trig.id);
  } catch (e) {
    return { claimed: false, reason: 'partial', stage: 'trigger', committed, holder: holderId, error: e };
  }
  for (const o of inactiveOthers) {
    try {
      const rel = await append(repoRoot, {
        type: EVENT_TYPES.LANE_RELEASED, actor: o.sessionId, lane: target,
        data: { reason: 'inactive-owner-cleanup', by: sid },
      });
      committed.push(rel.id);
    } catch (e) {
      return { claimed: false, reason: 'partial', stage: 'cleanup-release', committed, holder: holderId, error: e };
    }
  }
  let event;
  try {
    event = await append(repoRoot, {
      type: EVENT_TYPES.LANE_CLAIMED, actor: sid, lane: target,
      data: { focus: focus || sess.focus || 'auto-claimed before edit', autoClaimed: true },
      triggered_by: { kind: 'hook', id: 'auto-claim', fired_at: firedAt },
    });
  } catch (e) {
    return { claimed: false, reason: 'partial', stage: 'claim', committed, holder: holderId, error: e };
  }
  return { claimed: true, lane: target, event };
}

export async function autoClaimLane(repoRoot, opts) {
  const res = await withOwnershipLock(repoRoot, { closeLock: true, maxWaitMs: 0 }, () => autoClaimLaneIn(repoRoot, opts));
  if (res === 'lock') return { claimed: false, reason: 'claims-lock-busy' };
  return res;
}

// ── Janitor orphan reconcile (pass 2) ──────────────────────────────────────────
// Claims-only. Release every owner (incl. superseded) whose holder is not a
// currently-active session — each release AS the orphaned owner (correct in both
// the default delete-by-lane and sync delete-that-owner paths). A failed append
// stops the loop and leaves the rest for the next round.
// { status:'ok'|'spine-corrupt'|'lock', released:[{lane,sessionId}], corrupt }
export async function reapOrphanClaimsIn(repoRoot, { firedAt, nowMs = Date.now(), append = appendEvent }) {
  const snap = await ownershipSnapshotIn(repoRoot, nowMs);
  if (snap.gate === 'corrupt') return { status: 'spine-corrupt', released: [], corrupt: 0 };
  const { events, syncMode, activeIds } = snap;
  const owners = allOwners(events, syncMode);
  const orphaned = owners.filter((c) => typeof c.sessionId === 'string' && c.sessionId.length > 0 && !activeIds.has(c.sessionId));
  const corruptOwners = owners.filter((c) => typeof c.sessionId !== 'string' || c.sessionId.length === 0);
  const released = [];
  for (const c of orphaned) {
    try {
      await append(repoRoot, {
        type: EVENT_TYPES.LANE_RELEASED, actor: c.sessionId, lane: c.lane,
        data: { reason: 'orphan-reconcile' },
        triggered_by: { kind: 'janitor', id: 'sessions', fired_at: firedAt },
      });
      released.push({ lane: c.lane, sessionId: c.sessionId });
    } catch {
      break;
    }
  }
  return { status: 'ok', released, corrupt: corruptOwners.length };
}

export async function reapOrphanClaims(repoRoot, opts) {
  return withOwnershipLock(repoRoot, { closeLock: false }, () => reapOrphanClaimsIn(repoRoot, opts));
}
