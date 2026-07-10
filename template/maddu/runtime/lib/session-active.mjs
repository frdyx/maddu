// Per-repo "active session" cache. UX hint, never source of truth.
//
// Storage: .maddu/state/session.active.json
//
// Semantics:
//   - register / session start writes a pointer to the new session id.
//   - heartbeat / close consult the pointer when --session is omitted.
//   - close clears the pointer.
//   - Writes are atomic (temp + rename) so a crash mid-write never
//     leaves a corrupt half-file on disk.
//   - readActiveSessionVerified() does a single backward NDJSON scan of
//     the spine to confirm the cached session is still alive — if a
//     SESSION_CLOSED event for that id exists (or the SESSION_REGISTERED
//     event was never appended), the cache is reported stale and the
//     caller is expected to clear it and prompt for a fresh start.
//
// Hard-rule compliance: spine remains authoritative; this file is a
// rebuildable hint. If it disappears the user passes --session once and
// continues. No bridge involvement, no machine-wide state.

import { join } from 'node:path';
import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { pathsFor } from './paths.mjs';
import { readAll } from './spine.mjs';
import { redactLeaves } from './secret-scan.mjs';

const SCHEMA_VERSION = 1;

function activePath(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'session.active.json');
}

export async function readActiveSession(repoRoot) {
  try {
    let raw = await readFile(activePath(repoRoot), 'utf8');
    // Tolerate a UTF-8 BOM if anything other than our atomic writer
    // touched the file (e.g. an editor on Windows). Our own writes
    // never produce one.
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed && parsed.sessionId) return parsed;
    return null;
  } catch {
    return null;
  }
}

// Atomic write — temp file then rename. Power loss mid-write leaves
// either the prior file or the new file, never a truncated half-write.
export async function writeActiveSession(repoRoot, payload) {
  const dir = pathsFor(repoRoot).statePrjDir;
  await mkdir(dir, { recursive: true });
  const dst = activePath(repoRoot);
  const tmp = dst + '.tmp';
  // Write-boundary redaction: the pointer persists a caller-supplied focus/label.
  // Value-pattern scrub only; clean records are unchanged.
  const record = redactLeaves({ _v: SCHEMA_VERSION, ...payload });
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n');
  await rename(tmp, dst);
  return record;
}

export async function clearActiveSession(repoRoot) {
  try { await unlink(activePath(repoRoot)); } catch {}
}

// Self-healing read. Returns:
//   - null              → no cache, nothing to do
//   - the cached record → session found and still active in the spine
//   - { stale: true,
//       sessionId }     → cache exists but the session is closed (or was
//                         never registered). Caller should clear + error.
//
// Implementation: reverse-iterate the spine NDJSON, short-circuiting on
// either SESSION_CLOSED (stale) or SESSION_REGISTERED (alive). For
// typical repos the answer is found in the last few events.
export async function readActiveSessionVerified(repoRoot) {
  const cached = await readActiveSession(repoRoot);
  if (!cached) return null;
  let events;
  try { events = await readAll(repoRoot); }
  catch { return cached; }  // spine unreadable — be lenient, trust the cache
  // Session events carry the session id in `ev.actor`, not in data or in
  // the event id itself. Match accordingly.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.actor !== cached.sessionId) continue;
    if (ev.type === 'SESSION_CLOSED') return { stale: true, sessionId: cached.sessionId };
    if (ev.type === 'SESSION_AUTO_CLOSED') return { stale: true, sessionId: cached.sessionId };
    if (ev.type === 'SESSION_REGISTERED') return cached;
    // v0.17: zero-keystroke `maddu register` writes SESSION_AUTO_REGISTERED.
    // The lifecycle is identical to SESSION_REGISTERED — counts as alive.
    if (ev.type === 'SESSION_AUTO_REGISTERED') return cached;
  }
  // Walked the full spine, no REGISTERED event matches — the cache
  // points to a session that never existed in this repo. Treat as stale.
  return { stale: true, sessionId: cached.sessionId };
}

export function activeSessionPath(repoRoot) {
  return activePath(repoRoot);
}
