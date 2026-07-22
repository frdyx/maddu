// Per-repo "active session" cache. UX hint, never source of truth.
//
// Storage: .maddu/state/session.active.json
//
// Semantics (PR-A, v1.111.0):
//   - register / session start writes the pointer under the POINTER LOCK with
//     a unique temp name; a lock timeout SKIPS the write (an unlocked fallback
//     would defeat the CAS clear below).
//   - close clears the pointer ONLY if it still names the closed session
//     (clearActiveSessionIf — locked CAS). Invalid on-disk content is cleared
//     by byte-compare (clearActiveSessionInvalid).
//   - readActiveSessionDetailed distinguishes a SANITIZED valid record from
//     present-but-unusable content; readActiveSessionVerified returns a
//     DISCRIMINATED union — record properties can never masquerade as
//     sentinels.
//
// Lock order: the pointer lock is LEAF-ONLY — nothing else is ever acquired
// while holding it (see the session-lifecycle transaction model).
//
// Hard-rule compliance: spine remains authoritative; this file is a
// rebuildable hint. If it disappears the user passes --session once and
// continues. No bridge involvement, no machine-wide state.

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { pathsFor } from './paths.mjs';
import { readAllStrict, isRefId } from './spine.mjs';
import { withAppendLock } from './append-lock.mjs';
import { redactLeaves } from './secret-scan.mjs';

const SCHEMA_VERSION = 1;
// Short budget: the pointer is a hint — never hold session start hostage.
const POINTER_LOCK_WAIT_MS = 2000;

function activePath(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'session.active.json');
}
function lockPath(repoRoot) { return activePath(repoRoot) + '.lock'; }

// Serialize fn under the pointer lock. Returns fn's result, or `undefined`
// when the lock cannot be acquired (callers treat that as "skip").
async function withPointerLock(repoRoot, fn) {
  try {
    await mkdir(pathsFor(repoRoot).statePrjDir, { recursive: true });
    return await withAppendLock(lockPath(repoRoot), fn, { maxWaitMs: POINTER_LOCK_WAIT_MS });
  } catch {
    return undefined;
  }
}

// Copy ONLY the known fields out of a parsed pointer (sanitized record —
// arbitrary extra properties must never reach callers where they could act
// as sentinels), and require a conforming string sessionId.
function sanitizeRecord(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!isRefId(parsed.sessionId)) return null;
  const out = { sessionId: parsed.sessionId };
  for (const k of ['registeredAt', 'role', 'label', 'lane', 'focus']) {
    if (typeof parsed[k] === 'string') out[k] = parsed[k];
    else if (parsed[k] === null) out[k] = null;
  }
  return out;
}

// Detailed read: { record, raw, invalid }.
//   record  — sanitized pointer, or null
//   raw     — the file's byte content when present (for byte-compare cleanup)
//   invalid — true when a file exists but yields no valid record
export async function readActiveSessionDetailed(repoRoot) {
  let raw;
  try {
    raw = await readFile(activePath(repoRoot), 'utf8');
  } catch {
    return { present: false, record: null, raw: null, invalid: false };
  }
  let text = raw;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* invalid */ }
  const record = sanitizeRecord(parsed);
  return { present: true, record, raw, invalid: record === null };
}

export async function readActiveSession(repoRoot) {
  const d = await readActiveSessionDetailed(repoRoot);
  return d.record;
}

// Atomic locked write — unique temp per writer (a shared temp name lets two
// concurrent writers consume each other's file), rename inside the lock.
// Lock timeout → SKIP the write entirely and return null: an unlocked
// fallback would defeat clearActiveSessionIf's compare-and-clear.
export async function writeActiveSession(repoRoot, payload) {
  const record = redactLeaves({ _v: SCHEMA_VERSION, ...payload });
  const res = await withPointerLock(repoRoot, async () => {
    await writeRecordUnlocked(repoRoot, record);
    return record;
  });
  return res === undefined ? null : res;
}

