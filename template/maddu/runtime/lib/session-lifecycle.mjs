// Session-lifecycle transactions (PR-A, v1.111.0).
//
// Every session-lifecycle mutation goes through the primitives in this module
// — no lifecycle writer appends outside them. Each primitive has TWO layers
// (the advisory lock is NOT re-entrant): a public self-locking function and an
// unlocked `…In` variant callable only while the caller already holds the
// CLOSE lock (session-start composes `withBindingTransaction { withCloseLock {
// renewIn-or-registerIn + bind } }` with no nested acquisition).
//
// GLOBAL LOCK ORDER: claude-binding lock → session-close lock →
// active-pointer lock (leaf); the spine's own append lock is innermost and
// independent. No path acquires in reverse.
//
// PARSE-ACCOUNTING POLICY (one rule for every strict consumer):
//   parseErrors === 0    → full guarantees. The claim is scoped to ACCIDENTAL
//                          corruption (truncated/garbled lines) — a parseable
//                          adversarial edit passes parse accounting while
//                          breaking the hash chain; chain integrity is the
//                          verification layer's domain (`maddu verify`,
//                          threat-model §13), not these helpers'.
//   parseErrors > 0      → REFUSE mutation ('spine-corrupt'): a duplicate
//                          close corrupts the record further; fail toward the
//                          leak (the janitor reaps leaks). Explicit-id
//                          registration refuses (uniqueness unprovable);
//                          GENERATED-id registration proceeds (random
//                          collision negligible; basic operation survives).
//   parseErrors === null → replica/sync mode, accounting unavailable →
//                          today's tolerant semantics exactly (no regression
//                          from main).

import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathsFor } from './paths.mjs';
import { withAppendLock } from './append-lock.mjs';
import { readAllStrict, append, EVENT_TYPES, genSessionId, isSid } from './spine.mjs';
import { reduceSessions } from './projections.mjs';
import { clearActiveSessionIf } from './session-active.mjs';

const CLOSE_LOCK_WAIT_MS = 3000;

function closeLockPath(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'session.close.lock');
}

// Serialize fn under the close lock (mkdir first — the lock primitive opens
// its path directly and .maddu/state is rebuildable/possibly absent).
// Returns fn's result, or the LOCK sentinel ONLY for acquisition failure
// (timeout / lock IO): a callback exception PROPAGATES — an operational
// failure (strict read, reducer, append) must never masquerade as lock
// contention, or fallbacks meant for a busy lock would bypass the
// transaction on ordinary errors.
const LOCK_FAILED = Symbol('close-lock-failed');
export async function withCloseLock(repoRoot, fn) {
  try {
    await mkdir(pathsFor(repoRoot).statePrjDir, { recursive: true });
  } catch {
    return LOCK_FAILED;
  }
  let cbError = null;
  let result;
  try {
    result = await withAppendLock(closeLockPath(repoRoot), async () => {
      try { return await fn(); } catch (e) { cbError = e; return undefined; }
    }, { maxWaitMs: CLOSE_LOCK_WAIT_MS });
  } catch {
    return LOCK_FAILED;   // acquisition/timeout only — fn never ran
  }
  if (cbError) throw cbError;
  return result;
}
export function isLockFailed(v) { return v === LOCK_FAILED; }

// One strict snapshot + the session reduction, taken INSIDE a held lock.
// Returns { gate: 'ok' | 'corrupt', events, view } — `gate: 'corrupt'` only
// for parseErrors > 0; null accounting is tolerant-mode 'ok' per the policy.
async function snapshotIn(repoRoot, nowMs) {
  const { events, parseErrors } = await readAllStrict(repoRoot);
  if (typeof parseErrors === 'number' && parseErrors > 0) {
    return { gate: 'corrupt', events, view: null };
  }
  return { gate: 'ok', events, view: reduceSessions(events, { nowMs }) };
}

// Normalize a caller-supplied handoff into the schema shape (object|null) —
// this helper is the SINGLE normalization point for every close producer
// (CLI string flags, the bridge body, the hooks).
export function normalizeHandoff(h) {
  if (typeof h === 'string' && h.length > 0) return { summary: h };
  if (h && typeof h === 'object' && !Array.isArray(h)) return h;
  return null;
}

