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
//   MODEL_TRAINING_RUN_STARTED               → MODEL_DATASET_SNAPSHOT_RECORDED     (FAIL) [SLM p2]
//   MODEL_TRAINING_RUN_COMPLETED             → MODEL_TRAINING_RUN_STARTED (run_id) (FAIL) [SLM p2]
//   MODEL_CHECKPOINT_REGISTERED.run_id (when present) → MODEL_TRAINING_RUN_COMPLETED (WARN) [SLM p2]
//   MODEL_EVAL_RAN                           → MODEL_CHECKPOINT_REGISTERED (WARN); missing harness_version (WARN) [SLM p2]
//   MODEL_REGRESSION_FOUND                   → MODEL_EVAL_RAN (eval_id)            (FAIL) [SLM p2]
//   MODEL_REGRESSION_ACKNOWLEDGED            → MODEL_REGRESSION_FOUND (eval_id) (FAIL); empty reason (FAIL) [SLM p2]
//   MODEL_PROMOTION_PROPOSED                 → MODEL_CHECKPOINT_REGISTERED (FAIL); from_stage/to_stage vs DERIVED stage (FAIL); unbound approvalRequestId (FAIL) [SLM p2]
//   MODEL_PROMOTION_APPROVED                 → MODEL_PROMOTION_PROPOSED (FAIL); approval_ref must be that proposal's own request with an allowing decision (allow-once/allow-always exact) (FAIL); to_stage must equal the proposal's (FAIL); duplicate per proposal (FAIL) [SLM p2]
//   MODEL_RELEASED                           → derived stage released (FAIL); missing rollback_plan (FAIL) [SLM p2]
//   MODEL_ROLLED_BACK                        → MODEL_RELEASED (checkpointKey) (FAIL); reverted_to must be strictly BELOW the derived stage — a rollback never re-elevates (FAIL) [SLM p2]
//
// INTENTIONALLY UNCONSTRAINED — no parent-anchor invariant; flagging would be
// over-constraining (the "create" may legitimately predate an export/replay
// window, or the event is a standalone record):
//   * remove/disable/rotate lifecycle: TRUST_PIN_REMOVED, MCP_*, AUTH_KEY_*,
//     SKILL_{UPDATED,DELETED,APPLIED,TRUSTED}, SKILL_CANDIDATE_{APPROVED,REJECTED},
//     CHECKPOINT_{REMOVED,ROLLBACK_REQUESTED,WORKTREE_CREATED}, *_{DISABLED,ALLOWLIST_SET}.
//   * MODEL_DATASET_SNAPSHOT_RECORDED — the MODEL_ family's single root anchor [SLM p2].
//   * standalone records: DOCTOR_REPORT, AUDIT_REPORT, GATE_RAN, TRIGGER_FIRED,
//     GOVERNANCE_MODE_CHANGED, TOKEN_USAGE_REPORTED, INBOX_MESSAGE, MAILBOX_*,
//     IMPORT_*, PROPOSAL_*, BOSS_MESSAGE, HANDOFF_SET, BRIEFING_CURATED,
//     GOAL_DECLARED, PHASE_DECLARED, SLASH_COMMANDS_SYNCED, AGENT_FILE_SYNCED,
//     SECRET_DETECTED_IN_ARGV, TOOL_{INVOKED,COMPLETED,REFUSED}, WORKER_ENV_FILTERED,
//     BRIDGE_ORIGIN_REJECTED, LEARN_*, SOURCE_HASH_RECOMPUTED, BRIDGE_CROSS_WORKSPACE,
//     SPINE_CUTOVER (a chain-local tamper-detection anchor — no parent invariant).
//   * MEMORY_FACT_SUPERSEDED.supersedes is validated by hindsight's replay, not here.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { EVENT_TYPES, hashLine } from './spine.mjs';
import { listPartitionIds, partitionDir, FLAT_LOCK_VERSION } from './spine-append-core.mjs';

