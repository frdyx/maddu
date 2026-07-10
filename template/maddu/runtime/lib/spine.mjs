// Append-only NDJSON event spine.
//
// Layout: <repoRoot>/.maddu/events/000000000001.ndjson, 000000000002.ndjson, …
// Roll segments when the current one exceeds ROLL_BYTES.
//
// Every event has shape:
//   { v: 1, id: 'evt_<ts><rand>', ts: ISO-8601, type: TYPE, actor: id|null, lane: id|null, data: {…} }
//
// IDs are timestamp + 6 hex chars. Monotonic enough for human reading;
// total ordering comes from segment file index + line number.

import { mkdir, readFile, readdir, stat, writeFile, appendFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathsFor } from './paths.mjs';
import { DEFAULT_LANE_CATALOG } from './defaults.mjs';
// Sync-mode (#12c) partitioned append + the canonical line hash live in the
// stdlib-only core so the worker token-wrapper can share them. hashLine is
// re-exported below so verify.mjs / usage.mjs (which import it from here) are
// unaffected.
import { hashLine, readActiveReplicaId, resolveWriteReplica, appendPartitioned, appendFlatChained, readAllPartitioned } from './spine-append-core.mjs';
import { redactDataPayload } from './secret-scan.mjs';
export { hashLine };

const ROLL_BYTES = 10 * 1024 * 1024;

