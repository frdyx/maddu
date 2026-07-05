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

// ── Referential coverage map (B2, v1.13.0) ──
// Every event type either HAS a referential rule below or is intentionally
// unconstrained. Keep this honest as the vocabulary grows.
//
// CHECKED — child must resolve to a prior anchor (severity in parens):
//   APPROVAL_DECIDED                         → APPROVAL_REQUESTED                 (FAIL)
//   SESSION_{HEARTBEAT,CLOSED,AUTO_CLOSED,STALE_DETECTED} → SESSION_REGISTERED/AUTO_REGISTERED (FAIL/WARN)
//   SESSION_{REGISTERED,AUTO_REGISTERED}.parentSessionId  → prior session        (FAIL)
//   LANE_RELEASED                            → active or historical LANE_CLAIMED  (FAIL for never-claimed, WARN for duplicate release)
//   TASK_{UPDATED,COMPLETED}                 → TASK_CREATED                       (FAIL)
//   WORKER_{HEARTBEAT,EXITED,KILLED}         → WORKER_SPAWNED                     (WARN)
//   SCHEDULE_FIRED                           → live SCHEDULE_CREATED              (WARN)
//   SLICE_REVIEWED                           → SLICE_STOP                         (FAIL)
//   SLICE_SCOPE_EXPANDED / SLICE_FUNCTIONAL_APPROVED → SLICE_SCOPE_DECLARED       (FAIL)
//   PENDING_ACTION_DRAINED                   → PENDING_ACTION_ENQUEUED            (FAIL)
//   FOLLOWUP_OPENED                          → SLICE_REVIEWED                     (FAIL)
//   TEAM_{LANE_ALLOCATED,MEMBER_JOINED,MEMBER_LEFT,CLOSED}        → TEAM_OPENED         (WARN) [B2]
//   PIPELINE_{STAGE_ENTERED,STAGE_EXITED,COMPLETED,HALTED}        → PIPELINE_STARTED    (WARN) [B2]
//   PLAN_{PHASE_ADDED,PHASE_COMPLETED,PHASE_BLOCKED,REVISED,COMPLETED,CANCELLED} → PLAN_CREATED (WARN) [B2]
//   LOOP_{ITERATION_STARTED,ITERATION_COMPLETED,HALTED,COMPLETED} → LOOP_STARTED        (WARN) [B2]
//   COORDINATOR_{PHASE_STARTED,PHASE_COMPLETED,HALTED,COMPLETED}  → COORDINATOR_STARTED (WARN) [B2]
//   ADVISOR_ARTIFACT_WRITTEN                 → ADVISOR_INVOKED                    (WARN) [B2]
//   WORKTREE_DETACHED                        → live WORKTREE_ATTACHED (attachmentId) (FAIL never-attached, WARN duplicate detach) [#12a]
//   WORKTREE_ATTACHED missing claimEventId   → orphan attach (no claim ref)        (WARN) [#12a]
//   WORKTREE_ATTACHED on a still-live pathRepoRel → live-path reuse                (WARN) [#12a]
//
// INTENTIONALLY UNCONSTRAINED — no parent-anchor invariant; flagging would be
// over-constraining (the "create" may legitimately predate an export/replay
// window, or the event is a standalone record):
//   * remove/disable/rotate lifecycle: TRUST_PIN_REMOVED, MCP_*, AUTH_KEY_*,
//     SKILL_{UPDATED,DELETED,APPLIED,TRUSTED}, SKILL_CANDIDATE_{APPROVED,REJECTED},
//     CHECKPOINT_{REMOVED,ROLLBACK_REQUESTED,WORKTREE_CREATED}, *_{DISABLED,ALLOWLIST_SET}.
//   * standalone records: DOCTOR_REPORT, AUDIT_REPORT, GATE_RAN, TRIGGER_FIRED,
//     GOVERNANCE_MODE_CHANGED, TOKEN_USAGE_REPORTED, INBOX_MESSAGE, MAILBOX_*,
//     IMPORT_*, PROPOSAL_*, BOSS_MESSAGE, HANDOFF_SET, BRIEFING_CURATED,
//     GOAL_DECLARED, PHASE_DECLARED, SLASH_COMMANDS_SYNCED, AGENT_FILE_SYNCED,
//     SECRET_DETECTED_IN_ARGV, TOOL_{INVOKED,COMPLETED,REFUSED}, WORKER_ENV_FILTERED,
//     BRIDGE_ORIGIN_REJECTED, LEARN_*, SOURCE_HASH_RECOMPUTED.
//   * MEMORY_FACT_SUPERSEDED.supersedes is validated by hindsight's replay, not here.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { EVENT_TYPES, hashLine } from './spine.mjs';
import { listPartitionIds, partitionDir } from './spine-append-core.mjs';

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
  // In sync mode each partition is scanned as its own chain; `currentPartition`
  // stamps every issue/segment with its replicaId so a `000000000001.ndjson`
  // ambiguity across partitions is disambiguated. Null in default mode → issues
  // are byte-identical to before.
  let currentPartition = null;
  const push = (it) => {
    if (currentPartition) it.replicaId = currentPartition;
    result.issues.push(it);
    result.counts[it.level]++;
  };

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
  const laneEverClaimed = new Set();
  // #12a — worktree attachment lifecycle. attachmentId → "attached"/"detached";
  // livePaths tracks pathRepoRel → attachmentId while an attachment is live so
  // path reuse across live attachments is flagged.
  const worktreeAttachments = new Map();
  const worktreeEverAttached = new Set();
  const worktreeLivePaths = new Map();
  // B2 (v1.13.0) — orchestration-lifecycle anchors. Each family's child events
  // carry the parent id; a child whose parent was never opened is an orphan,
  // exactly like the TASK / WORKER / SCHEDULE checks above. WARN (not FAIL):
  // these are higher-level coordination heads-up, and the field is checked only
  // when PRESENT so old/forward-compat events without it are never flagged.
  const openedTeams = new Set();          // TEAM_OPENED.data.teamId
  const startedPipelines = new Set();     // PIPELINE_STARTED.data.pipelineRunId
  const createdPlans = new Set();         // PLAN_CREATED.data.planId
  const startedLoops = new Set();         // LOOP_STARTED.data.loopId
  const startedCoordinators = new Set();  // COORDINATOR_STARTED.data.coordinatorId
  const invokedAdvisors = new Set();      // ADVISOR_INVOKED.data.advisorId
  let installedAt = null;                // FRAMEWORK_INSTALLED.ts — lower bound for ts sanity

  // Scan ONE independent prev_hash chain — the ordered segments in `dir`. In
  // default mode there is a single chain (the flat events dir). In sync mode (#12c)
  // each replica partition is scanned as its own chain (this function is called
  // once per partition), because the chain is per-partition: `prevLineHash` /
  // `chainStarted` are chain-LOCAL and reset on every call. `referential` gates the
  // cross-event switch — it is deferred in sync mode, where the correct input for
  // referential integrity is the k-way-MERGED order across partitions (a child in
  // one replica may reference a parent in another), which import (phase 3) supplies.
  // Global concerns that DON'T depend on order (envelope, id-uniqueness across all
  // partitions via the shared `ids` map, id-format, ts-sanity, type registry, chain)
  // run in every mode. Returns false if the maxEvents cap was hit (stop scanning).
  async function scanChain(dir, { referential }) {
    let entries;
    try { entries = await readdir(dir); }
    catch { push(issue('FAIL', 'events_dir_missing', `cannot read ${dir}`)); return true; }
    const segs = entries.filter((f) => SEGMENT_RE.test(f)).sort();
    if (segs.length === 0) return true; // empty chain is fine

    // Segment continuity from 1 to N within this chain — gaps anywhere fail.
    const segNums = segs.map((s) => parseInt(s.match(SEGMENT_RE)[1], 10));
    for (let i = 0; i < segNums.length; i++) {
      const expected = 1 + i;
      if (segNums[i] !== expected) {
        const missing = String(expected).padStart(12, '0') + '.ndjson';
        push(issue('FAIL', 'segment_gap',
          `expected segment ${missing} between …${String(segNums[i - 1] || 0).padStart(12, '0')} and ${segs[i]}`,
          { segment: missing }));
        break; // partial verification is better than none
      }
    }

    // v1.14.0 forward `prev_hash` chain — continuous across this chain's rolls,
    // reset per chain. chainStarted flips true at the first event carrying
    // prev_hash; everything before it is pre-v1.14.0 legacy and unchecked.
    let prevLineHash = null;
    let chainStarted = false;

  for (const segName of segs) {
    const abs = join(dir, segName);
    let text;
    try { text = await readFile(abs, 'utf8'); }
    catch (err) { push(issue('FAIL', 'segment_unreadable', `${segName}: ${err.message}`, { segment: segName })); continue; }

    let st;
    try { st = await stat(abs); } catch { st = { size: text.length }; }

    const lines = text.split('\n');
    // A2: torn-trailing-line detection. A well-formed segment always ends each
    // event with '\n', so a complete file ends in a newline and split() yields
    // a final empty element. A file whose last physical line is non-empty (no
    // terminating newline) is the classic signature of a write interrupted
    // mid-append — a crash, or a concurrent writer whose line exceeded the
    // atomic-append threshold. That is a DIFFERENT failure class from a corrupt
    // interior line (which means real data loss in the middle of history): the
    // torn trailer is the only event never durably committed, and the operator
    // can safely trim it. We flag it distinctly so the remediation differs.
    const isLastSegment = segName === segs[segs.length - 1];
    const fileEndsWithNewline = text.endsWith('\n');
    let evCount = 0;
    let firstTs = null;
    let lastTs = null;
    let prevTs = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const lineNo = i + 1;

      // Chain-integrity bookkeeping (v1.14.0): hash this stored line and capture
      // the previous line's hash, then advance — so every early `continue` below
      // still carries the chain forward correctly.
      const thisPrev = prevLineHash;
      prevLineHash = hashLine(line);

      // ─── Parseability ───
      let ev;
      try { ev = JSON.parse(line); }
      catch (err) {
        const isTornTrailer = isLastSegment && !fileEndsWithNewline && i === lines.length - 1;
        if (isTornTrailer) {
          push(issue('FAIL', 'torn_trailing_line',
            `${segName}:${lineNo}: trailing line is truncated/unterminated JSON — a write was interrupted mid-append (crash, or a concurrent writer above the atomic-append size). This event was never durably committed. Remediation: manually trim the final partial line, then re-run \`maddu spine verify\` and record a slice-stop. Never auto-repaired.`,
            { segment: segName, line: lineNo }));
        } else {
          push(issue('FAIL', 'unparseable',
            `${segName}:${lineNo}: ${err.message}`,
            { segment: segName, line: lineNo }));
        }
        continue;
      }
      if (!ev || typeof ev !== 'object') {
        push(issue('FAIL', 'non_object', `${segName}:${lineNo}: line is not a JSON object`,
          { segment: segName, line: lineNo }));
        continue;
      }

      // ─── Chain integrity (v1.14.0, forward-only prev_hash) ───
      // WARN, not FAIL: a mismatch is the tamper signal, but the no-mutex
      // append path means a rare concurrent write can also fork the chain — so
      // the verifier reports it and the operator decides (never auto-repaired).
      if ('prev_hash' in ev) {
        if (ev.prev_hash !== thisPrev) {
          push(issue('WARN', 'chain_broken',
            `${ev.id}: prev_hash does not match the preceding event's stored-line hash — history altered, an event inserted/removed, or a concurrent append forked the chain`,
            { segment: segName, line: lineNo, eventId: ev.id }));
        }
        chainStarted = true;
      } else if (chainStarted) {
        push(issue('WARN', 'chain_gap',
          `${ev.id}: event lacks prev_hash after the chain began (a pre-v1.14.0 writer or a hand edit)`,
          { segment: segName, line: lineNo, eventId: ev.id }));
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
      // Deferred in sync mode: cross-replica references resolve only in the
      // k-way-merged order, which import (phase 3) supplies. Here (per-partition)
      // it would false-flag a legitimate cross-replica reference as an orphan.
      if (referential)
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
          laneEverClaimed.add(key);
          break;
        }

        case 'LANE_RELEASED': {
          const key = `${ev.lane}::${ev.actor}`;
          if (laneClaims.get(key) !== 'claimed') {
            if (laneEverClaimed.has(key)) {
              push(issue('WARN', 'duplicate_lane_release',
                `${ev.id}: LANE_RELEASED for (${ev.lane}, ${ev.actor}) after that claim was already released`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            } else {
              push(issue('FAIL', 'orphan_lane_release',
                `${ev.id}: LANE_RELEASED for (${ev.lane}, ${ev.actor}) with no prior matching LANE_CLAIMED`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
          } else {
            laneClaims.set(key, 'released');
          }
          break;
        }

        case 'WORKTREE_ATTACHED': {
          const aid = ev.data?.attachmentId;
          if (aid) {
            worktreeAttachments.set(aid, 'attached');
            worktreeEverAttached.add(aid);
          }
          // Orphan attach: an attachment must reference the claim it binds.
          if (!ev.data?.claimEventId) {
            push(issue('WARN', 'worktree_attach_no_claim_ref',
              `${ev.id}: WORKTREE_ATTACHED without a claimEventId — attachment is not bound to any lane claim`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          // Live-path reuse: two live attachments must never share a path.
          const rel = ev.data?.pathRepoRel;
          if (rel) {
            const holder = worktreeLivePaths.get(rel);
            if (holder && holder !== aid && worktreeAttachments.get(holder) === 'attached') {
              push(issue('WARN', 'worktree_live_path_reuse',
                `${ev.id}: WORKTREE_ATTACHED at "${rel}" while attachment ${holder} is still live on that path`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
            if (aid) worktreeLivePaths.set(rel, aid);
          }
          break;
        }

        case 'WORKTREE_DETACHED': {
          const aid = ev.data?.attachmentId;
          if (!aid) break; // forward-compat: unshaped detach is not flagged here
          if (worktreeAttachments.get(aid) !== 'attached') {
            if (worktreeEverAttached.has(aid)) {
              push(issue('WARN', 'duplicate_worktree_detach',
                `${ev.id}: WORKTREE_DETACHED for attachment ${aid} after it was already detached`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            } else {
              push(issue('FAIL', 'orphan_worktree_detach',
                `${ev.id}: WORKTREE_DETACHED for attachment ${aid} with no prior WORKTREE_ATTACHED`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
          } else {
            worktreeAttachments.set(aid, 'detached');
            const rel = ev.data?.pathRepoRel;
            if (rel && worktreeLivePaths.get(rel) === aid) worktreeLivePaths.delete(rel);
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

        // ── B2: orchestration-lifecycle referential checks (WARN) ──
        case 'TEAM_OPENED':
          if (ev.data?.teamId) openedTeams.add(ev.data.teamId);
          break;
        case 'TEAM_LANE_ALLOCATED':
        case 'TEAM_MEMBER_JOINED':
        case 'TEAM_MEMBER_LEFT':
        case 'TEAM_CLOSED': {
          const tid = ev.data?.teamId;
          if (tid && !openedTeams.has(tid)) {
            push(issue('WARN', 'orphan_team_event',
              `${ev.id}: ${ev.type} references unknown team ${tid} (no prior TEAM_OPENED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'PIPELINE_STARTED':
          if (ev.data?.pipelineRunId) startedPipelines.add(ev.data.pipelineRunId);
          break;
        case 'PIPELINE_STAGE_ENTERED':
        case 'PIPELINE_STAGE_EXITED':
        case 'PIPELINE_COMPLETED':
        case 'PIPELINE_HALTED': {
          const pid = ev.data?.pipelineRunId;
          if (pid && !startedPipelines.has(pid)) {
            push(issue('WARN', 'orphan_pipeline_event',
              `${ev.id}: ${ev.type} references unknown pipeline ${pid} (no prior PIPELINE_STARTED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'PLAN_CREATED':
          if (ev.data?.planId) createdPlans.add(ev.data.planId);
          break;
        case 'PLAN_PHASE_ADDED':
        case 'PLAN_PHASE_COMPLETED':
        case 'PLAN_PHASE_BLOCKED':
        case 'PLAN_REVISED':
        case 'PLAN_COMPLETED':
        case 'PLAN_CANCELLED': {
          const pid = ev.data?.planId;
          if (pid && !createdPlans.has(pid)) {
            push(issue('WARN', 'orphan_plan_event',
              `${ev.id}: ${ev.type} references unknown plan ${pid} (no prior PLAN_CREATED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'LOOP_STARTED':
          if (ev.data?.loopId) startedLoops.add(ev.data.loopId);
          break;
        case 'LOOP_ITERATION_STARTED':
        case 'LOOP_ITERATION_COMPLETED':
        case 'LOOP_HALTED':
        case 'LOOP_COMPLETED': {
          const lid = ev.data?.loopId;
          if (lid && !startedLoops.has(lid)) {
            push(issue('WARN', 'orphan_loop_event',
              `${ev.id}: ${ev.type} references unknown loop ${lid} (no prior LOOP_STARTED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'COORDINATOR_STARTED':
          if (ev.data?.coordinatorId) startedCoordinators.add(ev.data.coordinatorId);
          break;
        case 'COORDINATOR_PHASE_STARTED':
        case 'COORDINATOR_PHASE_COMPLETED':
        case 'COORDINATOR_HALTED':
        case 'COORDINATOR_COMPLETED': {
          const cid = ev.data?.coordinatorId;
          if (cid && !startedCoordinators.has(cid)) {
            push(issue('WARN', 'orphan_coordinator_event',
              `${ev.id}: ${ev.type} references unknown coordinator ${cid} (no prior COORDINATOR_STARTED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'ADVISOR_INVOKED':
          if (ev.data?.advisorId) invokedAdvisors.add(ev.data.advisorId);
          break;
        case 'ADVISOR_ARTIFACT_WRITTEN': {
          const aid = ev.data?.advisorId;
          if (aid && !invokedAdvisors.has(aid)) {
            push(issue('WARN', 'orphan_advisor_event',
              `${ev.id}: ADVISOR_ARTIFACT_WRITTEN references unknown advisor ${aid} (no prior ADVISOR_INVOKED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }
      }

      evCount++;
      result.events++;
      if (result.events >= maxEvents) {
        result.capped = true;
        // Record the partial segment summary before stopping.
        result.segments.push({ name: segName, events: evCount, bytes: st.size, firstTs, lastTs, ...(currentPartition ? { replicaId: currentPartition } : {}) });
        return false; // cap hit — stop scanning this and any further chains
      }
    }

    result.segments.push({ name: segName, events: evCount, bytes: st.size, firstTs, lastTs, ...(currentPartition ? { replicaId: currentPartition } : {}) });
  }
    return true;
  } // ── end scanChain ──

  // ── Dispatch: default single flat chain vs sync per-partition chains ──
  // The verifier keys on partitions that ACTUALLY HOLD a segment file — not merely
  // the presence of a by-replica dir. A stray/empty `by-replica/<id>/` must NOT
  // flip a default repo into sync mode (which disables the flat referential pass).
  // Keying on segment-bearing partitions (rather than replica.json) also keeps the
  // fresh-clone case working: a clone has committed partitions but no replica.json,
  // and `maddu spine verify` should still check those partitions' integrity.
  const nonEmptyParts = [];
  for (const rid of await listPartitionIds(repoRoot)) {
    let segs = [];
    try { segs = (await readdir(partitionDir(repoRoot, rid))).filter((f) => SEGMENT_RE.test(f)); }
    catch { /* unreadable partition dir — treat as empty */ }
    if (segs.length) nonEmptyParts.push(rid);
  }

  if (nonEmptyParts.length) {
    // Sync mode. Each partition is its own single-writer chain; scan them
    // independently, report-only. Cross-replica referential integrity is deferred
    // to `spine import` (phase 3), which sees the k-way-merged order. Any residual
    // flat legacy segments are scanned as their own (referential-off) chain too.
    currentPartition = null;
    if (!(await scanChain(eventsDir, { referential: false }))) return result;
    for (const rid of nonEmptyParts) {
      currentPartition = rid;
      if (!(await scanChain(partitionDir(repoRoot, rid), { referential: false }))) {
        currentPartition = null;
        return result;
      }
    }
    currentPartition = null;
  } else {
    // Default single-machine mode — the unchanged single flat chain, referential ON.
    await scanChain(eventsDir, { referential: true });
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