const SEGMENT_RE = /^(\d{12})\.ndjson$/;
const EVENT_ID_RE = /^evt_\d{14}_[0-9a-f]{6}$/;

// FRAMEWORK_INSTALLED / FRAMEWORK_UPGRADED / DOCTOR_REPORT events use
// well-known fixed suffixes instead of random hex. Exempt them from the
// id-format check.
const WELL_KNOWN_ID_SUFFIXES = new Set(['init00', 'upgr00', 'drep00']);

// Default future-clock tolerance: 60 seconds.
const FUTURE_TS_TOLERANCE_MS = 60 * 1000;

// Minimal stdlib semver ">=" on major.minor.patch (pre-release/build ignored).
function semverGte(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

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
export async function verifySpine(repoRoot, { maxEvents = Infinity, collectEvents = false } = {}) {
  const paths = pathsFor(repoRoot);
  const eventsDir = paths.events;

  const result = {
    segments: [],
    events: 0,
    issues: [],
    counts: { WARN: 0, FAIL: 0 },
    capped: false,
    // audit P3 — when collectEvents, the SAME single forward pass that verifies
    // the chain also returns the parsed events in order, so a caller
    // (readVerifiedEvents) trusts exactly the list it just verified: coverage is
    // inherent, no separate readAll (which silently skips malformed lines).
    eventList: collectEvents ? [] : null,
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
  // SLM-governance MODEL_ family (contract 1.1.0, design §5). The promotion
  // chain is the load-bearing part: stage is DERIVED here (approved sets
  // to_stage, rollback sets reverted_to, latest wins) so a manifest's
  // declared from_stage can never smuggle a stage skip past replay; approval
  // binding is exact (a proposal's own request id + an allowing decision).
  const approvalDecisionById = new Map(); // approvalId → decision string (first decision wins)
  const modelDatasets = new Set();        // MODEL_DATASET_SNAPSHOT_RECORDED.data.dataset_id
  const modelRunsStarted = new Set();     // MODEL_TRAINING_RUN_STARTED.data.run_id
  const modelRunsCompleted = new Set();   // MODEL_TRAINING_RUN_COMPLETED.data.run_id
  const modelCheckpoints = new Set();     // MODEL_CHECKPOINT_REGISTERED.data.checkpointKey
  const modelEvals = new Set();           // MODEL_EVAL_RAN.data.eval_id
  const modelRegressionEvals = new Set(); // eval_ids with ≥1 MODEL_REGRESSION_FOUND
  const modelStages = new Map();          // checkpointKey → derived stage
  const modelProposals = new Map();       // proposal event id → { approvalRequestId, checkpointKey, to_stage }
  const modelApprovedProposals = new Set(); // proposal ids with a MODEL_PROMOTION_APPROVED
  const modelReleased = new Set();        // checkpointKeys with a MODEL_RELEASED
  const MODEL_STAGE_LADDER = ['experiment', 'candidate', 'canary', 'released'];
  const MODEL_ALLOWING = new Set(['allow-once', 'allow-always']); // the exact grant vocabulary — never a prefix match
  // Phase 3 emits checkpointKey pre-normalized (§4.5); lowercasing again at
  // read costs nothing and keeps lineage intact if an emitter ever regresses.
  const lcKey = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
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
    // audit P1 — flips true once this chain shows a cutover anchor (see below).
    // Chain-LOCAL like chainStarted: reset per chain (per partition in sync mode).
    let strictChain = false;

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

      // ─── Chain integrity (v1.14.0 forward-only prev_hash; audit P1 strict) ───
      // Severity keys on `strictChain` (flipped by the cutover-anchor detection
      // below), NOT on chainStarted. A strict chain was written by lock-holding
      // >=FLAT_LOCK_VERSION writers, so it cannot benignly fork and is fully keyed —
      // any mismatch or missing key is genuine tampering (FAIL). A pre-cutover chain
      // could legitimately fork on the old unlocked flat path, and existing on-disk
      // spines carry legitimate keyed->keyless(TOKEN_USAGE_REPORTED)->keyed histories
      // from the pre-P1 wrapper — so there a mismatch is only chain_fork WARN and a
      // missing key only chain_gap WARN. Never auto-repaired; the operator decides.
      if ('prev_hash' in ev) {
        if (ev.prev_hash !== thisPrev) {
          if (strictChain) {
            push(issue('FAIL', 'chain_broken',
              `${ev.id}: prev_hash does not match the preceding event's stored-line hash on a post-cutover (locked) chain — history altered, or an event inserted/removed/reordered`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else {
            push(issue('WARN', 'chain_fork',
              `${ev.id}: prev_hash does not match the preceding event's stored-line hash on a pre-cutover chain — a hand edit, or a concurrent append forked the unlocked flat chain`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
        }
        chainStarted = true;
      } else if (strictChain && ev.type !== 'TOKEN_USAGE_REPORTED') {
        // Post-cutover the chain is fully keyed, so a missing key is a stripped event.
        // TOKEN_USAGE_REPORTED is exempt: a straggler pre-P1 wrapper subprocess
        // surviving the upgrade could still emit one keyless. Its own stripping is
        // still caught via the SUCCESSOR's mismatch — except a trailing token event
        // with no keyed successor, a conceded residual (see docs/34-threat-model).
        push(issue('FAIL', 'chain_stripped',
          `${ev.id}: event lacks prev_hash on a post-cutover (locked) chain — a prev_hash key was stripped`,
          { segment: segName, line: lineNo, eventId: ev.id }));
      } else if (chainStarted) {
        push(issue('WARN', 'chain_gap',
          `${ev.id}: event lacks prev_hash after the chain began (a pre-v1.14.0 writer or a hand edit)`,
          { segment: segName, line: lineNo, eventId: ev.id }));
      }

      // ─── Cutover-anchor detection (audit P1) ───
      // Flip strictChain when this event proves the chain is held to post-cutover
      // rules: a FRAMEWORK_INSTALLED/UPGRADED at/after FLAT_LOCK_VERSION, or a
      // SPINE_CUTOVER anchor (seeded into a freshly-minted sync partition). Placed
      // AFTER the chain check (so the marker event itself is graded lenient) but
      // BEFORE the envelope early-return below — else stripping a required field from
      // a marker would `continue` past this and leave the chain lenient, letting a
      // successor tamper grade as chain_fork WARN (which import quarantines). OUTSIDE
      // the `if (referential)` switch so sync-mode (referential:false) scans see it.
      // Optional-chained so a malformed marker (missing data) is safe to inspect.
      if (!strictChain) {
        if (ev.type === 'SPINE_CUTOVER') strictChain = true;
        else if (ev.type === 'FRAMEWORK_INSTALLED' && semverGte(ev.data?.version, FLAT_LOCK_VERSION)) strictChain = true;
        else if (ev.type === 'FRAMEWORK_UPGRADED' && semverGte(ev.data?.to, FLAT_LOCK_VERSION)) strictChain = true;
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
      // firstReplicaId records where the FIRST occurrence lived so a consumer
      // (import) can tell a within-partition duplicate (a real single-writer bug —
      // fatal) from a cross-partition id collision (tolerated: identity is
      // partition-position, and ids are only probabilistically unique).
      if (ids.has(ev.id)) {
        const prev = ids.get(ev.id);
        push(issue('FAIL', 'duplicate_id',
          `${ev.id}: duplicate (first seen at ${prev.segment}:${prev.line})`,
          { segment: segName, line: lineNo, eventId: ev.id, firstReplicaId: prev.replicaId ?? null }));
      } else {
        ids.set(ev.id, { segment: segName, line: lineNo, replicaId: currentPartition });
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
            // MODEL_PROMOTION_APPROVED binding (design §5): first decision wins.
            if (typeof ev.data?.decision === 'string') approvalDecisionById.set(aid, ev.data.decision);
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

        // ── SLM-governance MODEL_ family (contract 1.1.0, design §5) ──
        case 'MODEL_DATASET_SNAPSHOT_RECORDED':
          // Root anchor — intentionally unconstrained.
          if (ev.data?.dataset_id) modelDatasets.add(ev.data.dataset_id);
          break;

        case 'MODEL_TRAINING_RUN_STARTED': {
          const ds = ev.data?.dataset_snapshot;
          if (ds && !modelDatasets.has(ds)) {
            push(issue('FAIL', 'orphan_model_training_run',
              `${ev.id}: MODEL_TRAINING_RUN_STARTED references unknown dataset_snapshot ${ds} (no prior MODEL_DATASET_SNAPSHOT_RECORDED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (ev.data?.run_id) modelRunsStarted.add(ev.data.run_id);
          break;
        }

        case 'MODEL_TRAINING_RUN_COMPLETED': {
          const rid = ev.data?.run_id;
          if (rid && !modelRunsStarted.has(rid)) {
            push(issue('FAIL', 'orphan_model_run_completed',
              `${ev.id}: MODEL_TRAINING_RUN_COMPLETED references unknown run_id ${rid} (no prior MODEL_TRAINING_RUN_STARTED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (rid) modelRunsCompleted.add(rid);
          break;
        }

        case 'MODEL_CHECKPOINT_REGISTERED': {
          // run_id is optional — imported/foreign checkpoints carry none.
          const rid = ev.data?.run_id;
          if (rid && !modelRunsCompleted.has(rid)) {
            push(issue('WARN', 'orphan_model_checkpoint',
              `${ev.id}: MODEL_CHECKPOINT_REGISTERED references run_id ${rid} with no prior MODEL_TRAINING_RUN_COMPLETED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (ev.data?.checkpointKey) modelCheckpoints.add(lcKey(ev.data.checkpointKey));
          break;
        }

        case 'MODEL_EVAL_RAN': {
          const ck = lcKey(ev.data?.checkpointKey);
          if (ck && !modelCheckpoints.has(ck)) {
            push(issue('WARN', 'orphan_model_eval',
              `${ev.id}: MODEL_EVAL_RAN references unregistered checkpoint ${ck}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (!ev.data?.harness_version) {
            push(issue('WARN', 'model_eval_harness_unpinned',
              `${ev.id}: MODEL_EVAL_RAN has no harness_version — the eval is not reproducible as recorded`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (ev.data?.eval_id) modelEvals.add(ev.data.eval_id);
          break;
        }

        case 'MODEL_REGRESSION_FOUND': {
          const eid = ev.data?.eval_id;
          if (eid && !modelEvals.has(eid)) {
            push(issue('FAIL', 'orphan_model_regression',
              `${ev.id}: MODEL_REGRESSION_FOUND references unknown eval_id ${eid} (no prior MODEL_EVAL_RAN)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (eid) modelRegressionEvals.add(eid);
          break;
        }

        case 'MODEL_REGRESSION_ACKNOWLEDGED': {
          const eid = ev.data?.eval_id;
          if (eid && !modelRegressionEvals.has(eid)) {
            push(issue('FAIL', 'orphan_model_regression_ack',
              `${ev.id}: MODEL_REGRESSION_ACKNOWLEDGED references eval_id ${eid} with no prior MODEL_REGRESSION_FOUND`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (typeof ev.data?.reason !== 'string' || ev.data.reason.trim() === '') {
            push(issue('FAIL', 'model_regression_ack_unreasoned',
              `${ev.id}: MODEL_REGRESSION_ACKNOWLEDGED carries no reason — the recorded judgment is the point`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'MODEL_PROMOTION_PROPOSED': {
          const ck = lcKey(ev.data?.checkpointKey);
          let flagged = false;
          if (!ck || !modelCheckpoints.has(ck)) {
            flagged = true;
            push(issue('FAIL', 'orphan_model_promotion',
              `${ev.id}: MODEL_PROMOTION_PROPOSED references unregistered checkpoint ${ck ?? '(none)'}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          // Stage discipline vs the DERIVED stage — declared adjacency alone
          // is exactly the forgery the design closes (§4.4).
          const derived = (ck && modelStages.get(ck)) || 'experiment';
          const from = ev.data?.from_stage;
          const to = ev.data?.to_stage;
          if (from !== derived) {
            flagged = true;
            push(issue('FAIL', 'model_stage_mismatch',
              `${ev.id}: MODEL_PROMOTION_PROPOSED declares from_stage ${from ?? '(none)'} but the spine-derived stage of ${ck ?? '(none)'} is ${derived}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          const di = MODEL_STAGE_LADDER.indexOf(derived);
          if (to !== MODEL_STAGE_LADDER[di + 1]) {
            flagged = true;
            push(issue('FAIL', 'model_stage_skip',
              `${ev.id}: MODEL_PROMOTION_PROPOSED to_stage ${to ?? '(none)'} is not the single forward step from derived stage ${derived}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          const req = ev.data?.approvalRequestId;
          if (!req || !requestedApprovals.has(req)) {
            flagged = true;
            push(issue('FAIL', 'model_promotion_unbound',
              `${ev.id}: MODEL_PROMOTION_PROPOSED has no resolvable approvalRequestId (${req ?? 'absent'}) — the request must ride the spine first`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          modelProposals.set(ev.id, { approvalRequestId: req ?? null, checkpointKey: ck ?? null, to_stage: to ?? null, flagged });
          break;
        }

        case 'MODEL_PROMOTION_APPROVED': {
          const pid = ev.data?.proposalId;
          const prop = pid ? modelProposals.get(pid) : null;
          if (!prop) {
            push(issue('FAIL', 'orphan_model_promotion_approved',
              `${ev.id}: MODEL_PROMOTION_APPROVED references unknown proposalId ${pid ?? '(none)'}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
            break;
          }
          if (modelApprovedProposals.has(pid)) {
            push(issue('FAIL', 'duplicate_model_promotion_approved',
              `${ev.id}: proposal ${pid} already has a MODEL_PROMOTION_APPROVED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
            break;
          }
          const ref = ev.data?.approval_ref;
          const decision = ref ? approvalDecisionById.get(ref) : undefined;
          if (!ref || ref !== prop.approvalRequestId) {
            push(issue('FAIL', 'model_approval_ref_mismatch',
              `${ev.id}: approval_ref ${ref ?? '(none)'} is not proposal ${pid}'s own approvalRequestId (${prop.approvalRequestId ?? '(none)'}) — cross-proposal replay`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!MODEL_ALLOWING.has(decision)) {
            push(issue('FAIL', 'model_promotion_unapproved',
              `${ev.id}: MODEL_PROMOTION_APPROVED without an allowing APPROVAL_DECIDED for ${ref} (decision: ${decision ?? 'none'})`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (ev.data?.to_stage !== prop.to_stage) {
            push(issue('FAIL', 'model_approved_stage_mismatch',
              `${ev.id}: MODEL_PROMOTION_APPROVED to_stage ${ev.data?.to_stage ?? '(none)'} differs from proposal ${pid}'s to_stage ${prop.to_stage ?? '(none)'}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else {
            modelApprovedProposals.add(pid);
            // A flagged proposal (stage lie / skip / unbound) never advances
            // the derived stage — the spine already carries its FAIL, and the
            // derived model must not follow the forgery.
            if (!prop.flagged && prop.checkpointKey && prop.to_stage) modelStages.set(prop.checkpointKey, prop.to_stage);
          }
          break;
        }

        case 'MODEL_RELEASED': {
          const ck = lcKey(ev.data?.checkpointKey);
          if (!ck || modelStages.get(ck) !== 'released') {
            push(issue('FAIL', 'model_release_unapproved',
              `${ev.id}: MODEL_RELEASED for ${ck ?? '(none)'} whose derived stage is ${(ck && modelStages.get(ck)) || 'experiment'} — no approved promotion to released`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (typeof ev.data?.rollback_plan !== 'string' || ev.data.rollback_plan.trim() === '') {
            push(issue('FAIL', 'model_release_no_rollback_plan',
              `${ev.id}: MODEL_RELEASED without a rollback_plan`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (ck) modelReleased.add(ck);
          break;
        }

        case 'MODEL_ROLLED_BACK': {
          const ck = lcKey(ev.data?.checkpointKey);
          if (!ck || !modelReleased.has(ck)) {
            push(issue('FAIL', 'orphan_model_rollback',
              `${ev.id}: MODEL_ROLLED_BACK for ${ck ?? '(none)'} with no prior MODEL_RELEASED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          // Rollback only ever moves DOWN the ladder (p2 red-team SF-1):
          // reverted_to at-or-above the derived stage would re-elevate a
          // checkpoint without the approval ride — the same forgery class as
          // a from_stage lie. Absent reverted_to defaults to candidate
          // (§4.4); present-but-invalid or non-downward is tamper-detecting,
          // and a flagged rollback never moves the derived stage.
          const cur = (ck && modelStages.get(ck)) || 'experiment';
          const rt = ev.data?.reverted_to === undefined ? 'candidate' : ev.data.reverted_to;
          const ri = MODEL_STAGE_LADDER.indexOf(rt);
          if (ri === -1 || ri >= MODEL_STAGE_LADDER.indexOf(cur)) {
            push(issue('FAIL', 'model_rollback_not_downward',
              `${ev.id}: MODEL_ROLLED_BACK reverted_to ${JSON.stringify(ev.data?.reverted_to ?? null)} is not a stage strictly below the derived stage ${cur} — a rollback can never re-elevate`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (ck) {
            modelStages.set(ck, rt);
          }
          break;
        }
      }

      evCount++;
      result.events++;
      if (result.eventList) result.eventList.push(ev);
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

// audit P3 — the verified-read the recency/success GATES use as their authority.
// A single uncapped, parse-clean forward pass verifies the chain AND returns the
// exact events it verified (coverage inherent). integrity:
//   'ok'      — no FAIL and the scan was NOT capped (a WARN, e.g. a pre-cutover
//               legacy fork, does NOT force non-'ok'; only a FAIL does).
//   'broken'  — a FAIL issue (unparseable line, hash-chain break, torn trailer…).
//   'unknown' — the scan was capped (maxEvents hit), so we can't assert the whole
//               chain is clean; a caller must NOT render green from 'unknown'.
// `events` is [] when integrity !== 'ok' by default (a caller shouldn't trust
// events from a chain it couldn't fully verify) unless {allowUnverifiedEvents}.
export async function readVerifiedEvents(repoRoot, { maxEvents = Infinity, allowUnverifiedEvents = false } = {}) {
  const res = await verifySpine(repoRoot, { maxEvents, collectEvents: true });
  const integrity = res.counts.FAIL > 0 ? 'broken' : (res.capped ? 'unknown' : 'ok');
  const trust = integrity === 'ok' || allowUnverifiedEvents;
  return {
    events: trust ? (res.eventList || []) : [],
    integrity,
    capped: res.capped,
    failCount: res.counts.FAIL,
    warnCount: res.counts.WARN,
  };
}

// One-line summary of result.counts for doctor output.
export function summarizeCounts(counts) {
  if (counts.FAIL === 0 && counts.WARN === 0) return '0 fails · 0 warns';
  const parts = [];
  if (counts.FAIL) parts.push(`${counts.FAIL} fail${counts.FAIL === 1 ? '' : 's'}`);
  if (counts.WARN) parts.push(`${counts.WARN} warn${counts.WARN === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