export const EVENT_TYPES = {
  FRAMEWORK_INSTALLED:  'FRAMEWORK_INSTALLED',
  FRAMEWORK_UPGRADED:   'FRAMEWORK_UPGRADED',
  FRAMEWORK_BOOTED:     'FRAMEWORK_BOOTED',
  DOCTOR_REPORT:        'DOCTOR_REPORT',
  AUDIT_REPORT:         'AUDIT_REPORT',
  SESSION_REGISTERED:   'SESSION_REGISTERED',
  SESSION_HEARTBEAT:    'SESSION_HEARTBEAT',
  SESSION_CLOSED:       'SESSION_CLOSED',
  LANE_CLAIMED:         'LANE_CLAIMED',
  LANE_RELEASED:        'LANE_RELEASED',
  LANE_ADDED:           'LANE_ADDED',
  LANE_REMOVED:         'LANE_REMOVED',
  LANE_DEFAULTS_SET:    'LANE_DEFAULTS_SET',
  LANE_POLICY_SET:      'LANE_POLICY_SET',
  SLICE_STOP:           'SLICE_STOP',
  INBOX_MESSAGE:        'INBOX_MESSAGE',
  APPROVAL_REQUESTED:   'APPROVAL_REQUESTED',
  APPROVAL_DECIDED:     'APPROVAL_DECIDED',
  APPROVAL_POLICY_SET:  'APPROVAL_POLICY_SET',
  MAILBOX_SENT:         'MAILBOX_SENT',
  MAILBOX_READ:         'MAILBOX_READ',
  TASK_CREATED:         'TASK_CREATED',
  TASK_UPDATED:         'TASK_UPDATED',
  TASK_COMPLETED:       'TASK_COMPLETED',
  SKILL_CREATED:        'SKILL_CREATED',
  SKILL_UPDATED:        'SKILL_UPDATED',
  SKILL_DELETED:        'SKILL_DELETED',
  SKILL_APPLIED:        'SKILL_APPLIED',
  WORKER_SPAWNED:       'WORKER_SPAWNED',
  WORKER_HEARTBEAT:     'WORKER_HEARTBEAT',
  WORKER_EXITED:        'WORKER_EXITED',
  WORKER_KILLED:        'WORKER_KILLED',
  RUNTIME_REGISTERED:   'RUNTIME_REGISTERED',
  RUNTIME_DETECTED:     'RUNTIME_DETECTED',
  RUNTIME_REMOVED:      'RUNTIME_REMOVED',
  MCP_REGISTERED:       'MCP_REGISTERED',
  MCP_ENABLED:          'MCP_ENABLED',
  MCP_DISABLED:         'MCP_DISABLED',
  MCP_TESTED:           'MCP_TESTED',
  MCP_REMOVED:          'MCP_REMOVED',
  SCHEDULE_CREATED:     'SCHEDULE_CREATED',
  SCHEDULE_UPDATED:     'SCHEDULE_UPDATED',
  SCHEDULE_REMOVED:     'SCHEDULE_REMOVED',
  SCHEDULE_FIRED:       'SCHEDULE_FIRED',
  CHECKPOINT_CREATED:   'CHECKPOINT_CREATED',
  CHECKPOINT_REMOVED:   'CHECKPOINT_REMOVED',
  CHECKPOINT_WORKTREE_CREATED: 'CHECKPOINT_WORKTREE_CREATED',
  CHECKPOINT_ROLLBACK_REQUESTED: 'CHECKPOINT_ROLLBACK_REQUESTED',
  AUTH_KEY_ADDED:        'AUTH_KEY_ADDED',
  AUTH_KEY_REMOVED:      'AUTH_KEY_REMOVED',
  AUTH_KEY_ROTATED:      'AUTH_KEY_ROTATED',
  AUTH_KEY_RATE_LIMITED: 'AUTH_KEY_RATE_LIMITED',
  IMPORT_ACCEPTED:       'IMPORT_ACCEPTED',
  IMPORT_REJECTED:       'IMPORT_REJECTED',
  PROPOSAL_CREATED:      'PROPOSAL_CREATED',
  PROPOSAL_DECIDED:      'PROPOSAL_DECIDED',
  BOSS_MESSAGE:          'BOSS_MESSAGE',
  TELEGRAM_ENABLED:          'TELEGRAM_ENABLED',
  TELEGRAM_DISABLED:         'TELEGRAM_DISABLED',
  TELEGRAM_ALLOWLIST_SET:    'TELEGRAM_ALLOWLIST_SET',
  TELEGRAM_INBOUND:          'TELEGRAM_INBOUND',
  TELEGRAM_OUTBOUND:         'TELEGRAM_OUTBOUND',
  TELEGRAM_OUTBOUND_FAILED:  'TELEGRAM_OUTBOUND_FAILED',
  TELEGRAM_DROPPED:          'TELEGRAM_DROPPED',
  DISCORD_ENABLED:           'DISCORD_ENABLED',
  DISCORD_DISABLED:          'DISCORD_DISABLED',
  DISCORD_ALLOWLIST_SET:     'DISCORD_ALLOWLIST_SET',
  DISCORD_OUTBOUND:          'DISCORD_OUTBOUND',
  DISCORD_OUTBOUND_FAILED:   'DISCORD_OUTBOUND_FAILED',
  EMAIL_ENABLED:             'EMAIL_ENABLED',
  EMAIL_DISABLED:            'EMAIL_DISABLED',
  EMAIL_CONFIG_SET:          'EMAIL_CONFIG_SET',
  EMAIL_ALLOWLIST_SET:       'EMAIL_ALLOWLIST_SET',
  EMAIL_SENT:                'EMAIL_SENT',
  EMAIL_OUTBOUND_FAILED:     'EMAIL_OUTBOUND_FAILED',
  // Governance layer (reserved; emitted in Phases 1–5)
  FOLLOWUP_OPENED:           'FOLLOWUP_OPENED',
  GATE_RAN:                  'GATE_RAN',
  GOAL_DECLARED:             'GOAL_DECLARED',
  // A declared goal was marked done (or abandoned). Closes the goal lifecycle so
  // a finished goal stops lingering as "the current goal". data: { note, outcome }
  GOAL_COMPLETED:            'GOAL_COMPLETED',
  PENDING_ACTION_DRAINED:    'PENDING_ACTION_DRAINED',
  PENDING_ACTION_ENQUEUED:   'PENDING_ACTION_ENQUEUED',
  PHASE_DECLARED:            'PHASE_DECLARED',
  // Per-phase strictness (v1.91.0) — explicit phase exit; while a phase with
  // a `tier` is active, the effective governance mode escalates to it.
  PHASE_CLEARED:             'PHASE_CLEARED',
  SLICE_FUNCTIONAL_APPROVED: 'SLICE_FUNCTIONAL_APPROVED',
  SLICE_REVIEWED:            'SLICE_REVIEWED',
  SLICE_SCOPE_DECLARED:      'SLICE_SCOPE_DECLARED',
  SLICE_SCOPE_EXPANDED:      'SLICE_SCOPE_EXPANDED',
  SOURCE_HASH_RECOMPUTED:    'SOURCE_HASH_RECOMPUTED',
  TRIGGER_FIRED:             'TRIGGER_FIRED',
  // Agent-native bootstrap (v0.17; emitted in Phases 1–5)
  // SESSION_REGISTERED.data also gains an OPTIONAL `parentSessionId` field
  // for tree provenance — events without it remain valid (forward-compat).
  AGENT_FILE_SYNCED:         'AGENT_FILE_SYNCED',
  SESSION_AUTO_CLOSED:       'SESSION_AUTO_CLOSED',
  SESSION_AUTO_REGISTERED:   'SESSION_AUTO_REGISTERED',
  SESSION_STALE_DETECTED:    'SESSION_STALE_DETECTED',
  // Pre-compaction governance checkpoint (v1.89.0) — written by the PreCompact
  // hook just before Claude Code compacts its context, recording what the
  // durable record held at that moment (last slice-stop, handoff currency).
  COMPACTION_CHECKPOINT:     'COMPACTION_CHECKPOINT',
  // Vendor-memory interop (v1.90.0) — one per fact imported from a vendor
  // tool's own memory store (import-only; carries the full fact for rebuild).
  VENDOR_MEMORY_IMPORTED:    'VENDOR_MEMORY_IMPORTED',
  // No-learning-curve UX shell (v0.18; emitted in Phases 1–5)
  SLASH_COMMANDS_SYNCED:     'SLASH_COMMANDS_SYNCED',
  // Architectural backbone (v0.18 Phase 4) — teams, pipelines, advisors, token ledger.
  TEAM_OPENED:               'TEAM_OPENED',
  TEAM_LANE_ALLOCATED:       'TEAM_LANE_ALLOCATED',
  TEAM_MEMBER_JOINED:        'TEAM_MEMBER_JOINED',
  TEAM_MEMBER_LEFT:          'TEAM_MEMBER_LEFT',
  TEAM_CLOSED:               'TEAM_CLOSED',
  PIPELINE_STARTED:          'PIPELINE_STARTED',
  PIPELINE_STAGE_ENTERED:    'PIPELINE_STAGE_ENTERED',
  PIPELINE_STAGE_EXITED:     'PIPELINE_STAGE_EXITED',
  PIPELINE_COMPLETED:        'PIPELINE_COMPLETED',
  PIPELINE_HALTED:           'PIPELINE_HALTED',
  ADVISOR_INVOKED:           'ADVISOR_INVOKED',
  ADVISOR_ARTIFACT_WRITTEN:  'ADVISOR_ARTIFACT_WRITTEN',
  TOKEN_USAGE_REPORTED:      'TOKEN_USAGE_REPORTED',
  // v0.19 Phase 3 — skill auto-injection. Emitted when `maddu brief
  // --for-agent` (or the agent-context bridge endpoint) appends one or
  // more skill bodies to the orientation digest based on trigger/tag
  // matches. data: { sessionId, triggers, tags, skillIds, totalBytes }.
  SKILL_INJECTED:            'SKILL_INJECTED',
  // A matching skill was NOT injected because its provenance is untrusted
  // (imported without `maddu skill trust`, or no provenance). Closes the
  // load-time half of the imported-skill threat (docs/34 scenario 5): the
  // refusal is witnessed on the spine, not a silent drop.
  // data: { sessionId, reason, refused: [{ id, provenance }] }
  SKILL_INJECTION_REFUSED:   'SKILL_INJECTION_REFUSED',
  // v1.1.0 Phase 1 — default framework tools (git/test/format/lint/install)
  // emit one event per invocation. TOOL_INVOKED at start, TOOL_COMPLETED on
  // exit, TOOL_REFUSED when allowlist or dangerous-form check blocks before
  // spawn. data shape:
  //   TOOL_INVOKED:   { tool, argv, lane, sessionId, mode }
  //   TOOL_COMPLETED: { tool, argv, lane, sessionId, exitCode, durationMs }
  //   TOOL_REFUSED:   { tool, argv, lane, sessionId, reason, detail }
  TOOL_INVOKED:              'TOOL_INVOKED',
  TOOL_COMPLETED:            'TOOL_COMPLETED',
  TOOL_REFUSED:              'TOOL_REFUSED',
  // v1.1.0 Phase 3 — workspace governance tier transitions.
  // data: { from, to, by: sessionId|null, reason }
  GOVERNANCE_MODE_CHANGED:   'GOVERNANCE_MODE_CHANGED',
  // v1.1.0 Phase 5 — plan persistence + revision.
  // PLAN_CREATED:        { planId, title, phases: [{name, intent}], goal }
  // PLAN_PHASE_ADDED:    { planId, name, intent, at }
  // PLAN_PHASE_COMPLETED:{ planId, name, summary }
  // PLAN_PHASE_BLOCKED:  { planId, name, reason }
  // PLAN_REVISED:        { planId, by, diff: { added, removed, modified } }
  // PLAN_COMPLETED:      { planId }
  // PLAN_CANCELLED:      { planId, reason }
  PLAN_CREATED:              'PLAN_CREATED',
  PLAN_PHASE_ADDED:          'PLAN_PHASE_ADDED',
  PLAN_PHASE_COMPLETED:      'PLAN_PHASE_COMPLETED',
  PLAN_PHASE_BLOCKED:        'PLAN_PHASE_BLOCKED',
  PLAN_REVISED:              'PLAN_REVISED',
  PLAN_COMPLETED:            'PLAN_COMPLETED',
  PLAN_CANCELLED:            'PLAN_CANCELLED',
  // v1.1.0 Phase 6 — loops (ralph + plan-loop).
  // data: { loopId, kind: 'ralph'|'plan-loop', goal, iter?, maxIter?, cooldownMs?, reason? }
  LOOP_STARTED:              'LOOP_STARTED',
  LOOP_ITERATION_STARTED:    'LOOP_ITERATION_STARTED',
  LOOP_ITERATION_COMPLETED:  'LOOP_ITERATION_COMPLETED',
  LOOP_HALTED:               'LOOP_HALTED',
  LOOP_COMPLETED:            'LOOP_COMPLETED',
  // v1.1.0 Phase 7 — coordinator primitive (runtime-agnostic).
  // data: { coordinatorId, planId, phase?, iter?, runtime?, reason? }
  COORDINATOR_STARTED:        'COORDINATOR_STARTED',
  COORDINATOR_PHASE_STARTED:  'COORDINATOR_PHASE_STARTED',
  COORDINATOR_PHASE_COMPLETED:'COORDINATOR_PHASE_COMPLETED',
  COORDINATOR_HALTED:         'COORDINATOR_HALTED',
  COORDINATOR_COMPLETED:      'COORDINATOR_COMPLETED',
  // v1.1.0 Phase 8 — lane force-claim discipline + skill candidates.
  // LANE_CLAIM_FORCED: { lane, priorSessionId, by, focus, reason }
  // SKILL_CANDIDATE_*: { hash, tags, examples, decided?, reason? }
  LANE_CLAIM_FORCED:          'LANE_CLAIM_FORCED',
  SKILL_CANDIDATE_DETECTED:   'SKILL_CANDIDATE_DETECTED',
  SKILL_CANDIDATE_APPROVED:   'SKILL_CANDIDATE_APPROVED',
  SKILL_CANDIDATE_REJECTED:   'SKILL_CANDIDATE_REJECTED',
  // v1.2.0 Phase 1 — supply-chain trust audit + pinning. Append-only.
  //   TRUST_AUDIT_RAN:        { audited:N, freshDays, warns, fails, cacheHit }
  //   TRUST_PIN_ADDED:        { name, version, sha256? }
  //   TRUST_PIN_REMOVED:      { name }
  //   TRUST_VIOLATION_DETECTED: { kind, pkg, expected?, actual?, detail }
  TRUST_AUDIT_RAN:            'TRUST_AUDIT_RAN',
  TRUST_PIN_ADDED:            'TRUST_PIN_ADDED',
  TRUST_PIN_REMOVED:          'TRUST_PIN_REMOVED',
  TRUST_VIOLATION_DETECTED:   'TRUST_VIOLATION_DETECTED',
  // v1.2.0 Phase 2 — MCP provenance + worker env allowlist.
  //   MCP_PROVENANCE_VERIFIED: { template, sha256 }
  //   MCP_PROVENANCE_MISMATCH: { template, expected, actual, detail }
  //   MCP_APPROVAL_GRANTED:    { name, by }
  //   WORKER_ENV_FILTERED:     { workerId, lane, allowed:N, denied:[KEYS_ONLY], deniedSecretCount }
  MCP_PROVENANCE_VERIFIED:    'MCP_PROVENANCE_VERIFIED',
  MCP_PROVENANCE_MISMATCH:    'MCP_PROVENANCE_MISMATCH',
  MCP_APPROVAL_GRANTED:       'MCP_APPROVAL_GRANTED',
  WORKER_ENV_FILTERED:        'WORKER_ENV_FILTERED',
  // v1.2.0 Phase 3 — secret detection in tool argv.
  //   SECRET_DETECTED_IN_ARGV: { tool, pattern_type, argv_index, override? }
  //   override is set to 'operator-allowed-secret' when the operator
  //   passed `--allow-secret` to bypass the refusal. The raw matched
  //   value is NEVER stored in the event payload — only pattern_type
  //   + argv_index.
  SECRET_DETECTED_IN_ARGV:    'SECRET_DETECTED_IN_ARGV',
  // v1.2.0 Phase 4 — skill provenance enforcement.
  //   SKILL_IMPORTED:           { source, sha256, trusted, dest }
  //   SKILL_TRUSTED:            { id }
  SKILL_IMPORTED:             'SKILL_IMPORTED',
  SKILL_TRUSTED:              'SKILL_TRUSTED',
  // v1.6.0 — curated cross-session handoff. The operator/agent's "▶ RESUME HERE"
  // narrative (next slice, blockers, queue, decisions-pending). Latest wins.
  //   HANDOFF_SET: { body, by }
  HANDOFF_SET:                'HANDOFF_SET',
  // v1.9.0 — failure-learning (`maddu learn`). Mine Claude Code session
  // transcripts for failed tool calls paired with the later success that
  // resolved them, judge the pairs in a spawned worker (provider SDK lives in
  // the subprocess, never in core), and write typed corrections to two
  // destinations. The parent process is the ONLY spine writer.
  //   LEARN_MINED:              { mined, paired, candidates, slug, since }
  //   LEARN_DIGEST_WRITTEN:     { digestPath, candidates }  (no-provider fallback)
  //   LEARN_JUDGED:             { candidateId, category, verdict, destination, workerId }
  //   LEARN_CORRECTION_WRITTEN: { correctionId, category, destination:'agent-file'|'memory', target }
  LEARN_MINED:                'LEARN_MINED',
  LEARN_DIGEST_WRITTEN:       'LEARN_DIGEST_WRITTEN',
  LEARN_JUDGED:               'LEARN_JUDGED',
  LEARN_CORRECTION_WRITTEN:   'LEARN_CORRECTION_WRITTEN',
  // v1.9.0 — memory supersession chains. When a fact changes, a new fact
  // carries `supersedes:<priorFactId>` and this event records the link so the
  // chain survives a `rebuildMemory` replay (events are the source of truth).
  //   MEMORY_FACT_SUPERSEDED: { factId, supersedes, kind, reason }
  MEMORY_FACT_SUPERSEDED:     'MEMORY_FACT_SUPERSEDED',
  // v1.9.0 — reversible briefings (retrieve-on-demand / CCR). A curated
  // orient/handoff briefing persists its full original so dropped detail stays
  // retrievable via `maddu learn retrieve <briefingId>`.
  //   BRIEFING_CURATED: { briefingId, kind:'orient'|'handoff', originalRef, dropped }
  BRIEFING_CURATED:           'BRIEFING_CURATED',
  // v1.13.0 (A3) — bridge loopback origin enforcement. The bridge serves the
  // cockpit over 127.0.0.1; a malicious web page can reach it via DNS
  // rebinding (resolving its own hostname to loopback) and drive endpoints
  // that mutate the spine. The bridge rejects any request whose Host/Origin
  // hostname is not loopback with 403, and records the rejection here (rate-
  // limited per offending origin to avoid spine flooding). data:
  //   { reason:'host'|'origin', host, origin, path, method }
  BRIDGE_ORIGIN_REJECTED:     'BRIDGE_ORIGIN_REJECTED',
  // v1.98.0 (audit P0b) — a bridge request selected a workspace other than the
  // active one (via the X-Maddu-Workspace header, incl. the `_all` fan-out).
  // Cross-repo access is authorized by the capability token but always recorded
  // (rate-limited per workspace+path) so one repo reaching into another's spine
  // is on the record. data: { workspace, active, method, path }
  BRIDGE_CROSS_WORKSPACE:     'BRIDGE_CROSS_WORKSPACE',
  // audit P1 — chain-local tamper-detection cutover anchor. Seeded into a
  // freshly-minted sync partition (spine sync init) so the verifier holds that
  // partition to the post-cutover strict rules even without a migrated FRAMEWORK
  // marker. data: { version }
  SPINE_CUTOVER:              'SPINE_CUTOVER',
  // v1.15.0 — `maddu blueprint --distill` spawned a provider CLI (subprocess,
  // hard rule #5) to rewrite the deterministic skeleton into prose. Recorded on
  // success only; an unmet auth gate or worker failure falls back to the
  // deterministic export and emits nothing. data:
  //   { runtime, provider, slug, skeletonBytes, distilledBytes, outPath }
  BLUEPRINT_DISTILLED:        'BLUEPRINT_DISTILLED',
  // v1.17.0 — `maddu debt` scanned the source tree for deliberate-shortcut
  // markers (`maddu-debt: <what>. ceiling: <limit>. upgrade: <trigger>.`) and
  // wrote the derived ledger to .maddu/state/debt-ledger.json. Read-only over
  // the source tree (not spine-derived); this event is the spine record of the
  // scan. data: { markers, noTrigger, files, ledgerPath }
  DEBT_SCANNED:               'DEBT_SCANNED',
  // v1.18.0 — `maddu architecture scan` compared the declared architecture
  // contract (.maddu/config/architecture.json) against the observed code import
  // graph and recorded the drift. Read-only over the source tree; this event is
  // the spine record + the trend signal. data:
  //   { modules, edges, forbidden, cycles, undeclared, uncovered, driftScore,
  //     failOn, newViolations, blocking }
  ARCHITECTURE_SCANNED:       'ARCHITECTURE_SCANNED',
  // Focus Director (maddu focus) — domain-blind trajectory instrument. The
  // deterministic per-turn tagger scores the pilot's drift vs the declared
  // goal and (only on sustained, un-returned divergence) a cheap worker writes
  // a flag carrying a swap/revert/continue choice. Consumed by the focus{}
  // projection slot; emitted by focus-trigger (fires on SESSION_HEARTBEAT +
  // SLICE_STOP). data shapes:
  //   FOCUS_TAGGED:   { tag:'toward'|'lateral'|'away', distanceScore, signals, goalSetAt }
  //   DRIFT_FLAGGED:  { reason, runs, menu:['swap','revert','continue'], workerId?, cleared? }
  FOCUS_TAGGED:               'FOCUS_TAGGED',
  DRIFT_FLAGGED:              'DRIFT_FLAGGED',

  // Earned autonomy (maddu autonomy, roadmap #11) — deterministic per-lane
  // trust score over the verified record; RECOMMEND-ONLY (never writes
  // governance config). Frozen data shapes (schemaVersion 1) in
  // docs/research/earned-autonomy-proposal.md. Both are report/meta events —
  // the scorer ignores them, so scoring never feeds on itself.
  //   AUTONOMY_SCORED:         { schemaVersion, asOf, attribution, configHash, totalSlices, lanes:[{lane, clean, cleanCapped, dirty, neutral, unwitnessed, total, n, coverage, wilson, rung}] }
  //   AUTONOMY_RECOMMENDATION: { schemaVersion, asOf, lane, fromRung, toRung, wilson, n, coverage, recommendation, muted, mutedReason, configHash }
  AUTONOMY_SCORED:            'AUTONOMY_SCORED',
  AUTONOMY_RECOMMENDATION:    'AUTONOMY_RECOMMENDATION',

  // Lane worktrees (roadmap #12a) — a worktree ATTACHMENT binds a lane claim
  // to an isolated git-worktree checkout under .maddu/worktrees/<lane>/.
  // Frozen data shapes (schemaVersion 1) in
  // docs/research/competitive-response-proposal.md; verifier rules in
  // verify.mjs (orphan/duplicate detach, live-path reuse, claim-ref
  // presence). Emitted by the attach/release flow (phase 4+); registered and
  // verifier-covered FIRST so no unshaped event can ever land on a spine.
  //   WORKTREE_ATTACHED: { schemaVersion, attachmentId, claimEventId, lane, session,
  //                        pathRepoRel, pathAbs, branchRef, baseRef, baseHeadAtAttach,
  //                        created, reused, dirty, gitCommonDir, platform }
  //   WORKTREE_DETACHED: { schemaVersion, attachmentId, lane, pathRepoRel,
  //                        disposition: merged|abandoned|kept|orphaned,
  //                        branchHead, integrationRef, integrationHead,
  //                        ancestorCheck: pass|fail|skipped, dirtyAtDetach, reason }
  WORKTREE_ATTACHED:          'WORKTREE_ATTACHED',
  WORKTREE_DETACHED:          'WORKTREE_DETACHED',
  // SLM-governance p2 (plan pln_20260706133422_0f60, contract 1.1.0) — the
  // MODEL_ family: Máddu governs an SLM factory's record (hash-pinned
  // manifests via lib/model-manifests.mjs ingest), never the training.
  // Design: docs/research/slm-governance-design.md §5. All 11 carry
  // data.schemaVersion:1; manifest-backed ones carry manifestPath +
  // manifestHash (pinned). Verifier rules in verify.mjs; emitted by
  // `maddu model` (phase 3) — registered and verifier-covered FIRST so no
  // unshaped event can ever land on a spine.
  MODEL_DATASET_SNAPSHOT_RECORDED: 'MODEL_DATASET_SNAPSHOT_RECORDED',
  MODEL_TRAINING_RUN_STARTED:   'MODEL_TRAINING_RUN_STARTED',
  MODEL_TRAINING_RUN_COMPLETED: 'MODEL_TRAINING_RUN_COMPLETED',
  MODEL_CHECKPOINT_REGISTERED:  'MODEL_CHECKPOINT_REGISTERED',
  MODEL_EVAL_RAN:               'MODEL_EVAL_RAN',
  MODEL_REGRESSION_FOUND:       'MODEL_REGRESSION_FOUND',
  MODEL_REGRESSION_ACKNOWLEDGED: 'MODEL_REGRESSION_ACKNOWLEDGED',
  MODEL_PROMOTION_PROPOSED:     'MODEL_PROMOTION_PROPOSED',
  MODEL_PROMOTION_APPROVED:     'MODEL_PROMOTION_APPROVED',
  MODEL_RELEASED:               'MODEL_RELEASED',
  MODEL_ROLLED_BACK:            'MODEL_ROLLED_BACK'
};