async function writeRecordUnlocked(repoRoot, record) {
  const dst = activePath(repoRoot);
  const tmp = `${dst}.tmp.${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n');
  await rename(tmp, dst);
}

// Repair-only write: inside the lock, write ONLY when the current pointer is
// REPLACEABLE — absent, unparseable, sessionId not a conforming string, or
// verified-stale (the pointed-at session is closed / never registered). A
// pointer verified to name a LIVE session is preserved regardless of which
// session it names (an idempotent re-register never steals a live pointer).
// Returns true when the write happened.
export async function writeActiveSessionIfAbsent(repoRoot, payload) {
  const record = redactLeaves({ _v: SCHEMA_VERSION, ...payload });
  const res = await withPointerLock(repoRoot, async () => {
    const d = await readActiveSessionDetailed(repoRoot);
    if (d.record) {
      // Valid shape — preserve unless the spine proves it stale. The
      // verified classification runs INSIDE the lock (rare repair path).
      const v = await classifyVerified(repoRoot, d);
      if (v && (v.kind === 'active' || v.kind === 'unverified')) return false;
    }
    await writeRecordUnlocked(repoRoot, record);
    return true;
  });
  return res === true;
}

// Unconditional clear — kept ONLY for callers with genuine wipe semantics.
// Every lifecycle path uses the CAS forms below.
export async function clearActiveSession(repoRoot) {
  try { await unlink(activePath(repoRoot)); } catch {}
}

// Locked compare-and-clear: unlink only if the pointer still names
// `sessionId` (string-guarded). Returns true when it cleared.
export async function clearActiveSessionIf(repoRoot, sessionId) {
  if (!isRefId(sessionId)) return false;
  const res = await withPointerLock(repoRoot, async () => {
    const d = await readActiveSessionDetailed(repoRoot);
    if (!d.record || d.record.sessionId !== sessionId) return false;
    try { await unlink(activePath(repoRoot)); return true; } catch { return false; }
  });
  return res === true;
}

// Locked cleanup of INVALID content: re-read inside the lock, byte-compare
// against the caller's earlier observation, verify still-invalid, unlink.
// Returns true when it cleared (so callers report honestly).
export async function clearActiveSessionInvalid(repoRoot, rawSnapshot) {
  if (typeof rawSnapshot !== 'string') return false;
  const res = await withPointerLock(repoRoot, async () => {
    const d = await readActiveSessionDetailed(repoRoot);
    if (!d.invalid || d.raw !== rawSnapshot) return false;
    try { await unlink(activePath(repoRoot)); return true; } catch { return false; }
  });
  return res === true;
}

// Shared classifier for the verified read. Given a detailed read, returns the
// discriminated union (or null when no pointer). Parse-accounting policy:
//   parseErrors > 0    → { kind: 'unverified', record } — a partial replay
//                        must never confidently classify (a skipped
//                        registration would false-stale a live pointer).
//   parseErrors === null (replica mode — accounting unavailable) → TOLERANT
//                        classification from the returned events, exactly as
//                        main: stale detection stays intact.
//   parseErrors === 0  → confident classification.
async function classifyVerified(repoRoot, detailed) {
  if (detailed.invalid) return { kind: 'invalid', raw: detailed.raw };
  if (!detailed.record) return null;
  const record = detailed.record;
  let events, parseErrors;
  try { ({ events, parseErrors } = await readAllStrict(repoRoot)); }
  catch { return { kind: 'unverified', record }; }
  if (typeof parseErrors === 'number' && parseErrors > 0) {
    return { kind: 'unverified', record };
  }
  // Session events carry the session id in `ev.actor`. Reverse-iterate;
  // short-circuit on the newest lifecycle event for this id.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.actor !== record.sessionId) continue;
    if (ev.type === 'SESSION_CLOSED') return { kind: 'stale', sessionId: record.sessionId };
    if (ev.type === 'SESSION_AUTO_CLOSED') return { kind: 'stale', sessionId: record.sessionId };
    if (ev.type === 'SESSION_REGISTERED') return { kind: 'active', record };
    if (ev.type === 'SESSION_AUTO_REGISTERED') return { kind: 'active', record };
  }
  // No registration found — a pointer to a session that never existed here.
  return { kind: 'stale', sessionId: record.sessionId };
}

// Verified read — DISCRIMINATED union, never a raw record whose own
// properties act as sentinels:
//   null                              → no pointer
//   { kind: 'active',     record }    → verified live
//   { kind: 'unverified', record }    → cannot verify (partial replay / read
//                                       failure). USABLE for resolution;
//                                       NEVER a clear trigger, never claimed
//                                       as verified.
//   { kind: 'stale',      sessionId } → verified closed / never registered
//   { kind: 'invalid',    raw }       → file present, content unusable —
//                                       clean with clearActiveSessionInvalid.
export async function readActiveSessionVerified(repoRoot) {
  const d = await readActiveSessionDetailed(repoRoot);
  if (!d.present) return null;
  return classifyVerified(repoRoot, d);
}

export function activeSessionPath(repoRoot) {
  return activePath(repoRoot);
}
