// Command tier manifest — Governance Phase 4.
//
// Keep in sync with bin/maddu.mjs COMMANDS. The command-tier-discipline gate
// fails when any top-level command is missing here.
//
//   tier:        'mutating' | 'read-only'
//   autoTrigger: 'allowed'  | 'forbidden'
//   surface:     'agent'    | 'operator'  (v1.3.0)
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

export default {
  agents:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  approval:     { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  focus:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  auth:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  brief:        { tier: 'read-only', autoTrigger: 'allowed',   surface: 'operator' },
  checkpoint:   { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  doctor:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  events:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'operator' },
  global:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  goal:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  import:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  init:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  lane:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  mailbox:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  mcp:          { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  memory:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  phase:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  register:     { tier: 'mutating',  autoTrigger: 'allowed',   surface: 'operator' },
  review:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  runtime:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  schedule:     { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  search:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  session:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  skill:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  slice:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  'slice-stop': { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  sources:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  spine:        { tier: 'read-only', autoTrigger: 'allowed',   surface: 'operator' },
  start:        { tier: 'read-only', autoTrigger: 'allowed',   surface: 'operator' },
  stop:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  status:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  task:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  upgrade:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  worker:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  workspace:    { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  // v0.18 — discovery surface (read-only).
  help:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  suggest:      { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  // v0.18 Phase 4 — architectural backbone.
  team:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  pipeline:     { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  advise:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  cost:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  // v0.19.1 — retroactive transcript import populates the ledger.
  usage:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  // v1.1.0 Phase 1 — default tools. All mutating; auto-trigger forbidden
  // (the slash command path is the explicit-invocation surface).
  git:          { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  test:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  'self-test':  { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  format:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  lint:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  install:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  // v1.1.0 Phase 3 — governance tier control surface.
  governance:   { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  // v1.1.0 Phase 4 — receipt log viewer.
  log:          { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  // v1.1.0 Phase 5 — plan persistence.
  plan:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  // v1.1.0 Phase 6 — loops.
  loop:         { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  // v1.1.0 Phase 7 — coordinator primitive.
  coordinator:  { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  // v1.2.0 Phase 1 — supply-chain trust audit + pinning. `audit/list/verify/report`
  // are read-only-shaped but the verb dispatches into write paths too (pin/unpin),
  // so the verb itself is mutating; auto-trigger forbidden (operator explicit).
  trust:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  // v1.2.1 F2 — bridges list/kill-all is operator-explicit only.
  // `list` is read-only-shaped but the verb dispatches into kill-all too,
  // so the verb itself is mutating; auto-trigger forbidden.
  bridges:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'operator' },
  // v1.3.0 — framework-coherence self-audit. Read-only (scans source, appends
  // one best-effort AUDIT_REPORT timeline event); safe to auto-trigger so the
  // drift check can run on a schedule every release.
  audit:        { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  // v1.4.0 — cross-project empirical usage audit. Read-only (scans registered
  // workspaces' spines + transcripts, writes nothing); safe to auto-trigger.
  insights:     { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  // v1.6.0 — session-start briefing. Read-only (runs operator-declared verify
  // commands + reads the spine; writes nothing).
  orient:       { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  // v1.6.0 — curated cross-session handoff. `set` writes a HANDOFF_SET event;
  // mutating, operator/agent-explicit.
  handoff:      { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  // v1.4.0 — plugin loader: capabilities that live outside the core. list/info
  // are read-only-shaped but the verb dispatches into enable/disable writes, so
  // the verb is mutating; auto-trigger forbidden (operator-explicit, like mcp).
  plugin:       { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  // v1.9.0 — failure-learning. `run` spawns a judgment worker + writes
  // corrections (agent-file + memory); mutating and auto-trigger forbidden
  // (operator/agent-explicit, like advise). `digest` is the read-only fallback.
  learn:        { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
  // v1.12.0 — portable project-blueprint export. Reads transcripts + spine and
  // writes a brief artifact under .maddu/state/blueprints/; no spine mutation.
  blueprint:    { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  // v1.17.0 — deliberate-shortcut ledger. Read-only (scans the source tree,
  // writes a derived .maddu/state cache + one best-effort DEBT_SCANNED event);
  // safe to auto-trigger so the ledger can refresh on a schedule.
  debt:         { tier: 'read-only', autoTrigger: 'allowed',   surface: 'agent'    },
  // v1.18.0 — architecture-drift. `init`/`baseline` write the contract/baseline,
  // so the verb is mutating + auto-trigger forbidden (operator-explicit). The
  // AUTO path is the read-only `architecture-drift` gate (doctor/audit).
  architecture: { tier: 'mutating',  autoTrigger: 'forbidden', surface: 'agent'    },
};