export const STUCK_THRESHOLD_MS = 15000;

// Canonical Máddu id factory: `<prefix>_<ts14>_<hex>`.
//   prefix : short type tag (evt, ses, tsk, skl, wrk, …).
//   ts     : ISO timestamp to derive the 14-char compact stamp from;
//            defaults to now. Pass the event's own ts for evt ids so the
//            id and the event timestamp line up.
//   bytes  : entropy width. Defaults to 3 (6 hex chars) — the spine/event
//            convention. A few short-lived ids (plans, loops, coordinators)
//            historically use 2 bytes (4 hex chars); they pass bytes=2 so
//            their exact format is preserved.
// The ID FORMAT (ts14 + hex entropy) is load-bearing — spine data keys on
// prefixes and shape — so it must not change. Every local newId/genId
// across commands/ and runtime/lib/ should route through this.
export function makeId(prefix, ts = new Date().toISOString(), bytes = 3) {
  const t = ts.replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(bytes).toString('hex');
  return `${prefix}_${t}_${r}`;
}

function genId(ts) { return makeId('evt', ts); }

function genSessionId() { return makeId('ses'); }

export function genTaskId() { return makeId('tsk'); }

export function genSkillId() { return makeId('skl'); }

export function genWorkerId() { return makeId('wrk'); }

