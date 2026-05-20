// Spine integrity verifier.
//
// Hard rule #2 says "the spine wins over any projection." That claim is
// only as strong as the spine itself. This module does what no other
// part of the runtime does: it reads every NDJSON segment line by line
// and confirms the spine is the well-formed, internally-consistent
// artifact the rest of the framework assumes it is.
//
// Critically, the verifier does NOT call the projector. The point is to
// catch problems the projector would either silently mask or crash on —
// so it builds its own minimal indexes from a single forward pass.
//
// Read-only. Never mutates the spine. Operator decides how to address
// flagged issues (manual edit + slice-stop, checkpoint rollback, etc.).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { EVENT_TYPES } from './spine.mjs';

const SEGMENT_RE = /^(\d{12})\.ndjson$/;
const EVENT_ID_RE = /^evt_\d{14}_[0-9a-f]{6}$/;

// FRAMEWORK_INSTALLED / FRAMEWORK_UPGRADED / DOCTOR_REPORT events use
// well-known fixed suffixes instead of random hex. Exempt them from the
// id-format check.
const WELL_KNOWN_ID_SUFFIXES = new Set(['init00', 'upgr00', 'drep00']);

// Default future-clock tolerance: 60 seconds.
const FUTURE_TS_TOLERANCE_MS = 60 * 1000;

function issue(level, kind, detail, extra = {}) {
  return { level, kind, detail, ...extra };
}

