// Máddu cockpit — route metadata registry (pure data leaf).
//
// Extracted from cockpit.js (v1.44.0) as the first STRUCTURAL slice of Phase 1.
// This is the plain-data half of the route table: title, nav group, rank,
// anchor flag, description, search keywords, and framework-only visibility —
// everything EXCEPT the render function binding. Because it imports nothing and
// pulls in no render functions, view modules (and the rail / dock / palette) can
// import route metadata without dragging in the whole render graph (the
// circular-import trap that blocks view extraction).
//
// cockpit.js is the composition root: it owns the render bindings and rebuilds
// the full `ROUTES` registry by merging each render fn onto ROUTE_META[id].
//
// Every route carries group + rank so the rail can be built dynamically and the
// same registry powers desktop rail, tablet glyphs, and the mobile dock. Anchor
// routes (the five depth-upgrade signatures) carry anchor:true and render with
// the filled ◆ glyph.
export const ROUTE_META = {
  goal:       { title: 'Goal',       group: 'decide',    anchor: true,  rank: 0,  description: 'The objective + measurable success conditions + constraints + the curated cross-session handoff. Run `maddu orient` for live success-condition verification.' },
  conductor:  { title: 'Conductor',  group: 'decide',    anchor: true,  rank: 1,  description: 'Command-control: what is safe to do next? KPI strip, next-command, operation score matrix, Now/Next/Waiting/Done board.' },
  boss:       { title: 'BOSS',       group: 'decide',    anchor: true,  rank: 2,  description: 'BOSS proposes · Enforcer cites · Operator decides. Terminal transcript, proposal cards with risk pill, approve/reject/negotiate.' },
  queue:      { title: 'Queue',      group: 'decide',    rank: 3,                 description: 'Scheduler / Queue / Dispatch / Preflights kanban. Every parked card carries a reason code and a safe next action.' },
  claims:     { title: 'Claims',     group: 'decide',    rank: 4,                 description: 'Active claims by lane — who is holding what, lease state, heartbeat age. Request handoff with one click.' },
  approvals:  { title: 'Approvals',  group: 'decide',    rank: 5,                 description: 'Pending tool / subprocess approvals. Allow-once, allow-always, or deny — every decision recorded.' },
  tasks:      { title: 'Tasks',      group: 'decide',    rank: 6,                 description: 'Dependency-aware task board. Completing a task auto-unblocks dependents.' },
  plans:      { title: 'Plans',      group: 'decide',    rank: 7,                 description: 'Multi-phase plan persistence + Kanban (Now / Next / Blocked / Done). State derived from spine PLAN_* events. (v1.1.0)',
                keywords: 'plans plan phases kanban revision multi-phase' },
  focus:      { title: 'Focus',      group: 'decide',    rank: 8,                 description: 'Focus Director — a domain-blind trajectory instrument. Per-turn drift tag (toward/lateral/away) vs the declared goal, with a sustained-drift flag carrying a swap/revert/continue choice. Opt-in: `maddu focus enable`.',
                keywords: 'focus director drift trajectory toward lateral away goal pilot attention anti-adhd nudge' },
  digest:     { title: 'Digest',     group: 'decide',    rank: 9,                 description: 'While you were away — the delta since you last looked: slices landed, gates run, drift flagged, plus what needs you now (open approvals, goal ✓/○/? from the cached success eval). Read-time derivation, zero writes. CLI: `maddu orient --digest`.',
                keywords: 'digest while you were away delta since catch-up approvals needs-you slices gates drift resume' },
  project:    { title: 'Project',    group: 'decide',    rank: 10,                description: 'Single-project cockpit — where this project stands on one screen: goal % to done (cached ✓/○/?), the Focus Director on-goal trajectory, the worker fleet, who is steering, and the recent slice trail. Read-time derivation, zero writes.',
                keywords: 'project cockpit single mission status percent done trajectory fleet workers steering sessions overview' },

  workflows:  { title: 'Workflows',  group: 'operate',   anchor: true,  rank: 1,  description: 'Blueprint of how Máddu thinks: operator → BOSS → Enforcer → claims → fleet → gates → reports → learning → wiki.' },
  agents:     { title: 'Agents',     group: 'operate',   rank: 2,                 description: 'Coworker profile grid — every active session with heartbeat, focus, claims held, score, mode, last slice.' },
  teams:      { title: 'Teams',      group: 'operate',   rank: 3,                 description: 'Lane ownership map — who is responsible for what, who is currently writing, who scored last.' },
  workbench:  { title: 'Workbench',  group: 'operate',   rank: 4,                 description: 'OS-like 3-pane shell. Left: lanes + sessions. Center: live event stream filtered by selection. Right: status counts, approvals, mailbox, schedule.' },
  chats:      { title: 'Chats',      group: 'operate',   rank: 5,                 description: 'Conversation surfaces. History, attachments, replay.' },
  mailbox:    { title: 'Mailbox',    group: 'operate',   rank: 6,                 description: 'Per-lane mailbox bus. Async handoffs without simultaneous lane mutation.' },
  swarm:      { title: 'Swarm',      group: 'operate',   rank: 7,                 description: 'Multi-agent fan-out. Lane-bound workers and their mailboxes.' },

  learning:   { title: 'Learning',   group: 'verify',    anchor: true,  rank: 1,  description: 'Durable findings distilled from slice-stops. Browse by kind, lane, recency. Hindsight worker writes; nothing here is hand-edited.' },
  wiki:       { title: 'Wiki',       group: 'verify',    anchor: true,  rank: 2,  description: 'Auto-maintained per-lane wiki. The Wiki Updater syncs pages from slice-stops; the Drift Drawer flags pages that fell behind.' },
  events:     { title: 'Events',     group: 'verify',    rank: 3,                 description: 'Live cursor stream of the append-only spine. Filters by type. Pause/resume.' },
  operations: { title: 'Operations', group: 'verify',    rank: 4,                 description: 'Live work in flight. Slice-stops, verifications, checkpoints.' },
  search:     { title: 'Search',     group: 'verify',    rank: 5,                 description: 'Cross-corpus search over events, slice-stops, memory, skills, mailbox, and inbox.' },

  runtimes:   { title: 'Runtimes',   group: 'connect',   rank: 1,                 description: 'Pluggable subprocess workers — Claude Code, Codex, Hermes, future agents. Descriptor + detection + spawn.',
                keywords: 'claude codex hermes worker subprocess spawn provider' },
  mcp:        { title: 'MCP',        group: 'connect',   rank: 2,                 description: 'Bridge-owned MCP server registry. stdio / sse / http transports. Per-lane visibility filtering.' },
  tools:      { title: 'Tools',      group: 'connect',   rank: 7,                 description: 'Unified tool gateway — 5 default tools (git/test/format/lint/install), active MCP servers, last 20 invocations. (v1.1.0)',
                keywords: 'tools default mcp gateway git test format lint install audited' },
  auth:       { title: 'Auth',       group: 'connect',   rank: 3,                 description: 'Multi-API-key store with rotation. Keys live in your OS auth dir — never served raw over HTTP. Last 4 chars only.',
                keywords: 'api key keys token oauth credentials secret rotation anthropic openai' },
  imports:    { title: 'Imports',    group: 'connect',   rank: 4,                 description: 'Safe import gateway. Foreign artifacts in — provider secrets always out. Rejected payloads are logged with paths + pattern names only.' },
  schedule:   { title: 'Schedule',   group: 'connect',   rank: 5,                 description: 'NL→cron scheduler. The bridge polls every 30 s; matching schedules fire their action (default: inbox note).' },
  settings:   { title: 'Settings',   group: 'connect',   rank: 6,                 description: 'Bridge, lanes, providers, tokens, integrations, MCP registry.',
                keywords: 'telegram discord email smtp integrations bot chat notifications dropbox imap outbound webhook' },

  orientation:{ title: 'Orientation',group: 'decide',    rank: 0,                 description: 'Turn-start digest. Goal, phase, last slice, open follow-ups.',
                keywords: 'goal phase brief orientation handoff next' },
  gates:      { title: 'Gates',      group: 'verify',    rank: 6,                 description: 'Recent gate runs. Filter by verdict / severity / gate id.',
                keywords: 'gates doctor verdict severity hard-rules' },
  reviews:    { title: 'Reviews',    group: 'verify',    rank: 7,                 description: 'Post-stop reviews. Verdict counts + per-review markdown.',
                keywords: 'reviews verdict findings followups P1 P2 P3' },
  // v0.18 — backbone routes split into dedicated entries in v0.19.2. Each
  // route reads the matching /bridge/<slice> endpoint (v0.19.1 PR-C4).
  pipelines:  { title: 'Pipelines',  group: 'operate',   rank: 8,                 description: 'Pipeline runs with stage timeline. plan-exec-verify-fix and related multi-stage workflows.',
                keywords: 'pipelines runs stages plan-exec-verify-fix autopilot' },
  loops:      { title: 'Loops',      group: 'operate',   rank: 12,                description: 'Ralph + plan-loops with iteration count, status, stuck-detection. (v1.1.0)',
                keywords: 'loop loops ralph plan-loop persist iterate stuck' },
  portfolio:  { title: 'Portfolio',  group: 'operate',   rank: 13,                description: 'Cross-workspace portfolio wall — one card per mounted project (goal % · on-goal · drift · approvals · fleet · last slice) with a "Needs the human" list that bubbles up open approvals, drift flags, and stuck workers across every project. Read-time fan-out over the workspace registry, zero writes.',
                keywords: 'portfolio wall cross-workspace projects overview needs-the-human approvals drift fleet fan-out multi-repo' },
  cost:       { title: 'Cost',       group: 'operate',   rank: 9,                 description: 'Token / call rollup per session, day, model, runtime. Surfaces unreported-token gaps honestly.',
                keywords: 'cost tokens ledger usage billing rollup unreported' },
  advisors:   { title: 'Advisors',   group: 'operate',   rank: 10,                description: 'Non-claiming advisor query artifacts. Runtime + session + ts + first-line preview.',
                keywords: 'advisors advise artifact non-claiming consult opinion' },
  skillinjections: { title: 'Skill Injections', group: 'operate', rank: 11,       description: 'Log of SKILL_INJECTED events — which skill, which slice, when. Bounded by the skill-injection-bounded gate.',
                keywords: 'skill injection injections inlined recipe slice budget' },
  modelrouting: { title: 'Model Routing', group: 'connect', rank: 7,              description: 'Per-runtime + per-lane + per-pipeline modelPreference. Active hints by spawn.',
                keywords: 'model routing modelPreference runtime lane pipeline stage hint' },
  trust:      { title: 'Trust',      group: 'verify',   rank: 9,                 description: 'Supply-chain trust posture — pins, last audit, violations, MCP provenance, worker env policy, skill provenance distribution. (v1.2.0)',
                keywords: 'trust supply chain audit pin freshness cve provenance secrets worker env' },
  experience: { title: 'Experience', group: 'verify',   rank: 10,                description: 'Experience ledger + evolve planner — the spine as session trajectories of normalized steps with late-bound signals, and the recommend-only evolution plan (the honest no-op is a result). Read-time derivation, zero writes; adoption stays an operator CLI verb.',
                keywords: 'experience ledger trajectory steps signals evolve plan adopt recommendation no-op atdp export learn spine verification' },
  model:      { title: 'Model',      group: 'verify',   rank: 11,                description: 'SLM-factory registry — datasets, training runs, checkpoints on the promotion ladder (spine-derived stage), evals with unacknowledged critical regressions, pending proposals, releases/rollbacks. Read-time derivation, zero writes; promotion/release/rollback stay operator CLI verbs behind the approvals ride.',
                keywords: 'model slm factory dataset training checkpoint eval regression promotion canary release rollback governance manifest' },
  decisions:  { title: 'Decisions',  group: 'verify',   rank: 13,                description: 'Decision ledger — the curated decision-grade spine (intent set · approvals + forced claims + drift triggers · failing gates · goal completed), each row carrying actor, provenance (human vs which auto-trigger), and its tamper-evident stored-line SHA that ties back to the verified chain. Read-time derivation, zero writes.',
                keywords: 'decisions ledger audit provenance approval goal gate trigger sha chain tamper-evident accountability who-decided' },
  oversight:  { title: 'Oversight',  group: 'verify',   rank: 12,                description: 'The non-coder oversight readout — what the agent DID with a skill: fed vs WITHHELD (and why, in plain language), whether it stayed on your goal, on a tamper-evident record you can independently verify. Read-time derivation, zero writes. Accountability substrate, not a safety proof.',
                keywords: 'oversight skill withheld blocked injection refused provenance drift on-goal focus verify chain intact contract independently checkable accountability translucent operator' },
  teststatus: { title: 'Test Status', group: 'verify',   rank: 8,                 description: 'Last-run timestamps for stress harness, upgrade matrix, projection roundtrip. WARN if older than doctor threshold.',
                keywords: 'test status stress harness upgrade matrix roundtrip ci recent',
                // v1.0.3 — framework-source-only. The scripts under
                // scripts/test/ that populate this route don't ship to
                // consumer installs, so the panel is permanently empty
                // for end users. Hidden on installed layouts.
                frameworkOnly: true },
  dashboard:  { title: 'Dashboard',  group: 'reference', rank: 1,                 description: 'Snapshot of every lane, every spawned worker, every open approval.' },
  roadmap:    { title: 'Roadmap',    group: 'reference', rank: 2,                 description: 'Planned slices, tagged versions, dependency graph.' },
  skills:     { title: 'Skills',     group: 'reference', rank: 3,                 description: 'Reusable recipes distilled from slice-stops. SKILL.md format under .maddu/skills/.' },
  docs:       { title: 'Docs',       group: 'reference', rank: 4,                 description: 'End-user manual. Install, concepts, CLI, cockpit tour, troubleshooting. Open from any route with ?' }
};
