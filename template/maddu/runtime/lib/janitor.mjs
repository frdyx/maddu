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

  // Lane worktrees (roadmap #12a phase 6): auto-closing a session drops its
  // lane claims, orphaning any worktree it held. The janitor REPORTS these so
  // the operator can disposition them — it NEVER auto-removes a worktree (that
  // could discard un-integrated work; removal is always an explicit
  // `maddu lane release <lane> --worktree ...`). Best-effort + read-only.
  let orphanedWorktrees = [];
  if (closed.length) {
    try {
      const { readAttachments } = await import('./worktrees.mjs');
      const closedIds = new Set(closed.map((s) => s.sessionId));
      for (const att of (await readAttachments(repoRoot)).values()) {
        if (closedIds.has(att.session)) {
          orphanedWorktrees.push({ lane: att.lane, path: att.pathRepoRel, session: att.session });
        }
      }
    } catch { /* older install without worktrees lib → nothing to report */ }
  }

  return { staleEmitted: stale.length, closedEmitted: closed.length, orphanedWorktrees };
}

// Full stale reconciliation — the CLI-side counterpart to the bridge's inline
// janitor. Two passes, because they catch different leaks:
//   1. runJanitor: auto-close ACTIVE sessions past the threshold. The
//      projection's close-cascade releases the claims those sessions hold.
//   2. Orphan-claim reconcile: release any claim whose holder is NOT a
//      currently-active session. This catches the leak runJanitor structurally
//      cannot — a claim held by an already-CLOSED session. It happens when a
//      `LANE_CLAIMED` lands after that session's `SESSION_CLOSED` in spine order
//      (a stale MADDU_SESSION_ID claiming a lane post-close), so the close
//      cascade never saw the claim and the session janitor never revisits a
//      non-active session. Without this pass such a claim lingers forever.
//
// Rule #9: every emitted event carries the allowlisted `janitor:sessions`
// trigger. Idempotent + best-effort. Returns a structured report.
export async function reconcileStale(repoRoot, projections, nowMs = Date.now()) {
  const firedAt = new Date(nowMs).toISOString();

  // Pass 1 — session auto-close (cascades claim release for active sessions).
  const proj1 = await projections.project(repoRoot);
  const jan = await runJanitor(repoRoot, proj1, nowMs);

  // Pass 2 — orphan-claim reconcile (re-project so we see pass-1's releases).
  const proj2 = await projections.project(repoRoot);
  const activeIds = new Set(
    (proj2.activeSessions || []).filter((s) => s.status === 'active').map((s) => s.id),
  );
  const orphaned = (proj2.claims || []).filter((c) => !activeIds.has(c.sessionId));
  for (const c of orphaned) {
    // Release AS the orphaned owner: correct in both the default (delete-by-lane)
    // and sync (delete-that-owner) projection paths.
    await append(repoRoot, {
      type: EVENT_TYPES.LANE_RELEASED,
      actor: c.sessionId,
      lane: c.lane,
      data: { reason: 'orphan-reconcile' },
      triggered_by: { kind: 'janitor', id: 'sessions', fired_at: firedAt },
    });
  }

  return {
    staleDetected: jan.staleEmitted,
    autoClosed: jan.closedEmitted,
    orphanedClaimsReleased: orphaned.map((c) => ({ lane: c.lane, sessionId: c.sessionId })),
    orphanedWorktrees: jan.orphanedWorktrees || [],
  };
}