// Walk every segment in order, run all checks. Returns:
//   {
//     segments: [{ name, events, bytes, firstTs, lastTs }],
//     events:   <total>,
//     issues:   [{ level, kind, detail, segment?, line?, eventId? }],
//     counts:   { WARN, FAIL },
//     capped:   bool        — true if maxEvents was reached and the
//                              verifier stopped early
//   }
//
// Options:
//   maxEvents:  cap on total events scanned (default: unlimited).
//               Doctor passes 50_000; the CLI passes Infinity.
export async function verifySpine(repoRoot, { maxEvents = Infinity } = {}) {
  const paths = pathsFor(repoRoot);
  const eventsDir = paths.events;

  const result = {
    segments: [],
    events: 0,
    issues: [],
    counts: { WARN: 0, FAIL: 0 },
    capped: false
  };
  const push = (it) => { result.issues.push(it); result.counts[it.level]++; };

  // ── Discover + check segment continuity ──
  let entries;
  try { entries = await readdir(eventsDir); }
  catch { push(issue('FAIL', 'events_dir_missing', `cannot read ${eventsDir}`)); return result; }
  const segs = entries.filter((f) => SEGMENT_RE.test(f)).sort();
  if (segs.length === 0) return result;  // empty spine is fine

  const segNums = segs.map((s) => parseInt(s.match(SEGMENT_RE)[1], 10));
  // Continuity from 1 to N — gaps anywhere fail.
  const expectedFirst = 1;
  for (let i = 0; i < segNums.length; i++) {
    const expected = expectedFirst + i;
    if (segNums[i] !== expected) {
      const missing = String(expected).padStart(12, '0') + '.ndjson';
      push(issue('FAIL', 'segment_gap',
        `expected segment ${missing} between …${String(segNums[i - 1] || 0).padStart(12, '0')} and ${segs[i]}`,
        { segment: missing }));
      // Continue with what we have — partial verification is better than none.
      break;
    }
  }

  // ── Single forward pass: parse, envelope, refs, monotonicity ──
  const ids = new Map();              // eventId → { segment, line }
  const requestedApprovals = new Set();  // APPROVAL_REQUESTED ids
  const decidedApprovals = new Set();    // approvalIds that have ≥1 APPROVAL_DECIDED
  const registeredSessions = new Set();  // SESSION_REGISTERED actors
  const closedSessions = new Set();
  const createdTasks = new Set();
  const spawnedWorkers = new Set();
  const liveSchedules = new Set();       // SCHEDULE_CREATED minus SCHEDULE_REMOVED
  const declaredSlices = new Set();      // SLICE_SCOPE_DECLARED.data.sliceId (Phase 3)
  const reviewedSlices = new Map();      // SLICE_REVIEWED.id → sliceEventId (Phase 5)
  const enqueuedActions = new Set();     // PENDING_ACTION_ENQUEUED.actionId (Phase 4)
  const sliceStopIds = new Set();        // SLICE_STOP.id (Phase 5)
  // (lane, sessionId) → "claimed" / "released". Used to verify LANE_RELEASED has a prior LANE_CLAIMED.
  const laneClaims = new Map();
  let installedAt = null;                // FRAMEWORK_INSTALLED.ts — lower bound for ts sanity

  outer:
  for (const segName of segs) {
    const abs = join(eventsDir, segName);
    let text;
    try { text = await readFile(abs, 'utf8'); }
    catch (err) { push(issue('FAIL', 'segment_unreadable', `${segName}: ${err.message}`, { segment: segName })); continue; }

    let st;
    try { st = await stat(abs); } catch { st = { size: text.length }; }

    const lines = text.split('\n');
    let evCount = 0;
    let firstTs = null;
    let lastTs = null;
    let prevTs = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const lineNo = i + 1;

      // ─── Parseability ───
      let ev;
      try { ev = JSON.parse(line); }
      catch (err) {
        push(issue('FAIL', 'unparseable',
          `${segName}:${lineNo}: ${err.message}`,
          { segment: segName, line: lineNo }));
        continue;
      }
      if (!ev || typeof ev !== 'object') {
        push(issue('FAIL', 'non_object', `${segName}:${lineNo}: line is not a JSON object`,
          { segment: segName, line: lineNo }));
        continue;
      }

      // ─── Envelope ───
      const missing = ['v', 'id', 'ts', 'type', 'data'].filter((k) => !(k in ev));
      // actor + lane are allowed to be null but must be PRESENT as keys for shape.
      // We only flag them missing if they're truly absent.
      if (!('actor' in ev)) missing.push('actor');
      if (!('lane' in ev)) missing.push('lane');
      if (missing.length) {
        push(issue('FAIL', 'envelope_missing',
          `${ev.id || segName + ':' + lineNo}: missing required field(s): ${missing.join(', ')}`,
          { segment: segName, line: lineNo, eventId: ev.id }));
        continue;
      }

      // ─── Schema version ───
      if (ev.v !== 1) {
        push(issue('WARN', 'schema_version',
          `${ev.id}: v=${JSON.stringify(ev.v)} (expected 1)`,
          { segment: segName, line: lineNo, eventId: ev.id }));
      }

      // ─── Event-id uniqueness ───
      if (ids.has(ev.id)) {
        const prev = ids.get(ev.id);
        push(issue('FAIL', 'duplicate_id',
          `${ev.id}: duplicate (first seen at ${prev.segment}:${prev.line})`,
          { segment: segName, line: lineNo, eventId: ev.id }));
      } else {
        ids.set(ev.id, { segment: segName, line: lineNo });
      }

      // ─── Event-id format ───
      const idSuffix = ev.id?.split('_').pop();
      if (!EVENT_ID_RE.test(ev.id) && !WELL_KNOWN_ID_SUFFIXES.has(idSuffix)) {
        push(issue('WARN', 'id_format',
          `${ev.id}: doesn't match evt_<14digit-ts>_<6hex> (and isn't a known fixed suffix)`,
          { segment: segName, line: lineNo, eventId: ev.id }));
      }

      // ─── Timestamp parsing + monotonicity + sanity ───
      const tsMs = Date.parse(ev.ts);
      if (Number.isNaN(tsMs)) {
        push(issue('FAIL', 'ts_unparseable',
          `${ev.id}: ts=${JSON.stringify(ev.ts)} is not a valid ISO-8601 timestamp`,
          { segment: segName, line: lineNo, eventId: ev.id }));
      } else {
        if (prevTs !== null && tsMs < prevTs) {
          push(issue('WARN', 'ts_out_of_order',
            `${ev.id}: ts ${ev.ts} is earlier than previous event in ${segName}`,
            { segment: segName, line: lineNo, eventId: ev.id }));
        }
        prevTs = tsMs;
        if (firstTs === null) firstTs = ev.ts;
        lastTs = ev.ts;
        // Sanity: not absurdly in the future.
        if (tsMs > Date.now() + FUTURE_TS_TOLERANCE_MS) {
          push(issue('WARN', 'ts_future',
            `${ev.id}: ts ${ev.ts} is more than 60s in the future`,
            { segment: segName, line: lineNo, eventId: ev.id }));
        }
        // Sanity: not before FRAMEWORK_INSTALLED.
        if (installedAt !== null && tsMs < installedAt) {
          push(issue('WARN', 'ts_before_install',
            `${ev.id}: ts ${ev.ts} is earlier than FRAMEWORK_INSTALLED`,
            { segment: segName, line: lineNo, eventId: ev.id }));
        }
      }

      // ─── Type registry ───
      if (!EVENT_TYPES[ev.type]) {
        push(issue('WARN', 'unknown_type',
          `${ev.id}: unknown event type ${JSON.stringify(ev.type)}`,
          { segment: segName, line: lineNo, eventId: ev.id }));
      }

      // ─── Type-specific tracking + referential integrity ───
      switch (ev.type) {
        case 'FRAMEWORK_INSTALLED':
          if (installedAt === null && !Number.isNaN(tsMs)) installedAt = tsMs;
          break;

        case 'APPROVAL_REQUESTED':
          requestedApprovals.add(ev.id);
          break;

        case 'APPROVAL_DECIDED': {
          const aid = ev.data?.approvalId;
          if (!aid) {
            push(issue('FAIL', 'orphan_approval_decided',
              `${ev.id}: APPROVAL_DECIDED has no data.approvalId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!requestedApprovals.has(aid)) {
            push(issue('FAIL', 'orphan_approval_decided',
              `${ev.id}: APPROVAL_DECIDED references unknown approvalId ${aid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (decidedApprovals.has(aid)) {
            push(issue('WARN', 'duplicate_approval_decided',
              `${ev.id}: ${aid} already has a prior APPROVAL_DECIDED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else {
            decidedApprovals.add(aid);
          }
          // Migration-event sanity.
          if (ev.triggered_by?.kind === 'policy_migration') {
            const orig = ev.triggered_by?.original_request;
            if (orig && !requestedApprovals.has(orig)) {
              push(issue('WARN', 'orphan_migration_original',
                `${ev.id}: policy_migration original_request ${orig} not found`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
          }
          break;
        }

        case 'SESSION_REGISTERED':
          // ev.actor is the sessionId by convention (see projections.mjs).
          if (ev.actor) registeredSessions.add(ev.actor);
          // v0.17 Phase 2: optional parentSessionId must reference a prior
          // SESSION_REGISTERED / SESSION_AUTO_REGISTERED actor. Old events
          // without the field remain valid (forward-compat).
          if (ev.data && ev.data.parentSessionId && !registeredSessions.has(ev.data.parentSessionId)) {
            push(issue('FAIL', 'unknown_parent_session',
              `${ev.id}: SESSION_REGISTERED references unknown parentSessionId ${ev.data.parentSessionId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;

        case 'SESSION_AUTO_REGISTERED':
          // v0.17 — agent-native bootstrap. Lifecycle identical to
          // SESSION_REGISTERED for the purposes of referential integrity:
          // heartbeats and closes reference the same actor id. Same
          // parentSessionId referential check applies.
          if (ev.actor) registeredSessions.add(ev.actor);
          if (ev.data && ev.data.parentSessionId && !registeredSessions.has(ev.data.parentSessionId)) {
            push(issue('FAIL', 'unknown_parent_session',
              `${ev.id}: SESSION_AUTO_REGISTERED references unknown parentSessionId ${ev.data.parentSessionId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;

        case 'SESSION_STALE_DETECTED':
          // Janitor observation (Phase 5). No state transition — the
          // session stays open; this is a heads-up event.
          if (ev.data && ev.data.sessionId && !registeredSessions.has(ev.data.sessionId)) {
            push(issue('WARN', 'unknown_session_stale',
              `${ev.id}: SESSION_STALE_DETECTED for unregistered session ${ev.data.sessionId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;

        case 'SESSION_AUTO_CLOSED':
          // Janitor auto-close (Phase 5). Treat the same as SESSION_CLOSED
          // for closed-set bookkeeping but emit a distinct issue code.
          if (ev.actor && !registeredSessions.has(ev.actor)) {
            push(issue('FAIL', 'unknown_session_auto_close',
              `${ev.id}: SESSION_AUTO_CLOSED for unregistered session ${ev.actor}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (ev.actor) {
            closedSessions.add(ev.actor);
          }
          break;

        case 'SESSION_HEARTBEAT':
          if (ev.actor && !registeredSessions.has(ev.actor)) {
            push(issue('WARN', 'unknown_session_heartbeat',
              `${ev.id}: SESSION_HEARTBEAT from unregistered session ${ev.actor}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;

        case 'SESSION_CLOSED':
          if (ev.actor && !registeredSessions.has(ev.actor)) {
            push(issue('FAIL', 'unknown_session_close',
              `${ev.id}: SESSION_CLOSED for unregistered session ${ev.actor}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (ev.actor) {
            closedSessions.add(ev.actor);
          }
          break;

        case 'LANE_CLAIMED': {
          const key = `${ev.lane}::${ev.actor}`;
          laneClaims.set(key, 'claimed');
          break;
        }

        case 'LANE_RELEASED': {
          const key = `${ev.lane}::${ev.actor}`;
          if (laneClaims.get(key) !== 'claimed') {
            push(issue('FAIL', 'orphan_lane_release',
              `${ev.id}: LANE_RELEASED for (${ev.lane}, ${ev.actor}) with no prior matching LANE_CLAIMED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else {
            laneClaims.set(key, 'released');
          }
          break;
        }

        case 'TASK_CREATED':
          if (ev.data?.id) createdTasks.add(ev.data.id);
          break;

        case 'TASK_UPDATED':
        case 'TASK_COMPLETED': {
          const tid = ev.data?.id;
          if (!tid) {
            push(issue('FAIL', 'orphan_task_event',
              `${ev.id}: ${ev.type} has no data.id`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!createdTasks.has(tid)) {
            push(issue('FAIL', 'orphan_task_event',
              `${ev.id}: ${ev.type} references unknown task ${tid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'WORKER_SPAWNED':
          if (ev.data?.id) spawnedWorkers.add(ev.data.id);
          break;

        case 'WORKER_HEARTBEAT':
        case 'WORKER_EXITED':
        case 'WORKER_KILLED': {
          const wid = ev.data?.id;
          if (wid && !spawnedWorkers.has(wid)) {
            push(issue('WARN', 'orphan_worker_event',
              `${ev.id}: ${ev.type} references unknown worker ${wid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'SCHEDULE_CREATED':
          if (ev.data?.id) liveSchedules.add(ev.data.id);
          break;

        case 'SCHEDULE_REMOVED':
          if (ev.data?.id) liveSchedules.delete(ev.data.id);
          break;

        case 'SCHEDULE_FIRED': {
          const sid = ev.data?.id;
          if (sid && !liveSchedules.has(sid)) {
            push(issue('WARN', 'orphan_schedule_fire',
              `${ev.id}: SCHEDULE_FIRED references unknown or removed schedule ${sid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'SLICE_STOP':
          sliceStopIds.add(ev.id);
          break;

        case 'SLICE_SCOPE_DECLARED': {
          const sid = ev.data?.sliceId;
          if (!sid) {
            push(issue('FAIL', 'invalid_slice_scope_declared',
              `${ev.id}: SLICE_SCOPE_DECLARED missing data.sliceId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else {
            declaredSlices.add(sid);
          }
          break;
        }

        case 'SLICE_SCOPE_EXPANDED': {
          const sid = ev.data?.sliceId;
          if (!sid) {
            push(issue('FAIL', 'invalid_slice_scope_expanded',
              `${ev.id}: SLICE_SCOPE_EXPANDED missing data.sliceId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!declaredSlices.has(sid)) {
            push(issue('FAIL', 'orphan_slice_scope_expanded',
              `${ev.id}: SLICE_SCOPE_EXPANDED references unknown sliceId ${sid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'SLICE_FUNCTIONAL_APPROVED': {
          const sid = ev.data?.sliceId;
          if (!sid) {
            push(issue('FAIL', 'invalid_slice_functional_approved',
              `${ev.id}: SLICE_FUNCTIONAL_APPROVED missing data.sliceId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!declaredSlices.has(sid)) {
            push(issue('FAIL', 'orphan_slice_functional_approved',
              `${ev.id}: SLICE_FUNCTIONAL_APPROVED references unknown sliceId ${sid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'PENDING_ACTION_ENQUEUED': {
          const aid = ev.data?.actionId;
          if (aid) enqueuedActions.add(aid);
          break;
        }

        case 'PENDING_ACTION_DRAINED': {
          const aid = ev.data?.actionId;
          if (!aid) {
            push(issue('FAIL', 'invalid_pending_action_drained',
              `${ev.id}: PENDING_ACTION_DRAINED missing data.actionId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!enqueuedActions.has(aid)) {
            push(issue('FAIL', 'orphan_pending_action_drained',
              `${ev.id}: PENDING_ACTION_DRAINED references unknown actionId ${aid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'SLICE_REVIEWED': {
          const sliceEventId = ev.data?.sliceEventId;
          if (!sliceEventId) {
            push(issue('FAIL', 'invalid_slice_reviewed',
              `${ev.id}: SLICE_REVIEWED missing data.sliceEventId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!sliceStopIds.has(sliceEventId)) {
            push(issue('FAIL', 'orphan_slice_reviewed',
              `${ev.id}: SLICE_REVIEWED references unknown SLICE_STOP ${sliceEventId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          reviewedSlices.set(ev.id, sliceEventId);
          break;
        }

        case 'FOLLOWUP_OPENED': {
          const reviewId = ev.data?.fromReviewEventId;
          if (!reviewId) {
            push(issue('FAIL', 'invalid_followup_opened',
              `${ev.id}: FOLLOWUP_OPENED missing data.fromReviewEventId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!reviewedSlices.has(reviewId)) {
            push(issue('FAIL', 'orphan_followup_opened',
              `${ev.id}: FOLLOWUP_OPENED references unknown SLICE_REVIEWED ${reviewId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }
      }

      evCount++;
      result.events++;
      if (result.events >= maxEvents) {
        result.capped = true;
        // Record the partial segment summary before breaking out.
        result.segments.push({ name: segName, events: evCount, bytes: st.size, firstTs, lastTs });
        break outer;
      }
    }

    result.segments.push({ name: segName, events: evCount, bytes: st.size, firstTs, lastTs });
  }

  return result;
}

// One-line summary of result.counts for doctor output.
export function summarizeCounts(counts) {
  if (counts.FAIL === 0 && counts.WARN === 0) return '0 fails · 0 warns';
  const parts = [];
  if (counts.FAIL) parts.push(`${counts.FAIL} fail${counts.FAIL === 1 ? '' : 's'}`);
  if (counts.WARN) parts.push(`${counts.WARN} warn${counts.WARN === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