async function ensureDirs(paths) {
  await mkdir(paths.state, { recursive: true });
  await mkdir(paths.events, { recursive: true });
  await mkdir(paths.statePrjDir, { recursive: true });
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.lanes, { recursive: true });
  await mkdir(paths.inbox, { recursive: true });
  await mkdir(paths.archive, { recursive: true });
}

async function ensureCatalog(paths) {
  try {
    await stat(paths.laneCatalog);
  } catch {
    await writeFile(paths.laneCatalog, JSON.stringify(DEFAULT_LANE_CATALOG, null, 2) + '\n');
  }
  try {
    await stat(paths.laneClaims);
  } catch {
    await writeFile(paths.laneClaims, JSON.stringify({ schemaVersion: 1, claims: [] }, null, 2) + '\n');
  }
}

async function listSegments(paths) {
  try {
    const files = await readdir(paths.events);
    return files.filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  } catch {
    return [];
  }
}

async function currentSegment(paths) {
  const segs = await listSegments(paths);
  if (segs.length === 0) {
    const name = '000000000001.ndjson';
    await writeFile(join(paths.events, name), '');
    return name;
  }
  const last = segs[segs.length - 1];
  const st = await stat(join(paths.events, last));
  if (st.size < ROLL_BYTES) return last;
  // Roll.
  const next = String(parseInt(last.split('.')[0], 10) + 1).padStart(12, '0') + '.ndjson';
  await writeFile(join(paths.events, next), '');
  return next;
}

