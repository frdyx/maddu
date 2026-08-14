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
import { makeReferentialStep } from './verify-referential.mjs';
import { kWayMergeStreams, readActiveReplicaId, listPartitionIds, partitionDir, FLAT_LOCK_VERSION, readFlatGenesisLine, wsFromLine, scanWsAuthorityEvents, resolveWsAuthority, verifyAnchorNomination, readIdentityCache, WS_ID_RE, validWsResolutions, buildWsGrandfather, wsStampGrandfathered, readPartitionLineAt } from './spine-append-core.mjs';

const SEGMENT_RE = /^(\d{12})\.ndjson$/;

// Bound on events retained for the sync-mode merged-order pass. Past this the
// pass is skipped with a named WARN rather than risking memory exhaustion on
// the uncapped `spine verify` / `spine import` paths.
const MERGED_PASS_MAX_EVENTS = 250_000;
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
  // Merged-order pass (v1.124.0): findings from the k-way merge are capped at
  // WARN. A timestamp merge across independent replicas is not a causal order,
  // so an apparent child-before-parent may be clock skew, not damage — FAILing
  // would red a healthy synced workspace, worse than the gap it closes.
  let capIssuesAtWarn = false;
  // Sync mode only — per-replica streams awaiting the merged pass, keyed by
  // replicaId so they can be merged under the SAME contract the projection
  // uses (kWayMergeStreams: physical order within a stream, interleaved by
  // (ts, replicaId)). A flat sort would reorder a stream against itself
  // whenever a timestamp regresses, and then miss the very orphan the
  // projection sees.
  const mergedStreams = new Map();
  let mergedBuffered = 0;
  let mergedOverflow = false;
  const push = (it) => {
    if (currentPartition) it.replicaId = currentPartition;
    if (capIssuesAtWarn && it.level === 'FAIL') { it.level = 'WARN'; it.mergedOrder = true; }
    else if (capIssuesAtWarn) it.mergedOrder = true;
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
  // PR-D: a durable WORKTREE_DETACHING intent stands between ATTACHED and the
  // terminal DETACHED. Track which attachments have an OPEN intent so a second
  // intent (double), an intent with no live ATTACHED (orphan), and an intent
  // after the terminal (post-detached) are each flagged. Cleared on DETACHED.
  const worktreePendingDetach = new Set();
  // B2 (v1.13.0) — orchestration-lifecycle anchors. Each family's child events
  // carry the parent id; a child whose parent was never opened is an orphan,
  // exactly like the TASK / WORKER / SCHEDULE checks above. WARN (not FAIL):
  // these are higher-level coordination heads-up, and the field is checked only
  // when PRESENT so old/forward-compat events without it are never flagged.
  const openedTeams = new Set();          // TEAM_OPENED.data.teamId
  const startedPipelines = new Set();     // PIPELINE_STARTED.data.pipelineRunId
  const createdPlans = new Set();         // PLAN_CREATED.data.planId
  const planPhases = new Map();           // planId → Set of known phase names
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

  // Referential rules live in verify-referential.mjs (split v1.124.0 — the
  // switch outgrew the monolith ratchet). It closes over the tracking
  // structures above by reference; `state` carries the one reassigned value.
  const refState = { installedAt: null };
  const referentialStep = makeReferentialStep({
    MODEL_ALLOWING, MODEL_STAGE_LADDER, approvalDecisionById, closedSessions, createdPlans, createdTasks, decidedApprovals, declaredSlices, enqueuedActions, invokedAdvisors, issue, laneClaims, laneEverClaimed, lcKey, liveSchedules, modelApprovedProposals, modelCheckpoints, modelDatasets, modelEvals, modelProposals, modelRegressionEvals, modelReleased, modelRunsCompleted, modelRunsStarted, modelStages, openedTeams, planPhases, push, registeredSessions, requestedApprovals, reviewedSlices, sliceStopIds, spawnedWorkers, startedCoordinators, startedLoops, startedPipelines, worktreeAttachments, worktreeEverAttached, worktreeLivePaths, worktreePendingDetach,
    state: refState,
  });

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
    const fileEndsWithNewline = text.endsWith('\n');
    let evCount = 0;
    let firstTs = null;
    let lastTs = null;
    let prevTs = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const lineNo = i + 1;

      // ─── Committed-record boundary (diff-funnel r7-F2, widened r8-F1,
      // fenced r19-F1) ───
      // A nonempty UNTERMINATED trailer is torn whether or not it parses: a
      // complete-looking JSON object whose newline never landed is not part
      // of the committed record (the S2 identity law, the authority scan,
      // and the writers all exclude it). Classified BEFORE parsing AND
      // BEFORE the chain bookkeeping (r19-F1: hashing a torn element would
      // let its committed successor chain THROUGH an element the record
      // excludes — the successor must instead chain-FAIL against the last
      // committed line). Every segment, not only the globally last one.
      const isUnterminatedTrailer = !fileEndsWithNewline && i === lines.length - 1;
      if (isUnterminatedTrailer) {
        push(issue('FAIL', 'torn_trailing_line',
          `${segName}:${lineNo}: trailing line is unterminated (missing final newline) — a write was interrupted mid-append (crash, or a concurrent writer above the atomic-append size). This event is not part of the committed record. Remediation: if the JSON is complete, append the missing newline; otherwise trim the partial line. Then re-run \`maddu spine verify\` and record a slice-stop. Never auto-repaired.`,
          { segment: segName, line: lineNo }));
        continue; // prevLineHash NOT advanced — the torn element is outside the chain
      }

      // Chain-integrity bookkeeping (v1.14.0): hash this stored line and capture
      // the previous line's hash, then advance — so every early `continue` below
      // still carries the chain forward correctly.
      const thisPrev = prevLineHash;
      prevLineHash = hashLine(line);

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
        // Sanity: not before FRAMEWORK_INSTALLED. Flat mode only — in sync mode
        // the floor is learned per-partition in scan order, so the same event
        // would warn or not depending on which replica was scanned first. The
        // merged pass runs this check instead, over an order-independent floor.
        if (referential && refState.installedAt !== null && tsMs < refState.installedAt) {
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
      if (referential) referentialStep(ev, segName, lineNo, tsMs);
      // Sync mode defers referential rules to the merged-order pass; buffer the
      // already-parsed event for it rather than re-reading (readAll silently
      // skips malformed lines, which the scan has already accounted for).
      // Bounded by construction: past the cap we stop retaining and say so,
      // rather than let an adversarially large synced spine exhaust memory on
      // the uncapped `spine verify` / `spine import` paths.
      else if (!mergedOverflow) {
        if (mergedBuffered >= MERGED_PASS_MAX_EVENTS) {
          mergedOverflow = true;
          mergedStreams.clear();
        } else {
          const rid = currentPartition || '(flat)';
          if (!mergedStreams.has(rid)) mergedStreams.set(rid, []);
          mergedStreams.get(rid).push({ ts: ev.ts, ev, segName, lineNo, tsMs, replicaId: currentPartition });
          mergedBuffered++;
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
    //
    // v1.124.0 — that deferral used to go nowhere: `importPartitions`
    // (spine-sync.mjs) calls this same verifier, which lands HERE with
    // referential:false, so NO referential family was ever checked in merged
    // order on a synced workspace. The merged pass below closes it.
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

    // ── Merged-order referential pass (v1.124.0) ──
    // Per-partition scans verify each chain; referential rules need the k-way
    // MERGED order, since a child in one replica can reference a parent in
    // another. Replay the SAME rules over the buffered events in merged order,
    // capped at WARN. This is what makes a cross-replica duplicate phase-add
    // visible — the case no local appender guard can see, because each replica
    // correctly believes it won.
    if (mergedOverflow) {
      // No remediation is suggested on purpose: a LOWER maxEvents returns
      // before this pass runs, and a higher one overflows again. The honest
      // statement is that referential coverage did not run on this spine.
      push(issue('WARN', 'merged_referential_skipped',
        `merged-order referential pass skipped: sync spine exceeds ${MERGED_PASS_MAX_EVENTS} events — cross-replica referential integrity was NOT verified on this run`));
    } else {
      // Match the projection's migration read-consistency rule
      // (spine-append-core.mjs): a `spine sync init` racing a read can capture
      // an event in BOTH the flat-legacy stream and its byte-identical
      // partition copy. Drop the flat copy when its id lives in a real
      // partition — otherwise a healthy migration reports phantom duplicates
      // the projection never sees. Never collapse partition-vs-partition ids.
      const flat = mergedStreams.get('(flat)');
      if (flat && [...mergedStreams.keys()].some((k) => k !== '(flat)')) {
        const partitionIds = new Set();
        for (const [k, entries] of mergedStreams) {
          if (k === '(flat)') continue;
          for (const e of entries) partitionIds.add(e.ev.id);
        }
        mergedStreams.set('(flat)', flat.filter((e) => !partitionIds.has(e.ev.id)));
      }
      // The SAME merge the projection performs, so an orphan the projection
      // sees is an orphan this pass sees.
      const merged = kWayMergeStreams(
        [...mergedStreams.entries()].map(([replicaId, events]) => ({ replicaId, events })));
      // The install floor must be known BEFORE the replay: learning it during
      // the sequential partition scan made ts_before_install depend on which
      // replica happened to be scanned first. Derived from the merged set, it
      // is order-independent.
      for (const m of merged) {
        if (m.ev.type === 'FRAMEWORK_INSTALLED' && !Number.isNaN(m.tsMs)) {
          if (refState.installedAt === null || m.tsMs < refState.installedAt) refState.installedAt = m.tsMs;
        }
      }
      capIssuesAtWarn = true;
      try {
        for (const m of merged) {
          if (refState.installedAt !== null && m.tsMs < refState.installedAt) {
            push(issue('WARN', 'ts_before_install',
              `${m.ev.id}: ts ${m.ev.ts} is earlier than FRAMEWORK_INSTALLED`,
              { segment: m.segName, line: m.lineNo, eventId: m.ev.id }));
          }
          // Stamp provenance: segment names repeat across partitions, and
          // cross-partition event-id collisions are tolerated, so a merged
          // finding without a replicaId is not locatable.
          currentPartition = m.replicaId;
          referentialStep(m.ev, m.segName, m.lineNo, m.tsMs);
        }
      } finally {
        capIssuesAtWarn = false;
        currentPartition = null;
        mergedStreams.clear();
      }
    }
  } else {
    // Default single-machine mode — the unchanged single flat chain, referential ON.
    await scanChain(eventsDir, { referential: true });
  }

  // ── Workspace-identity post-pass (S2, v1.117.0) ──
  // ONE authority for the whole workspace, resolved OUTSIDE the per-partition
  // chain scans (plan-review r1-F3: an internally-consistent foreign partition
  // must not pass) — anchors when present, flat derivation otherwise — then
  // every ws-bearing line in every chain is compared against it. Runs as a
  // separate pass over the SHARED strict enumerators in spine-append-core
  // (r2-F2), after the chain scans so chain issues stay primary. Forward-only:
  // ws-less legacy events are untouched.
  await wsIdentityPass(repoRoot, push, { partitioned: nonEmptyParts.length > 0, eventsDir });

  return result;
}

// The S2 identity checks. FAIL kinds:
//   ws_identity_unverifiable — an anchor's nominated position is missing or
//     mismatched, the authority scan itself failed, or ws-bearing events
//     exist with no derivable authority (never a silent skip; r2-F2).
//   ws_anchor_conflict — conflicting anchors without a binding resolution
//     (or conflicting resolutions).
//   ws_mismatch — an event's ws differs from the workspace authority (the
//     splice signal), or is an empty string (presence-byte lesson: absent
//     and empty must be distinguishable — empty is malformed).
// WARN kinds:
//   ws_cache_stale — identity.json disagrees with the resolved authority
//     (cache, never authority).
async function wsIdentityPass(repoRoot, push, { partitioned, eventsDir }) {
  let anchors = [], resolutions = [];
  let authorityScanFailed = false;
  try { ({ anchors, resolutions } = await scanWsAuthorityEvents(repoRoot)); }
  catch (e) {
    // Fail closed but DON'T stop (diff-funnel r21-F1): the committed-line
    // sweep below still runs with NO authority, so every ws-bearing line —
    // including a foreign stamp inside the very directory that broke the
    // scan — surfaces individually instead of hiding behind one generic
    // failure.
    push(issue('FAIL', 'ws_identity_unverifiable', `authority scan failed: ${e?.message || e}`));
    authorityScanFailed = true;
    anchors = []; resolutions = [];
  }

  // Anchor nominations must survive a re-read (position + hash + derivation).
  for (const a of anchors) {
    const v = await verifyAnchorNomination(repoRoot, a.data);
    if (!v.ok) push(issue('FAIL', 'ws_identity_unverifiable', `anchor ${a.id}: ${v.reason}`, { eventId: a.id }));
  }

  let flatWs = null;
  if (!partitioned && !authorityScanFailed) {
    // Skipped when the authority scan failed (r22-F1): degraded mode means
    // NO authority at all — deriving flat identity here would let stamped
    // events pass silently behind the one generic scan FAIL instead of
    // surfacing individually.
    const g = await readFlatGenesisLine(repoRoot);
    if (g.state === 'ok') flatWs = wsFromLine(g.line);
    else if (g.state === 'unresolvable') {
      // Only fatal if identity is actually at stake (ws-bearing events exist).
      flatWs = { unresolvable: g.error };
    }
  }

  const law = resolveWsAuthority({ anchors, resolutions, flatWs: typeof flatWs === 'string' ? flatWs : null });
  if (law.conflict) {
    push(issue('FAIL', 'ws_anchor_conflict', `conflicting workspace-identity anchors: ${law.identities.join(', ')} — resolve with \`maddu spine identity resolve --keep <ws_...>\``));
  }
  const authority = law.conflict ? null : law.authority;

  // The resolution GRANDFATHER law (diff-funnel r4-F1): a valid resolution
  // binds a forward cutover (per-partition chain heads at ceremony time) —
  // LOSING-identity stamps at-or-before their bound head are tolerated;
  // everything after must carry the selected authority. The bound heads
  // themselves must survive a position+hash re-read (a moved/rewritten head
  // would silently widen or shrink the grandfathered range).
  const grandfather = buildWsGrandfather(anchors, resolutions);
  for (const r of validWsResolutions(anchors, resolutions)) {
    for (const h of Array.isArray(r?.data?.cutover) ? r.data.cutover : []) {
      // Malformed rows FAIL, never throw (diff-funnel r5-F1: a tampered
      // imported resolution must degrade to ws_identity_unverifiable —
      // buildWsGrandfather already excludes such rows from the grandfather).
      const wellFormed = h && typeof h === 'object' && typeof h.replicaId === 'string'
        && typeof h.segment === 'string' && Number.isInteger(h.line) && typeof h.hash === 'string';
      if (!wellFormed) {
        push(issue('FAIL', 'ws_identity_unverifiable', `resolution ${r.id}: malformed cutover row ${JSON.stringify(h).slice(0, 80)}`, { eventId: r.id }));
        continue;
      }
      const rr = await readPartitionLineAt(repoRoot, h.replicaId, h.segment, h.line);
      if (rr.state !== 'ok' || hashLine(rr.line) !== h.hash) {
        push(issue('FAIL', 'ws_identity_unverifiable', `resolution ${r.id}: cutover head ${h.replicaId}/${h.segment}:${h.line} ${rr.state !== 'ok' ? rr.state : 'hash mismatch'}`, { eventId: r.id }));
      }
    }
  }

  // Sweep every stored line for a ws stamp (cheap substring prefilter; lines
  // that fail to parse already FAILed in the chain scan above). Positions are
  // tracked so the grandfather law can compare against the bound heads —
  // `replicaId` is '' for the flat dir (never grandfathered: cutovers bind
  // by-replica partitions only).
  const sweep = async (dir, replicaId) => {
    // FAIL-CLOSED (diff-funnel r17-F1): an unreadable dir/segment in the ws
    // sweep must surface as ws_identity_unverifiable — a transiently
    // unreadable spliced segment would otherwise let verify return green.
    let segs = [];
    try { segs = (await readdir(dir)).filter((f) => SEGMENT_RE.test(f)).sort(); }
    catch (e) {
      if (!(e && e.code === 'ENOENT')) {
        push(issue('FAIL', 'ws_identity_unverifiable', `ws sweep: ${replicaId || 'flat'}: ${e?.message || e}`));
      }
      return;
    }
    for (const seg of segs) {
      let txt;
      try { txt = await readFile(join(dir, seg), 'utf8'); }
      catch (e) {
        push(issue('FAIL', 'ws_identity_unverifiable', `ws sweep: ${replicaId || 'flat'}/${seg}: ${e?.message || e}`, { segment: seg }));
        continue;
      }
      const lines = txt.split('\n');
      // Committed elements only (r7-F2): an unterminated trailer is not part
      // of the record — the chain scan already FAILs it as torn.
      const committedN = txt.endsWith('\n') ? lines.length : lines.length - 1;
      for (let li = 0; li < committedN; li++) {
        const line = lines[li];
        if (!line.trim()) continue;
        // PARSE is authoritative (diff-funnel r6-F1: any substring prefilter
        // — even on the bare quoted key — is evadable with JSON escapes like
        // an escaped key (backslash-u0077 then s), which parses to a top-level `ws` the raw bytes never
        // show). Lines that fail to parse already FAILed the chain scan.
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || !('ws' in ev)) continue;
        if (ev.type === 'WS_IDENTITY_ANCHORED' || ev.type === 'WS_IDENTITY_RESOLVED') {
          // Authority events are ws-less BY PROTOCOL (they precede/suspend
          // stamping) — any ws on one is a violation, whatever its value.
          push(issue('FAIL', 'ws_mismatch', `authority event ${ev.id} (${ev.type}) carries a ws stamp — anchors/resolutions are ws-less by protocol`, { eventId: ev.id }));
          continue;
        }
        if (ev.ws === '' || !WS_ID_RE.test(String(ev.ws))) {
          push(issue('FAIL', 'ws_mismatch', `event ${ev.id}: malformed ws ${JSON.stringify(ev.ws)} (absent ≠ empty)`, { eventId: ev.id }));
          continue;
        }
        if (authority && ev.ws !== authority) {
          if (wsStampGrandfathered(grandfather, ev.ws, replicaId, seg, li + 1)) continue; // pre-cutover losing stamp — tolerated by the resolution
          push(issue('FAIL', 'ws_mismatch', `event ${ev.id}: ws ${ev.ws} ≠ workspace authority ${authority} (cross-workspace splice signal)`, { eventId: ev.id }));
        } else if (!authority && !law.conflict) {
          const why = flatWs && flatWs.unresolvable ? `genesis unresolvable: ${flatWs.unresolvable}` : 'no derivable authority';
          push(issue('FAIL', 'ws_identity_unverifiable', `event ${ev.id} carries ws ${ev.ws} but the workspace has ${why}`, { eventId: ev.id }));
        }
      }
    }
  };
  await sweep(eventsDir, '');
  // STRICT parent enumeration (diff-funnel r18-F1): listPartitionIds
  // collapses every readdir error to [] — a transient EACCES here would
  // skip the partition sweep entirely and let a foreign-ws splice verify
  // green. Only ENOENT means "no partitions".
  {
    const byReplicaDir = join(eventsDir, 'by-replica');
    let repNames = [];
    let enumFailed = false;
    try { repNames = await readdir(byReplicaDir); }
    catch (e) {
      if (!(e && e.code === 'ENOENT')) {
        push(issue('FAIL', 'ws_identity_unverifiable', `ws sweep: by-replica enumeration failed: ${e?.message || e}`));
        enumFailed = true;
      }
    }
    if (!enumFailed) {
      // r20-F1: an INVALIDLY-named dir is chain-scanned like any partition,
      // so the identity sweep must not silently skip it — a segment-bearing
      // one FAILs (and is swept anyway, so its foreign stamps also surface).
      const validName = (d) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(d);
      for (const rid of [...repNames].sort()) {
        let segBearing = false;
        if (!validName(rid)) {
          try {
            const sub = await readdir(join(byReplicaDir, rid));
            segBearing = sub.some((f) => SEGMENT_RE.test(f));
          } catch (e) {
            if (e && (e.code === 'ENOTDIR' || e.code === 'ENOENT')) continue; // plain junk file — not a partition
            push(issue('FAIL', 'ws_identity_unverifiable', `ws sweep: by-replica/${rid}: ${e?.message || e}`));
            continue;
          }
          if (!segBearing) continue;
          push(issue('FAIL', 'ws_identity_unverifiable', `by-replica/${rid}: invalidly-named segment-bearing partition dir — the identity law cannot account for it; remove or rename it`));
        }
        await sweep(join(byReplicaDir, rid), rid);
      }
    }
  }

  // Cache honesty (never authority).
  if (authority) {
    const c = await readIdentityCache(repoRoot);
    if (c.state === 'present' && !c.conflict && c.spineIdentity !== authority) {
      push(issue('WARN', 'ws_cache_stale', `identity.json caches ${c.spineIdentity} but the resolved authority is ${authority} — the next append re-resolves`));
    }
  }
}

// THE spine read-mode predicate — one function, so no two surfaces can disagree
// about whether a checkout supports the reasoning that only holds over a single
// totally-ordered chain (the acceptance proof's O-clauses, the digests a receipt
// records). 'flat' | 'partitioned' | 'unknown'.
//
// TWO SIGNALS, EITHER SUFFICIENT, because they disagree exactly where it
// matters. Active replica configuration says "this checkout WRITES a partition";
// segment-bearing partition directories say "this checkout HOLDS partitions". A
// freshly synced clone has the second without the first — no replica of its own
// yet, but a partitioned spine underneath — and calling that 'flat' would let a
// consumer hash and reason over a tree its digests do not describe.
//
// EVERY UNCERTAINTY IS 'unknown', never 'flat'. `listPartitionIds` swallows its
// own enumeration errors to an empty list, which is the fail-OPEN direction
// here, so this walks `by-replica` itself: an absent directory genuinely means
// no partitions, but an unreadable one means we cannot tell. Consumers already
// fail closed on anything that is not 'flat' — `deriveProofs` refuses and
// `observeAcceptance` voids its receipt — so an honest 'unknown' costs a proof,
// while a wrong 'flat' would mint one.
export async function resolveSpineMode(repoRoot) {
  try {
    if (await readActiveReplicaId(repoRoot)) return 'partitioned';
    const byReplicaDir = join(pathsFor(repoRoot).events, 'by-replica');
    let entries;
    try {
      entries = await readdir(byReplicaDir, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === 'ENOENT') return 'flat';
      return 'unknown';
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const segs = await readdir(partitionDir(repoRoot, e.name));
      if (segs.some((f) => SEGMENT_RE.test(f))) return 'partitioned';
    }
    return 'flat';
  } catch {
    return 'unknown';
  }
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
  const events = trust ? (res.eventList || []) : [];
  // The single flat chain is already in APPEND order — the authoritative "newest"
  // even if a clock rollback made a later event's ts earlier. Do NOT sort it.
  // Only in SYNC mode is eventList partition-concatenated (not time-ordered), so
  // sort by ts there to approximate a cross-partition merge (a documented
  // sync-mode limitation under clock skew; the k-way merge is `spine import`'s job).
  const isSync = (res.segments || []).some((s) => s && s.replicaId);
  if (isSync) {
    events.sort((a, b) => (Date.parse((a && a.ts) || '') || 0) - (Date.parse((b && b.ts) || '') || 0));
  }
  // `mode` is the SCANNED-CHAIN question ("may a reader reason over this as one
  // totally-ordered spine?"), answered by the shared predicate so a caller that
  // resolves it separately gets the same word. It deliberately does NOT drive
  // the sort above: that decision is about the segments THIS scan concatenated,
  // and re-deciding it from configuration would reorder a flat legacy stream in
  // a checkout that merely holds a replica config.
  return {
    events,
    integrity,
    mode: await resolveSpineMode(repoRoot),
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
