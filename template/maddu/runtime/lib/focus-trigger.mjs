// Focus Director trigger — the per-turn deterministic tagger + sustained-drift
// flag. Fires from session-heartbeat (the per-turn pulse) and slice-stop (a
// floor, so the director never goes blind when heartbeats are sparse).
//
// Rule-#9 gauntlet: gated on `heartbeat:focus-director` / `slice-stop:focus-director`
// in the allowlist (the CALLER checks isAllowed, matching the existing trigger
// pattern in slice-stop.mjs); every emission carries triggered_by and a
// TRIGGER_FIRED anchors provenance. The per-turn TAG has no cooldown — tagging
// every turn is the whole point (like auto-handoff's latest-wins refresh). The
// FLAG has its own cooldown so the director flags at most once per window and
// never nags.
//
// Cheap by construction: scoring is pure-deterministic (focus.mjs) — NO LLM
// here. The cheap-model worker that writes the human-readable flag narrative
// lands in the worker-flag slice; until then DRIFT_FLAGGED carries the
// deterministic run summary. Best-effort — never breaks a heartbeat/slice-stop.

import { readAll, append, EVENT_TYPES } from './spine.mjs';
import { project } from './projections.mjs';
import { tagTurn, shouldFlag } from './focus.mjs';
import { writeFlag } from './focus-flag.mjs';

const FLAG_COOLDOWN_MS = 30 * 60 * 1000; // 30 min — the director flags at most this often.
const RECENT_WINDOW = 40;                 // events scanned for current-focus text + churn.
const FLAG_RUN_K = 4;                     // consecutive off-axis turns before a flag.
const WINDOW_CAP = 12;                     // mirror the focus{} projection window cap.

function triggerIdFor(sourceType) {
  return sourceType === 'SLICE_STOP' ? 'slice-stop:focus-director' : 'heartbeat:focus-director';
}

// Epoch-ms of the most recent OPEN drift flag (ignores cleared ones).
function lastDriftFlaggedAt(events) {
  let last = 0;
  for (const ev of events) {
    if (ev.type === 'DRIFT_FLAGGED' && !ev.data?.cleared) {
      const t = new Date(ev.ts).getTime();
      if (Number.isFinite(t) && t > last) last = t;
    }
  }
  return last;
}

// Tag the current turn and, on sustained drift, flag it. `sourceEv` is the
// triggering SESSION_HEARTBEAT or SLICE_STOP event. Returns:
//   { skipped: <reason> }
//   { tagged: true, tag, flagged: bool, runs, flagSuppressed? }
export async function maybeTagFocus(repoRoot, sourceEv, sessionId = null, triggeredBy = null) {
  const srcType = sourceEv?.type;
  if (srcType !== 'SESSION_HEARTBEAT' && srcType !== 'SLICE_STOP') return { skipped: 'not-a-focus-source' };

  const events = await readAll(repoRoot);
  const proj = await project(repoRoot);
  const goal = proj.goal || null;
  const recent = events.slice(-RECENT_WINDOW);

  const triggerId = triggerIdFor(srcType);
  const fired_at = new Date().toISOString();
  const provenance = triggeredBy
    || { kind: srcType === 'SLICE_STOP' ? 'slice-stop' : 'heartbeat', id: 'focus-director', fired_at };

  const { tag, distanceScore, signals } = tagTurn(goal, recent);
  const lane = sourceEv.lane || null;

  // Provenance anchor + the per-turn tag (no cooldown — every turn tags).
  await append(repoRoot, {
    type: EVENT_TYPES.TRIGGER_FIRED,
    actor: sessionId,
    data: { triggerId, reason: 'turn-boundary', sourceEventId: sourceEv.id || null, tag, triggered_by: provenance },
  });
  await append(repoRoot, {
    type: EVENT_TYPES.FOCUS_TAGGED,
    actor: sessionId,
    data: {
      tag, distanceScore, signals,
      goalSetAt: goal?.setAt || null,
      sourceEventId: sourceEv.id || null,
      triggered_by: provenance,
    },
  });

  // Sustained-drift decision over the rolling window (this fresh tag included).
  const window = [...(proj.focus?.window || []), { tag }].slice(-WINDOW_CAP);
  const decision = shouldFlag(window, { k: FLAG_RUN_K });
  if (!decision.flag) return { tagged: true, tag, flagged: false, runs: decision.runs };

  // Flag cooldown — the director never nags. Anchored on the last open flag.
  if (Date.now() - lastDriftFlaggedAt(events) < FLAG_COOLDOWN_MS) {
    return { tagged: true, tag, flagged: false, runs: decision.runs, flagSuppressed: 'cooldown' };
  }

  // The flag is due. writeFlag emits DRIFT_FLAGGED (deterministic floor,
  // optionally enriched by a cheap worker) and surfaces it to the mailbox.
  const { enriched } = await writeFlag(repoRoot, {
    decision, goal, focusText: signals?.focusText || '',
    sessionId, provenance, lane,
  });
  return { tagged: true, tag, flagged: true, runs: decision.runs, enriched };
}