export async function ensureSpine(repoRoot) {
  const paths = pathsFor(repoRoot);
  await ensureDirs(paths);
  await ensureCatalog(paths);
  return paths;
}

// ── Tamper-evidence: forward `prev_hash` chain (v1.14.0) ──
//
// Each event carries `prev_hash` = the SHA-256 of the EXACT stored line of the
// immediately-preceding event (the literal NDJSON line, trailing CR stripped so
// a CRLF-normalized copy verifies identically). Hashing the stored line — not a
// re-serialization — sidesteps any canonical-JSON ambiguity: the bytes on disk
// are the same on every machine. The genesis event (empty spine) carries
// `prev_hash: null`. `maddu spine verify` recomputes the chain and flags the
// first link that doesn't match (history altered, or an event inserted/removed).
// Forward-only: events written before v1.14.0 have no `prev_hash`; the chain is
// only checked from the first event that has one, so no migration is needed.
// Both this writer and the verifier import `hashLine` so they can never drift.
// (Definition moved to spine-append-core.mjs; re-exported at the top of this file.)

// Return the exact stored text of the last non-empty event line across all
// segments, or null for an empty spine. Tail-reads (≤64 KB) so the cost stays
// flat regardless of segment size — a single event line is always well under
// that, so the final complete line is captured even from a 10 MB segment.
async function lastEventLine(paths) {
  const segs = await listSegments(paths);
  for (let i = segs.length - 1; i >= 0; i--) {
    const p = join(paths.events, segs[i]);
    let st;
    try { st = await stat(p); } catch { continue; }
    if (st.size === 0) continue;
    const readLen = Math.min(st.size, 65536);
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, st.size - readLen);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
      if (lines.length) return lines[lines.length - 1];
    } finally { await fh.close(); }
    // Pathological: a single line longer than 64 KB — fall back to a full read.
    const lines = (await readFile(p, 'utf8')).split('\n').filter((l) => l.trim());
    if (lines.length) return lines[lines.length - 1];
  }
  return null;
}

