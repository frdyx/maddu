// event-schema.mjs (roadmap #12b phase 7) — the PUBLISHED spine event
// contract. Every spine.mjs EVENT_TYPES key carries an EXPLICIT per-event data
// schema here (not derived from EVENT_TYPES alone): the known, load-bearing
// fields with their JSON types. The `event-schema-complete` gate holds this
// registry in 1:1 parity with EVENT_TYPES (a type can never be added or retired
// without updating the contract), and docs/event-schema.{md,json} are GENERATED
// from it — so the existing `generated-artifacts-current` gate proves the
// published contract can never drift from the code.
//
// FORWARD-COMPAT: every event's `data` is treated as an OPEN object — extra
// keys beyond those listed are valid (matches the spine verifier's forward-
// compat stance). The listed fields are the CONTRACT (what consumers may rely
// on); additive-only within a MAJOR. `frozen: true` marks a schemaVersion-
// pinned shape whose listed fields are guaranteed stable and carry a
// `schemaVersion` discriminator in `data`.
//
// ENVELOPE (every event, not repeated per-type) is defined once in
// EVENT_ENVELOPE below — the single source for the generated JSON Schema /
// Markdown AND the contract fingerprint.
//
// SEMVER (EVENT_CONTRACT_VERSION) — enforced by versionDiscipline() against the
// committed baseline (the `event-schema` self-test fails an under-sized bump):
//   MAJOR — remove an event type or a listed field, change a field's type, or
//           flip a frozen flag.
//   MINOR — add an event type, or add a listed field to an existing type.
//   PATCH — summary/wording only; no shape change (invisible to the fingerprint).
//
// data field type grammar: 'string' | 'number' | 'boolean' | 'object' |
// 'array' | 'any'; a trailing '?' marks a field that may be absent; '|null'
// marks a nullable value (the key is present).

// 1.1.0 (SLM-governance p2): +11 MODEL_* types — the one deliberate MINOR
// bump the phase-0 design commits to (docs/research/slm-governance-design.md
// §5/§11). Additive only; no existing type or field changed.
// 1.2.0 — added SKILL_INJECTION_REFUSED (load-time untrusted-skill refusal is
// now witnessed on the spine). Additive: a new event type, no existing type or
// field changed → minor bump.
// 1.3.0 — added GOAL_COMPLETED (goal lifecycle: a finished goal is closed
// instead of lingering forever). Additive → minor bump.
// 1.4.0 (audit P0b) — added BRIDGE_CROSS_WORKSPACE (a bridge request selected a
// non-active workspace). Additive → minor bump; baseline refreshed so a
// consumer caching 1.3.0 never sees the extra type under an unchanged version.
// 1.5.0 (audit P1) — added SPINE_CUTOVER (a chain-local tamper-detection cutover
// anchor, seeded into a freshly-minted sync partition so verify holds it to the
// post-cutover strict rules even with no migrated FRAMEWORK marker). Additive.
// 1.6.0 (audit P2) — added DISCIPLINE_SKIPPED, ENFORCEMENT_ERROR, and
// GOVERNANCE_OVERRIDE_CHANGED so a discipline bypass / fail-open / off-switch
// change always leaves a spine witness (the "actor not sole witness" north star).
// Additive → minor bump; baseline refreshed at release.
export const EVENT_CONTRACT_VERSION = '1.6.0';

// The shared envelope — every spine event carries exactly these top-level keys.
// Single source of truth for BOTH the generated JSON Schema / Markdown envelope
// section AND the contract fingerprint (so an envelope change forces a version
// bump too). The generator layers the JSON-Schema specifics on top by field name
// (`v` is const 1, `ts` is date-time, `type` is the event-type enum).
//   prev_hash    — absent on pre-chain events, null on the genesis event.
//   triggered_by — object provenance ({ kind, id, fired_at, … }) or null.
export const EVENT_ENVELOPE = {
  v: 'number',
  id: 'string',
  ts: 'string',
  type: 'string',
  actor: 'string|null',
  lane: 'string|null',
  prev_hash: 'string|null',
  triggered_by: 'object|null',
  data: 'object',
};

// Envelope keys that are ALWAYS present (the rest — prev_hash, triggered_by —
// appear only when applicable). This is the JSON Schema `required` set and is
// part of the fingerprinted shape, so changing which keys are guaranteed forces
// a version bump. Single-sourced here; the generator imports it.
export const ENVELOPE_REQUIRED = ['v', 'id', 'ts', 'type', 'actor', 'lane', 'data'];

