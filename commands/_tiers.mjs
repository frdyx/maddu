// Command tier manifest — Governance Phase 4.
//
// Keep in sync with bin/maddu.mjs COMMANDS. The command-tier-discipline gate
// fails when any top-level command is missing here.
//
//   tier:        'mutating' | 'read-only'
//   autoTrigger: 'allowed'  | 'forbidden'
//   surface:     'agent'    | 'operator'  (v1.3.0)
//   layer:       'core'     | 'orchestration'  (v1.80.0)
//
// Schedule integration (`template/maddu/runtime/lib/schedule.mjs`) consults
// this manifest before firing: mutating + non-allowlisted → refused.
//
// `surface` (v1.3.0 completeness): the operator's north star is that every
// AGENT-FACING capability is reachable by natural language (slash command +
// intent routing), while operator/script plumbing stays verbose-CLI-only.
//   - 'agent'    — something a user asks for in natural language during work
//                  (plan, review, status, cost, search, memory, task, …).
//                  MUST have an on-ramp: a /maddu-* slash OR an intent-routing
//                  row. `maddu audit slash` WARNs when an 'agent' verb has none.
//   - 'operator' — install / lifecycle / plumbing reached only by scripts or
//                  the framework itself (init, upgrade, spine, auth, …). No
//                  on-ramp expected; verbose CLI is the surface.
//
// `layer` (v1.80.0, roadmap #12 / F4): the honest positioning axis. Most
// capabilities are 'core' — the always-on disciplined substrate (session, lane,
// slice, gate, plan, review, memory, tools, …) that every install actually
// uses. 'orchestration' is the OPT-IN multi-agent layer (coordinator, loop,
// pipeline, team) that only 2–5 of 13 installs reach for. The audit reads this
// to frame orchestration as opt-in (an honest fire-rate), NOT as "dead" — so a
// future audit can't re-raise "orchestration unused" as a false-alarm finding.
// `command-tier-discipline` requires a valid `layer` on every command.

