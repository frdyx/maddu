// event-dispositions.mjs (DD1, roadmap #3) — the definition-site disposition
// registry. EVERY event type defined in spine.mjs EVENT_TYPES carries a verdict
// here, so a type can never be added without a decision and the dead-domain
// surface (F3) can never silently grow. The `event-dispositions-complete` gate
// holds this registry in 1:1 parity with EVENT_TYPES and requires a reason on
// every non-active entry; insights derives DORMANT_BY_DESIGN from it (single
// source of truth — collapsing the three previously-disconnected surfaces).
//
// disp:
//   'active'  — fires in normal operation (load-bearing or occasional).
//   'dormant' — defined but fires only under a specific posture/edge. reason
//               REQUIRED. Reads as dormant (not dead) in `maddu insights`.
//   'plugin'  — owned by an optional plugin (off in core). reason = plugin name.
//
// Seeded 2026-06-30 from the cross-project audit: the 34 then-dead core types
// are accepted as dormant-with-reason (see docs/audit/LEDGER.md F3). To retire a
// type instead, remove it from EVENT_TYPES (the gate then drops it here too).

export const EVENT_DISPOSITIONS = {
  FRAMEWORK_INSTALLED: { disp: 'active' },
  FRAMEWORK_UPGRADED: { disp: 'active' },
  FRAMEWORK_BOOTED: { disp: 'active' },
  DOCTOR_REPORT: { disp: 'active' },
  AUDIT_REPORT: { disp: 'active' },
  SESSION_REGISTERED: { disp: 'active' },
  SESSION_HEARTBEAT: { disp: 'active' },
  SESSION_CLOSED: { disp: 'active' },
  LANE_CLAIMED: { disp: 'active' },
  LANE_RELEASED: { disp: 'active' },
  LANE_ADDED: { disp: 'dormant', reason: "lane catalog is authored by hand; admin verbs fire only when used" },
  LANE_REMOVED: { disp: 'dormant', reason: "lane catalog is authored by hand; admin verbs fire only when used" },
  LANE_DEFAULTS_SET: { disp: 'dormant', reason: "lane catalog is authored by hand; admin verbs fire only when used" },
  LANE_POLICY_SET: { disp: 'dormant', reason: "lane catalog is authored by hand; admin verbs fire only when used" },
  SLICE_STOP: { disp: 'active' },
  INBOX_MESSAGE: { disp: 'dormant', reason: "inbox write path; `mailbox send` is the load-bearing entry" },
  APPROVAL_REQUESTED: { disp: 'active' },
  APPROVAL_DECIDED: { disp: 'active' },
  APPROVAL_POLICY_SET: { disp: 'dormant', reason: "fires only when an approval policy is set" },
  MAILBOX_SENT: { disp: 'active' },
  MAILBOX_READ: { disp: 'dormant', reason: "read-side receipt; fires only when the inbox is consumed programmatically" },
  TASK_CREATED: { disp: 'active' },
  TASK_UPDATED: { disp: 'active' },
  TASK_COMPLETED: { disp: 'active' },
  SKILL_CREATED: { disp: 'dormant', reason: "skill lifecycle — skills are hand-authored (`maddu skill create`/`from-slice`); the auto-detector was retired (#5/F2, v1.81.0)" },
  SKILL_UPDATED: { disp: 'dormant', reason: "skill lifecycle — skills are hand-authored (`maddu skill create`/`from-slice`); the auto-detector was retired (#5/F2, v1.81.0)" },
  SKILL_DELETED: { disp: 'dormant', reason: "skill lifecycle — skills are hand-authored (`maddu skill create`/`from-slice`); the auto-detector was retired (#5/F2, v1.81.0)" },
  SKILL_APPLIED: { disp: 'dormant', reason: "skill lifecycle — skills are hand-authored (`maddu skill create`/`from-slice`); the auto-detector was retired (#5/F2, v1.81.0)" },
  WORKER_SPAWNED: { disp: 'active' },
  WORKER_HEARTBEAT: { disp: 'dormant', reason: "real-worker lifecycle; fires only when a worker subprocess runs" },
  WORKER_EXITED: { disp: 'active' },
  WORKER_KILLED: { disp: 'dormant', reason: "real-worker lifecycle; fires only when a worker is killed" },
  RUNTIME_REGISTERED: { disp: 'active' },
  RUNTIME_DETECTED: { disp: 'dormant', reason: "fires only on runtime auto-detection" },
  RUNTIME_REMOVED: { disp: 'active' },
  MCP_REGISTERED: { disp: 'active' },
  MCP_ENABLED: { disp: 'dormant', reason: "MCP management; fires only under MCP configuration" },
  MCP_DISABLED: { disp: 'dormant', reason: "MCP management; fires only under MCP configuration" },
  MCP_TESTED: { disp: 'dormant', reason: "MCP management; fires only under MCP configuration" },
  MCP_REMOVED: { disp: 'dormant', reason: "MCP management; fires only under MCP configuration" },
  SCHEDULE_CREATED: { disp: 'dormant', reason: "operator opt-in recurring tasks" },
  SCHEDULE_UPDATED: { disp: 'dormant', reason: "operator opt-in recurring tasks" },
  SCHEDULE_REMOVED: { disp: 'dormant', reason: "operator opt-in recurring tasks" },
  SCHEDULE_FIRED: { disp: 'dormant', reason: "operator opt-in recurring tasks" },
  CHECKPOINT_CREATED: { disp: 'dormant', reason: "operator opt-in checkpoints" },
  CHECKPOINT_REMOVED: { disp: 'dormant', reason: "operator opt-in checkpoints" },
  CHECKPOINT_WORKTREE_CREATED: { disp: 'dormant', reason: "fires only when an operator materializes a checkpoint worktree" },
  CHECKPOINT_ROLLBACK_REQUESTED: { disp: 'dormant', reason: "fires only when an operator rolls back to a checkpoint" },
  AUTH_KEY_ADDED: { disp: 'dormant', reason: "API-key auth path; OAuth is the default" },
  AUTH_KEY_REMOVED: { disp: 'dormant', reason: "API-key auth path; OAuth is the default" },
  AUTH_KEY_ROTATED: { disp: 'dormant', reason: "API-key auth path; OAuth is the default" },
  AUTH_KEY_RATE_LIMITED: { disp: 'dormant', reason: "fires only on a provider rate-limit response" },
  IMPORT_ACCEPTED: { disp: 'dormant', reason: "cross-machine spine import only" },
  IMPORT_REJECTED: { disp: 'dormant', reason: "cross-machine spine import only" },
  PROPOSAL_CREATED: { disp: 'dormant', reason: "proposal flow; fires only when a proposal is raised" },
  PROPOSAL_DECIDED: { disp: 'dormant', reason: "proposal flow; fires only when a proposal is decided" },
  BOSS_MESSAGE: { disp: 'plugin', reason: 'comms' },
  TELEGRAM_ENABLED: { disp: 'plugin', reason: 'comms' },
  TELEGRAM_DISABLED: { disp: 'plugin', reason: 'comms' },
  TELEGRAM_ALLOWLIST_SET: { disp: 'plugin', reason: 'comms' },
  TELEGRAM_INBOUND: { disp: 'plugin', reason: 'comms' },
  TELEGRAM_OUTBOUND: { disp: 'plugin', reason: 'comms' },
  TELEGRAM_OUTBOUND_FAILED: { disp: 'plugin', reason: 'comms' },
  TELEGRAM_DROPPED: { disp: 'plugin', reason: 'comms' },
  DISCORD_ENABLED: { disp: 'plugin', reason: 'comms' },
  DISCORD_DISABLED: { disp: 'plugin', reason: 'comms' },
  DISCORD_ALLOWLIST_SET: { disp: 'plugin', reason: 'comms' },
  DISCORD_OUTBOUND: { disp: 'plugin', reason: 'comms' },
  DISCORD_OUTBOUND_FAILED: { disp: 'plugin', reason: 'comms' },
  EMAIL_ENABLED: { disp: 'plugin', reason: 'comms' },
  EMAIL_DISABLED: { disp: 'plugin', reason: 'comms' },
  EMAIL_CONFIG_SET: { disp: 'plugin', reason: 'comms' },
  EMAIL_ALLOWLIST_SET: { disp: 'plugin', reason: 'comms' },
  EMAIL_SENT: { disp: 'plugin', reason: 'comms' },
  EMAIL_OUTBOUND_FAILED: { disp: 'plugin', reason: 'comms' },
  FOLLOWUP_OPENED: { disp: 'active' },
  GATE_RAN: { disp: 'active' },
  GOAL_DECLARED: { disp: 'active' },
  GOAL_COMPLETED: { disp: 'active' },
  PENDING_ACTION_DRAINED: { disp: 'dormant', reason: "deferred-action queue; fires only when the queue is drained" },
  PENDING_ACTION_ENQUEUED: { disp: 'dormant', reason: "deferred-action queue; fires only when an action is deferred" },
  PHASE_DECLARED: { disp: 'active' },
  PHASE_CLEARED: { disp: 'dormant', reason: "fires only when the operator explicitly exits a phase (`maddu phase clear`)" },
  SLICE_FUNCTIONAL_APPROVED: { disp: 'dormant', reason: "optional functional-approval branch of slice review" },
  SLICE_REVIEWED: { disp: 'active' },
  SLICE_SCOPE_DECLARED: { disp: 'active' },
  SLICE_SCOPE_EXPANDED: { disp: 'dormant', reason: "fires only when a slice scope is widened mid-work" },
  SOURCE_HASH_RECOMPUTED: { disp: 'dormant', reason: "fires only on an integrity hash recompute" },
  TRIGGER_FIRED: { disp: 'active' },
  AGENT_FILE_SYNCED: { disp: 'active' },
  SESSION_AUTO_CLOSED: { disp: 'active' },
  SESSION_AUTO_REGISTERED: { disp: 'active' },
  SESSION_STALE_DETECTED: { disp: 'active' },
  COMPACTION_CHECKPOINT: { disp: 'dormant', reason: "fires only when the PreCompact hook is installed and a Claude Code compaction occurs" },
  VENDOR_MEMORY_IMPORTED: { disp: 'dormant', reason: "fires only when the operator runs `learn sync --from-claude-memory --adopt`" },
  SLASH_COMMANDS_SYNCED: { disp: 'active' },
  TEAM_OPENED: { disp: 'active' },
  TEAM_LANE_ALLOCATED: { disp: 'active' },
  TEAM_MEMBER_JOINED: { disp: 'active' },
  TEAM_MEMBER_LEFT: { disp: 'active' },
  TEAM_CLOSED: { disp: 'active' },
  PIPELINE_STARTED: { disp: 'active' },
  PIPELINE_STAGE_ENTERED: { disp: 'active' },
  PIPELINE_STAGE_EXITED: { disp: 'active' },
  PIPELINE_COMPLETED: { disp: 'active' },
  PIPELINE_HALTED: { disp: 'dormant', reason: "pipeline failure branch; fires only when a pipeline halts" },
  ADVISOR_INVOKED: { disp: 'active' },
  ADVISOR_ARTIFACT_WRITTEN: { disp: 'active' },
  TOKEN_USAGE_REPORTED: { disp: 'active' },
  SKILL_INJECTED: { disp: 'dormant', reason: "skill lifecycle — skills are hand-authored (`maddu skill create`/`from-slice`); the auto-detector was retired (#5/F2, v1.81.0)" },
  SKILL_INJECTION_REFUSED: { disp: 'active' },
  TOOL_INVOKED: { disp: 'active' },
  TOOL_COMPLETED: { disp: 'active' },
  TOOL_REFUSED: { disp: 'active' },
  GOVERNANCE_MODE_CHANGED: { disp: 'active' },
  PLAN_CREATED: { disp: 'active' },
  PLAN_PHASE_ADDED: { disp: 'active' },
  PLAN_PHASE_COMPLETED: { disp: 'active' },
  PLAN_PHASE_BLOCKED: { disp: 'active' },
  PLAN_REVISED: { disp: 'active' },
  PLAN_COMPLETED: { disp: 'active' },
  PLAN_CANCELLED: { disp: 'active' },
  LOOP_STARTED: { disp: 'active' },
  LOOP_ITERATION_STARTED: { disp: 'active' },
  LOOP_ITERATION_COMPLETED: { disp: 'active' },
  LOOP_HALTED: { disp: 'active' },
  LOOP_COMPLETED: { disp: 'active' },
  COORDINATOR_STARTED: { disp: 'active' },
  COORDINATOR_PHASE_STARTED: { disp: 'active' },
  COORDINATOR_PHASE_COMPLETED: { disp: 'active' },
  COORDINATOR_HALTED: { disp: 'active' },
  COORDINATOR_COMPLETED: { disp: 'active' },
  LANE_CLAIM_FORCED: { disp: 'active' },
  SKILL_CANDIDATE_DETECTED: { disp: 'dormant', reason: "auto-detector RETIRED (#5/F2, v1.81.0): generic tag-set candidates, 0 conversion fleet-wide. Skills are hand-authored; auto-capture is `maddu learn`. The funnel-integrity gate keeps it retired." },
  SKILL_CANDIDATE_APPROVED: { disp: 'dormant', reason: "skill lifecycle — skills are hand-authored (`maddu skill create`/`from-slice`); the auto-detector was retired (#5/F2, v1.81.0)" },
  SKILL_CANDIDATE_REJECTED: { disp: 'dormant', reason: "skill lifecycle — skills are hand-authored (`maddu skill create`/`from-slice`); the auto-detector was retired (#5/F2, v1.81.0)" },
  TRUST_AUDIT_RAN: { disp: 'active' },
  TRUST_PIN_ADDED: { disp: 'dormant', reason: "fires only when an operator pins a dependency" },
  TRUST_PIN_REMOVED: { disp: 'dormant', reason: "fires only when an operator unpins a dependency" },
  TRUST_VIOLATION_DETECTED: { disp: 'active' },
  MCP_PROVENANCE_VERIFIED: { disp: 'dormant', reason: "fires only under MCP use with provenance checks" },
  MCP_PROVENANCE_MISMATCH: { disp: 'dormant', reason: "attack/tamper signal under MCP provenance checks" },
  MCP_APPROVAL_GRANTED: { disp: 'dormant', reason: "fires only under gated MCP approval" },
  WORKER_ENV_FILTERED: { disp: 'dormant', reason: "fires only when a real worker spawn strips env" },
  SECRET_DETECTED_IN_ARGV: { disp: 'active' },
  SKILL_IMPORTED: { disp: 'dormant', reason: "skill lifecycle — skills are hand-authored (`maddu skill create`/`from-slice`); the auto-detector was retired (#5/F2, v1.81.0)" },
  SKILL_TRUSTED: { disp: 'dormant', reason: "skill lifecycle — skills are hand-authored (`maddu skill create`/`from-slice`); the auto-detector was retired (#5/F2, v1.81.0)" },
  HANDOFF_SET: { disp: 'active' },
  LEARN_MINED: { disp: 'active' },
  LEARN_DIGEST_WRITTEN: { disp: 'dormant', reason: "no-provider fallback path; autonomous judging is the default" },
  LEARN_JUDGED: { disp: 'dormant', reason: "fires only when a `maddu learn` judgment worker runs" },
  LEARN_CORRECTION_WRITTEN: { disp: 'dormant', reason: "fires only when `maddu learn` writes a correction" },
  MEMORY_FACT_SUPERSEDED: { disp: 'dormant', reason: "fires only when a memory fact is superseded" },
  BRIEFING_CURATED: { disp: 'dormant', reason: "fires only under a curated (--curate) orient/handoff briefing" },
  BRIDGE_ORIGIN_REJECTED: { disp: 'active' },
  BRIDGE_CROSS_WORKSPACE: { disp: 'dormant', reason: "fires only when a request targets a non-active workspace (multi-workspace bridge)" },
  SPINE_CUTOVER: { disp: 'dormant', reason: "fires only when a fresh sync partition is minted (spine sync init)" },
  DISCIPLINE_SKIPPED: { disp: 'dormant', reason: "fires only when a discipline bypass is witnessed (enforcement off / self-disable / hook uninstalled) — absent in a healthy disciplined run" },
  ENFORCEMENT_ERROR: { disp: 'dormant', reason: "fires only when the enforcement path throws and falls open — absent unless there's an enforcement bug" },
  GOVERNANCE_OVERRIDE_CHANGED: { disp: 'dormant', reason: "fires only when a governance behavior-override key is changed/cleared (e.g. the discipline off-switch)" },
  VERIFICATION_STARTED: { disp: 'active' },
  VERIFICATION_RAN: { disp: 'active' },
  BLUEPRINT_DISTILLED: { disp: 'dormant', reason: "blueprint --distill emits it; not exercised in registered projects" },
  DEBT_SCANNED: { disp: 'active' },
  ARCHITECTURE_SCANNED: { disp: 'active' },
  FOCUS_TAGGED: { disp: 'dormant', reason: "Focus Director is opt-in (off by default)" },
  DRIFT_FLAGGED: { disp: 'dormant', reason: "Focus Director is opt-in; fires only on sustained drift" },
  AUTONOMY_SCORED: { disp: 'active' },
  AUTONOMY_RECOMMENDATION: { disp: 'dormant', reason: "fires only on a rung change — a lane's record crossing (or falling from) a trust-ladder threshold" },
  WORKTREE_ATTACHED: { disp: 'dormant', reason: "registered + verifier-covered ahead of the attach flow (roadmap #12a phase 3); emitted once `lane claim --worktree` lands (phase 4)" },
  WORKTREE_DETACHED: { disp: 'dormant', reason: "registered + verifier-covered ahead of the attach flow (roadmap #12a phase 3); emitted once `lane release --worktree` lands (phase 5)" },
  // SLM-governance MODEL_ family (contract 1.1.0): fires only in repos
  // running an SLM factory through `maddu model` (plan pln_20260706133422_0f60)
  // — dormant by design on every ordinary spine, exactly so `maddu insights`
  // never reads the family as dead surface.
  MODEL_DATASET_SNAPSHOT_RECORDED: { disp: 'dormant', reason: "fires only in repos governing an SLM factory via `maddu model` (phase 3)" },
  MODEL_TRAINING_RUN_STARTED: { disp: 'dormant', reason: "fires only in repos governing an SLM factory via `maddu model` (phase 3)" },
  MODEL_TRAINING_RUN_COMPLETED: { disp: 'dormant', reason: "fires only in repos governing an SLM factory via `maddu model` (phase 3)" },
  MODEL_CHECKPOINT_REGISTERED: { disp: 'dormant', reason: "fires only in repos governing an SLM factory via `maddu model` (phase 3)" },
  MODEL_EVAL_RAN: { disp: 'dormant', reason: "fires only in repos governing an SLM factory via `maddu model` (phase 3)" },
  MODEL_REGRESSION_FOUND: { disp: 'dormant', reason: "fires only when an eval manifest declares a critical regression (`maddu model eval record`, phase 3)" },
  MODEL_REGRESSION_ACKNOWLEDGED: { disp: 'dormant', reason: "fires only on explicit operator judgment (`maddu model regression ack`, phase 3)" },
  MODEL_PROMOTION_PROPOSED: { disp: 'dormant', reason: "fires only on `maddu model promote` (phase 3); the paired APPROVAL_REQUESTED rides first" },
  MODEL_PROMOTION_APPROVED: { disp: 'dormant', reason: "fires only on `maddu model promote --confirm` against an allowing decision (phase 3)" },
  MODEL_RELEASED: { disp: 'dormant', reason: "fires only on `maddu model release` after an approved promotion to released (phase 3)" },
  MODEL_ROLLED_BACK: { disp: 'dormant', reason: "fires only on `maddu model rollback` of a released checkpoint (phase 3)" },
};