export const EVENT_SCHEMA = {
  FRAMEWORK_INSTALLED: { summary: "Máddu was installed into a repo for the first time.", data: { version: 'string', files: 'number' } },
  FRAMEWORK_UPGRADED: { summary: "An existing install was upgraded to a new framework version.", data: { from: 'string', to: 'string', updated: 'number', added: 'number', removed: 'number', skipped: 'number', warnings: 'array' } },
  FRAMEWORK_BOOTED: { summary: "The bridge server started and bound its port.", data: { host: 'string', pid: 'number', port: 'number', version: 'string', workspaceId: 'string' } },
  DOCTOR_REPORT: { summary: "A `maddu doctor` integrity run completed with per-check results.", data: { checks: 'array', counts: 'object' } },
  AUDIT_REPORT: { summary: "A `maddu audit` governance run completed with per-check results.", data: { checks: 'array', counts: 'object', scope: 'string' } },
  SESSION_REGISTERED: { summary: "An agent session was registered (explicitly or by a hook).", data: { focus: 'string|null', label: 'string|null', role: 'string|null', runtime: 'string|null' } },
  SESSION_HEARTBEAT: { summary: "A live session reported it is still active.", data: { focus: 'string|null' } },
  SESSION_CLOSED: { summary: "A session ended, optionally leaving a handoff note.", data: { handoff: 'object|null' } },
  LANE_CLAIMED: { summary: "A session took exclusive ownership of a lane.", data: { focus: 'string|null' } },
  LANE_RELEASED: { summary: "A session released its claim on a lane.", data: {} },
  LANE_ADDED: { summary: "A lane was added to the catalog.", data: { lane: 'object' } },
  LANE_REMOVED: { summary: "A lane was removed from the catalog.", data: { ok: 'boolean' } },
  LANE_DEFAULTS_SET: { summary: "Default lane assignments were configured.", data: { defaults: 'object' } },
  LANE_POLICY_SET: { summary: "A per-lane governance policy was set.", data: { policy: 'object' } },
  SLICE_STOP: { summary: "A slice boundary was recorded with its summary, deliverables, and next step.", data: { action: 'string|null', gates: 'array', learnings: 'array', next: 'array', paths: 'array', reason: 'string|null', summary: 'string', targets: 'array', risk: 'object|null', deliverables: 'object|null' } },
  INBOX_MESSAGE: { summary: "A message was written to a session inbox.", data: { kind: 'string', message: 'string', reason: 'string', scheduleId: 'string', scope: 'string', text: 'string', to: 'string' } },
  APPROVAL_REQUESTED: { summary: "An action was submitted for operator approval.", data: { action: 'string|null', payload: 'object|null', summary: 'string|null', tool: 'string' } },
  APPROVAL_DECIDED: { summary: "A pending approval was approved or denied.", data: { approvalId: 'string', decision: 'string', reason: 'string|null', tool: 'string|null' } },
  APPROVAL_POLICY_SET: { summary: "A standing approval policy for a tool was set.", data: { decision: 'string', tool: 'string', lane: 'string|null' } },
  MAILBOX_SENT: { summary: "A mailbox message was sent between sessions.", data: { hasBody: 'boolean', messageId: 'string', subject: 'string' } },
  MAILBOX_READ: { summary: "A mailbox message was marked read.", data: { messageId: 'string' } },
  TASK_CREATED: { summary: "A task was created on the dependency-aware board.", data: { id: 'string', blockedBy: 'array', description: 'string', metadata: 'object', owner: 'string|null', status: 'string', tags: 'array', title: 'string' } },
  TASK_UPDATED: { summary: "A task's fields or status were updated.", data: { id: 'string', by: 'string' } },
  TASK_COMPLETED: { summary: "A task was marked complete.", data: { id: 'string' } },
  SKILL_CREATED: { summary: "A skill was authored and added to the gallery.", data: { title: 'string' } },
  SKILL_UPDATED: { summary: "An existing skill was edited.", data: {} },
  SKILL_DELETED: { summary: "A skill was removed from the gallery.", data: { id: 'string' } },
  SKILL_APPLIED: { summary: "A skill body was applied during a session.", data: { id: 'string', sessionId: 'string', title: 'string' } },
  WORKER_SPAWNED: { summary: "A sub-worker subprocess was launched.", data: { id: 'string', args: 'array', command: 'string|null', error: 'string|null', log: 'string', modelHint: 'string|null', pid: 'number|null', runtime: 'string', sessionId: 'string|null', stage: 'string|null', wrapper: 'string|null' } },
  WORKER_HEARTBEAT: { summary: "A running worker reported it is still alive.", data: { focus: 'string|null', id: 'string' } },
  WORKER_EXITED: { summary: "A worker subprocess exited on its own.", data: { id: 'string', exitCode: 'number', reason: 'string', runtime: 'string', sessionId: 'string|null' } },
  WORKER_KILLED: { summary: "A worker subprocess was killed.", data: { id: 'string', reason: 'string|null' } },
  RUNTIME_REGISTERED: { summary: "A runtime adapter was registered.", data: { binary: 'string', displayName: 'string', name: 'string', version: 'string|null' } },
  RUNTIME_DETECTED: { summary: "A runtime binary was auto-detected on the host.", data: { exitCode: 'number', name: 'string', ok: 'boolean', version: 'string|null' } },
  RUNTIME_REMOVED: { summary: "A runtime adapter was removed.", data: { name: 'string' } },
  MCP_REGISTERED: { summary: "An MCP server template was registered.", data: { enabled: 'boolean', name: 'string', transport: 'string' } },
  MCP_ENABLED: { summary: "An MCP server was enabled.", data: { name: 'string' } },
  MCP_DISABLED: { summary: "An MCP server was disabled.", data: { name: 'string' } },
  MCP_TESTED: { summary: "An MCP server connectivity test ran.", data: { error: 'string|null', name: 'string', ok: 'boolean', transport: 'string' } },
  MCP_REMOVED: { summary: "An MCP server registration was removed.", data: { name: 'string' } },
  SCHEDULE_CREATED: { summary: "A recurring schedule (cron) was created.", data: { id: 'string', title: 'string', cron: 'string', natural: 'string|null', enabled: 'boolean' } },
  SCHEDULE_UPDATED: { summary: "A schedule's definition or enabled state changed.", data: { id: 'string', title: 'string', cron: 'string', natural: 'string|null', enabled: 'boolean' } },
  SCHEDULE_REMOVED: { summary: "A schedule was removed.", data: { id: 'string' } },
  SCHEDULE_FIRED: { summary: "A schedule reached its trigger time and fired.", data: { id: 'string', title: 'string', cron: 'string', action: 'object', fireCount: 'number' } },
  CHECKPOINT_CREATED: { summary: "A git-backed checkpoint was recorded.", data: { id: 'string', commit: 'string', tag: 'string', title: 'string', triggered_by: 'object|null' } },
  CHECKPOINT_REMOVED: { summary: "A checkpoint was removed.", data: { id: 'string' } },
  CHECKPOINT_WORKTREE_CREATED: { summary: "A worktree was materialized for a checkpoint.", data: { id: 'string', path: 'string' } },
  CHECKPOINT_ROLLBACK_REQUESTED: { summary: "A rollback to a checkpoint was requested.", data: { id: 'string', applied: 'boolean', mode: 'string' } },
  AUTH_KEY_ADDED: { summary: "An API key was added to the keyring.", data: { keyId: 'string', label: 'string', provider: 'string', replaced: 'boolean', tail: 'string' } },
  AUTH_KEY_REMOVED: { summary: "An API key was removed from the keyring.", data: { keyId: 'string', provider: 'string' } },
  AUTH_KEY_ROTATED: { summary: "An API key was rotated to a new value.", data: { from: 'string', provider: 'string', reason: 'string', to: 'string' } },
  AUTH_KEY_RATE_LIMITED: { summary: "An API key hit a provider rate limit and was benched.", data: { keyId: 'string', provider: 'string', until: 'string' } },
  IMPORT_ACCEPTED: { summary: "An external artifact passed the import gate and was accepted.", data: { id: 'string', kind: 'string', refId: 'string' } },
  IMPORT_REJECTED: { summary: "An external artifact was rejected by the import gate.", data: { id: 'string', error: 'string', hitCount: 'number', kind: 'string', patterns: 'array', reason: 'string' } },
  PROPOSAL_CREATED: { summary: "A governance proposal was raised for a boss decision.", data: { id: 'string', bossSessionId: 'string', action: 'string|null', actionPayload: 'object|null', summary: 'string|null', risk: 'string', preconditions: 'array', enforcer: 'object|null' } },
  PROPOSAL_DECIDED: { summary: "A governance proposal was decided.", data: { id: 'string', decision: 'string', reason: 'string|null' } },
  BOSS_MESSAGE: { summary: "A boss/enforcer message was posted in the governance channel.", data: { bossSessionId: 'string', citedRule: 'string|null', proposalId: 'string', reasonCode: 'string', role: 'string', text: 'string' } },
  TELEGRAM_ENABLED: { summary: "The Telegram comms bridge was enabled.", data: { tail: 'string' } },
  TELEGRAM_DISABLED: { summary: "The Telegram comms bridge was disabled.", data: {} },
  TELEGRAM_ALLOWLIST_SET: { summary: "The Telegram chat allowlist was set.", data: { chatIds: 'array', count: 'number' } },
  TELEGRAM_INBOUND: { summary: "An inbound Telegram update was received.", data: { chatId: 'string', hasText: 'boolean', length: 'number', updateId: 'number' } },
  TELEGRAM_OUTBOUND: { summary: "An outbound Telegram message was sent.", data: { chatId: 'string', length: 'number', messageId: 'string' } },
  TELEGRAM_OUTBOUND_FAILED: { summary: "An outbound Telegram message failed to send.", data: { chatId: 'string', error: 'string', reason: 'string' } },
  TELEGRAM_DROPPED: { summary: "An inbound Telegram update was dropped (not allowlisted).", data: { chatId: 'string', reason: 'string', updateId: 'number' } },
  DISCORD_ENABLED: { summary: "The Discord comms bridge was enabled.", data: { tail: 'string' } },
  DISCORD_DISABLED: { summary: "The Discord comms bridge was disabled.", data: {} },
  DISCORD_ALLOWLIST_SET: { summary: "The Discord channel allowlist was set.", data: { channelIds: 'array', count: 'number' } },
  DISCORD_OUTBOUND: { summary: "An outbound Discord message was sent.", data: { channelId: 'string', length: 'number', messageId: 'string' } },
  DISCORD_OUTBOUND_FAILED: { summary: "An outbound Discord message failed to send.", data: { channelId: 'string', error: 'string', reason: 'string', status: 'string' } },
  EMAIL_ENABLED: { summary: "The email comms bridge was enabled.", data: {} },
  EMAIL_DISABLED: { summary: "The email comms bridge was disabled.", data: {} },
  EMAIL_CONFIG_SET: { summary: "The email (SMTP) configuration was set.", data: { from: 'string', host: 'string', port: 'number', user: 'string' } },
  EMAIL_ALLOWLIST_SET: { summary: "The email recipient allowlist was set.", data: { count: 'number', recipients: 'array' } },
  EMAIL_SENT: { summary: "An email was sent.", data: { length: 'number', to: 'string' } },
  EMAIL_OUTBOUND_FAILED: { summary: "An outbound email failed to send.", data: { error: 'string', reason: 'string', to: 'string' } },
  FOLLOWUP_OPENED: { summary: "A follow-up was opened from a slice review finding.", data: { draftScope: 'array', fromReviewEventId: 'string', severity: 'string' } },
  GATE_RAN: { summary: "A verification gate ran and recorded its verdict.", data: { durationMs: 'number', evidence: 'object|null', gateId: 'string', ok: 'boolean', severity: 'string', sliceId: 'string', status: 'string' } },
  GOAL_DECLARED: { summary: "A goal with success conditions and constraints was declared.", data: { constraints: 'array', objective: 'string', success: 'array' } },
  GOAL_COMPLETED: { summary: "A declared goal was marked done or abandoned, closing the goal lifecycle.", data: { note: 'string|null', objective: 'string|null', outcome: 'string' } },
  PENDING_ACTION_DRAINED: { summary: "A queued pending action was drained (executed or resolved).", data: { actionId: 'string', detail: 'string', kind: 'string', outcome: 'string', payload: 'object' } },
  PENDING_ACTION_ENQUEUED: { summary: "An action was enqueued for later draining.", data: { actionId: 'string', kind: 'string', payload: 'object' } },
  PHASE_DECLARED: { summary: "A plan phase was entered, optionally raising the governance tier.", data: { name: 'string', notes: 'string|null', tier: 'string|null' } },
  PHASE_CLEARED: { summary: "A plan phase was explicitly exited.", data: { name: 'string|null' } },
  SLICE_FUNCTIONAL_APPROVED: { summary: "A slice's functional deliverable was approved.", data: { sliceId: 'string' } },
  SLICE_REVIEWED: { summary: "A slice review completed with a verdict and findings.", data: { findingsCount: 'number', reviewPath: 'string', reviewerRuntime: 'string', sliceEventId: 'string', verdict: 'string' } },
  SLICE_SCOPE_DECLARED: { summary: "A slice locked its intended file scope.", data: { expansionBound: 'object', lockedScopeHash: 'string', scope: 'array', sliceId: 'string' } },
  SLICE_SCOPE_EXPANDED: { summary: "A slice's locked scope was expanded with a reason.", data: { addedPaths: 'array', newHash: 'string', reason: 'string', sliceId: 'string' } },
  SOURCE_HASH_RECOMPUTED: { summary: "Source-file hashes were recomputed for drift tracking.", data: { count: 'number', paths: 'array' } },
  TRIGGER_FIRED: { summary: "A registered trigger fired and dispatched its target.", data: { cooldownMs: 'number', depsHash: 'string', escalated: 'boolean', planId: 'string', reason: 'string', risk: 'string|null', sliceEventId: 'string', sourceEventId: 'string|null', tag: 'string', target: 'string', triggerId: 'string', verdict: 'string', triggered_by: 'object|null' } },
  AGENT_FILE_SYNCED: { summary: "Agent instruction files were synced.", data: { action: 'string', files: 'array', perFile: 'object' } },
  SESSION_AUTO_CLOSED: { summary: "A stale session was auto-closed by the janitor.", data: { ageMs: 'number', lastHeartbeatAt: 'string', reason: 'string', sessionId: 'string' } },
  SESSION_AUTO_REGISTERED: { summary: "A session was auto-registered by a SessionStart hook.", data: { label: 'string', parentSessionId: 'string|null', role: 'string', runtime: 'string', sessionId: 'string', source: 'string' } },
  SESSION_STALE_DETECTED: { summary: "A session was detected as stale (missed heartbeats).", data: { ageMs: 'number', lastHeartbeatAt: 'string', sessionId: 'string' } },
  COMPACTION_CHECKPOINT: { summary: "A pre-compaction checkpoint captured record currency before context compaction.", data: { trigger: 'string|null', claudeSessionId: 'string|null', lastSliceStop: 'object|null', handoffSetAt: 'string|null', openApprovals: 'number', activeClaims: 'number' } },
  VENDOR_MEMORY_IMPORTED: { summary: "A fact was imported from a vendor tool's own memory store.", data: { dir: 'string', fact: 'object', factId: 'string', file: 'string' } },
  SLASH_COMMANDS_SYNCED: { summary: "Slash-command definitions were synced to the runtime.", data: { action: 'string', files: 'array', perFile: 'object', reason: 'string|null' } },
  TEAM_OPENED: { summary: "A team was opened with allocated lanes and members.", data: { label: 'string', lanes: 'array', members: 'number', parentSessionId: 'string|null', teamId: 'string' } },
  TEAM_LANE_ALLOCATED: { summary: "A lane was allocated to a team.", data: { teamId: 'string', lane: 'string|null' } },
  TEAM_MEMBER_JOINED: { summary: "A member session joined a team.", data: { sessionId: 'string', teamId: 'string', lane: 'string|null' } },
  TEAM_MEMBER_LEFT: { summary: "A member session left a team.", data: { error: 'string|null', exitCode: 'number', sessionId: 'string', teamId: 'string', workerId: 'string|null', lane: 'string|null' } },
  TEAM_CLOSED: { summary: "A team was closed.", data: { openMembers: 'array', teamId: 'string' } },
  PIPELINE_STARTED: { summary: "A multi-stage pipeline run started.", data: { goal: 'string|null', name: 'string', pipelineRunId: 'string' } },
  PIPELINE_STAGE_ENTERED: { summary: "A pipeline run entered a stage.", data: { intent: 'string|null', pipelineRunId: 'string', stage: 'string' } },
  PIPELINE_STAGE_EXITED: { summary: "A pipeline run exited a stage with a status.", data: { pipelineRunId: 'string', stage: 'string', status: 'string' } },
  PIPELINE_COMPLETED: { summary: "A pipeline run completed all stages.", data: { name: 'string', pipelineRunId: 'string' } },
  PIPELINE_HALTED: { summary: "A pipeline run halted before completion.", data: { pipelineRunId: 'string', reason: 'string' } },
  ADVISOR_INVOKED: { summary: "An advisor (external CLI) was invoked in a subprocess.", data: { advisorId: 'string', authProvider: 'string', binary: 'string', kind: 'string', parentSessionId: 'string|null', prompt: 'string', runtime: 'string', timeoutSec: 'number' } },
  ADVISOR_ARTIFACT_WRITTEN: { summary: "An advisor wrote its result artifact.", data: { advisorId: 'string', artifactPath: 'string', exitCode: 'number|null', status: 'string' } },
  TOKEN_USAGE_REPORTED: { summary: "Token usage for a session/model was reported to the ledger.", data: { cacheCreation: 'number|null', cacheRead: 'number|null', importHash: 'string', inputTokens: 'number|null', model: 'string|null', outputTokens: 'number|null', runtime: 'string|null', sessionId: 'string|null', source: 'string', ts: 'string', unreportedTokens: 'boolean' } },
  SKILL_INJECTED: { summary: "Skill bodies were auto-injected into an orientation digest.", data: { sessionId: 'string|null', skillIds: 'array', tags: 'array', totalBytes: 'number', triggers: 'array' } },
  SKILL_INJECTION_REFUSED: { summary: "A matching skill was withheld from injection for untrusted provenance.", data: { reason: 'string', refused: 'array', sessionId: 'string|null' } },
  TOOL_INVOKED: { summary: "A default framework tool invocation started.", data: { argv: 'array', mode: 'string', sessionId: 'string|null', tool: 'string', lane: 'string|null' } },
  TOOL_COMPLETED: { summary: "A default framework tool invocation exited.", data: { argv: 'array', durationMs: 'number', exitCode: 'number|null', sessionId: 'string|null', tool: 'string', lane: 'string|null' } },
  TOOL_REFUSED: { summary: "A tool invocation was refused (allowlist or dangerous form).", data: { argv: 'array', argv_index: 'number', detail: 'string', pattern_type: 'string', reason: 'string', sessionId: 'string|null', source: 'string', tool: 'string', lane: 'string|null' } },
  GOVERNANCE_MODE_CHANGED: { summary: "The workspace governance tier changed.", data: { by: 'string|null', from: 'string', reason: 'string|null', to: 'string' } },
  GOVERNANCE_OVERRIDE_CHANGED: { summary: "A governance behavior-override key was changed or cleared (recorded write-ahead so the discipline off-switch is always on the record).", data: { by: 'string|null', from: 'string|null', key: 'string', reason: 'string|null', to: 'string|null' } },
  PLAN_CREATED: { summary: "A persisted plan was created.", data: { goal: 'string|null', intent: 'string', name: 'string', phases: 'array', planId: 'string', title: 'string' } },
  PLAN_PHASE_ADDED: { summary: "A phase was added to a plan.", data: { at: 'string', intent: 'string', name: 'string', planId: 'string' } },
  PLAN_PHASE_COMPLETED: { summary: "A plan phase was completed.", data: { name: 'string', planId: 'string', summary: 'string|null' } },
  PLAN_PHASE_BLOCKED: { summary: "A plan phase was blocked with a reason.", data: { name: 'string', planId: 'string', reason: 'string' } },
  PLAN_REVISED: { summary: "A plan was revised (phases added/removed/modified).", data: { planId: 'string', by: 'string|null', diff: 'object' } },
  PLAN_COMPLETED: { summary: "A plan was completed.", data: { planId: 'string' } },
  PLAN_CANCELLED: { summary: "A plan was cancelled.", data: { planId: 'string', reason: 'string|null' } },
  LOOP_STARTED: { summary: "A loop (ralph or plan-loop) started.", data: { loopId: 'string', kind: 'string', goal: 'string', maxIter: 'number', cooldownMs: 'number' } },
  LOOP_ITERATION_STARTED: { summary: "A loop iteration started.", data: { loopId: 'string', kind: 'string', iter: 'number' } },
  LOOP_ITERATION_COMPLETED: { summary: "A loop iteration completed.", data: { loopId: 'string', kind: 'string', iter: 'number', ok: 'boolean', signature: 'string|null', summary: 'string|null' } },
  LOOP_HALTED: { summary: "A loop halted before its goal.", data: { loopId: 'string', kind: 'string|null', iter: 'number|null', reason: 'string', signature: 'string' } },
  LOOP_COMPLETED: { summary: "A loop completed its goal.", data: { loopId: 'string', kind: 'string', iter: 'number', summary: 'string|null' } },
  COORDINATOR_STARTED: { summary: "A coordinator primitive started driving a plan.", data: { coordinatorId: 'string', dryRun: 'boolean', planId: 'string', runtime: 'string|null' } },
  COORDINATOR_PHASE_STARTED: { summary: "A coordinator entered a plan phase.", data: { coordinatorId: 'string', intent: 'string', phase: 'string', planId: 'string' } },
  COORDINATOR_PHASE_COMPLETED: { summary: "A coordinator completed a plan phase.", data: { coordinatorId: 'string', phase: 'string', planId: 'string' } },
  COORDINATOR_HALTED: { summary: "A coordinator halted.", data: { coordinatorId: 'string', detail: 'string', exitCode: 'number|null', phase: 'string', planId: 'string', reason: 'string', signature: 'string|null' } },
  COORDINATOR_COMPLETED: { summary: "A coordinator completed the plan.", data: { coordinatorId: 'string', phaseCount: 'number', planId: 'string' } },
  LANE_CLAIM_FORCED: { summary: "A lane claim was force-taken from a prior holder.", data: { by: 'string', focus: 'string|null', priorSessionId: 'string', reason: 'string|null', lane: 'string|null' } },
  SKILL_CANDIDATE_DETECTED: { summary: "A candidate skill pattern was detected.", data: { examples: 'array', hash: 'string', tags: 'array' } },
  SKILL_CANDIDATE_APPROVED: { summary: "A skill candidate was approved into the gallery.", data: { hash: 'string' } },
  SKILL_CANDIDATE_REJECTED: { summary: "A skill candidate was rejected.", data: { hash: 'string', reason: 'string' } },
  TRUST_AUDIT_RAN: { summary: "A supply-chain trust audit ran over dependencies.", data: { audited: 'number', blockDays: 'number', cacheHit: 'boolean', cacheHits: 'number', cacheMisses: 'number', cveTotal: 'number|null', depsHash: 'string', fails: 'number', freshDays: 'number', violations: 'number', warns: 'number', triggered_by: 'object|null' } },
  TRUST_PIN_ADDED: { summary: "A dependency version/hash pin was added.", data: { name: 'string', sha256: 'string', version: 'string' } },
  TRUST_PIN_REMOVED: { summary: "A dependency pin was removed.", data: { name: 'string' } },
  TRUST_VIOLATION_DETECTED: { summary: "A supply-chain trust violation was detected.", data: { actual: 'string|null', detail: 'string|null', expected: 'string|null', kind: 'string', pkg: 'string', triggered_by: 'object|null' } },
  MCP_PROVENANCE_VERIFIED: { summary: "An MCP template's provenance hash verified.", data: { sha256: 'string', template: 'string' } },
  MCP_PROVENANCE_MISMATCH: { summary: "An MCP template's provenance hash did not match.", data: { actual: 'string', detail: 'string', expected: 'string', template: 'string' } },
  MCP_APPROVAL_GRANTED: { summary: "An MCP server was approved for use.", data: { by: 'string', name: 'string' } },
  WORKER_ENV_FILTERED: { summary: "A worker's environment was filtered against an allowlist.", data: { KEYS_ONLY: 'string', allowed: 'string', allowedCount: 'number', denied: 'array', deniedSecretCount: 'number', runtime: 'string', workerId: 'string' } },
  SECRET_DETECTED_IN_ARGV: { summary: "A secret-shaped value was detected in tool argv.", data: { tool: 'string', pattern_type: 'string', argv_index: 'number', sessionId: 'string|null', lane: 'string|null', override: 'string|null' } },
  SKILL_IMPORTED: { summary: "A skill was imported from an external source.", data: { source: 'string', sha256: 'string', trusted: 'boolean', dest: 'string' } },
  SKILL_TRUSTED: { summary: "An imported skill was marked trusted.", data: { id: 'string' } },
  HANDOFF_SET: { summary: "A cross-session handoff narrative was set.", data: { auto: 'boolean', body: 'string', by: 'string|null', sliceEventId: 'string', triggered_by: 'object|null' } },
  LEARN_MINED: { summary: "Transcripts were mined for failed→succeeded correction pairs.", data: { candidates: 'number', mined: 'number', paired: 'number', since: 'string|null', slug: 'string|null' } },
  LEARN_DIGEST_WRITTEN: { summary: "A no-provider learning digest was written.", data: { candidates: 'number', digestPath: 'string' } },
  LEARN_JUDGED: { summary: "A correction candidate was judged by a worker.", data: { candidateId: 'string', category: 'string', destination: 'string', verdict: 'string', workerId: 'string' } },
  LEARN_CORRECTION_WRITTEN: { summary: "A typed correction was written to an agent file or memory.", data: { agent: 'string', category: 'string', correctionId: 'string', destination: 'string', file: 'string', memory: 'string', target: 'string' } },
  MEMORY_FACT_SUPERSEDED: { summary: "A memory fact was superseded by a newer fact.", data: { fact: 'object', factId: 'string', kind: 'string', reason: 'string', supersedes: 'string' } },
  BRIEFING_CURATED: { summary: "A curated orient/handoff briefing persisted its original for retrieval.", data: { briefingId: 'string', dropped: 'string', handoff: 'object', kind: 'string', orient: 'string', originalRef: 'string' } },
  BRIDGE_ORIGIN_REJECTED: { summary: "The bridge rejected a request with a non-loopback Host/Origin.", data: { host: 'string|null', method: 'string', origin: 'string|null', path: 'string', reason: 'string' } },
  BRIDGE_CROSS_WORKSPACE: { summary: "A bridge request selected a workspace other than the active one.", data: { active: 'string', method: 'string', path: 'string', workspace: 'string' } },
  SPINE_CUTOVER: { summary: "A chain-local tamper-detection cutover anchor (seeded into a freshly-minted sync partition so verify holds it to the post-cutover strict rules).", data: { version: 'string' } },
  DISCIPLINE_SKIPPED: { summary: "A mutating tool was let through without a discipline check (enforcement off, a self-disable attempt, or the enforcement hook uninstalled) — a witness so a bypass is never silent.", data: { blocked: 'boolean?', enforcement: 'string|null', reason: 'string', sessionId: 'string|null', tool: 'string|null' } },
  ENFORCEMENT_ERROR: { summary: "The self-discipline enforcement path threw and fell open — recorded so a persistent enforcement bug can't hide behind a silent fail-open.", data: { reason: 'string', sessionId: 'string|null', tool: 'string|null' } },
  BLUEPRINT_DISTILLED: { summary: "A blueprint skeleton was distilled into prose by a provider CLI.", data: { distilledBytes: 'number', outPath: 'string', provider: 'string', runtime: 'string', skeletonBytes: 'number', slug: 'string' } },
  DEBT_SCANNED: { summary: "The source tree was scanned for deliberate-shortcut debt markers.", data: { files: 'number', ledgerPath: 'string|null', markers: 'number', noTrigger: 'number' } },
  ARCHITECTURE_SCANNED: { summary: "The declared architecture contract was checked against the import graph.", data: { blocking: 'boolean', cycles: 'number', driftScore: 'number', edges: 'number', failOn: 'string', forbidden: 'number', modules: 'number', newViolations: 'number', uncovered: 'number', undeclared: 'number' } },
  FOCUS_TAGGED: { summary: "A per-turn drift trajectory tag was recorded vs the declared goal.", data: { away: 'string', distanceScore: 'number', goalSetAt: 'string|null', lateral: 'string', signals: 'object', sourceEventId: 'string|null', tag: 'string', toward: 'string', triggered_by: 'object|null' } },
  DRIFT_FLAGGED: { summary: "Sustained un-returned drift raised a swap/revert/continue flag.", data: { cleared: 'boolean', continue: 'string', deterministic: 'boolean', enriched: 'boolean', menu: 'array', reason: 'string', revert: 'string', runs: 'number', swap: 'string', workerId: 'string', triggered_by: 'object|null' } },
  AUTONOMY_SCORED: { summary: "Per-lane earned-autonomy trust scores were computed over the record.", data: { schemaVersion: 'number', asOf: 'string|null', attribution: 'string', configHash: 'string', totalSlices: 'number', lanes: 'array' }, frozen: true },
  AUTONOMY_RECOMMENDATION: { summary: "An autonomy rung change was recommended (recommend-only).", data: { schemaVersion: 'number', asOf: 'string|null', lane: 'string', fromRung: 'string', toRung: 'string', wilson: 'number', n: 'number', coverage: 'number', recommendation: 'string', muted: 'boolean', mutedReason: 'string|null', configHash: 'string' }, frozen: true },
  WORKTREE_ATTACHED: { summary: "A worktree checkout was attached to a lane claim.", data: { schemaVersion: 'number', attachmentId: 'string', claimEventId: 'string|null', lane: 'string', session: 'string', pathRepoRel: 'string', pathAbs: 'string', branchRef: 'string', baseRef: 'string|null', baseHeadAtAttach: 'string', created: 'boolean', reused: 'boolean', dirty: 'boolean', gitCommonDir: 'string|null', platform: 'string' }, frozen: true },
  WORKTREE_DETACHED: { summary: "A worktree was detached from a lane claim with a disposition.", data: { schemaVersion: 'number', attachmentId: 'string', lane: 'string', pathRepoRel: 'string', disposition: 'string', branchHead: 'string|null', integrationRef: 'string|null', integrationHead: 'string|null', ancestorCheck: 'string', dirtyAtDetach: 'boolean', reason: 'string|null' }, frozen: true },
  // ── SLM-governance MODEL_ family (contract 1.1.0, plan pln_20260706133422_0f60) ──
  // Máddu records an SLM factory's manifests + lifecycle; it never trains,
  // serves, or evaluates. manifestPath/manifestHash are PINNED first-hand at
  // ingest (lib/model-manifests.mjs); every artifact hash inside a manifest is
  // the author's DECLARATION recorded verbatim. checkpointKey is the normalized
  // lowercase sha256:<hex> identity (design §4.5). MODEL_REGRESSION_ACKNOWLEDGED
  // and MODEL_PROMOTION_APPROVED are verb-emitted (no manifest of their own).
  MODEL_DATASET_SNAPSHOT_RECORDED: { summary: "A dataset-snapshot manifest was validated, hash-pinned, and recorded.", data: { schemaVersion: 'number', manifestPath: 'string', manifestHash: 'string', dataset_id: 'string', source: 'string', license: 'string', hash: 'string', synthetic: 'boolean' }, frozen: true },
  MODEL_TRAINING_RUN_STARTED: { summary: "An externally-run training run was recorded as started from its manifest.", data: { schemaVersion: 'number', manifestPath: 'string', manifestHash: 'string', run_id: 'string', model_id: 'string', method: 'string', dataset_snapshot: 'string', base_model: 'object', seed: 'number', commit: 'string' }, frozen: true },
  MODEL_TRAINING_RUN_COMPLETED: { summary: "A training run's completion (checkpoint + metrics) was recorded.", data: { schemaVersion: 'number', manifestPath: 'string', manifestHash: 'string', run_id: 'string', model_id: 'string', checkpoint: 'object', checkpointKey: 'string', metrics: 'object' }, frozen: true },
  MODEL_CHECKPOINT_REGISTERED: { summary: "A model checkpoint was registered under its sha256 identity key.", data: { schemaVersion: 'number', manifestPath: 'string', manifestHash: 'string', model_id: 'string', checkpoint: 'object', checkpointKey: 'string', run_id: 'string?' }, frozen: true },
  MODEL_EVAL_RAN: { summary: "An externally-run benchmark eval of a checkpoint was recorded.", data: { schemaVersion: 'number', manifestPath: 'string', manifestHash: 'string', eval_id: 'string', checkpointKey: 'string', benchmark: 'string', harness_version: 'string?', pass_rate: 'number', regressions: 'array?' }, frozen: true },
  MODEL_REGRESSION_FOUND: { summary: "An eval manifest declared a critical regression (one event per regression).", data: { schemaVersion: 'number', eval_id: 'string', checkpointKey: 'string', metric: 'string', delta: 'number', critical: 'boolean', vs: 'string?' }, frozen: true },
  MODEL_REGRESSION_ACKNOWLEDGED: { summary: "An operator acknowledged an eval's critical regressions with a recorded reason.", data: { schemaVersion: 'number', eval_id: 'string', reason: 'string' }, frozen: true },
  MODEL_PROMOTION_PROPOSED: { summary: "A stage promotion was proposed; its approval request rides the spine first.", data: { schemaVersion: 'number', manifestPath: 'string', manifestHash: 'string', model_id: 'string', checkpointKey: 'string', from_stage: 'string', to_stage: 'string', approvalRequestId: 'string' }, frozen: true },
  MODEL_PROMOTION_APPROVED: { summary: "A proposed promotion was confirmed against its own allowing approval decision.", data: { schemaVersion: 'number', proposalId: 'string', approval_ref: 'string', model_id: 'string', checkpointKey: 'string', to_stage: 'string' }, frozen: true },
  MODEL_RELEASED: { summary: "A checkpoint approved to released was recorded as released with a rollback plan.", data: { schemaVersion: 'number', manifestPath: 'string', manifestHash: 'string', model_id: 'string', checkpointKey: 'string', rollback_plan: 'string' }, frozen: true },
  MODEL_ROLLED_BACK: { summary: "A released checkpoint was rolled back to an earlier stage.", data: { schemaVersion: 'number', manifestPath: 'string', manifestHash: 'string', model_id: 'string', checkpointKey: 'string', reverted_to: 'string' }, frozen: true },
};

