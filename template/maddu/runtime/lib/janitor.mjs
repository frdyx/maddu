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
import { append, EVENT_TYPES, readAllStrict } from './spine.mjs';
import { readActiveReplicaId } from './spine-append-core.mjs';
import { reduceSessions, reduceClaims } from './projections.mjs';
import { markSessionStaleIfStill, closeSessionIfActive } from './session-lifecycle.mjs';
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
  // v1.111.0: PASS-LEVEL strict snapshot + parse gate. Candidate selection
  // comes from ONE strict reduction (not the caller's tolerant projection —
  // kept as a parameter for API compatibility, used only as a fallback on an
  // older lib without the reducers): parseErrors > 0 skips the WHOLE pass
  // before any candidate is mutated; the close-locked helpers then
  // re-validate each mutation against their own fresh in-lock snapshot.
  let selectionView = projection;
  try {
    const { events, parseErrors } = await readAllStrict(repoRoot);
    if (typeof parseErrors === 'number' && parseErrors > 0) {
      process.stderr.write('[maddu janitor] spine has malformed lines — session pass skipped this round (run maddu verify)\n');
      return { staleEmitted: 0, closedEmitted: 0, orphanedWorktrees: [] };
    }
    const view = reduceSessions(events, { nowMs });
    selectionView = { activeSessions: view.activeSessions, janitor: { staleSessions: [...view.staleSet] } };
  } catch { /* fall back to the caller's projection */ }
  const { stale, closed } = evaluateSessions(selectionView, nowMs, cfg);
  const firedAt = new Date(nowMs).toISOString();
  const triggeredBy = { kind: 'janitor', id: 'sessions', fired_at: firedAt };

  // v1.111.0: every lifecycle append goes through the close-locked
  // conditional helpers, which RE-VALIDATE against a fresh strict snapshot
  // INSIDE the lock — a session that heartbeated after candidate selection is
  // never marked or closed, parallel sweeps can't double-mark, and reported
  // counts derive ONLY from appends that actually happened. Non-string
  // actors (historical corrupt registrations) are classified unrecoverable
  // corruption: skipped with a stderr note, never appended for.
  let staleEmitted = 0;
  const closedDone = [];
  const stalePrecondition = (session) => {
    const last = new Date(session.lastHeartbeatAt || session.registeredAt).getTime();
    return Number.isFinite(last) && (nowMs - last) >= cfg.staleAfterMs;
  };
  for (const s of stale) {
    if (typeof s.sessionId !== 'string' || s.sessionId.length === 0) {
      process.stderr.write(`[maddu janitor] skipping corrupt session actor (non-string) — unrecoverable history\n`);
      continue;
    }
    const r = await markSessionStaleIfStill(repoRoot, {
      sessionId: s.sessionId,
      data: { lastHeartbeatAt: s.lastHeartbeatAt, ageMs: s.ageMs },
      triggeredBy,
      precondition: stalePrecondition,
      nowMs,
    });
    if (r.status === 'marked') staleEmitted++;
    else if (r.status === 'spine-corrupt') {
      process.stderr.write('[maddu janitor] spine has malformed lines — stale marking skipped this round (run maddu verify)\n');
      break;
    }
  }
  const closePrecondition = (session) => {
    const last = new Date(session.lastHeartbeatAt || session.registeredAt).getTime();
    return Number.isFinite(last) && (nowMs - last) >= cfg.autoCloseAfterMs;
  };
  for (const s of closed) {
    if (typeof s.sessionId !== 'string' || s.sessionId.length === 0) {
      process.stderr.write(`[maddu janitor] skipping corrupt session actor (non-string) — unrecoverable history\n`);
      continue;
    }
    const r = await closeSessionIfActive(repoRoot, {
      sessionId: s.sessionId,
      eventType: EVENT_TYPES.SESSION_AUTO_CLOSED,
      data: {
        sessionId: s.sessionId,
        reason: 'janitor-stale',
        lastHeartbeatAt: s.lastHeartbeatAt,
        ageMs: s.ageMs,
      },
      triggeredBy,
      precondition: closePrecondition,
      nowMs,
    });
    if (r.status === 'closed') closedDone.push(s);
    else if (r.status === 'spine-corrupt') {
      process.stderr.write('[maddu janitor] spine has malformed lines — auto-close skipped this round (run maddu verify)\n');
      break;
    }
  }

  // Lane worktrees (roadmap #12a phase 6): auto-closing a session drops its
  // lane claims, orphaning any worktree it held. The janitor REPORTS these so
  // the operator can disposition them — it NEVER auto-removes a worktree (that
  // could discard un-integrated work; removal is always an explicit
  // `maddu lane release <lane> --worktree ...`). Best-effort + read-only.
  // Derived ONLY from closes that actually happened.
  let orphanedWorktrees = [];
  if (closedDone.length) {
    try {
      const { readAttachments } = await import('./worktrees.mjs');
      const closedIds = new Set(closedDone.map((s) => s.sessionId));
      for (const att of (await readAttachments(repoRoot)).values()) {
        if (closedIds.has(att.session)) {
          orphanedWorktrees.push({ lane: att.lane, path: att.pathRepoRel, session: att.session });
        }
      }
    } catch { /* older install without worktrees lib → nothing to report */ }
  }

  return { staleEmitted, closedEmitted: closedDone.length, orphanedWorktrees };
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

  // Pass 2 — orphan-claim reconcile with its OWN fresh strict snapshot
  // (v1.111.0): a valid force-claim landing during pass 1 must be visible
  // here (a round-start snapshot would make this pass LESS fresh than main),
  // and a malformed registration line must not fabricate an orphan (the
  // tolerant projection would drop the session but keep its parseable claim
  // → false LANE_RELEASED). parseErrors > 0 → skip the pass with a note;
  // null (replica mode) → tolerant semantics exactly as main. The remaining
  // snapshot→append window inside this pass is main's own pre-existing race
  // (no claim writer takes a lock today) — unwidened here, seeded to the
  // follow-up lane-surface campaign.
  let orphaned = [];
  try {
    const { events, parseErrors } = await readAllStrict(repoRoot);
    if (typeof parseErrors === 'number' && parseErrors > 0) {
      process.stderr.write('[maddu janitor] spine has malformed lines — orphan-claim pass skipped this round (run maddu verify)\n');
    } else {
      const syncMode = !!(await readActiveReplicaId(repoRoot));
      const view = reduceSessions(events, { nowMs });
      const activeIds = new Set(view.activeSessions.map((s) => s.id));
      const claims = reduceClaims(events, { syncMode });
      orphaned = claims.filter((c) => typeof c.sessionId === 'string' && c.sessionId.length > 0 && !activeIds.has(c.sessionId));
      const corrupt = claims.filter((c) => typeof c.sessionId !== 'string' || c.sessionId.length === 0);
      if (corrupt.length) process.stderr.write(`[maddu janitor] skipping ${corrupt.length} claim(s) with corrupt (non-string) actors — unrecoverable history\n`);
      for (const c of orphaned) {
        // Release AS the orphaned owner: correct in both the default
        // (delete-by-lane) and sync (delete-that-owner) projection paths.
        await append(repoRoot, {
          type: EVENT_TYPES.LANE_RELEASED,
          actor: c.sessionId,
          lane: c.lane,
          data: { reason: 'orphan-reconcile' },
          triggered_by: { kind: 'janitor', id: 'sessions', fired_at: firedAt },
        });
      }
    }
  } catch { /* best-effort pass */ }

  return {
    staleDetected: jan.staleEmitted,
    autoClosed: jan.closedEmitted,
    orphanedClaimsReleased: orphaned.map((c) => ({ lane: c.lane, sessionId: c.sessionId })),
    orphanedWorktrees: jan.orphanedWorktrees || [],
  };
}
