// Stale-session janitor — Phase 5 of the v0.17 agent-native rollout.
//
// Design (plan §8):
//   No new timer thread. The bridge already calls project() on every
//   /bridge/projection GET. The janitor runs inline at the top of that
//   path: walk projection.activeSessions, compare lastHeartbeatAt to
//   `now`, and emit SESSION_STALE_DETECTED (one-shot per session) or
//   SESSION_AUTO_CLOSED (idempotent against the closed set).
//
// Configuration:
//   .maddu/config/janitor.json — { staleAfterMs, autoCloseAfterMs }.
//   Defaults: 30 min stale, 4 hr auto-close. Missing file → defaults.
//
// Trigger discipline:
//   SESSION_AUTO_CLOSED carries triggered_by:{kind:'janitor',
//   id:'sessions', fired_at}. The trigger MUST appear in
//   .maddu/config/triggers.json's allowlist; init ships the default
//   entry, operator can opt out by removing it.
//
// Idempotency:
//   - SESSION_STALE_DETECTED: emit at most once per (sessionId,
//     ageBracket). We compare against projection.janitor.staleSessions
//     to avoid re-detecting the same session every read. Bracket
//     changes (stale → auto-close-eligible) get a fresh emit.
//   - SESSION_AUTO_CLOSED: never emit for a session already in
//     closed status.

import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { append, EVENT_TYPES } from './spine.mjs';
import { pathsFor } from './paths.mjs';

export const DEFAULT_STALE_MS = 30 * 60 * 1000;        // 30 min
export const DEFAULT_AUTO_CLOSE_MS = 4 * 60 * 60 * 1000; // 4 hr

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export async function readJanitorConfig(repoRoot) {
  const p = join(pathsFor(repoRoot).state, '..', 'config', 'janitor.json');
  if (!(await exists(p))) {
    return { staleAfterMs: DEFAULT_STALE_MS, autoCloseAfterMs: DEFAULT_AUTO_CLOSE_MS };
  }
  try {
    const text = await readFile(p, 'utf8');
    const cfg = JSON.parse(text);
    return {
      staleAfterMs: Number.isFinite(cfg.staleAfterMs) ? cfg.staleAfterMs : DEFAULT_STALE_MS,
      autoCloseAfterMs: Number.isFinite(cfg.autoCloseAfterMs) ? cfg.autoCloseAfterMs : DEFAULT_AUTO_CLOSE_MS,
    };
  } catch {
    return { staleAfterMs: DEFAULT_STALE_MS, autoCloseAfterMs: DEFAULT_AUTO_CLOSE_MS };
  }
}

// Pure evaluation: given a projection and a now timestamp, return the
// session ids that crossed the stale threshold and the ones that crossed
// the auto-close threshold (excluding any already known to be stale /
// closed per the projection's janitor slot).
//
// Returns { stale[], closed[] }. The caller emits events.
export function evaluateSessions(projection, now, cfg) {
  const active = (projection.activeSessions || []).filter((s) => s.status === 'active');
  const alreadyStale = new Set((projection.janitor && projection.janitor.staleSessions) || []);
  const stale = [];
  const closed = [];
  for (const s of active) {
    const last = new Date(s.lastHeartbeatAt || s.registeredAt).getTime();
    const ageMs = now - last;
    if (ageMs >= cfg.autoCloseAfterMs) {
      closed.push({ sessionId: s.id, lastHeartbeatAt: s.lastHeartbeatAt || s.registeredAt, ageMs });
    } else if (ageMs >= cfg.staleAfterMs && !alreadyStale.has(s.id)) {
      stale.push({ sessionId: s.id, lastHeartbeatAt: s.lastHeartbeatAt || s.registeredAt, ageMs });
    }
  }
  return { stale, closed };
}

// Drive an evaluation pass: read config, compute stale/closed sets,
// append the corresponding events. Returns the counts emitted; the
// caller logs/exposes them.
export async function runJanitor(repoRoot, projection, nowMs = Date.now()) {
  const cfg = await readJanitorConfig(repoRoot);
  const { stale, closed } = evaluateSessions(projection, nowMs, cfg);
  const firedAt = new Date(nowMs).toISOString();

  for (const s of stale) {
    await append(repoRoot, {
      type: EVENT_TYPES.SESSION_STALE_DETECTED,
      actor: null,
      lane: null,
      data: {
        sessionId: s.sessionId,
        lastHeartbeatAt: s.lastHeartbeatAt,
        ageMs: s.ageMs,
      },
    });
  }
  for (const s of closed) {
    await append(repoRoot, {
      type: EVENT_TYPES.SESSION_AUTO_CLOSED,
      actor: s.sessionId,
      lane: null,
      data: {
        sessionId: s.sessionId,
        reason: 'janitor-stale',
        lastHeartbeatAt: s.lastHeartbeatAt,
        ageMs: s.ageMs,
      },
      triggered_by: { kind: 'janitor', id: 'sessions', fired_at: firedAt },
    });
  }
  return { staleEmitted: stale.length, closedEmitted: closed.length };
}
