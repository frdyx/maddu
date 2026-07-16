// Learn candidate detection at the ritual boundary (usage-audit roadmap
// Tier 5, v1.105.0).
//
// The 2026-07-16 fleet audit found `maddu learn` self-dev-only: 11 accepted
// corrections in the framework repo, 0 across all 21 consumers — including
// repos with 59/41/32/31 slice-stops. The verbs exist but nothing surfaces
// them where the work actually happens. This module runs a candidate
// DETECTION PASS when a slice stops (and when a session closes) and previews
// what `maddu learn` would harvest — with accept one-liners pointing at the
// EXISTING learn verbs. It writes NOTHING (no auto-corrections, no events,
// no state): pure read + print, which is why it needs no rule-#9 gauntlet
// entry (the gauntlet governs mutating auto-triggers).
//
// CONTAINMENT CONTRACT (roadmap §Tier 5, Codex-reviewed plan):
//   (a) ISOLATION — the caller invokes this only AFTER the SLICE_STOP /
//       SESSION_CLOSED event is appended, inside try/catch: no detection
//       outcome (throw, hang, garbage) can affect the stop's success, exit
//       code, or spine write. Proven by test with a deliberately-throwing
//       detector (guarded test-only hook).
//   (b) BOUNDED INPUT — only the current session's window: raw spine lines
//       newest-first back to this session's PREVIOUS slice-stop, capped at
//       MAX_LINES (500) AND MAX_TOTAL_BYTES (256KB); any single line over
//       MAX_LINE_BYTES (64KB) is skipped UNPARSED and counted (a line count
//       alone is not a byte bound — the spine permits pathological lines).
//   (c) COOPERATIVE DEADLINE — the deadline (1500ms) is checked between
//       per-event parse steps, AND the caller-facing runDetectionPreview
//       races detection against a timer and returns without awaiting the
//       straggler; process exit reaps leftover work. Synchronous preemption
//       of a single parse step is NOT claimed — with the 64KB/256KB caps the
//       residual overrun is bounded by one ≤64KB line parse.
//
// Detection itself is the EXISTING deterministic spine miner
// (learn-spine.spineCandidates: TOOL_REFUSED→TOOL_COMPLETED pairs, GATE_RAN
// fail→ok arcs, non-clean SLICE_REVIEWED findings) — no new heuristics.
//
// Trial framing (kickoff decisions, recorded): adoption metric = ACCEPTED
// corrections (LEARN_CORRECTION_WRITTEN, measurable today); the
// LEARN_RETRIEVED contract bump was considered at kickoff and NOT taken —
// acceptance alone decides. Demotion criterion: 4 weeks from ship, cohort =
// ≥3 non-fixture consumer repos with ≥10 slice-stops in-window, 12-week hard
// backstop (a cohort that never forms IS the verdict); on failure the
// pre-authorized demotion PR removes this hook-in and reclassifies learn as
// an expert/self-dev feature in docs. Tracked as a `maddu plan`.
//
// Pure lib — no console output, no process.exit. Node stdlib only (rule #4).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSpineShards } from './insights.mjs';
import { spineCandidates } from './learn-spine.mjs';

export const DETECT_DEADLINE_MS = 1500;
export const MAX_LINES = 500;
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024;

// Bounded raw-line window: newest shards backwards, newest lines first,
// stopping (exclusive) at this session's previous SLICE_STOP or at the
// caps. Returns lines in CHRONOLOGICAL order (the miners expect spine
// order), plus honesty counters.
async function collectWindow(repoRoot, { sessionId, stopEventId }) {
  const shards = (await listSpineShards(join(repoRoot, '.maddu', 'events'))) || [];
  const collected = []; // newest-first while collecting
  let skippedOversize = 0;
  let truncated = false;
  let totalBytes = 0;
  outer:
  for (let s = shards.length - 1; s >= 0; s--) {
    let text;
    try { text = await readFile(shards[s], 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > MAX_LINE_BYTES) { skippedOversize++; continue; } // counted, never parsed
      // Boundary probe: only lines that can be the session's prior stop.
      if (line.includes('"SLICE_STOP"')) {
        let e = null;
        try { e = JSON.parse(line); } catch {}
        if (e && e.type === 'SLICE_STOP' && e.actor === sessionId && e.id !== stopEventId) break outer;
        if (e && e.id === stopEventId) continue; // the just-appended stop itself is not input
      }
      if (collected.length >= MAX_LINES || totalBytes + bytes > MAX_TOTAL_BYTES) { truncated = true; break outer; }
      collected.push(line);
      totalBytes += bytes;
    }
  }
  return { lines: collected.reverse(), skippedOversize, truncated };
}

// The detection pass. `_testThrow` / `_testDelayMs` are GUARDED TEST-ONLY
// hooks (no production caller sets them) — they exist so the isolation and
// deadline-race acceptance tests can exercise the REAL failure paths.
export async function detectCandidates(repoRoot, {
  sessionId, stopEventId = null,
  deadlineMs = DETECT_DEADLINE_MS, now = () => Date.now(),
  _testThrow = false, _testDelayMs = 0,
} = {}) {
  if (_testThrow) throw new Error('injected detector failure (test hook)');
  const t0 = now();
  const { lines, skippedOversize, truncated } = await collectWindow(repoRoot, { sessionId, stopEventId });
  const events = [];
  let timedOut = false;
  for (const line of lines) {
    // Cooperative deadline, checked between per-event parse steps (c).
    if (now() - t0 > deadlineMs) { timedOut = true; break; }
    if (_testDelayMs) await new Promise((r) => setTimeout(r, _testDelayMs));
    try { events.push(JSON.parse(line)); } catch {}
  }
  const candidates = timedOut ? [] : spineCandidates(events);
  return { candidates, skippedOversize, truncated, linesScanned: events.length, timedOut, raced: false };
}

// Caller-facing wrapper: races detection against the deadline (+100ms grace
// over the cooperative check) and returns WITHOUT awaiting a straggler —
// the ritual's print happens within budget no matter what detection does;
// process exit reaps leftover work. The timer is unref'd so it never holds
// the process open.
export async function runDetectionPreview(repoRoot, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? DETECT_DEADLINE_MS;
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ candidates: [], skippedOversize: 0, truncated: false, linesScanned: 0, timedOut: true, raced: true }), deadlineMs + 100);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([detectCandidates(repoRoot, { ...opts, deadlineMs }), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