export const DISP_KINDS = new Set(['active', 'dormant', 'plugin']);

// Pure completeness/parity check, shared by the gate and the fixture. Given the
// authoritative type keys (spine.mjs EVENT_TYPES) and a dispositions map, it
// reports: types with NO disposition (the recurrence the gate prevents — adding
// a type without a verdict), dispositions for UNKNOWN types (drift after a
// retire), invalid `disp` kinds, and non-active entries MISSING a reason.
export function validateDispositions(typeKeys, dispositions = EVENT_DISPOSITIONS) {
  const typeSet = new Set(typeKeys);
  const dispKeys = Object.keys(dispositions);
  const dispSet = new Set(dispKeys);
  const missing = [...typeSet].filter((k) => !dispSet.has(k));
  const extra = dispKeys.filter((k) => !typeSet.has(k));
  const badKind = [];
  const noReason = [];
  for (const [k, v] of Object.entries(dispositions)) {
    if (!v || !DISP_KINDS.has(v.disp)) { badKind.push(k); continue; }
    if (v.disp !== 'active' && !(typeof v.reason === 'string' && v.reason.trim())) noReason.push(k);
  }
  const ok = missing.length === 0 && extra.length === 0 && badKind.length === 0 && noReason.length === 0;
  return { ok, missing, extra, badKind, noReason };
}

// DORMANT_BY_DESIGN, DERIVED from this registry — the single source of truth.
// Only disp:'dormant' entries; plugin-owned types are reclassified separately
// via insights' pluginOwners (preserving prior [plugin:name] display semantics).
export function dormantByDesignMap(dispositions = EVENT_DISPOSITIONS) {
  return new Map(
    Object.entries(dispositions)
      .filter(([, v]) => v.disp === 'dormant')
      .map(([k, v]) => [k, v.reason]),
  );
}
