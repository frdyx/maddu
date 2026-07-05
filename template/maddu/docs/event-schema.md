# Máddu spine event contract

<!-- GENERATED FILE — do not edit. Source: template/maddu/runtime/lib/event-schema.mjs.
     Regenerate: `node scripts/generate.mjs`. Policed by the `generated-artifacts-current` gate. -->

**Contract version:** `1.0.0` · **Event types:** 162

The spine is an append-only NDJSON event log. Every event shares one envelope;
each `type` constrains its `data` payload. Data fields are **typed when present**
and the payload is **open** — extra keys may appear and are additive-only within a
MAJOR. `frozen` shapes carry a `schemaVersion` discriminator and their listed
fields are guaranteed stable.

## Envelope

| Field | Type | Notes |
| --- | --- | --- |
| `v` | `number` | Envelope schema version. |
| `id` | `string` | `evt_<ts14>_<hex>`. |
| `ts` | `string` | ISO-8601 timestamp. |
| `type` | `string` | One of the event types below. |
| `actor` | `string\|null` | Session/worker id, or null. |
| `lane` | `string\|null` | Lane id, or null. |
| `prev_hash` | `string\|null` | Chain link to the prior line (absent pre-chain, null on genesis). |
| `triggered_by` | `object\|null` | Object provenance ({ kind, id, … }) or null. |
| `data` | `object` | Per-type payload — see below. |

## Semantic versioning

The contract version (`EVENT_CONTRACT_VERSION`) moves by:

- **MAJOR** — remove an event type or a listed field, or change a field's type.
- **MINOR** — add an event type, or add a listed field to an existing type.
- **PATCH** — summary/wording only; no shape change.

## Events (162)

