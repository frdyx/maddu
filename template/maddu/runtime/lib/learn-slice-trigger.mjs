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
//       straggler. The straggler is ABANDONED logically, not cancelled —
//       Node has no fs-read cancellation — and its run-out is bounded by
//       construction: the deadline is checked before every shard stat,
//       before every tail read, and every 64 scanned lines, and per-shard
//       I/O is a ≤512KB tail read (so the residual is one small read + one
//       ≤64-line batch + one parse step, and the largest synchronous
//       event-loop block is one ≤512KB split). Synchronous preemption
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

import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listSpineShards } from './insights.mjs';
import { spineCandidates } from './learn-spine.mjs';

export const DETECT_DEADLINE_MS = 1500;
export const MAX_LINES = 500;
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024;

// Bounded raw-line collection: newest shards backwards, newest lines first,
// EVERY scanned line — oversize included — counting toward BOTH caps (Codex
// round 1: exempting oversize lines from the caps would let a pathological
// spine be scanned unboundedly). No boundary detection happens here: shard
// paths do not sort chronologically across sync-mode partitions, so the
// session boundary is applied AFTER parse, on id-sorted events (event ids
// embed wall-clock). The only line-level cut is the oversize BOUNDARY PROBE:
// an unparseable-by-budget line that raw-contains both the SLICE_STOP marker
// and this session's id stops collection — a false positive only NARROWS
// the window (safe direction); without the probe an oversize prior stop
// would silently widen it (round 1).
// Per-shard I/O is a BOUNDED TAIL READ: at most TAIL_READ_BYTES (2× the
// collection budget, so a tail can never starve the caps) from the end of
// the file — a shard of ANY size costs one small positioned read plus one
// ≤512KB split, which is what makes the straggler run-out and the
// synchronous event-loop block genuinely bounded (Codex round 3: reading +
// splitting whole shards made the stated one-read bound false). When the
// tail clips older history, the first (partial) line is dropped and the
// window is flagged truncated once that shard's tail is exhausted.
const TAIL_READ_BYTES = MAX_TOTAL_BYTES * 2;
async function readTail(path) {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, TAIL_READ_BYTES);
    if (len === 0) return { text: '', clipped: false };
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    let text = buf.toString('utf8');
    const clipped = len < size;
    if (clipped) {
      const nl = text.indexOf('\n'); // drop the partial (and possibly mid-codepoint) first line
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, clipped };
  } finally { await fh.close(); }
}

// The cooperative deadline runs INSIDE collection too (Codex round 3):
// checked before every shard stat, before every tail read, and every 64
// scanned lines — a timed-out straggler's residual run-out is one tail
// read + one ≤64-line scan batch, never "every remaining shard".
const SCAN_CHECK_EVERY = 64;
async function collectWindow(repoRoot, { sessionId, now, t0, deadlineMs }) {
  const overdue = () => now() - t0 > deadlineMs;
  const shardPaths = (await listSpineShards(join(repoRoot, '.maddu', 'events'))) || [];
  // Walk shards in RECENCY order (mtime desc), not path order: on a
  // partitioned repo a lexically-first OLD partition must not burn the
  // caps before the newer events / the session boundary in another
  // partition are even reached (Codex round 2). mtime is the filesystem's
  // own answer to "which shard was appended to last"; on flat repos it
  // coincides with segment-number order.
  const shards = [];
  for (const p of shardPaths) {
    if (overdue()) return { lines: [], skippedOversize: 0, truncated: false, timedOut: true };
    try { shards.push({ p, mtime: (await stat(p)).mtimeMs }); } catch {}
  }
  shards.sort((a, b) => a.mtime - b.mtime); // oldest first; walked backwards below
  const collected = [];
  let skippedOversize = 0;
  let truncated = false;
  let totalBytes = 0;
  let scanned = 0;
  outer:
  for (let s = shards.length - 1; s >= 0; s--) {
    if (overdue()) return { lines: collected, skippedOversize, truncated, timedOut: true };
    let tail;
    try { tail = await readTail(shards[s].p); } catch { continue; }
    const lines = tail.text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (scanned % SCAN_CHECK_EVERY === 0 && overdue()) return { lines: collected, skippedOversize, truncated, timedOut: true };
      const line = lines[i];
      if (!line.trim()) continue;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (scanned >= MAX_LINES || totalBytes + bytes > MAX_TOTAL_BYTES) { truncated = true; break outer; }
      scanned++;
      totalBytes += bytes;
      if (bytes > MAX_LINE_BYTES) {
        skippedOversize++;
        if (sessionId && line.includes('"SLICE_STOP"') && line.includes(`"${sessionId}"`)) break outer; // oversize boundary probe
        continue;
      }
      // idx grows as we walk BACKWARD (newer = smaller idx): the tiebreaker
      // that keeps same-second events in true file order after the sort.
      collected.push({ line, idx: scanned });
    }
    // The tail clipped older history in this shard: anything further back is
    // unreachable via the bounded read — stop, flagged, rather than walking
    // an older shard as if this one were exhausted.
    if (tail.clipped) { truncated = true; break outer; }
  }
  return { lines: collected, skippedOversize, truncated, timedOut: false };
}