export async function append(repoRoot, { type, actor = null, lane = null, data = {}, triggered_by = null }) {
  if (!EVENT_TYPES[type]) {
    throw new Error(`unknown event type: ${type}`);
  }
  // Write-boundary payload sweep: every emit site funnels through here, so a
  // secret-shaped value in caller/agent/worker-supplied free text is redacted
  // BEFORE the line is built — prev_hash chains over the stored (redacted)
  // bytes on both the flat and partitioned branches, and the ENOENT-retry
  // reuses the same already-swept `ev`. Clean data passes through by
  // reference (no clone, identical return value). Scope: `data` only —
  // actor/lane/triggered_by carry ids by construction.
  data = redactDataPayload(data);
  const paths = await ensureSpine(repoRoot);
  const ts = new Date().toISOString();
  const ev = { v: 1, id: genId(ts), ts, type, actor, lane, data };
  if (triggered_by) ev.triggered_by = triggered_by;

  // ── Sync mode (#12c): partitioned append ──
  // Write to this replica's partition under the funnel (prev_hash computed inside
  // the lock, so the chain cannot fork). A write NEVER touches a partition whose
  // migration hasn't committed: if a `spine sync init` is in progress, resolveWrite-
  // Replica WAITS for it to commit, then writes to the completed partition; if it
  // stalls, we refuse rather than fork. Absent any replicaId/marker this is a no-op
  // and the DEFAULT flat path below runs unchanged.
  const w = await resolveWriteReplica(repoRoot);
  if (w.id) return appendPartitioned(repoRoot, w.id, ev);
  if (w.pending) throw new Error('spine append: a `spine sync init` migration is pending/stalled — re-run `maddu spine sync init`, then retry');

  // Tamper-evidence (v1.14.0): link to the prior event by hashing its stored
  // line. Since audit P1 the flat write goes through the SHARED locked+chained
  // primitive `appendFlatChained` (spine-append-core.mjs) — prev_hash is computed
  // INSIDE the append funnel, so a concurrent flat writer (bridge + a CLI invocation)
  // can no longer fork the chain, and the token wrapper shares the exact same path
  // so every flat event carries prev_hash. O_APPEND framing + one-event-per-line +
  // no-per-append-fsync durability all live in that primitive now.
  //
  // The primitive re-resolves the replica under the lock and returns a discriminated
  // outcome; the ENOENT catch stays OUT here as a backstop for a rename that slips
  // between currentSegment and appendFile (a `spine sync init` migration renaming a
  // segment out from under us — never happens in pure default mode).
  try {
    const outcome = await appendFlatChained(repoRoot, paths.events, ev, { maxWaitMs: Infinity });
    if (outcome.reroute) return appendPartitioned(repoRoot, outcome.reroute, ev);
    if (outcome.pending) throw new Error('spine append: a `spine sync init` migration is pending/stalled — re-run `maddu spine sync init`, then retry');
    return outcome.ev;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const w2 = await resolveWriteReplica(repoRoot);
      if (w2.id) return appendPartitioned(repoRoot, w2.id, ev);
      if (w2.pending) throw new Error('spine append: a `spine sync init` migration is pending/stalled — re-run `maddu spine sync init`, then retry');
    }
    throw err;
  }
}