// Parity + shape validation used by the event-schema-complete gate and the
// generators. Returns { ok, missing, extra, badShape }.
export function validateSchema(eventTypeKeys, schema = EVENT_SCHEMA) {
  const known = new Set(eventTypeKeys);
  const defined = new Set(Object.keys(schema));
  const missing = eventTypeKeys.filter((k) => !defined.has(k));
  const extra = Object.keys(schema).filter((k) => !known.has(k));
  const badShape = [];
  const TYPE_RE = /^(string|number|boolean|object|array|any)(\|null)?\??$/;
  for (const [k, spec] of Object.entries(schema)) {
    if (!spec || typeof spec.summary !== 'string' || !spec.summary.trim()) { badShape.push(`${k}: missing summary`); continue; }
    if (!spec.data || typeof spec.data !== 'object') { badShape.push(`${k}: missing data spec`); continue; }
    for (const [f, ty] of Object.entries(spec.data)) {
      if (typeof ty !== 'string' || !TYPE_RE.test(ty)) badShape.push(`${k}.${f}: invalid type '${ty}'`);
    }
  }
  return { ok: missing.length === 0 && extra.length === 0 && badShape.length === 0, missing, extra, badShape };
}

// The canonical SHAPE of the contract — envelope + per-type frozen flag + data
// fields/types, all keys sorted, summaries excluded (wording is PATCH, not a
// shape change). This is what the baseline snapshots and what change
// classification diffs. Deterministic across platforms.
export function contractShape(schema = EVENT_SCHEMA, envelope = EVENT_ENVELOPE, envelopeRequired = ENVELOPE_REQUIRED) {
  const sortObj = (o) => Object.fromEntries(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
  const types = {};
  for (const t of Object.keys(schema).sort()) {
    types[t] = { frozen: !!schema[t].frozen, data: sortObj(schema[t].data) };
  }
  return { envelope: sortObj(envelope), envelopeRequired: [...envelopeRequired].sort(), types };
}

// A stable, dependency-free fingerprint of the contract shape (FNV-1a over the
// canonical JSON). Used for the cheap "did anything change" signal.
export function contractFingerprint(schema = EVENT_SCHEMA, envelope = EVENT_ENVELOPE) {
  const canon = JSON.stringify(contractShape(schema, envelope));
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Classify the change from a previous shape to the current one against the
// published semver rules:
//   'major' — a removed field/type, a changed field type, or a flipped frozen
//             flag (a consumer relying on the old shape breaks);
//   'minor' — only additions (new type, or new field on an existing type);
//   'none'  — identical shape.
// (PATCH — summary/wording — is invisible to the shape and needs no gate.)
export function classifyChange(prevShape, curShape) {
  if (!prevShape || !curShape) return 'major';
  const reasons = [];
  // Envelope
  diffFields('envelope', prevShape.envelope || {}, curShape.envelope || {}, reasons);
  // Envelope required-set — any change to which keys are guaranteed is breaking.
  const prevReq = (prevShape.envelopeRequired || []).join(','), curReq = (curShape.envelopeRequired || []).join(',');
  if (prevReq !== curReq) reasons.push({ level: 'major', why: `envelope required set changed: [${prevReq}] → [${curReq}]` });
  // Types
  const prevTypes = prevShape.types || {}, curTypes = curShape.types || {};
  for (const t of Object.keys(prevTypes)) {
    if (!curTypes[t]) { reasons.push({ level: 'major', why: `type removed: ${t}` }); continue; }
    if (prevTypes[t].frozen !== curTypes[t].frozen) reasons.push({ level: 'major', why: `frozen flag changed: ${t}` });
    diffFields(t, prevTypes[t].data || {}, curTypes[t].data || {}, reasons);
  }
  for (const t of Object.keys(curTypes)) {
    if (!prevTypes[t]) reasons.push({ level: 'minor', why: `type added: ${t}` });
  }
  const level = reasons.some((r) => r.level === 'major') ? 'major'
    : reasons.some((r) => r.level === 'minor') ? 'minor' : 'none';
  return { level, reasons };
}

function diffFields(scope, prev, cur, reasons) {
  for (const f of Object.keys(prev)) {
    if (!(f in cur)) reasons.push({ level: 'major', why: `${scope}.${f} removed` });
    else if (prev[f] !== cur[f]) reasons.push({ level: 'major', why: `${scope}.${f} type changed ${prev[f]}→${cur[f]}` });
  }
  for (const f of Object.keys(cur)) {
    if (!(f in prev)) reasons.push({ level: 'minor', why: `${scope}.${f} added` });
  }
}

function parseSemver(v) { const [a, b, c] = String(v || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0); return [a, b, c]; }
// The semver magnitude of the FORWARD bump from `from` to `to`: 'major' |
// 'minor' | 'patch' | 'none'. Directional — a downgrade or same version is
// 'none' (never satisfies a change's required bump), so you cannot "clear" a
// breaking change by lowering the version.
function bumpMagnitude(from, to) {
  const a = parseSemver(from), b = parseSemver(to);
  const cmp = (b[0] - a[0]) || (b[1] - a[1]) || (b[2] - a[2]);
  if (cmp <= 0) return 'none';
  if (b[0] !== a[0]) return 'major';
  if (b[1] !== a[1]) return 'minor';
  return 'patch';
}

// Version discipline against a committed baseline ({ version, shape } of the last
// published/released contract). The baseline is refreshed at release time
// (scripts/refresh-event-contract-baseline.mjs), so between releases the FIRST
// shape change is caught here. Non-circular AND semver-magnitude-aware:
//   ok when the shape is unchanged, OR the version was bumped by AT LEAST the
//   magnitude the change requires (a MAJOR change needs a major bump; a MINOR
//   change needs a minor-or-major bump). A silent or under-sized bump fails.
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };
export function versionDiscipline(baseline, schema = EVENT_SCHEMA, version = EVENT_CONTRACT_VERSION, envelope = EVENT_ENVELOPE) {
  const cur = contractShape(schema, envelope);
  const change = classifyChange(baseline?.shape, cur);
  const required = change.level;            // 'none' | 'minor' | 'major'
  const bump = bumpMagnitude(baseline?.version, version);
  const ok = required === 'none' || RANK[bump] >= RANK[required];
  return { ok, required, bump, change, version, baselineVersion: baseline?.version, fingerprint: contractFingerprint(schema, envelope) };
}