| Event | Summary | Data fields |
| --- | --- | --- |
| `FRAMEWORK_INSTALLED` | Máddu was installed into a repo for the first time. | `version: string`, `files: number` |
| `FRAMEWORK_UPGRADED` | An existing install was upgraded to a new framework version. | `from: string`, `to: string`, `updated: number`, `added: number`, `removed: number`, `skipped: number`, `warnings: array` |
| `FRAMEWORK_BOOTED` | The bridge server started and bound its port. | `host: string`, `pid: number`, `port: number`, `version: string`, `workspaceId: string` |
| `DOCTOR_REPORT` | A `maddu doctor` integrity run completed with per-check results. | `checks: array`, `counts: object` |
| `AUDIT_REPORT` | A `maddu audit` governance run completed with per-check results. | `checks: array`, `counts: object`, `scope: string` |
| `SESSION_REGISTERED` | An agent session was registered (explicitly or by a hook). | `focus: string\|null`, `label: string\|null`, `role: string\|null`, `runtime: string\|null` |
| `SESSION_HEARTBEAT` | A live session reported it is still active. | `focus: string\|null` |
| `SESSION_CLOSED` | A session ended, optionally leaving a handoff note. | `handoff: object\|null` |
| `LANE_CLAIMED` | A session took exclusive ownership of a lane. | `focus: string\|null` |
| `LANE_RELEASED` | A session released its claim on a lane. | — |
| `LANE_ADDED` | A lane was added to the catalog. | `lane: object` |
| `LANE_REMOVED` | A lane was removed from the catalog. | `ok: boolean` |
| `LANE_DEFAULTS_SET` | Default lane assignments were configured. | `defaults: object` |
| `LANE_POLICY_SET` | A per-lane governance policy was set. | `policy: object` |
| `SLICE_STOP` | A slice boundary was recorded with its summary, deliverables, and next step. | `action: string\|null`, `gates: array`, `learnings: array`, `next: array`, `paths: array`, `reason: string\|null`, `summary: string`, `targets: array`, `risk: object\|null`, `deliverables: object\|null` |
| `INBOX_MESSAGE` | A message was written to a session inbox. | `kind: string`, `message: string`, `reason: string`, `scheduleId: string`, `scope: string`, `text: string`, `to: string` |
| `APPROVAL_REQUESTED` | An action was submitted for operator approval. | `action: string\|null`, `payload: object\|null`, `summary: string\|null`, `tool: string` |
| `APPROVAL_DECIDED` | A pending approval was approved or denied. | `approvalId: string`, `decision: string`, `reason: string\|null`, `tool: string\|null` |
| `APPROVAL_POLICY_SET` | A standing approval policy for a tool was set. | `decision: string`, `tool: string`, `lane: string\|null` |
| `MAILBOX_SENT` | A mailbox message was sent between sessions. | `hasBody: boolean`, `messageId: string`, `subject: string` |
| `MAILBOX_READ` | A mailbox message was marked read. | `messageId: string` |
| `TASK_CREATED` | A task was created on the dependency-aware board. | `id: string`, `blockedBy: array`, `description: string`, `metadata: object`, `owner: string\|null`, `status: string`, `tags: array`, `title: string` |
| `TASK_UPDATED` | A task's fields or status were updated. | `id: string`, `by: string` |
| `TASK_COMPLETED` | A task was marked complete. | `id: string` |
| `SKILL_CREATED` | A skill was authored and added to the gallery. | `title: string` |
| `SKILL_UPDATED` | An existing skill was edited. | — |
| `SKILL_DELETED` | A skill was removed from the gallery. | `id: string` |
| `SKILL_APPLIED` | A skill body was applied during a session. | `id: string`, `sessionId: string`, `title: string` |
| `WORKER_SPAWNED` | A sub-worker subprocess was launched. | `id: string`, `args: array`, `command: string\|null`, `error: string\|null`, `log: string`, `modelHint: string\|null`, `pid: number\|null`, `runtime: string`, `sessionId: string\|null`, `stage: string\|null`, `wrapper: string\|null` |
| `WORKER_HEARTBEAT` | A running worker reported it is still alive. | `focus: string\|null`, `id: string` |
| `WORKER_EXITED` | A worker subprocess exited on its own. | `id: string`, `exitCode: number`, `reason: string`, `runtime: string`, `sessionId: string\|null` |
| `WORKER_KILLED` | A worker subprocess was killed. | `id: string`, `reason: string\|null` |
| `RUNTIME_REGISTERED` | A runtime adapter was registered. | `binary: string`, `displayName: string`, `name: string`, `version: string\|null` |
| `RUNTIME_DETECTED` | A runtime binary was auto-detected on the host. | `exitCode: number`, `name: string`, `ok: boolean`, `version: string\|null` |
| `RUNTIME_REMOVED` | A runtime adapter was removed. | `name: string` |
| `MCP_REGISTERED` | An MCP server template was registered. | `enabled: boolean`, `name: string`, `transport: string` |
| `MCP_ENABLED` | An MCP server was enabled. | `name: string` |
| `MCP_DISABLED` | An MCP server was disabled. | `name: string` |
| `MCP_TESTED` | An MCP server connectivity test ran. | `error: string\|null`, `name: string`, `ok: boolean`, `transport: string` |
| `MCP_REMOVED` | An MCP server registration was removed. | `name: string` |
| `SCHEDULE_CREATED` | A recurring schedule (cron) was created. | `id: string`, `title: string`, `cron: string`, `natural: string\|null`, `enabled: boolean` |
| `SCHEDULE_UPDATED` | A schedule's definition or enabled state changed. | `id: string`, `title: string`, `cron: string`, `natural: string\|null`, `enabled: boolean` |
| `SCHEDULE_REMOVED` | A schedule was removed. | `id: string` |
| `SCHEDULE_FIRED` | A schedule reached its trigger time and fired. | `id: string`, `title: string`, `cron: string`, `action: object`, `fireCount: number` |
| `CHECKPOINT_CREATED` | A git-backed checkpoint was recorded. | `id: string`, `commit: string`, `tag: string`, `title: string`, `triggered_by: object\|null` |
| `CHECKPOINT_REMOVED` | A checkpoint was removed. | `id: string` |
| `CHECKPOINT_WORKTREE_CREATED` | A worktree was materialized for a checkpoint. | `id: string`, `path: string` |
| `CHECKPOINT_ROLLBACK_REQUESTED` | A rollback to a checkpoint was requested. | `id: string`, `applied: boolean`, `mode: string` |
| `AUTH_KEY_ADDED` | An API key was added to the keyring. | `keyId: string`, `label: string`, `provider: string`, `replaced: boolean`, `tail: string` |
| `AUTH_KEY_REMOVED` | An API key was removed from the keyring. | `keyId: string`, `provider: string` |
| `AUTH_KEY_ROTATED` | An API key was rotated to a new value. | `from: string`, `provider: string`, `reason: string`, `to: string` |
| `AUTH_KEY_RATE_LIMITED` | An API key hit a provider rate limit and was benched. | `keyId: string`, `provider: string`, `until: string` |
| `IMPORT_ACCEPTED` | An external artifact passed the import gate and was accepted. | `id: string`, `kind: string`, `refId: string` |
| `IMPORT_REJECTED` | An external artifact was rejected by the import gate. | `id: string`, `error: string`, `hitCount: number`, `kind: string`, `patterns: array`, `reason: string` |
| `PROPOSAL_CREATED` | A governance proposal was raised for a boss decision. | `id: string`, `bossSessionId: string`, `action: string\|null`, `actionPayload: object\|null`, `summary: string\|null`, `risk: string`, `preconditions: array`, `enforcer: object\|null` |
| `PROPOSAL_DECIDED` | A governance proposal was decided. | `id: string`, `decision: string`, `reason: string\|null` |
| `BOSS_MESSAGE` | A boss/enforcer message was posted in the governance channel. | `bossSessionId: string`, `citedRule: string\|null`, `proposalId: string`, `reasonCode: string`, `role: string`, `text: string` |
| `TELEGRAM_ENABLED` | The Telegram comms bridge was enabled. | `tail: string` |
| `TELEGRAM_DISABLED` | The Telegram comms bridge was disabled. | — |
| `TELEGRAM_ALLOWLIST_SET` | The Telegram chat allowlist was set. | `chatIds: array`, `count: number` |
| `TELEGRAM_INBOUND` | An inbound Telegram update was received. | `chatId: string`, `hasText: boolean`, `length: number`, `updateId: number` |
| `TELEGRAM_OUTBOUND` | An outbound Telegram message was sent. | `chatId: string`, `length: number`, `messageId: string` |
| `TELEGRAM_OUTBOUND_FAILED` | An outbound Telegram message failed to send. | `chatId: string`, `error: string`, `reason: string` |
| `TELEGRAM_DROPPED` | An inbound Telegram update was dropped (not allowlisted). | `chatId: string`, `reason: string`, `updateId: number` |
| `DISCORD_ENABLED` | The Discord comms bridge was enabled. | `tail: string` |
| `DISCORD_DISABLED` | The Discord comms bridge was disabled. | — |
| `DISCORD_ALLOWLIST_SET` | The Discord channel allowlist was set. | `channelIds: array`, `count: number` |
| `DISCORD_OUTBOUND` | An outbound Discord message was sent. | `channelId: string`, `length: number`, `messageId: string` |
| `DISCORD_OUTBOUND_FAILED` | An outbound Discord message failed to send. | `channelId: string`, `error: string`, `reason: string`, `status: string` |
| `EMAIL_ENABLED` | The email comms bridge was enabled. | — |
| `EMAIL_DISABLED` | The email comms bridge was disabled. | — |
| `EMAIL_CONFIG_SET` | The email (SMTP) configuration was set. | `from: string`, `host: string`, `port: number`, `user: string` |
| `EMAIL_ALLOWLIST_SET` | The email recipient allowlist was set. | `count: number`, `recipients: array` |
| `EMAIL_SENT` | An email was sent. | `length: number`, `to: string` |
| `EMAIL_OUTBOUND_FAILED` | An outbound email failed to send. | `error: string`, `reason: string`, `to: string` |
| `FOLLOWUP_OPENED` | A follow-up was opened from a slice review finding. | `draftScope: array`, `fromReviewEventId: string`, `severity: string` |
| `GATE_RAN` | A verification gate ran and recorded its verdict. | `durationMs: number`, `evidence: object\|null`, `gateId: string`, `ok: boolean`, `severity: string`, `sliceId: string`, `status: string` |
| `GOAL_DECLARED` | A goal with success conditions and constraints was declared. | `constraints: array`, `objective: string`, `success: array` |
| `PENDING_ACTION_DRAINED` | A queued pending action was drained (executed or resolved). | `actionId: string`, `detail: string`, `kind: string`, `outcome: string`, `payload: object` |
| `PENDING_ACTION_ENQUEUED` | An action was enqueued for later draining. | `actionId: string`, `kind: string`, `payload: object` |
| `PHASE_DECLARED` | A plan phase was entered, optionally raising the governance tier. | `name: string`, `notes: string\|null`, `tier: string\|null` |
| `PHASE_CLEARED` | A plan phase was explicitly exited. | `name: string\|null` |
| `SLICE_FUNCTIONAL_APPROVED` | A slice's functional deliverable was approved. | `sliceId: string` |
| `SLICE_REVIEWED` | A slice review completed with a verdict and findings. | `findingsCount: number`, `reviewPath: string`, `reviewerRuntime: string`, `sliceEventId: string`, `verdict: string` |
| `SLICE_SCOPE_DECLARED` | A slice locked its intended file scope. | `expansionBound: object`, `lockedScopeHash: string`, `scope: array`, `sliceId: string` |
| `SLICE_SCOPE_EXPANDED` | A slice's locked scope was expanded with a reason. | `addedPaths: array`, `newHash: string`, `reason: string`, `sliceId: string` |
| `SOURCE_HASH_RECOMPUTED` | Source-file hashes were recomputed for drift tracking. | `count: number`, `paths: array` |
| `TRIGGER_FIRED` | A registered trigger fired and dispatched its target. | `cooldownMs: number`, `depsHash: string`, `escalated: boolean`, `planId: string`, `reason: string`, `risk: string\|null`, `sliceEventId: string`, `sourceEventId: string\|null`, `tag: string`, `target: string`, `triggerId: string`, `verdict: string`, `triggered_by: object\|null` |
| `AGENT_FILE_SYNCED` | Agent instruction files were synced. | `action: string`, `files: array`, `perFile: object` |
| `SESSION_AUTO_CLOSED` | A stale session was auto-closed by the janitor. | `ageMs: number`, `lastHeartbeatAt: string`, `reason: string`, `sessionId: string` |
| `SESSION_AUTO_REGISTERED` | A session was auto-registered by a SessionStart hook. | `label: string`, `parentSessionId: string\|null`, `role: string`, `runtime: string`, `sessionId: string`, `source: string` |
| `SESSION_STALE_DETECTED` | A session was detected as stale (missed heartbeats). | `ageMs: number`, `lastHeartbeatAt: string`, `sessionId: string` |
| `COMPACTION_CHECKPOINT` | A pre-compaction checkpoint captured record currency before context compaction. | `trigger: string\|null`, `claudeSessionId: string\|null`, `lastSliceStop: object\|null`, `handoffSetAt: string\|null`, `openApprovals: number`, `activeClaims: number` |
| `VENDOR_MEMORY_IMPORTED` | A fact was imported from a vendor tool's own memory store. | `dir: string`, `fact: object`, `factId: string`, `file: string` |
| `SLASH_COMMANDS_SYNCED` | Slash-command definitions were synced to the runtime. | `action: string`, `files: array`, `perFile: object`, `reason: string\|null` |
| `TEAM_OPENED` | A team was opened with allocated lanes and members. | `label: string`, `lanes: array`, `members: number`, `parentSessionId: string\|null`, `teamId: string` |
| `TEAM_LANE_ALLOCATED` | A lane was allocated to a team. | `teamId: string`, `lane: string\|null` |
| `TEAM_MEMBER_JOINED` | A member session joined a team. | `sessionId: string`, `teamId: string`, `lane: string\|null` |
| `TEAM_MEMBER_LEFT` | A member session left a team. | `error: string\|null`, `exitCode: number`, `sessionId: string`, `teamId: string`, `workerId: string\|null`, `lane: string\|null` |
| `TEAM_CLOSED` | A team was closed. | `openMembers: array`, `teamId: string` |
| `PIPELINE_STARTED` | A multi-stage pipeline run started. | `goal: string\|null`, `name: string`, `pipelineRunId: string` |
| `PIPELINE_STAGE_ENTERED` | A pipeline run entered a stage. | `intent: string\|null`, `pipelineRunId: string`, `stage: string` |
| `PIPELINE_STAGE_EXITED` | A pipeline run exited a stage with a status. | `pipelineRunId: string`, `stage: string`, `status: string` |
| `PIPELINE_COMPLETED` | A pipeline run completed all stages. | `name: string`, `pipelineRunId: string` |
| `PIPELINE_HALTED` | A pipeline run halted before completion. | `pipelineRunId: string`, `reason: string` |
| `ADVISOR_INVOKED` | An advisor (external CLI) was invoked in a subprocess. | `advisorId: string`, `authProvider: string`, `binary: string`, `kind: string`, `parentSessionId: string\|null`, `prompt: string`, `runtime: string`, `timeoutSec: number` |
| `ADVISOR_ARTIFACT_WRITTEN` | An advisor wrote its result artifact. | `advisorId: string`, `artifactPath: string`, `exitCode: number\|null`, `status: string` |
| `TOKEN_USAGE_REPORTED` | Token usage for a session/model was reported to the ledger. | `cacheCreation: number\|null`, `cacheRead: number\|null`, `importHash: string`, `inputTokens: number\|null`, `model: string\|null`, `outputTokens: number\|null`, `runtime: string\|null`, `sessionId: string\|null`, `source: string`, `ts: string`, `unreportedTokens: boolean` |
| `SKILL_INJECTED` | Skill bodies were auto-injected into an orientation digest. | `sessionId: string\|null`, `skillIds: array`, `tags: array`, `totalBytes: number`, `triggers: array` |
| `TOOL_INVOKED` | A default framework tool invocation started. | `argv: array`, `mode: string`, `sessionId: string\|null`, `tool: string`, `lane: string\|null` |
| `TOOL_COMPLETED` | A default framework tool invocation exited. | `argv: array`, `durationMs: number`, `exitCode: number\|null`, `sessionId: string\|null`, `tool: string`, `lane: string\|null` |
| `TOOL_REFUSED` | A tool invocation was refused (allowlist or dangerous form). | `argv: array`, `argv_index: number`, `detail: string`, `pattern_type: string`, `reason: string`, `sessionId: string\|null`, `source: string`, `tool: string`, `lane: string\|null` |
| `GOVERNANCE_MODE_CHANGED` | The workspace governance tier changed. | `by: string\|null`, `from: string`, `reason: string\|null`, `to: string` |
| `PLAN_CREATED` | A persisted plan was created. | `goal: string\|null`, `intent: string`, `name: string`, `phases: array`, `planId: string`, `title: string` |
| `PLAN_PHASE_ADDED` | A phase was added to a plan. | `at: string`, `intent: string`, `name: string`, `planId: string` |
| `PLAN_PHASE_COMPLETED` | A plan phase was completed. | `name: string`, `planId: string`, `summary: string\|null` |
| `PLAN_PHASE_BLOCKED` | A plan phase was blocked with a reason. | `name: string`, `planId: string`, `reason: string` |
| `PLAN_REVISED` | A plan was revised (phases added/removed/modified). | `planId: string`, `by: string\|null`, `diff: object` |
| `PLAN_COMPLETED` | A plan was completed. | `planId: string` |
| `PLAN_CANCELLED` | A plan was cancelled. | `planId: string`, `reason: string\|null` |
| `LOOP_STARTED` | A loop (ralph or plan-loop) started. | `loopId: string`, `kind: string`, `goal: string`, `maxIter: number`, `cooldownMs: number` |
| `LOOP_ITERATION_STARTED` | A loop iteration started. | `loopId: string`, `kind: string`, `iter: number` |
| `LOOP_ITERATION_COMPLETED` | A loop iteration completed. | `loopId: string`, `kind: string`, `iter: number`, `ok: boolean`, `signature: string\|null`, `summary: string\|null` |
| `LOOP_HALTED` | A loop halted before its goal. | `loopId: string`, `kind: string\|null`, `iter: number\|null`, `reason: string`, `signature: string` |
| `LOOP_COMPLETED` | A loop completed its goal. | `loopId: string`, `kind: string`, `iter: number`, `summary: string\|null` |
| `COORDINATOR_STARTED` | A coordinator primitive started driving a plan. | `coordinatorId: string`, `dryRun: boolean`, `planId: string`, `runtime: string\|null` |
| `COORDINATOR_PHASE_STARTED` | A coordinator entered a plan phase. | `coordinatorId: string`, `intent: string`, `phase: string`, `planId: string` |
| `COORDINATOR_PHASE_COMPLETED` | A coordinator completed a plan phase. | `coordinatorId: string`, `phase: string`, `planId: string` |
| `COORDINATOR_HALTED` | A coordinator halted. | `coordinatorId: string`, `detail: string`, `exitCode: number\|null`, `phase: string`, `planId: string`, `reason: string`, `signature: string\|null` |
| `COORDINATOR_COMPLETED` | A coordinator completed the plan. | `coordinatorId: string`, `phaseCount: number`, `planId: string` |
| `LANE_CLAIM_FORCED` | A lane claim was force-taken from a prior holder. | `by: string`, `focus: string\|null`, `priorSessionId: string`, `reason: string\|null`, `lane: string\|null` |
| `SKILL_CANDIDATE_DETECTED` | A candidate skill pattern was detected. | `examples: array`, `hash: string`, `tags: array` |
| `SKILL_CANDIDATE_APPROVED` | A skill candidate was approved into the gallery. | `hash: string` |
| `SKILL_CANDIDATE_REJECTED` | A skill candidate was rejected. | `hash: string`, `reason: string` |
| `TRUST_AUDIT_RAN` | A supply-chain trust audit ran over dependencies. | `audited: number`, `blockDays: number`, `cacheHit: boolean`, `cacheHits: number`, `cacheMisses: number`, `cveTotal: number\|null`, `depsHash: string`, `fails: number`, `freshDays: number`, `violations: number`, `warns: number`, `triggered_by: object\|null` |
| `TRUST_PIN_ADDED` | A dependency version/hash pin was added. | `name: string`, `sha256: string`, `version: string` |
| `TRUST_PIN_REMOVED` | A dependency pin was removed. | `name: string` |
| `TRUST_VIOLATION_DETECTED` | A supply-chain trust violation was detected. | `actual: string\|null`, `detail: string\|null`, `expected: string\|null`, `kind: string`, `pkg: string`, `triggered_by: object\|null` |
| `MCP_PROVENANCE_VERIFIED` | An MCP template's provenance hash verified. | `sha256: string`, `template: string` |
| `MCP_PROVENANCE_MISMATCH` | An MCP template's provenance hash did not match. | `actual: string`, `detail: string`, `expected: string`, `template: string` |
| `MCP_APPROVAL_GRANTED` | An MCP server was approved for use. | `by: string`, `name: string` |
| `WORKER_ENV_FILTERED` | A worker's environment was filtered against an allowlist. | `KEYS_ONLY: string`, `allowed: string`, `allowedCount: number`, `denied: array`, `deniedSecretCount: number`, `runtime: string`, `workerId: string` |
| `SECRET_DETECTED_IN_ARGV` | A secret-shaped value was detected in tool argv. | `tool: string`, `pattern_type: string`, `argv_index: number`, `sessionId: string\|null`, `lane: string\|null`, `override: string\|null` |
| `SKILL_IMPORTED` | A skill was imported from an external source. | `source: string`, `sha256: string`, `trusted: boolean`, `dest: string` |
| `SKILL_TRUSTED` | An imported skill was marked trusted. | `id: string` |
| `HANDOFF_SET` | A cross-session handoff narrative was set. | `auto: boolean`, `body: string`, `by: string\|null`, `sliceEventId: string`, `triggered_by: object\|null` |
| `LEARN_MINED` | Transcripts were mined for failed→succeeded correction pairs. | `candidates: number`, `mined: number`, `paired: number`, `since: string\|null`, `slug: string\|null` |
| `LEARN_DIGEST_WRITTEN` | A no-provider learning digest was written. | `candidates: number`, `digestPath: string` |
| `LEARN_JUDGED` | A correction candidate was judged by a worker. | `candidateId: string`, `category: string`, `destination: string`, `verdict: string`, `workerId: string` |
| `LEARN_CORRECTION_WRITTEN` | A typed correction was written to an agent file or memory. | `agent: string`, `category: string`, `correctionId: string`, `destination: string`, `file: string`, `memory: string`, `target: string` |
| `MEMORY_FACT_SUPERSEDED` | A memory fact was superseded by a newer fact. | `fact: object`, `factId: string`, `kind: string`, `reason: string`, `supersedes: string` |
| `BRIEFING_CURATED` | A curated orient/handoff briefing persisted its original for retrieval. | `briefingId: string`, `dropped: string`, `handoff: object`, `kind: string`, `orient: string`, `originalRef: string` |
| `BRIDGE_ORIGIN_REJECTED` | The bridge rejected a request with a non-loopback Host/Origin. | `host: string\|null`, `method: string`, `origin: string\|null`, `path: string`, `reason: string` |
| `BLUEPRINT_DISTILLED` | A blueprint skeleton was distilled into prose by a provider CLI. | `distilledBytes: number`, `outPath: string`, `provider: string`, `runtime: string`, `skeletonBytes: number`, `slug: string` |
| `DEBT_SCANNED` | The source tree was scanned for deliberate-shortcut debt markers. | `files: number`, `ledgerPath: string\|null`, `markers: number`, `noTrigger: number` |
| `ARCHITECTURE_SCANNED` | The declared architecture contract was checked against the import graph. | `blocking: boolean`, `cycles: number`, `driftScore: number`, `edges: number`, `failOn: string`, `forbidden: number`, `modules: number`, `newViolations: number`, `uncovered: number`, `undeclared: number` |
| `FOCUS_TAGGED` | A per-turn drift trajectory tag was recorded vs the declared goal. | `away: string`, `distanceScore: number`, `goalSetAt: string\|null`, `lateral: string`, `signals: object`, `sourceEventId: string\|null`, `tag: string`, `toward: string`, `triggered_by: object\|null` |
| `DRIFT_FLAGGED` | Sustained un-returned drift raised a swap/revert/continue flag. | `cleared: boolean`, `continue: string`, `deterministic: boolean`, `enriched: boolean`, `menu: array`, `reason: string`, `revert: string`, `runs: number`, `swap: string`, `workerId: string`, `triggered_by: object\|null` |
| `AUTONOMY_SCORED` 🔒 | Per-lane earned-autonomy trust scores were computed over the record. | `schemaVersion: number`, `asOf: string\|null`, `attribution: string`, `configHash: string`, `totalSlices: number`, `lanes: array` |
| `AUTONOMY_RECOMMENDATION` 🔒 | An autonomy rung change was recommended (recommend-only). | `schemaVersion: number`, `asOf: string\|null`, `lane: string`, `fromRung: string`, `toRung: string`, `wilson: number`, `n: number`, `coverage: number`, `recommendation: string`, `muted: boolean`, `mutedReason: string\|null`, `configHash: string` |
| `WORKTREE_ATTACHED` 🔒 | A worktree checkout was attached to a lane claim. | `schemaVersion: number`, `attachmentId: string`, `claimEventId: string\|null`, `lane: string`, `session: string`, `pathRepoRel: string`, `pathAbs: string`, `branchRef: string`, `baseRef: string\|null`, `baseHeadAtAttach: string`, `created: boolean`, `reused: boolean`, `dirty: boolean`, `gitCommonDir: string\|null`, `platform: string` |
| `WORKTREE_DETACHED` 🔒 | A worktree was detached from a lane claim with a disposition. | `schemaVersion: number`, `attachmentId: string`, `lane: string`, `pathRepoRel: string`, `disposition: string`, `branchHead: string\|null`, `integrationRef: string\|null`, `integrationHead: string\|null`, `ancestorCheck: string`, `dirtyAtDetach: boolean`, `reason: string\|null` |