export default {
  agents:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  // v1.92.0 — `autonomy` reads the whole spine but appends AUTONOMY_SCORED /
  // AUTONOMY_RECOMMENDATION report events by default (--no-emit for read-only),
  // so the verb is mutating + auto-trigger forbidden. Recommend-only contract:
  // it never writes governance config.
  autonomy:     { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  approval:     { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  focus:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  auth:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  brief:        { tier: 'read-only', autoTrigger: 'allowed',   surface: 'operator',  layer: 'core' },
  checkpoint:   { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  // v1.87.0 — bare `ci` is read-only (headless gate run, no spine writes), but
  // `ci pin` writes the required-gate profile (maddu.json / .maddu/config), so
  // the verb is mutating + auto-trigger forbidden (fleet/trust convention).
  ci:           { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  doctor:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  events:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'operator',  layer: 'core' },
  // EXP phase 1 — the experience ledger: pure spine→trajectory projection.
  // Read-only today; phase 5's `experience export --out` writes an artifact
  // FILE (never spine/state), the same posture as `export` above — so the
  // classification mirrors export exactly (read-only + auto-trigger forbidden).
  experience:   { tier: 'read-only', autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // EXP phase 3 — recommend-only evolution planner. `plan` is a pure read,
  // but `adopt` writes (LEARN_CORRECTION_WRITTEN / skill save), so the verb is
  // mutating + auto-trigger forbidden (the autonomy/fleet convention: any
  // write path -> mutating). Recommend-never-apply contract: nothing fires
  // without the operator typing `adopt`.
  evolve:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // SLM-governance phase 3 (plan pln_20260706133422_0f60) — every write
  // sub-verb appends MODEL_* events (and promote appends APPROVAL_REQUESTED),
  // so the verb is mutating; auto-trigger forbidden because promotion must
  // never fire without a human-attributable invocation (the approval ride is
  // always-on, and a scheduled promote would defeat its point).
  model:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // v1.83.0 — bare `fleet` is read-only, but `fleet upgrade --apply` delivers
  // framework bytes into other repos, so the verb is mutating + auto-trigger
  // forbidden (same convention as trust/mcp/plugin: any write path → mutating).
  fleet:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  global:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  goal:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  import:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  export:       { tier: 'read-only', autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  init:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  lane:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  mailbox:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  mcp:          { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  memory:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  phase:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  register:     { tier: 'mutating',  autoTrigger: 'allowed',   surface: 'operator',  layer: 'core' },
  review:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  runtime:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  schedule:     { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  search:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  session:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  skill:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  slice:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  'slice-stop': { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  sources:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  // audit P4 — `spine` has mutating subverbs: `spine sync` git-commits/pulls/
  // pushes this replica's partition and `spine sync init` mints replica metadata
  // (commands/spine.mjs → lib.spineSync.syncGit/syncInit). Declaring it read-only
  // let those mutations escape the Rule-9 trigger gauntlet. Any-write-subverb ⇒
  // the top-level verb is mutating; it is operator-invoked, never auto-fired.
  spine:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  start:        { tier: 'read-only', autoTrigger: 'allowed',   surface: 'operator',  layer: 'core' },
  stop:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  status:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  task:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  upgrade:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  worker:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  workspace:    { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  // v0.18 — discovery surface (read-only).
  help:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  suggest:      { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  // v0.18 Phase 4 — architectural backbone.
  team:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'orchestration' },
  pipeline:     { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'orchestration' },
  advise:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  cost:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  // v0.19.1 — retroactive transcript import populates the ledger.
  usage:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  // v1.1.0 Phase 1 — default tools. All mutating; auto-trigger forbidden
  // (the slash command path is the explicit-invocation surface).
  git:          { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  test:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  'self-test':  { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  format:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  lint:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  install:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // v1.1.0 Phase 3 — governance tier control surface.
  governance:   { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // v1.1.0 Phase 4 — receipt log viewer.
  log:          { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  // v1.1.0 Phase 5 — plan persistence.
  plan:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // v1.1.0 Phase 6 — loops.
  loop:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'orchestration' },
  // v1.1.0 Phase 7 — coordinator primitive.
  coordinator:  { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'orchestration' },
  // v1.2.0 Phase 1 — supply-chain trust audit + pinning. `audit/list/verify/report`
  // are read-only-shaped but the verb dispatches into write paths too (pin/unpin),
  // so the verb itself is mutating; auto-trigger forbidden (operator explicit).
  trust:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // v1.2.1 F2 — bridges list/kill-all is operator-explicit only.
  // `list` is read-only-shaped but the verb dispatches into kill-all too,
  // so the verb itself is mutating; auto-trigger forbidden.
  bridges:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  // v1.3.0 — framework-coherence self-audit. Read-only (scans source, appends
  // one best-effort AUDIT_REPORT timeline event); safe to auto-trigger so the
  // drift check can run on a schedule every release.
  audit:        { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  // v1.4.0 — cross-project empirical usage audit. Read-only (scans registered
  // workspaces' spines + transcripts, writes nothing); safe to auto-trigger.
  insights:     { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  // v1.6.0 — session-start briefing. Read-only (runs operator-declared verify
  // commands + reads the spine; writes nothing).
  orient:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  // v1.6.0 — curated cross-session handoff. `set` writes a HANDOFF_SET event;
  // mutating, operator/agent-explicit.
  handoff:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // hooks install/remove write a HOST file (.claude/settings.json); `hooks fire`
  // is invoked by Claude Code's hook system (external), not a Máddu auto-trigger.
  hooks:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator',  layer: 'core' },
  // v1.4.0 — plugin loader: capabilities that live outside the core. list/info
  // are read-only-shaped but the verb dispatches into enable/disable writes, so
  // the verb is mutating; auto-trigger forbidden (operator-explicit, like mcp).
  plugin:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // v1.9.0 — failure-learning. `run` spawns a judgment worker + writes
  // corrections (agent-file + memory); mutating and auto-trigger forbidden
  // (operator/agent-explicit, like advise). `digest` is the read-only fallback.
  learn:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
  // v1.12.0 — portable project-blueprint export. Reads transcripts + spine and
  // writes a brief artifact under .maddu/state/blueprints/; no spine mutation.
  blueprint:    { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  // v1.17.0 — deliberate-shortcut ledger. Read-only (scans the source tree,
  // writes a derived .maddu/state cache + one best-effort DEBT_SCANNED event);
  // safe to auto-trigger so the ledger can refresh on a schedule.
  debt:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent',     layer: 'core' },
  // v1.18.0 — architecture-drift. `init`/`baseline` write the contract/baseline,
  // so the verb is mutating + auto-trigger forbidden (operator-explicit). The
  // AUTO path is the read-only `architecture-drift` gate (doctor/audit).
  architecture: { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent',     layer: 'core' },
};