export async function readAll(repoRoot) {
  const paths = await ensureSpine(repoRoot);
  // Sync mode (#12c) uses the SAME opt-in predicate as the write path: this
  // checkout has an active replicaId (committed, or a pending migration target).
  // Keying read and write on the one signal keeps a default repo (no replica.json)
  // byte/behaviour-identical even if a stray by-replica dir happens to be present,
  // and keeps reads consistent with writes DURING a migration. A teammate joins the
  // shared spine by running `spine sync init`, then readAllPartitioned merges every
  // partition present, including imported ones.
  if (await readActiveReplicaId(repoRoot)) return readAllPartitioned(repoRoot);
  const segs = await listSegments(paths);
  // Re-check AFTER the flat snapshot: a `spine sync init` may have begun between the
  // first check and listSegments, so this snapshot could already miss a just-renamed
  // segment WITHOUT any ENOENT firing. The migration writes its marker before any
  // rename, so it is visible now — restart into the consistent partitioned read
  // rather than return a partial flat view (which would give readSince/lastEventId
  // cursor consumers a persistent gap).
  if (await readActiveReplicaId(repoRoot)) return readAllPartitioned(repoRoot);
  const out = [];
  for (const seg of segs) {
    let text;
    try { text = await readFile(join(paths.events, seg), 'utf8'); }
    catch (err) {
      // A segment can vanish mid-read only when a migration began after the re-check
      // above (never in pure default mode). Do NOT return a PARTIAL flat view —
      // restart into the now-consistent partitioned read (partition + residual flat).
      if (err && err.code === 'ENOENT') return readAllPartitioned(repoRoot);
      throw err;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); }
      catch (err) { console.error(`spine: bad line in ${seg}:`, err.message); }
    }
  }
  return out;
}

export async function readSince(repoRoot, afterId) {
  const all = await readAll(repoRoot);
  if (!afterId) return all;
  const idx = all.findIndex((e) => e.id === afterId);
  return idx < 0 ? all : all.slice(idx + 1);
}

export async function lastEventId(repoRoot) {
  const all = await readAll(repoRoot);
  return all.length ? all[all.length - 1].id : null;
}

export { genSessionId };