// Chronological sort key: the event's ISO `ts` (millisecond resolution,
// lexically sortable — Codex round 2: the id's embedded wall-clock is
// seconds-only and its random suffix is unordered), falling back to the
// id's 14-digit clock when ts is missing. Same-timestamp ties break on the
// collection index (reverse-walk position, larger = older) — exact file
// order for flat repos; bounded-arbitrary only across partitions within
// one millisecond.
function clockKey(e) {
  if (typeof e?.ts === 'string' && e.ts) return e.ts;
  const id = String(e?.id || '');
  return id.startsWith('evt_') ? id.slice(4, 18) : '';
}

// The detection pass. `_testThrow` / `_testDelayMs` are GUARDED TEST-ONLY
// hooks — the CLI call sites honor them only under MADDU_SELF_TEST=1, so
// they exist purely for the isolation/deadline acceptance tests to exercise
// the REAL failure paths.
export async function detectCandidates(repoRoot, {
  sessionId, stopEventId = null,
  deadlineMs = DETECT_DEADLINE_MS, now = () => Date.now(),
  _testThrow = false, _testDelayMs = 0,
} = {}) {
  if (_testThrow) throw new Error('injected detector failure (test hook)');
  const t0 = now();
  const win = await collectWindow(repoRoot, { sessionId, now, t0, deadlineMs });
  if (win.timedOut) {
    return { candidates: [], skippedOversize: win.skippedOversize, truncated: win.truncated, linesScanned: 0, timedOut: true, raced: false };
  }
  const { lines, skippedOversize, truncated } = win;
  const parsed = [];
  let timedOut = false;
  for (const item of lines) {
    // Cooperative deadline, checked between per-event parse steps (c).
    if (now() - t0 > deadlineMs) { timedOut = true; break; }
    if (_testDelayMs) {
      // Straggler timers must never hold the process open after the caller's
      // race has already returned (round 1) — unref, then await.
      await new Promise((r) => { const t = setTimeout(r, _testDelayMs); if (typeof t.unref === 'function') t.unref(); });
    }
    try { parsed.push({ e: JSON.parse(item.line), idx: item.idx }); } catch {}
  }
  let candidates = [];
  if (!timedOut) {
    // Restore CHRONOLOGICAL order (round 1: shard-path order is meaningless
    // across partitions): millisecond ts primary, collection index breaking
    // ties so flat repos keep exact file order.
    parsed.sort((a, b) => {
      const ca = clockKey(a.e), cb = clockKey(b.e);
      if (ca !== cb) return ca < cb ? -1 : 1;
      return b.idx - a.idx;
    });
    let boundary = -1;
    for (let i = parsed.length - 1; i >= 0; i--) {
      const e = parsed[i].e;
      if (e && e.type === 'SLICE_STOP' && e.actor === sessionId && e.id !== stopEventId) { boundary = i; break; }
    }
    const windowEvents = parsed.slice(boundary + 1)
      .map((p) => p.e)
      .filter((e) => e && e.id !== stopEventId)
      // Cross-session honesty (rounds 1+2): events ATTRIBUTED to another
      // session never leak into this session's preview, and the null-actor
      // allowance is EXACTLY the documented residual — TOOL_* census events
      // only (live tool events carry no session linkage; the tool-pair
      // miner needs them). Null-actor GATE_RAN / SLICE_REVIEWED etc. are
      // excluded: they are repo-global or carry their own linkage and
      // cannot be claimed for this session.
      .filter((e) => e.actor === sessionId || (e.actor == null && String(e.type || '').startsWith('TOOL_')));
    candidates = spineCandidates(windowEvents);
  }
  return { candidates, skippedOversize, truncated, linesScanned: parsed.length, timedOut, raced: false };
}

// Caller-facing wrapper: races detection against the deadline (+100ms grace
// over the cooperative check) and returns WITHOUT awaiting a straggler —
// the ritual's print happens within budget no matter what detection does;
// the straggler's run-out is bounded (one fs read + one parse step to the
// next cooperative check). The deadline timer is REF'd so the race always
// resolves, and cleared the moment detection wins.
export async function runDetectionPreview(repoRoot, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? DETECT_DEADLINE_MS;
  let timer = null;
  const deadline = new Promise((resolve) => {
    // Deliberately REF'd (Codex round 1): this timer is what guarantees the
    // race resolves — unref'ing it could let the process exit before the
    // budget note prints. It is bounded (≤ deadline+100ms) and cleared the
    // moment detection wins, so it never lingers on the fast path.
    timer = setTimeout(() => resolve({ candidates: [], skippedOversize: 0, truncated: false, linesScanned: 0, timedOut: true, raced: true }), deadlineMs + 100);
  });
  try {
    return await Promise.race([detectCandidates(repoRoot, { ...opts, deadlineMs }), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