// ── Conditional close ───────────────────────────────────────────────────────
// { status: 'closed'|'already-closed'|'missing'|'lock'|'spine-corrupt'|
//   'precondition-failed', event }
export async function closeSessionIfActiveIn(repoRoot, { sessionId, eventType, data, triggeredBy, precondition, nowMs = Date.now() }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { status: 'missing', event: null };
  }
  const snap = await snapshotIn(repoRoot, nowMs);
  if (snap.gate === 'corrupt') return { status: 'spine-corrupt', event: null };
  const session = snap.view.sessions.find((s) => s.id === sessionId) || null;
  if (!session) return { status: 'missing', event: null };
  if (session.status !== 'active') return { status: 'already-closed', event: null };
  if (typeof precondition === 'function' && !precondition(session, snap.view)) {
    return { status: 'precondition-failed', event: null };
  }
  const payload = {
    type: eventType || EVENT_TYPES.SESSION_CLOSED,
    actor: sessionId,
    lane: null,
    data: { ...(data || {}) },
  };
  if ('handoff' in payload.data || payload.type === EVENT_TYPES.SESSION_CLOSED) {
    payload.data.handoff = normalizeHandoff(payload.data.handoff);
  }
  if (triggeredBy) payload.triggered_by = triggeredBy;
  const event = await append(repoRoot, payload);
  await clearActiveSessionIf(repoRoot, sessionId);
  return { status: 'closed', event };
}

export async function closeSessionIfActive(repoRoot, opts) {
  const res = await withCloseLock(repoRoot, () => closeSessionIfActiveIn(repoRoot, opts));
  return isLockFailed(res) ? { status: 'lock', event: null } : res;
}

// ── Conditional stale mark (janitor pass 1) ─────────────────────────────────
// One-shot invariant enforced IN-lock: still active + not already marked
// stale + caller precondition (heartbeat-age revalidation) all against the
// fresh snapshot. { status: 'marked'|'skipped'|'lock'|'spine-corrupt', event }
export async function markSessionStaleIfStillIn(repoRoot, { sessionId, data, triggeredBy, precondition, nowMs = Date.now() }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { status: 'skipped', event: null };
  }
  const snap = await snapshotIn(repoRoot, nowMs);
  if (snap.gate === 'corrupt') return { status: 'spine-corrupt', event: null };
  const session = snap.view.sessions.find((s) => s.id === sessionId) || null;
  if (!session || session.status !== 'active') return { status: 'skipped', event: null };
  if (snap.view.staleSet.has(sessionId)) return { status: 'skipped', event: null };
  if (typeof precondition === 'function' && !precondition(session, snap.view)) {
    return { status: 'skipped', event: null };
  }
  const payload = {
    type: EVENT_TYPES.SESSION_STALE_DETECTED,
    actor: null,
    lane: null,
    data: { sessionId, ...(data || {}) },
  };
  if (triggeredBy) payload.triggered_by = triggeredBy;
  const event = await append(repoRoot, payload);
  return { status: 'marked', event };
}

export async function markSessionStaleIfStill(repoRoot, opts) {
  const res = await withCloseLock(repoRoot, () => markSessionStaleIfStillIn(repoRoot, opts));
  return isLockFailed(res) ? { status: 'lock', event: null } : res;
}

// ── Atomic reuse renewal (env-idempotent register path) ─────────────────────
// Re-project → verify active → heartbeat, as ONE close-locked operation.
// { status: 'renewed'|'not-active'|'spine-corrupt'|'lock', event }
export async function renewSessionIfActiveIn(repoRoot, { sessionId, focus, nowMs = Date.now() }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { status: 'not-active', event: null };
  }
  const snap = await snapshotIn(repoRoot, nowMs);
  if (snap.gate === 'corrupt') return { status: 'spine-corrupt', event: null };
  const session = snap.view.sessions.find((s) => s.id === sessionId) || null;
  if (!session || session.status !== 'active') return { status: 'not-active', event: null };
  const event = await append(repoRoot, {
    type: EVENT_TYPES.SESSION_HEARTBEAT,
    actor: sessionId,
    lane: null,
    data: { focus: focus || null },
  });
  return { status: 'renewed', event };
}

export async function renewSessionIfActive(repoRoot, opts) {
  const res = await withCloseLock(repoRoot, () => renewSessionIfActiveIn(repoRoot, opts));
  return isLockFailed(res) ? { status: 'lock', event: null } : res;
}

// ── Unique registration (ALL FOUR production registration appenders) ────────
// makeEvent(sessionId) → { type, actor, lane, data } is invoked with the
// FINAL id after any regeneration (auto events must duplicate the id into the
// schema-required data.sessionId — prebuilt data can't survive a retry). The
// helper asserts actor/data.sessionId consistency before appending.
// { status: 'registered'|'invalid-id'|'exists'|'lock'|'spine-corrupt', sessionId, event }
export async function registerSessionUniqueIn(repoRoot, { id, makeEvent, nowMs = Date.now() }) {
  const explicit = id !== undefined && id !== null;
  // Grammar validation PRECEDES any snapshot/lock work — an invalid id must
  // map to invalid-id deterministically, never contention-dependently.
  if (explicit && !isSid(id)) return { status: 'invalid-id', sessionId: null, event: null };
  const snap = await snapshotIn(repoRoot, nowMs);
  if (explicit) {
    // Uniqueness is unprovable on a corrupt spine → refuse.
    if (snap.gate === 'corrupt') return { status: 'spine-corrupt', sessionId: null, event: null };
    if (snap.view.sessions.some((s) => s.id === id)) {
      return { status: 'exists', sessionId: id, event: null };
    }
    const event = await appendChecked(repoRoot, makeEvent, id);
    return { status: 'registered', sessionId: id, event };
  }
  // Generated ids: existence-checked when the snapshot allows; on a corrupt
  // spine proceed on randomness alone (basic operation must survive).
  let sessionId = genSessionId();
  if (snap.gate !== 'corrupt') {
    for (let attempt = 0; attempt < 3 && snap.view.sessions.some((s) => s.id === sessionId); attempt++) {
      sessionId = genSessionId();
    }
    if (snap.view.sessions.some((s) => s.id === sessionId)) {
      return { status: 'exists', sessionId, event: null };
    }
  }
  const event = await appendChecked(repoRoot, makeEvent, sessionId);
  return { status: 'registered', sessionId, event };
}

async function appendChecked(repoRoot, makeEvent, sessionId) {
  const ev = makeEvent(sessionId);
  if (!ev || ev.actor !== sessionId) {
    throw new Error('registerSessionUnique: makeEvent must set actor to the final session id');
  }
  if (ev.data && 'sessionId' in ev.data && ev.data.sessionId !== sessionId) {
    throw new Error('registerSessionUnique: makeEvent data.sessionId must match the final session id');
  }
  return append(repoRoot, ev);
}

export async function registerSessionUnique(repoRoot, opts) {
  // Grammar validation precedes the lock (deterministic invalid-id even
  // under contention).
  const explicit = opts && opts.id !== undefined && opts.id !== null;
  if (explicit && !isSid(opts.id)) return { status: 'invalid-id', sessionId: null, event: null };
  const res = await withCloseLock(repoRoot, () => registerSessionUniqueIn(repoRoot, opts));
  if (!isLockFailed(res)) return res;
  // Close-lock ACQUISITION failure (only — operational callback errors
  // propagate from withCloseLock and never reach this fallback): a
  // SessionStart must never be lost to a busy lock. An EXPLICIT id refuses
  // (uniqueness unprovable while the lock is held), but a GENERATED id
  // falls back to the unlocked append — main's current shape — a freshly
  // generated id cannot be the target of a racing close, and random
  // collision is the accepted negligible risk.
  if (explicit) {
    return { status: 'lock', sessionId: null, event: null };
  }
  const sessionId = genSessionId();
  const event = await appendChecked(repoRoot, opts.makeEvent, sessionId);
  return { status: 'registered', sessionId, event };
}
