# Changelog

All notable changes to Máddu. Versions follow the depth-upgrade slice plan
documented in `.claude/plans/so-let-me-revise-lazy-floyd.md` (slices α–ε)
plus the integration slices (ζ–η) and the cockpit polish pass.

The format roughly follows [Keep a Changelog](https://keepachangelog.com/),
adapted to the slice-stop ritual: every release is a `SLICE_STOP` event in
the spine, so the canonical log lives in `.maddu/events/`. This file is the
narrative summary.

---

## [v1.11.0] · 2026-06-09 · Drift-proofing — single-source config seeding + coherence guard gates

Shipping v1.10.0 surfaced a class of bug: `DEFAULT_TRIGGERS` was duplicated inline in `commands/init.mjs` AND `commands/upgrade.mjs`, and the upgrade copy went stale — so existing repos upgrading to v1.10.0 got the new trigger *code* but not the `slice-stop:auto-handoff`/`auto-review` allowlist entries, and the features silently didn't fire. The same class hid a security gap: `janitor`/`trust`/`worker-env`/`governance` configs were seeded by `init` only and **never backfilled on upgrade** (so an old repo never got `worker-env.json`'s default-deny-secrets list). This release fixes it for good — eliminate the drift by construction, then guard against its return.

- **Single-source config seeding** (`commands/_config-seed.mjs`). One module owns every `.maddu/config/*.json` default (triggers, janitor, trust, worker-env, governance, pipeline catalog) AND the seeding logic. Both `init` and `upgrade` call one `seedConfigDefaults()` — they can no longer diverge. Every write is write-if-missing; `triggers.json` merges add-missing without dropping operator entries; operator-edited files are never overwritten. **`maddu upgrade` now backfills all config defaults** (fixes the stale triggers AND the init-only security gap).
- **Guard gate `defaults-single-sourced`** (`safety`/FAIL). Source-scans `init.mjs` + `upgrade.mjs`: fails if either re-inlines a default constant or stops importing `_config-seed.mjs`. Makes "both must single-source" an enforced invariant, not a convention.
- **Guard gate `brief-coherence`** (`warn`). Every agent-facing `COMMANDS` verb must be named in the worker brief (`template/maddu/CLAUDE.md`) — closing the gap that shipped `learn` (v1.9.0) without a brief mention. Fixing it surfaced that **24 commands were never in the brief**; the brief now carries a complete grouped "agent command surface" reference (31 verbs).
- `maddu audit` grows 6 → **8 checks** (adds `defaults` + `brief`); both gates also auto-run under `maddu doctor`. No new event types or CLI commands.

Verified: 3 new tests (`config-seed-parity`, `gate-defaults-single-sourced`, `gate-brief-coherence`) + full suite — 21/21 green; `upgrade-matrix` 19/19 + `stress` 12/12 confirm init/upgrade still install cleanly. `maddu audit` 8/8. Tracked via `maddu plan` (dogfood).

## [v1.10.0] · 2026-06-09 · Invocation-logic pass 2 — light up the dead skills, handoff & review domains

Real burn-in across 8 projects showed whole shipped domains that `maddu insights dead` flagged as never-firing — not broken, just never invoked in the flow (the v1.7.0 diagnosis again). This wires the *WHEN* for three of them, all through the rule-#9 trigger gauntlet (allowlist + `triggered_by` + `TRIGGER_FIRED`, best-effort). **No new event types or commands** — pure invocation wiring; the audit surface is unchanged.

- **Auto-handoff at slice-stop** (`slice-stop:auto-handoff`, `runtime/lib/handoff-trigger.mjs`). `HANDOFF_SET` was dead yet `maddu orient` reads it, so "▶ RESUME HERE" was blank everywhere. Each slice-stop now derives a resume narrative (summary + next steps) and emits `HANDOFF_SET`. Latest-wins; a manual `maddu handoff set` still overrides until the next slice.
- **Skill-candidate detection now fires for real products** (`runtime/lib/skill-candidates.mjs`). `tagsFromSliceStop` only recognized Máddu's own conventions (`.md`→docs, `commands/`→command, `gates/`→gate), so a product touching `src/auth/*.ts` yielded <2 tags and nothing ever bucketed. Generalized to add `area:<parent-dir>` + `ext:<ext>` tags (skipping generic dirs like `src`/`app`). Also **high-confidence only**: the single-observation soft tier (`N_SOFT=1` + 24h cooldown) is dropped — a tag-set must recur (≥2 slices) before `SKILL_CANDIDATE_DETECTED` emits. Still suggest-only; never auto-writes a skill.
- **Auto-review after slice-stop** (`slice-stop:auto-review`, `runtime/lib/review-trigger.mjs`). Reuses the shared `runSliceReview` core, which **gracefully no-ops when no `kind:'reviewer'` runtime is configured** — so on-by-default is safe and never bills by surprise; only when an operator has set up a reviewer does it spawn (cooldown-guarded). Emits `SLICE_REVIEWED`/`FOLLOWUP_OPENED` with provenance.
- Both new triggers added to `init.mjs` `DEFAULT_TRIGGERS` (merged into existing installs on upgrade); documented in `docs/20-governance.md`.

Verified: 3 new fixture/CLI tests (`auto-handoff`, `skill-candidate-generalized`, `auto-review`) + full suite — 18/18 green. `maddu audit` 6/6. Planned + tracked inside Máddu via `maddu plan` (dogfood).

## [v1.9.2] · 2026-06-09 · `maddu learn` named in the framework worker brief

Doc completeness for the v1.9.0 feature. The installed worker brief (`template/maddu/CLAUDE.md`, which `maddu init` drops and `maddu upgrade` re-syncs into consumer repos) now lists `maddu learn digest` / `learn run` / `memory list --kind correction` in its "Useful commands" block, so agents in a consumer project discover the capability from the brief — not only via the `/maddu-learn` slash and intent routing (already shipped in v1.9.0). No behavior change; the *capability* shipped in v1.9.0/v1.9.1, and the corrections it writes remain project-scoped (never propagated into the framework template).

## [v1.9.1] · 2026-06-09 · `maddu learn` — Windows judgment-worker spawn fix

Patch on v1.9.0. The judgment worker (`maddu learn run`) couldn't spawn the provider CLI on Windows: npm installs `claude`/`codex` as `.cmd` shims, and modern Node refuses to spawn those without a shell (`spawn claude ENOENT`). The fallback handled it gracefully (wrote a review digest), but the autonomous judge never ran.

- **Prompt now goes to the worker on STDIN** for the built-in `claude`/`codex` runtimes (`learnArgs` drop the `${prompt}` arg). Safer than a KB-scale JSON prompt on argv, and it lets us use a shell only for the (data-free) command line.
- **Shell only for a bare `.cmd` shim on Windows** — an absolute `.exe` path still spawns shell-free; nothing untrusted ever reaches the command line (no `DEP0190`). argv-mode runtimes (`gemini`, custom descriptors, tests) are unchanged; descriptors can opt in/out via a `stdin` field.

Verified end-to-end on Windows against real sessions (the `claude` judge filtered 56 candidates → durable corrections written to the project brief + memory). New `learn-spawn` stdin scenario; full suite green.

## [v1.9.0] · 2026-06-09 · Failure learning — `maddu learn` (inspired by Headroom)

Máddu now learns from its own past sessions. Inspired by the [Headroom](https://github.com/chopratejas/headroom) project's failure-learning + memory ideas (the compression engine was not a fit; the *learning loop* was), `maddu learn` mines Claude Code transcripts for tool calls that **failed and were later resolved**, and distils the real lessons into durable corrections — extending the existing hindsight/`insights` machinery rather than bolting on a new subsystem.

- **Deterministic miner + failure→success pairer** (`runtime/lib/learn.mjs`) — reads the same `~/.claude/projects/<slug>/*.jsonl` transcripts the token ledger uses, pairs each failed tool call with the nearest later success of the same tool, and classifies it into five categories (`file-path`, `env-command`, `search-scope`, `large-file`, `command-pattern`). Pure core, no provider SDK; content-hashed candidate ids make re-mining idempotent.
- **Spawned-worker judgment, parent-only spine writes** — `maddu learn run` spawns the configured runtime **CLI** as a subprocess (same hard-rule-#5 boundary as `maddu advise`) to judge which candidates are real and word them; the parent parses the worker's JSON and is the *only* process that writes the spine. No runtime signed in (or a worker failure) falls back to a reviewable digest (`maddu learn digest`) instead of crashing.
- **Two destinations** (Headroom's split) — stable project facts → a marker-delimited block (`<!-- BEGIN MADDU LEARN v1 -->`) in the **project-root `CLAUDE.md`** (framework block never clobbered); volatile patterns → a `kind:'correction'` fact in `.maddu/memory.ndjson` (`maddu memory list --kind correction`). Corrections describe the **product**, never Máddu's rules — enforced by tests.
- **Supersession chains** — facts carry `supersedes:<priorId>`; `maddu memory list` shows the current view (`--all` for history), `maddu memory supersede` / `maddu memory history` manage chains. Event-sourced (`MEMORY_FACT_SUPERSEDED` carries the full fact), so chains survive `maddu memory extract --rebuild`.
- **Reversible briefings (retrieve-on-demand)** — `maddu orient --curate` persists the full briefing and shows a budget-bounded view + a `maddu learn retrieve <id>` pointer (`runtime/lib/briefings.mjs`); curation never silently drops detail. `BRIEFING_CURATED` records provenance.
- **6 new event types**, all but the load-bearing `LEARN_MINED` registered **dormant-by-design** so `maddu insights dead` stays honest. New `/maddu-learn` slash + intent-routing rows; `docs/37-failure-learning.md`.

Verified: 6 new fixture-based tests (`learn-events-registered`, `learn-miner`, `learn-fallback`, `learn-spawn`, `memory-supersession`, `reversible-briefings`, `learn-e2e`) + full prior suite — 15/15 green. `maddu audit` 6/6; no regressions to existing commands (default `orient` stays read-only). Planned + tracked inside Máddu itself via `maddu plan` (dogfood).

---

## [v1.8.0] · 2026-06-05 · Rule scope boundary — Máddu's rules govern Máddu, not your product

Fixes a framing bug that was crippling end products. The 8+1 hard rules describe **how Máddu itself is built** (the framework's own code under `.maddu/` + `maddu/` — CLI, bridge, cockpit), but the agent-facing wording stated them without scope, so agents building a product *with* Máddu applied "no provider SDKs / no hosted backends / no token storage" to **the product** — stubbing real features (e.g. a social planner that modeled "connected" channels but refused to actually publish). The rules were never meant to constrain the host project.

- **Scope banner on every agent-facing surface** — the worker brief (`template/maddu/CLAUDE.md`), `MADDU.md`, `CLAUDE`/`AGENTS` sections, `hard-rules.md`, `charter.md`, and the governance slash now state up front: these invariants govern the **Máddu framework layer only**; the product may use any SDK, hosted backend, database, OAuth/token storage, cron, or real publishing engine it needs — that's the project's own repo-root `CLAUDE.md`'s call. Never stub a product feature because of a Máddu rule; build the real thing (and reach for `maddu mcp` when a task needs an external capability).
- **`rule-2-no-sqlite` gate scoped to the framework** — it previously scanned the repo-root `package.json`, which in a host repo is the *product's* manifest, so a product depending on `better-sqlite3` was wrongly flagged. It now only evaluates Máddu's own manifest (`name === "maddu"`); a consumer install never ships a Máddu-owned `package.json`, so the product's deps are out of scope. (rule-1/5/6 were already correctly scoped to `.maddu/`/`maddu/`.)

Verified: a temp consumer install whose product uses `better-sqlite3` + `openai` + `@anthropic-ai/sdk` + token storage now passes `doctor` clean on rules #1/#2/#5; upgrade-matrix 19 (58 doctor passes), stress 12/12; audit 6/6. No new commands; the framework's own invariants are unchanged.

---

## [v1.7.0] · 2026-06-04 · Invocation logic — wire WHEN the still-dead domains fire

The 2026-06-03 usage audit found whole domains dead not because they were broken but because *nothing in the flow invoked them*. v1.7.0 gives each still-dead domain a **defined, safe trigger condition** wired into the flow — or honestly marks it operator-on-demand. The principle: don't force; give a clear WHEN. Every auto-trigger crosses the rule-#9 gauntlet (allowlist entry + `triggered_by` provenance + `TRIGGER_FIRED` + cooldown).

- **trust-audit on deps-change** — at slice-stop, if the dependency surface changed since the last `TRUST_AUDIT_RAN` (a stable `depsFingerprint` of direct deps + lockfiles), Máddu re-runs the supply-chain audit. Freshness/pin drift on newly-added deps is now caught in-flow instead of only on a manual `maddu trust audit`. Gated on `slice-stop:trust-audit`; resurrects `TRUST_VIOLATION_DETECTED` + `TRIGGER_FIRED`.
- **checkpoint before a coordinator run** — a real coordinator run spawns workers that mutate the repo across phases; Máddu now snapshots HEAD (a `maddu/checkpoint/*` git tag) *before* the run so the operator has a rollback point. Skipped for dry-run/synthetic. Gated on `coordinator:pre-run-checkpoint`; resurrects `CHECKPOINT_CREATED`.
- **mcp as a directive** — "a task needs an external tool the runtime lacks" can't be detected safely from the flow, so mcp gets an intent-routing row in the agent briefs (`MADDU.md` / `CLAUDE` / `AGENTS`), not an auto-trigger.
- **dormant-by-design registry** — `maddu insights dead` now separates genuine "nothing invokes it" gaps from capabilities that fire only under a specific posture/edge (API-key auth, opt-in schedules, manual dep-pinning, MCP provenance). Dead count on the real registry: 72 → 54, with 18 surfaced as dormant-by-design (each with a reason).
- **Docs** — governance doc gains an "embedded flow triggers" section (the flat-id allowlist + the WHEN table); init/upgrade seed the two new trigger ids.

Verified: unit (fingerprint) + end-to-end (trust fires once on deps-change then unchanged-gate skips; coordinator checkpoint precedes phases with a real git tag); audit 6/6, stress 12/12, layout-refusal 4/4, projection-roundtrip, advise-spawn 16, upgrade-matrix 19.

---

## [v1.6.0] · 2026-06-04 · Orchestration handoff — goal progress + cross-session briefing

Built for big multi-session projects: a goal-anchored session-start briefing that survives compaction, inspired by the posto `/orch:status` system. Extends existing primitives (spine + goal/brief/handoff/slice-stops) rather than adding a parallel system — the 8+1 hard rules are unchanged. Plan: [`docs/audit/2026-06-04-PLAN-orchestration-handoff.md`](docs/audit/2026-06-04-PLAN-orchestration-handoff.md).

- **Goal success conditions** — `GOAL_DECLARED` gains `success: [{text, verify}]`; `maddu goal set "<obj>" --success "<verify-cmd>::<text>"` (repeatable, ≤5). Measurable, command-verifiable conditions.
- **`maddu orient`** — the "session always starts here" briefing: runs each success condition's verify command → **✓ met / ○ pending / ? unverifiable**, and renders objective + success-progress + constraints + the curated handoff + recent slice-stop trail. When all verifiable conditions are met it suggests reviewing + closing the goal / a release. Read-only; complements `brief` (per-turn) and `status` (live snapshot). `/maddu-orient`.
- **Curated cross-session handoff** — `maddu handoff set "<markdown>"` / `show` + new `HANDOFF_SET` event. The operator/agent-maintained "▶ RESUME HERE" narrative (next slice, blockers, queue, decisions), surfaced first by `orient`. `/maddu-handoff`.
- **Session-open ritual** — `MADDU.md` / `CLAUDE` / `AGENTS` briefs lead a fresh session with `maddu orient`.
- **Cockpit Goal panel** — a Goal route (objective + success conditions + constraints + curated handoff), `GET /bridge/goal`.

Verified: full flow exercised (goal → orient runs verify cmds → ✓/○/? + handoff + completion nudge); audit 6/6, stress 12/12, layout-refusal 4/4, projection-roundtrip OK.

---

## [v1.5.0] · 2026-06-03 · Real sub-worker spawn + tracking

Máddu now actually spawns and tracks sub-workers — closing the audit's biggest dead surface (`WORKER_*` fired in 0/8 projects) not by demoting workers but by wiring the flow that drives them. Merged via PR #93.

- **Coordinator spawns tracked workers** — `spawnWorker` gains a `wait` mode (awaits exit, emits a real `WORKER_EXITED`); the coordinator's `--runtime` branch (formerly a stub) spawns a tracked worker per phase, exit code driving the phase.
- **`maddu team spawn`** — fans out N tracked workers across disjoint lanes **concurrently** (full lifecycle `TEAM_OPENED → MEMBER_JOINED → WORKER_SPAWNED/EXITED → MEMBER_LEFT → TEAM_CLOSED`); resurrects `TEAM_MEMBER_*`.
- **OAuth sub-worker tracking** — directive so an authed main agent registers its own sub-agents (which inherit OAuth) as tracked child sessions (`register --parent` → `session tree`), complementing headless spawn (for API-keyed runtimes).
- **Windows + security fixes** — `shell:true` for `.cmd`/`.ps1` shims; synchronous exit/error handlers (crash fix); the agent task delivered via **stdin** (never argv) to close a shell-injection vector.

---

## [v1.4.0] · 2026-06-03 · Empirical insights, a plugin loader, and a tighter core

The first **data-driven** release. After ~8 real projects had been run through Máddu, a cross-project usage audit (8 spines + 125 Claude Code transcripts) asked what is actually *used* vs merely *defined* — and acted on the answer. The 8+1 hard rules are unchanged. Two PRs: #91 (insights + plugin loader + comms demotion) and #92 (Bucket C — skills/review wired into the default flow).

### The finding

A verified producer census showed **90 of 142 event types never fired in any real project**, and only 9 are load-bearing (all lifecycle/bootstrap). They are dead in *burn-in*, not in *code* — every one has a producer — so the lever is **domain demotion, not constant deletion**. Full analysis in [`docs/audit/2026-06-03-usage-audit.md`](docs/audit/2026-06-03-usage-audit.md) + the kill-staging + ADR records beside it.

### `maddu insights` — measure what's used

- **New read-only, agent-facing `maddu insights`** (`/maddu-insights`): harvests `.maddu` spines across registered workspaces + scans transcripts, classifying every event type **load-bearing / occasional / single-project / dormant / dead** by per-project presence (so one high-volume project can't masquerade as broad use). Subcommands `events | dead | verbs | slashes`, `--json`. The repeatable instrument so the dead-type count can be re-checked every release.

### Plugin loader — capabilities outside the core

- **New `maddu plugin`** (`/maddu-plugin`): `list | info | enable | disable`. A capability can ship as a `plugin.json` manifest under `maddu/plugins/<name>/` (bundled) or `.maddu/plugins/` (user, gated by `--trust` + sha256), loaded only when enabled. Files-only enable-state in `.maddu/config/plugins.json`. Contract in [`docs/audit/2026-06-03-ADR-plugin-system.md`](docs/audit/2026-06-03-ADR-plugin-system.md).
- **Comms demoted to the first plugin.** Telegram / Discord / Email moved out of the bridge's static boot path into `template/maddu/plugins/comms/` (server + boot hooks); **off by default**. Back-compat migration on `upgrade` auto-enables comms if it was previously active. `insights` reclassifies the 19 comms types as `dormant [plugin:comms]` — the honest core-dead count drops 90 → 71. Cockpit Settings panels gate on `GET /bridge/plugins`.

### Bucket C — wire dead subsystems into the default flow

- **Skills funnel fires automatically.** `maddu slice-stop` now auto-detects reusable patterns and emits `SKILL_CANDIDATE_DETECTED` — crossing the rule-#9 gauntlet (allowlist `slice-stop:skill-candidate`, seeded by init/upgrade; `triggered_by` provenance). Previously the detector was only reachable via a manual subcommand nobody ran.
- **Coordinator enforces review.** `runSliceReview()` extracted into the review lib (shared by the CLI and auto-triggers); the coordinator reviews the newest slice produced during each phase (`SLICE_REVIEWED` + `FOLLOWUP_OPENED`), graceful no-op when no reviewer is configured.

### Verification

audit 6/6 · stress 12/12 · layout-refusal 4/4 · projection-roundtrip OK. Comms and review paths exercised end-to-end (live bridge + synthetic reviewer); cockpit gating browser-verified.

---

## [v1.3.0] · 2026-05-24 · Completeness — wire the framework to its charter

Máddu had the features; v1.3.0 joins them into one coherent, walkable flow and gives the framework a way to prove it stays coherent with itself. Coordinator-driven, single session, two arcs: the coherence realignment (merged via PR #89) and the completeness work that followed. The 8+1 hard rules are unchanged; this release is about intent, reachability, and ergonomics — not new surface area. Net LoC is negative.

The north star is now a single document: [`docs/charter.md`](docs/charter.md) — one mission, the 8+1 invariants, one canonical execution path. When any doc, agent brief, or feature disagrees with the charter, the charter is the intent and the disagreement is drift to be fixed.

### Connective tissue — the one canonical flow

- **Three default pipelines ship**, seeded on every `init` and carried through `upgrade`: `ship-a-feature` (the default), `fix-a-bug`, and `plan-and-delegate` (team / fan-out). Each stage is a literal `maddu` invocation, so walking a pipeline exercises and populates the Plans, Reviews, Pipelines, Loops, and Cost surfaces.
- **`MADDU.md` routing defaults non-trivial work to `maddu pipeline run <name> "<goal>"`.** The agent brief states the rule of thumb — *prefer a pipeline* — and maps an operator phrase to the right pipeline, telling the operator which it picked. Ad-hoc `/maddu-autopilot` (no pipeline) is reserved for genuine one-offs. Zero learning curve is preserved: the operator surface stays slash commands + natural language.

### Self-audit — the framework checks itself

- **New `maddu audit` command** (read-only) — a framework-coherence self-audit. Runs six gates: `event-types-reachable` (no dead event types), `command-surface-coherent` (every verb consistent across COMMANDS, tiers, and handler files), `cockpit-routes-reachable` (no route backed solely by a dead event), `docs-indexed` (every doc indexed and every index link resolves), plus the slash-on-ramp and charter-drift checks. Emits an `AUDIT_REPORT` event. Reports 6/6 on a clean tree.

### Charter — one north star, one flow

- **`docs/charter.md`** added and linked from `00-index.md`, the cockpit tour, and concepts: mission, the 8+1 invariants, the one canonical flow, scope boundaries (what Máddu is NOT), and a capability map where every top-level verb traces to a stated purpose (so `audit` can flag genuine orphans).
- **Permanent hard rule #9 unified** across the charter and `hard-rules.md`: every auto-trigger crosses the gauntlet (`tier:'mutating'` + `triggers.json` allowlist + cooldown + `TRIGGER_FIRED` provenance). Agent briefs (`MADDU.md`, `CLAUDE.section.md`, `AGENTS.section.md`) aligned to the charter's canonical flow.

### Forgiving CLI / agent ergonomics

- **Natural positional forms** now accepted where agents kept reaching for them: `maddu goal set "<obj>"`, `maddu task create "<title>"`, `maddu plan add-phase <plan-id> "<intent>"`, `maddu plan complete-phase <plan-id>`. The explicit flag forms (`--objective`, `--title`, `--phase`/`--intent`, `--summary`) all still work and stay canonical.
- **Every pipeline / slash / doc invocation corrected** to a verified-runnable form — no doc advertises a command that errors.
- **Subcommand `--help` routing** for `task` and `review`: `maddu <verb> <sub> --help` is detected at the dispatcher before flag validation, so it prints usage instead of a `required-flag` error.

### Slash on-ramp triage

- **All 53 verbs classified** agent-facing vs operator/plumbing via a new `surface` field, so the slash surface stays intentional rather than mirroring every verb. The audit's `slash-on-ramp` gate enforces that every agent-facing verb has an on-ramp and every CLI-only verb is intentionally so.
- **Four new agent slashes**, no sprawl: `/maddu-search`, `/maddu-memory`, `/maddu-task`, `/maddu-audit`.

### Internal

- Dead event types and unused exports removed; duplication collapsed via `makeId`, a shared `_libroot.mjs`, and a common `runWrapper`. The cumulative diff is net-negative LoC.

### Gates

- **`maddu doctor` → 58 gates** (was 54). **`maddu audit` → 6/6.** No new dependencies; no hard-rule changes; the spine, projections, and supply-chain posture are unchanged.

---

## [v1.2.3] · 2026-05-24 · Entity drawer — clickable plans + Kanban cards

Cockpit plans + Kanban cards become clickable. Click any card or row to open a right-side detail drawer showing the full plan state (goal, phases with completion glyphs, revisions, copy plan-id action). New reusable `openEntityDrawer({title, subtitle, body, onClose})` primitive that future cockpit routes can adopt for any entity (skills, MCP servers, advisors, slice-stops, runtimes, etc.).

### Backend

- New `GET /bridge/plans/<planId>` endpoint returns full projected plan state. Reuses existing `lib/plans.mjs:readPlan` — no new state mechanics.

### Frontend

- `openEntityDrawer(opts)` helper in `cockpit.js` — singleton drawer, slide-from-right with scrim, closes on `Esc` / scrim click / × button. `body` accepts a DOM Element, function, or async function returning a render Promise (loading state shows while async).
- Plans table rows and Kanban cards become `role=button` + `tabIndex=0` with click + Enter/Space keyboard handlers.
- `openPlanDrawer(planId)` fetches `/bridge/plans/<id>` and renders structured detail: title + status pill + revision count, goal section, phases list with `✓/◯/○` glyphs colored by state, revision history (last 20, newest first), and a Copy plan id action button.
- CSS for `.entity-drawer*` + `.entity-card` + `.entity-row` — slide animation, accent hover/focus rings, accessible focus-visible styling.

### Notes

- Reusable primitive — other cockpit routes can adopt `openEntityDrawer(...)` incrementally. No coordination required to migrate them.
- No new doctor gates. No spine event additions. No new dependencies. Cockpit + bridge only.
- Stress harness + layout-refusal + upgrade-matrix unchanged + still green.

---

## [v1.2.2] · 2026-05-24 · Cockpit polish — path popover + scope-pill active state

Two small cockpit UX fixes from the v1.2.1 burn-in.

### Path row — compact display + click-to-copy

The v1.2.1 rail-foot Path row (F4) showed a 40-char left-truncated full path that still overflowed the rail at common widths and offered no easy way to grab the value. v1.2.2:

- Compact display form: `<drive>/…/<basename>` (e.g. `C:/…/snyggare`). Width-bounded.
- Native browser tooltip (`title` attr) reveals the full path on hover.
- **Click the Path row to copy the full path to the clipboard** — toast confirms (`Path copied`). Keyboard activation (Enter / Space) works too; row is `role="button"` + `tabIndex=0` with an `aria-label`.
- CSS adds `max-width: 100%` + `overflow: hidden` + `text-overflow: ellipsis` to `.rail-foot-value` so any rail-foot value (workspace id included) no longer overflows the rail at narrow widths.

Fallback for non-Clipboard-API contexts uses a hidden textarea + `document.execCommand('copy')`.

### Scope pill — visible active state on click

The `This workspace | All workspaces` toggle (`.scope-pill`) had correct CSS for `.scope-btn.active` but the click handler only updated underlying scope state + triggered a content refresh. The pill UI itself never re-applied the `active` class to the clicked button, so the visual indicator was stuck on the first-render state.

Fix: click handler walks the pill's buttons, toggles `.active` to the clicked one, and updates `aria-pressed` for screen readers. No CSS change — the existing styling now actually triggers.

### Cumulative effect

After v1.2.1 (operator UX around multi-bridge / multi-workspace state) + v1.2.2 (cockpit polish), the operator-facing affordances around workspace identity are now consistent:

- Rail-foot shows current workspace label + compact path; click the path to copy.
- Scope pill visually reflects which scope is active.
- Cockpit chrome unambiguous across multiple tabs / repos.

No behavior change beyond the cockpit. No new doctor gates, no spine event additions, no API change. Pure rendering + UX fixes.

---

## [v1.2.1] · 2026-05-24 · Multi-bridge / multi-workspace polish

Patch release closing the five operator-UX findings from the v1.2.0 burn-in
in snyggare. All five concern multi-bridge / multi-workspace state — the
parts of Máddu that get exercised once the operator runs more than one
repo against the same machine. Nothing here changes the spine or the
hard rules; this is purely operator-surface polish.

### PR-A — Bridges lifecycle

- **F1 — Silent port-collision on `maddu start`.** Wraps the bridge's
  `server.listen()` with EADDRINUSE detection. On collision, probes
  `/bridge/status` to distinguish a foreign Máddu bridge from a non-Máddu
  process and emits actionable refusal copy with workspace + restart
  hints (Máddu case) or PID + `--port` hint (foreign case). No more
  bare `Error: listen EADDRINUSE`.
- **F2 — `maddu bridges list` + `maddu bridges kill-all`.** New
  `commands/bridges.mjs` subcommand. Device-local registry at
  `~/.config/maddu/bridges-registry.json` (or
  `%APPDATA%\maddu\bridges-registry.json` on Windows) records pid +
  port + repoRoot at `maddu start` time; the SIGTERM/SIGINT shutdown
  handler clears the entry. `bridges list` reads the registry +
  cross-platform process scan (Get-CimInstance / ps -ef) for orphans
  and refreshes the live state via `/bridge/status`. `kill-all`
  SIGTERMs every detected bridge with a 3 s SIGKILL fallback.
- **F3 — CWD not in registry → silent fallback to active workspace.**
  At start time, compares the resolved CWD against the workspace
  registry. If the registry has entries but CWD isn't one of them, the
  bridge would silently mount the registry's *active* workspace (not
  CWD); we refuse with an add/force-active/cancel triage instead.
  `--force-active` bypasses with a visible breadcrumb in stderr.
- **`maddu start` gains `--port <n>`** for non-default binds; `maddu
  stop` reads the port back from `.maddu/state/bridge.pid` so a custom
  port survives the round-trip.
- **Stress harness** picks up a 12th scenario (`port-collision-refusal`)
  that boots a real bridge on a pinned port and asserts the second
  `start` exits non-zero with the canonical refusal copy.

### PR-B — Cockpit + CLI polish

- **F4 — Rail-foot Workspace + Path rows.** The cockpit rail-foot now
  surfaces `workspaceId` and `repoRoot` above Bridge/Version/Uptime.
  Path truncates from the LEFT so the basename always stays visible
  (operator cue: ellipsis on the left means "more path above this").
  Hover reveals the full path via the `title` attribute. Resolves the
  "which cockpit tab is which?" confusion when running multiple repos.
- **F5 — `maddu workspace add` accepts both shapes.** `add <path>`
  (positional, legacy) and `add --path <path>` (flag form, aligns with
  the rest of the v1.1+ CLI like `plan complete --plan <id>`). Passing
  both refuses rather than silently preferring one. Full argv
  standardization across all subcommands is deferred to v1.3.

### Verification

- Doctor in test consumer: **54 PASS · 0 WARN · 0 FAIL.**
- Stress harness: **12 / 12 scenarios pass · 37 assertions pass.**
- Layout-refusal harness: **4 / 4 scenarios pass.**
- All 8+1 hard rules still green at every PR boundary.
- v1.0.3 framework-only route discipline, v1.1.1 stop/SIGINT handler,
  v1.2.0 trust + secret-scan + env-allowlist gates: all preserved.

---

## [v1.2.0] · 2026-05-24 · Supply-chain hardening + Hermes adapter

2026 has been the year of supply-chain attacks on developer tooling
(TeamPCP — Trivy, Checkmarx, Bitwarden CLI, TanStack, GitHub itself).
The operator chose Máddu specifically to minimize this attack surface;
v1.2.0 turns "local-first, no broad deps, no provider SDKs in framework
code, device-bound tokens" from architectural intent into **enforced
gates** with explicit threat-model documentation. The framework becomes
the operator's least-trust shell around their AI work.

The release also lands the Hermes runtime adapter (Nous Research) —
deferred from v1.1.0 — as the first new runtime added under the new
trust discipline. Hermes proves the discipline transfers cleanly: it
rides every gate (worker-env allowlist, secret-scan argv, tool
allowlist, strict-mode approval) with zero special-case code.

### Phase 1 — Dependency surface audit + pinning

- New `maddu trust <verb>`: `audit`, `pin`, `unpin`, `verify`, `list`,
  `report`, `env-allow`. Backed by `.maddu/config/trust.json`.
- All registry queries via `npm` subprocess (rule #4 — no new deps).
  6h cache on `npm view` time data in `.maddu/state/trust-cache.json`,
  stale-cache fallback on registry outage.
- Doctor gates: `dependency-freshness` (WARN within
  `freshness_warn_days`; FAIL in strict mode within
  `freshness_block_days`), `dep-pinning-respected` (FAIL when
  `package.json` declared spec ≠ pinned version).
- Spine events: `TRUST_AUDIT_RAN`, `TRUST_PIN_ADDED`,
  `TRUST_PIN_REMOVED`, `TRUST_VIOLATION_DETECTED`.
- `/maddu-trust` slash command shipped (raw, v0.19.1 frontmatter
  discipline).

### Phase 2 — MCP provenance + worker env allowlist

**MCP provenance:**

- Every shipped MCP template carries a `provenance` block with a SHA256
  hash of the canonical content (provenance stripped, keys sorted).
- `maddu mcp install <template>` verifies hash before scaffolding +
  registering. Tampered template → `MCP_PROVENANCE_MISMATCH` refusal.
- Operator-registered MCPs (`maddu mcp register`) tag as
  `provenance: 'operator-trusted'` and are **disabled until
  `maddu mcp approve <name>`**.
- Doctor gate `mcp-provenance-verified` (FAIL when any enabled MCP
  lacks approved provenance, or any shipped template hash drifts).
- Cockpit Tools route shows a provenance badge per server.

**Worker env allowlist:**

- New `template/maddu/runtime/lib/worker-env.mjs` filters
  `process.env` through an allowlist before every worker spawn.
  Default-deny on `AWS_*`, `OPENAI_*`, `ANTHROPIC_API_KEY`,
  `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_*`, `AZURE_*`, `GCP_*`,
  `STRIPE_*`. Default-allow on `PATH`, `HOME`, `MADDU_*`, `CLAUDE_*`,
  `CODEX_*`, etc.
- `maddu trust env-allow <VAR> [--lane <id>]` writes
  `.maddu/config/worker-env.json`.
- Every spawn emits `WORKER_ENV_FILTERED` with allowed-count and
  **denied KEYS ONLY — never values**.
- Doctor gate `worker-env-policy-coherent` validates the policy
  ships required deny prefixes; WARN on lane overrides re-allowing a
  secret prefix.

### Phase 3 — Secret detection in tool argv

- New `template/maddu/runtime/lib/secret-scan.mjs` — pure regex engine
  for AWS / OpenAI / Anthropic / GitHub (4 prefix variants) / GitLab /
  Slack / Stripe tokens + a `high-entropy-adjacent-to-secret-key`
  fallback that requires the long string to appear next to a known
  sensitive key name on the same arg (no false-positives on bare
  commit SHAs).
- Wired into `tools.runTool` central path AND every default tool
  wrapper (`commands/{git,test,format,lint,install}.mjs`). Match →
  refuse with `TOOL_REFUSED reason: 'secret-detected'`.
- THE MATCHED VALUE IS NEVER LOGGED. Only `pattern_type` +
  `argv_index` ride on the spine.
- Operator escape hatch: `--allow-secret` records
  `SECRET_DETECTED_IN_ARGV` with `override='operator-allowed-secret'`
  and proceeds. The matched arg is `[REDACTED:<pattern_type>]` in
  TOOL_INVOKED / TOOL_COMPLETED — even under override.
- Doctor gate `secret-scan-active` (verifies wiring + defensive
  200-char leak check on existing events).

### Phase 4 — Skill provenance enforcement

- Every skill in `.maddu/skills/` declares a `provenance` field:
  `framework-starter-pack-vX | operator | imported`. Pre-v1.2 skills
  auto-grandfathered at load time.
- New `maddu skill import <path> --trust` (refuses without `--trust`,
  injects provenance + SHA256, marks `trusted: false`).
- New `maddu skill trust <id>` flips to trusted.
- 8 starter skills stamped with
  `provenance: framework-starter-pack-v1.2.0`.
- Spine events: `SKILL_IMPORTED`, `SKILL_TRUSTED`,
  `SKILL_INJECTION_REFUSED`.
- Doctor gate `skill-provenance-required` (FAIL on missing
  provenance; WARN on imported-pending-trust).

### Phase 5 — Strict-mode approval enforcement (closes v1.1.0 burn-in)

- New `commands/_strict-approval.mjs` helper. In strict mode, gated
  tools (`install`, `mcp install`, `skill import`,
  `lane claim --force`) emit `APPROVAL_REQUESTED` and **wait** up to
  5 min for a paired `APPROVAL_DECIDED`. Auto-decide cascade:
  per-repo policy → global policy → operator decision.
- Wired into `commands/install.mjs` (the v1.1.0 burn-in target).
- Doctor gate `strict-mode-approval-active` (in strict mode, every
  gated `TOOL_INVOKED` must have preceding allow `APPROVAL_DECIDED`
  in scope).

### Phase 6 — Trust audit cockpit panel + threat model doc

- Cockpit Trust route (verify group, rank 9): pin list, last audit,
  violations, secret refusals (keys only), worker env policy, MCP
  provenance, skill provenance. Auto-refresh 15s.
- New bridge endpoints: `GET /bridge/trust`, `POST /bridge/trust/audit`.
- **NEW** `docs/34-threat-model.md` — operator's security manual.
  Documents 9 supply-chain attack scenarios with concrete gate
  citations and the boundary between what Máddu enforces vs what it
  documents (network egress, OS-level decisions, operator raw shell).
- **NEW** `docs/36-trust-audit.md` — `maddu trust` reference + file
  schemas + doctor gate list + cockpit Trust route description.
- `maddu trust report` enriched into a security-team-shareable
  Markdown document pulling governance + pins + recent events + MCP
  inventory + worker-env policy + skill distribution.

### Phase 7 — Hermes runtime adapter

- New `template/maddu/runtime/lib/runtimes/hermes-wrapper.mjs`
  (mirrors claude/codex wrapper shape). NDJSON splitter, OpenAI-style
  `prompt_tokens` / `completion_tokens` normalized into spine
  schema.
- New `template/maddu/runtimes/hermes.json` descriptor template.
- `BUILTIN_WRAPPERS` gains `hermes`.
- `maddu runtime detect hermes` runs `hermes --version`; clean
  refusal when binary absent.
- **NEW** `docs/35-hermes-adapter.md` — install, register, use, full
  security posture citing the four v1.2.0 gates, hard-rule notes.
- Hermes is the first new runtime added under v1.2.0's trust rails —
  zero special-case code in spawn. Proves the discipline transfers.

### Phase 8 — Doctor + docs sweep + tag

- `version.json` 1.1.2 → 1.2.0.
- `package.json` 1.1.2 → 1.2.0.
- This CHANGELOG entry.
- `docs/00-index.md` lists 34 / 35 / 36; mirrored under
  `template/maddu/docs/`.
- Test-consumer verification: doctor **54 PASS / 0 WARN / 0 FAIL**.
- Regression: layout-refusal 4/4, stress-harness 11/11 (34 assertions).

### Hard rules

All 8+1 preserved across the eight phases. Rules #4, #5, #6, #9
graduate from "architectural intent" to "enforced by gate." The
threat-model doc states which scenarios fall outside Máddu's
enforcement boundary so the operator knows where to layer OS-level
defenses (Little Snitch, ufw, etc.).

### Tag

`v1.2.0` annotated tag pushed to origin. 8 PRs landed in sequence on
main: #76 → #77 → #78 → #79 → #80 → #81 → #82 → (Phase 8 release PR).

---

## [v1.1.2] · 2026-05-24 · Narrative refresh + P3 backlog patches

Post-v1.1.1 polish release. PR-A is a docs-only narrative refresh that
brings the README + getting-started doc in line with the v1.1.x autonomy
+ planning + tool gateway shape. PR-B closes the 3 P3 findings deferred
from the v1.1.0 burn-in.

### PR-A — Narrative refresh (no functional change)

- README badge `1.1.0 → 1.1.2` (was stale through v1.1.1).
- README 60-second tour: `Máddu v0.19.1` → `Máddu v1.1.2`.
- `docs/01-getting-started.md` gains a new "Going autonomous (v1.1.x flow)" section after the manual walkthrough. Three escalation levels: `maddu blast` (single confident slice), `maddu loop ralph` (persist until done), `maddu coordinator <plan-id>` (multi-phase autonomous driver). Existing first-timer walkthrough stays intact.
- `docs/00-index.md` "Current version" → v1.1.2, mentions the new cross-stack detector.
- All edits mirrored to `template/maddu/docs/`. `docs-in-sync` gate green.

### PR-B — P3 backlog patches

**#15 — Cross-stack detector for Python.** `detectFramework()` in `template/maddu/runtime/lib/tools.mjs` now recognises Python projects via `pyproject.toml` or `requirements.txt`. Test → `pytest`. Format → `ruff format` with `black` fallback. Lint → `ruff check`. Install → `uv add` with `pip install` fallback. Node projects still take precedence when both stacks are present.

**#12 — Consumer-install upgrade refusal text trimmed.** `requireSourceLayout()` in `commands/_manifest.mjs` cuts the refusal output from 13 body lines to 5. Keeps "refused", "consumer install", the correct command, and the redirect — drops the verbose explanation. `scripts/test/layout-refusal.mjs` still passes (test asserts patterns, not exact text).

**#20 — Skill-candidate threshold tuned.** `template/maddu/runtime/lib/skill-candidates.mjs` ships two confidence tiers instead of a single hard `N=3` threshold:

- `N_HIGH = 2` — "high" confidence candidate, emits once on first detection.
- `N_SOFT = 1` — "soft" suggestion from a single observation, throttled by a 24h per-hash cooldown so the surface doesn't flood.

New event data field `confidence: 'high' | 'soft'` on `SKILL_CANDIDATE_DETECTED`. Older events default to `'high'` on read. Operator surface (`maddu skill candidates list` + cockpit panel) shows both tiers.

### Backlog cleared

`docs/v1.1.2-backlog.md` removed — all 3 P3 findings closed.

### Notes

- No new `package.json` dependencies (rule #4 holds).
- All edits ship through Node stdlib + `child_process.spawn` (rule #5 holds).
- Three new Python tool wrappers (`pytest`, `ruff`, `uv`/`pip`) are operator-provided binaries on PATH — Máddu never bundles them, same posture as `npm`/`prettier`/`eslint`.

---

## [v1.1.1] · 2026-05-24 · Burn-in patch — Windows spawn, ralph verify, plan argv, lifecycle

Patch release closing the 12 fixes surfaced by the v1.1.0 burn-in inside
`~/projects/memo/`. Four PRs, no functional surface change, no new
dependencies. Operator-facing reliability improvements only.

### Headline changes

- **P0 — Windows `spawnSafe` `.cmd` shim (PR-A).** `maddu test/format/lint/install` no longer crash with `spawn EINVAL` on Windows + Node 22+. npm-family runners (`npm`, `pnpm`, `yarn`, `npx`) are now spawned with `shell:true` and conservatively quoted argv so the `.cmd` shims resolve cleanly. `git` still uses the bare-exe path.

- **P1 — Ralph loop verify-contract regression test (PR-A).** New synthetic stress-harness scenario `ralph-always-fail-halts` locks the verify→loop contract in three forms (stable-fail → stuck, distinct-fail → max-iter, pass → complete). Catches regressions where exit-code interpretation flips.

- **P1 — Plan argv standardization (PR-A).** Plan id is now the first positional argument across `show / add-phase / complete-phase / block-phase / revise / complete / cancel`. `--plan <id>` is accepted as an alias and normalized so `maddu plan complete --plan pln_xxx` no longer creates a literal `.maddu/plans/--plan/` directory. Phase identifier canonicalized to `--phase <id>`; `--name <id>` is a deprecated alias that emits a one-time stderr warning.

- **P1 — `lanes-catalog-parseable` doctor gate (PR-A).** New gate validates `.maddu/lanes/catalog.json` parses as JSON and has the v1 shape (`schemaVersion`, `lanes:[{id, scope?}]`, optional `framework`). Burn-in could corrupt the catalog and stay 46/0/0 green; doctor now FAILs with an actionable message and remediation pointer.

- **P1 — Plan kanban phase aggregation (PR-A).** `maddu plan kanban` now buckets phases individually: completed phases land in DONE, blocked phases in BLOCKED, the first pending phase in NOW, the next two in NEXT. A plan whose phases are all done but plan-level status is still `open` surfaces in DONE with a `phases-complete` marker rather than vanishing. The `kanban-coherent` gate treats plan-level vs phase-level rows distinctly.

- **P2 — `maddu workspace activate <id>` reroots a live bridge (PR-B).** The CLI POSTs to `/bridge/_workspaces/activate` so the bridge's in-memory active pointer follows the registry. If the requested workspace isn't yet mounted (added after `maddu start`), the CLI prints a loud `maddu stop && maddu start` warning instead of silently mis-routing.

- **P2 — `maddu stop` + SIGINT/SIGTERM trap on `start` (PR-B).** New `maddu stop` reads `.maddu/state/bridge.pid` and gracefully terminates the bridge (SIGTERM → SIGKILL after a 3 s grace). `maddu start` writes that PID file on boot and installs signal handlers — Ctrl+C cleanly shuts the bridge down instead of leaving a detached node process.

- **P2 — `--help` discipline (PR-B).** `bin/maddu.mjs` intercepts `--help` / `-h` BEFORE dispatching to the verb, so `maddu <verb> --help` never errors out with `--flag required` first. Six verbs ship verb-specific usage (start, stop, workspace, plan, lane, install); everything else falls back to the global discovery surface.

- **P2 — `lane claim` positional shorthand (PR-C).** `maddu lane claim <lane-id>` now works (positional first-arg). `--lane <id>` flag form retained for backward compatibility. Same shorthand added to `lane release`.

- **P2 — `maddu install` validates package specs (PR-C).** Each package arg is trimmed and validated (npm-name regex or file:/github:/git+/https?: URL escape hatches) BEFORE spawn. `maddu install ""` now refuses cleanly with a `TOOL_REFUSED dangerous-form` audit event instead of crashing downstream with EINVAL.

- **Docs sweep (PR-D).** `docs/03-cli-reference.md`, `docs/31-operations-log.md`, `docs/32-kanban-and-plans.md`, `docs/33-loops-and-coordinator.md` (and mirrors under `template/maddu/docs/`) document every v1.1.1 surface change. `docs-in-sync` gate green.

### Deferred to v1.1.2

P3 findings (#15 cross-stack pytest/ruff detection, #20 skill-candidate threshold) logged in `docs/v1.1.2-backlog.md` for future patch.

### Doctor end-state (test consumer)

47 pass · 0 warn · 0 fail across a fresh `maddu init` install. Stress harness 11/11, upgrade matrix 19/19, layout refusal 4/4.

---

## [v1.1.0] · 2026-05-24 · Autonomy + Planning + Tool Gateway

Largest minor release since v1.0.0. Nine phases, all coordinator-driven
from a single session, each landed as its own PR (#61–#69).

### Headline changes

- **Default framework tools** (Phase 1) — five audited subprocess
  wrappers ship: `maddu git/test/format/lint/install`. Every invocation
  emits `TOOL_INVOKED` / `TOOL_COMPLETED` (or `TOOL_REFUSED`) on the
  spine. Dangerous-form catalog refuses `git commit -m ""`, `git push
  -f`, empty install lists, no-detector test/format/lint resolution.
  Per-lane allowlist via `.maddu/config/triggers.json`. New gates:
  `default-tools-shipped`, `tool-allowlist`.

- **MCP server template gallery** (Phase 2) — 5 curated templates ship
  as JSON descriptors (no new package.json deps): `local-fs`,
  `local-search`, `calculator`, `git-advanced`, `time-and-date`. New
  verbs `maddu mcp templates list/show`, `install <template>`,
  `uninstall <name>`. `install` checks required binaries and refuses
  cleanly when missing. New cockpit `tools` route unifies default tools
  + active MCP servers + last 20 tool events.

- **Workspace governance tiers** (Phase 3) —
  `.maddu/config/governance.json` declares `strict | standard | relaxed`
  + per-gate overrides. Three modes tune *operational* gates only; the
  8+1 structural hard rules remain immutable. `maddu governance set
  relaxed` requires `--reason` (explicit operator intent). Doctor
  banner + cockpit rail-foot show mode prominently. New event
  `GOVERNANCE_MODE_CHANGED`. New gate `governance-mode-coherent`.

- **Receipt log + cockpit Operations feed** (Phase 4) — every
  operational event projects to `.maddu/log/operations.ndjson` with a
  human-readable summary; `.maddu/log/README.md` auto-refreshes with
  last 50. `maddu log [--since][--lane][--op][--rebuild][--json]`.
  Cockpit Operations route renders the feed. The projection is
  REGENERABLE — `receipts-coherent` gate replays twice and asserts
  byte-equality.

- **Kanban projection + plan persistence + auto-revision** (Phase 5) —
  plans live as files at `.maddu/plans/<plan-id>/{plan.md,state.json,
  revisions/}`. All mutations land via `PLAN_*` events. `state.json`
  is regenerable — `plan-state-derivable` gate enforces. Slice-stop
  with `--triggered-by plan:<id>` auto-emits `PLAN_REVISED`. New
  cockpit `plans` route with Kanban grid (Now/Next/Blocked/Done).
  New gates: `plan-state-derivable`, `kanban-coherent`.

- **Loops — ralph + plan-loop** (Phase 6) — persist-until-done
  iteration. Every iter is a real slice with `LOOP_ITERATION_*`
  events. Stuck-detection halts at two consecutive identical fail
  signatures. Max iter + cooldown read from governance tier (strict
  3/10s, standard 5/5s, relaxed 10/1s). New cockpit `loops` route.
  New gates: `loop-iteration-audit`, `loop-cooldown-respected`.

- **Coordinator as a Máddu primitive** (Phase 7) — the missing
  portability piece. `maddu coordinator <plan-id>` walks a plan's
  phases via `child_process.spawn` subprocesses passing
  `MADDU_COORDINATOR_PLAN_ID / _PHASE / _ID / _ITER` env vars. 5-iter
  cap per phase + stuck-detection. **Does NOT depend on Claude Code's
  `Agent` tool** — verified by walking a synthetic 3-phase plan via
  `--dry-run` and `--synthetic-cmd`. New events
  `COORDINATOR_STARTED/_PHASE_STARTED/_PHASE_COMPLETED/_HALTED/_COMPLETED`.
  New gate: `coordinator-phase-coherent`. (Also fixes a
  `projectPlanState` bug where COORDINATOR_* events sharing planId
  drifted state.json from spine.)

- **Blast + starter skills + autonomous skill curation** (Phase 8) —
  three bundled sub-phases:
  - 8a: new `/maddu-blast` slash command (chained no-asks autonomous
    run); `lane claim --force` flag emits `LANE_CLAIM_FORCED` for
    audit preservation.
  - 8b: 8 starter skills shipped under
    `template/maddu/skills/starter/` and seeded into `.maddu/skills/`
    on init.
  - 8c: autonomous skill candidate detector (suggest-only — never
    auto-writes a skill file). `maddu skill candidates list`,
    `from-candidate <hash>`, `candidate-reject <hash>`. New events
    `SKILL_CANDIDATE_DETECTED/_APPROVED/_REJECTED`.
  - New gates: `lane-force-discipline`, `skills-starter-pack-installed`,
    `skill-candidates-bounded`.

- **Doctor + docs sweep + tag** (Phase 9, this entry) — gate count
  rose from 32 (v1.0.5) to 45 PASS in a fresh consumer. README +
  9 canonical docs updated. Six new docs added: `28-default-tools.md`,
  `29-mcp-templates.md`, `30-governance-tiers.md`, `31-operations-log.md`,
  `32-kanban-and-plans.md`, `33-loops-and-coordinator.md`. Tagged
  `v1.1.0`.

### Hard-rule compliance audit

All 8+1 hard rules preserved by construction:
- Rule #1 (files-only): receipts ndjson, plans .md/.json, governance
  json — no DB.
- Rule #2 (append-only): all projections rebuild from events.
- Rule #3 (no hosted backend): MCP templates run local subprocesses;
  coordinator subprocess is local.
- Rule #4 (no broad new deps): zero new package.json entries.
- Rule #5 (no provider SDKs): tool wrappers + loops + plans +
  coordinator all stdlib + `child_process.spawn`.
- Rule #6 (device-bound tokens): untouched.
- Rule #7 (three-layer brand boundary): all v1.1.0 surfaces
  framework-level.
- Rule #8 (lane ownership): `--force` claim audit-logged.
- Rule #9 (auto-trigger gauntlet): loop + coordinator iterations
  emit `triggered_by` lineage; cooldown enforced; stuck-detection
  caps runaway.

Governance tiers tune operational gates only — never the 8+1 rules.

### Verification

- Fresh-consumer doctor: 45 PASS / 1 WARN / 0 FAIL at `standard`
  (with no operator-side warnings beyond the pre-existing empty
  workspace registry WARN).
- `scripts/test/layout-refusal.mjs`: 4/4 green at every phase boundary.
- `scripts/test/stress-harness.mjs --all`: 9/9 scenarios green
  (added `tool-refusals-coherent` in Phase 1).
- `scripts/test/upgrade-matrix.mjs`: 19/19 PASS (fresh + v0.16.0 +
  v0.17.1 + v0.18.0 baselines).
- Synthetic 3-phase coordinator walk: end-to-end via subprocess only —
  no Claude Code `Agent` tool invoked.

### PRs

#61 (P1 tools) · #62 (P2 MCP templates) · #63 (P3 governance) ·
#64 (P4 receipts) · #65 (P5 plans/kanban) · #66 (P6 loops) ·
#67 (P7 coordinator) · #68 (P8 blast/skills) · #69 (P9 docs/tag).

---

## [v1.0.5] · 2026-05-23 · sweep Phase-X leakage from shipped docs

Burn-in feedback: v1.0.4 fixed the default lane catalog, but operator
still saw "Phase A1 / Phase B1 / Phase B4" annotations in the Docs
route and other places. Those were Máddu's internal depth-upgrade slice
plan markers leaking through shipped documentation.

### Cleaned

- **Deleted `docs/maddu-v0.3-roadmap.md`** — Máddu's full internal v0.3
  development roadmap, four-research-report distillation, was being
  shipped to every consumer install's Docs route. This is a framework
  artifact, not user documentation. Removed from both `docs/` and
  `template/maddu/docs/`.
- `docs/02-concepts.md` — sample `--reason "Phase A1 ship"` → `"ship the approvals route"`.
- `docs/04-cockpit-tour.md` — dropped `(Phase B1 — see roadmap)` and `(Phase B4)` annotations and the cross-link to the deleted roadmap.
- `docs/08-slice-stop-ritual.md` — same `"Phase A1 ship"` → generic example reason, in both CLI and HTTP examples.
- `docs/11-runtimes-and-mcp.md` — dropped the "See also" line linking to the deleted roadmap.

Operator never sees Máddu's internal phase-plan structure again.

### Note on the catalog file in existing installs

If an existing consumer install still has the old `DEFAULT_LANE_CATALOG`
content in `.maddu/lanes/catalog.json` after `maddu upgrade` (because
the bridge was running during upgrade and re-wrote the file from its
in-memory old defaults), delete the file with the bridge stopped and
restart — `ensureCatalog` will re-seed from the v1.0.5 defaults.

### Not touched (intentional)

- `template/maddu/runtime/server.js` and `template/maddu/cockpit/cockpit.js` source comments mentioning Phase markers are organizational labels for the framework's own contributors. They ship as code comments but are not user-visible. Left as-is.

---

## [v1.0.4] · 2026-05-23 · generic default lane catalog

Burn-in feedback from snyggare: the Conductor route listed lanes like
`cockpit-shell`, `bridge-server`, `runtime-integration`, `wiki`,
`briefs`, `verification`, `shell`, with descriptions tagged `Phase A1`,
`Phase B6`, `Phase C1`, `Phase D1`. Those are **Máddu's own internal
development lanes** — the depth-upgrade slice plan structure — leaking
verbatim into every consumer install via `DEFAULT_LANE_CATALOG`. End
users were greeted by 19 empty lanes describing the framework's own
roadmap instead of their project's surfaces.

### Fix

`template/maddu/runtime/lib/defaults.mjs` `DEFAULT_LANE_CATALOG` is now
a generic minimal seed:

- `architecture` — design, planning, briefs
- `frontend` — UI, styles, client-side
- `backend` — server, APIs, data
- `infra` — build, deploy, CI, ops
- `tests` — test code and fixtures
- `docs` — documentation
- `general` — catch-all

Operators edit `.maddu/lanes/catalog.json` directly to match their own
project surfaces. `maddu upgrade` never touches an operator-edited
catalog; only the initial `maddu init` seed comes from this default.

Máddu's own contributors maintain their internal lane catalog locally
in the source repo's `.maddu/lanes/catalog.json` (gitignored) — same
as any other operator. The framework's development structure no longer
ships as a consumer's project structure.

`docs/lanes.md` (and `template/maddu/docs/lanes.md` mirror) updated to
match. `docs-in-sync` gate green.

---

## [v1.0.3] · 2026-05-21 · framework-only route hiding

Burn-in feedback from the snyggare consumer install: the `Test Status`
cockpit route is permanently empty in any consumer install because the
scripts that populate it (`scripts/test/stress-harness.mjs`,
`upgrade-matrix.mjs`, `projection-roundtrip.mjs`) only ship with the
framework source repo, not consumer scaffolds. Showing an unfillable
panel to end users is the opposite of the no-learning-curve standard.

### Fix

1. `/bridge/status` returns a new `frameworkLayout: 'source' | 'installed' | 'unknown'` field, computed from the presence of `template/maddu/runtime/` (source) vs flat `maddu/runtime/` (consumer install).
2. Cockpit `ROUTES` entries gain an optional `frameworkOnly: true` flag. The `teststatus` route is the first to use it.
3. `routesInGroup`, the palette indexer, and the hash router all filter framework-only routes when the layout isn't `source`. Deep links to hidden routes (e.g. `#/teststatus`) redirect to Conductor.
4. After the first `/bridge/status` response, if the layout differs from the boot default (`source`), the rail is rebuilt and the route bounces if it would otherwise be hidden.

### Outcome

- **Consumer installs:** Test Status no longer appears in the sidenav, the palette, or via direct hash navigation. Cleaner sidenav, no confusing empty panel.
- **Framework source repo:** Test Status still visible for contributors; populates from `scripts/test/*.mjs` runs as before.
- **Affordance available for future routes:** any cockpit surface whose data sources don't ship to consumers can mark `frameworkOnly: true` and inherit the same hiding behavior.

Small JS + one bridge field. No behavior change in the framework source repo. No state mechanics changed.

---

## [v1.0.2] · 2026-05-21 · stage-scroll hotfix

v1.0.1 introduced `#app { overflow: hidden }` to prevent the rail from
pushing the composer below viewport, but missed `min-height: 0` on the
`.stage` grid container and `.stage-body`. Without those, the `1fr`
grid track grew to the body's intrinsic content size, pushed `.stage`
past viewport, and the absolute-positioned `.stage-foot` composer
ended up below the visible area while the page itself couldn't scroll
(clipped by `#app`'s overflow).

### Fix

- `.stage` gains `min-height: 0` + `height: 100%` so the grid track is
  bounded by the parent column.
- `.stage-body` gains `min-height: 0` so its existing `overflow: auto`
  actually activates inside the 1fr track.

Two lines of behavior change. Composer anchored. Stage-body scrolls.

### Verification

- Test consumer doctor: green at v1.0.1 baseline; CSS-only change does
  not affect any doctor gate.
- Manual smoke at 1280×720 + 1280×600: composer visible at viewport
  bottom; route content scrolls inside the stage-body; rail still
  scrolls inside its own column.

---

## [v1.0.1] · 2026-05-21 · cockpit UX patch

Post-v1.0.0 burn-in revealed three real cockpit-UX issues. Single-PR fix,
cockpit only — no state mechanics, no new dependencies, no breaking
surfaces.

- **Composer footer anchors to viewport for real.** The 37-route rail
  could overflow `.rail` on short viewports and push the page past
  `100vh`, dragging the absolute-positioned `.stage-foot` composer
  below the fold. Now `#app` is `overflow: hidden`, `.rail` has
  `min-height: 0`, and `.rail-nav` declares `min-height: 0` + scrolls
  internally. Page never scrolls — only panes do.
- **Sidenav groups collapse by default.** Opening the cockpit shows
  ~7–10 visible rows instead of 37 — only the group containing the
  current route is expanded; the rest are collapsed headers with a
  route-count badge (`OPERATE · 11`). Operator toggles persist in
  `localStorage.maddu.railGroups`. Group headers are real `<button>`s
  with `aria-expanded`. Navigation into a collapsed group auto-expands
  it.
- **Recent-routes group above the standard nav.** Top of the rail now
  has a synthetic "Recent" group showing the operator's last 5 visited
  routes (excluding the current one). Backed by
  `localStorage.maddu.routes.recent`. Skipped when the operator has
  visited fewer than 2 distinct routes.

Route ids, palette indexing, deep links, and the mobile dock are
untouched. All 8+1 hard rules + the gates remain green.

---

## [v1.0.0] · 2026-05-21 · stable, declared

**Same commit as v0.19.2. No code change.** This tag is the public
declaration that Máddu is now stable, earned by a real-world burn-in
in a foreign project (`snyggare`) where the full pipeline shipped real
code end-to-end using only slash commands.

### What v1.0.0 commits to

The following surfaces are stable across the v1.x line. Changes that
break any of them require a major version bump.

- **The 8+1 hard rules** (now all permanent — see `docs/hard-rules.md`):
  files-only state · append-only spine · no hosted backend · no broad
  new deps · no provider SDKs in framework code · device-bound tokens
  · three-layer brand boundary · lane ownership · every auto-trigger
  crosses the gauntlet.
- **Spine NDJSON event format** — event ids (`evt_<14-digit>_<6-hex>`),
  the `EVENT_TYPES` registry, segment rotation, projection determinism.
- **Slash command names** — the 13 framework-owned `/maddu-*` commands
  (autopilot · plan · review · team · advise · status · cost · skill ·
  note · cancel · help · doctor · suggest).
- **Cockpit routes** — all routes listed in `docs/04-cockpit-tour.md`.
  New routes may be added; existing route ids are stable.
- **CLI surface** — every `maddu <cmd>` verb documented in
  `docs/03-cli-reference.md`. Flag additions are non-breaking; flag
  removals/renames require a major bump.
- **`MADDU.md` / `CLAUDE.md` / `AGENTS.md` marker discipline** —
  `<!-- BEGIN MADDU v1 --> / <!-- END MADDU v1 -->` is the v1 marker;
  v2 would migrate to `MADDU v2` markers and provide an automatic
  upgrade path.

### Verification (recorded in spine + this release)

- Foreign-repo burn-in (`snyggare`) shipped a real `/health` endpoint
  end-to-end via `/maddu-autopilot`. Pipeline + slice-stop + lane
  release all clean.
- Doctor in foreign repo: **32 PASS · 1 WARN · 0 FAIL.**
- Token ledger populated from real Claude Code transcripts:
  **53 668 calls · 56 031 565 output tokens · 0 unreported.**
- All v0.19.1 regressions verified clean in re-burn.
- All 8 hard rules + (now permanent) rule #9 enforced by gates.
- Stress harness (8 scenarios) + upgrade matrix (4 source versions)
  both pass.

### Roadmap

v1.x evolves additively. New features land as minor bumps. Breaking
changes require a v2.0 with documented migration. The framework's
shape is now fixed; the work ahead is depth and polish.

---

## [v0.19.2] · 2026-05-21 · final-polish patch series

A two-PR follow-up to v0.19.1, closing the last items surfaced by the
re-burn-in v2 in `snyggare`. No v1.0 commitment yet — user-driven
ceremony after the final re-burn.

### PR-A — Slash output rendering discipline

The five display-oriented slash commands (`/maddu-help`,
`/maddu-doctor`, `/maddu-status`, `/maddu-cost`, `/maddu-skill`) said
"print verbatim" but Claude Code's bash-output view collapses long
output behind `… +N lines (ctrl+o to expand)` — the agent treated the
collapsed display as compliant and the operator never saw the content.
The unconditional "what are you trying to do?" follow-up also fired
even when the operator's previous message already had context.

- **Re-print pattern** — every display-oriented body now instructs the
  agent to re-print the CLI output inside a fenced markdown code block
  in its reply. That's the only way the roster, doctor verdicts,
  brief, ledger, or skill list end up visible to the operator.
- **Conditional follow-up** — the "what are you trying to do?"
  question only fires when the operator typed the slash command with
  no surrounding intent. If the previous message gave context, the
  agent points at the matching row in one line.
- **`slash-command-display-pattern` doctor gate** asserts the
  canonical phrase "re-print" is present in each of the five
  display-oriented templates so a regression fails CI.

### PR-B — Cockpit nav completeness

The v0.18 `Pipelines` cockpit route bundled teams + pipelines + cost +
the slash cheatsheet into one 4-card grid. v0.19 added skill injection
+ model routing + test status data without dedicated nav, so operators
had to know to click "Pipelines" to find their token cost. v0.19.2
splits each into its own sidebar entry:

- **`#pipelines`** — narrowed to actual pipeline runs only. Reads
  `GET /bridge/pipelines`.
- **`#cost`** — Token + call rollup per runtime. Reads `GET /bridge/cost`.
- **`#advisors`** — Advisor artifact list (newest first), with refusal
  flag and first-200-char preview. Reads `GET /bridge/advisors`.
- **`#skillinjections`** — Log of `SKILL_INJECTED` events. Reads
  `GET /bridge/skill-injections`.
- **`#modelrouting`** — Per-runtime + per-lane + per-pipeline
  `modelPreference`. Three panels. Reads `GET /bridge/runtimes`,
  `GET /bridge/lanes`, `GET /bridge/pipelines`.
- **`#teststatus`** — Last-run timestamps for the stress harness and
  upgrade matrix; `warn (Nd)` tag if older than threshold. Reads
  `GET /bridge/test-status`.

The slash-command cheatsheet moved from the bundled Pipelines route to
a small "Slash-command quick reference" card on `#conductor`.

### Docs sweep

- `docs/04-cockpit-tour.md` — documents the six new routes.
- `docs/22-slash-commands.md` — documents the re-print pattern and
  the new doctor gate.
- `docs/25-model-routing.md` — points at the new Model Routing
  cockpit panel.
- All updated docs mirrored to `template/maddu/docs/`.

### Doctor

Test-consumer doctor: 32 PASS · 1 WARN · 0 FAIL (the workspace-registry
WARN is acceptable). The new `slash-command-display-pattern` gate
brings the total to 32 from the v0.19.1 baseline of 31.

---

## [v0.19.1] · 2026-05-21 · burn-in patch series

A tight follow-up to v0.19.0, fixing 11 real friction findings surfaced
during the first burn-in inside an unrelated foreign repo (the user's
`snyggare` project). Four bundled PRs, no v1.0 commitment yet.

### PR-A — UX shell hygiene

- **Slash-command files installed raw, not marker-wrapped.** Claude
  Code's frontmatter parser requires `---` on line 1; the previous
  `<!-- BEGIN MADDU v1 -->` marker was clobbering the parsed
  `description:`. Framework owns these files in their entirety; operator-
  authored slash commands belong in sibling files NOT prefixed
  `maddu-`. `slash-commands-installed` gate updated to verify raw byte-
  equality and surface legacy marker installs as drift.
- **Display-not-summarize discipline** added to the slash bodies that
  surface CLI output verbatim: `/maddu-help`, `/maddu-status`,
  `/maddu-cost`, `/maddu-doctor`, `/maddu-skill`.
- **`[phase N]` tags removed** from `maddu help` — every advertised
  verb now ships.
- **New `/maddu-suggest`** slash command dispatches `./maddu/run
  suggest` for vague-task triage. Help roster, intent-routing tables
  (MADDU.md + CLAUDE.section.md + AGENTS.section.md), and docs/22 all
  updated.
- **`maddu skill add`** works as an alias for `create` (help text
  already advertised it). A new doctor gate
  `help-roster-matches-cli` walks every `under:` verb in the help
  ROSTER and verifies it resolves to a real subcommand.

### PR-B — CLI consistency

- **`MADDU_SESSION_ID` env-var fallback** added to `lane claim`,
  `lane release`, `session heartbeat`, `session close`, and
  `slice-stop` (matching `advise` / `team open` / `pipeline run` which
  already honored the env in v0.19.0). Documented in
  `template/maddu/CLAUDE.md`.
- **`slice-stop` accepts a positional first argument as the summary**
  when `--summary` is omitted. Forgives the natural
  `slice-stop --session X "SLICE STOP: ..."` agent invocation.

### PR-C — Honesty + observability

- **`maddu cost` empty-state honesty.** The output now explains WHY
  the ledger is empty (the bridge only sees workers it spawns; direct
  Claude Code / Codex CLI sessions aren't captured because the bridge
  isn't their parent process). Points operators at the new import
  path.
- **`maddu usage import --from claude-code`** walks
  `~/.claude/projects/<slug>/*.jsonl` and emits one
  `TOKEN_USAGE_REPORTED` event per assistant turn with
  `source: "claude-code-transcript"`. Idempotent via `importHash`
  (sessionUuid + lineNumber + usage payload). Flags: `--dry-run`,
  `--since <iso>`, `--session <substring>`. Pure stdlib parsing — no
  provider SDKs. Full doc at
  [`docs/27-transcript-import.md`](docs/27-transcript-import.md).
- **Port-4177 doctor gate** now probes `/bridge/status` when the port
  is in use. If our bridge owns it, the gate PASSes with "our bridge
  is running on 127.0.0.1:4177"; otherwise it WARNs as before. False-
  positive eliminated.
- **Six new read-only bridge endpoints** for cockpit nav:
  `/bridge/teams`, `/bridge/cost`, `/bridge/advisors`,
  `/bridge/pipelines`, `/bridge/skill-injections`, `/bridge/test-status`.
  Pure projection-slice serializers, no state changes.

### PR-D — Onboarding pivot + docs sweep + release

- **`maddu init` post-install message** leads with the slash-command
  surface (`/maddu-help`, `/maddu-suggest`, `/maddu-autopilot`); the
  verbose CLI moves to a "Power users / scripts" subsection.
- **README + 8 numbered docs** touched up for the v0.19.1 surface
  (slash-command count 12 → 13; raw-frontmatter rationale; new
  `usage import` command; new bridge endpoints).
- **New doc**: `docs/27-transcript-import.md` covers `maddu usage
  import --from claude-code` in full.
- **`v0.19.1` tag** pushed to origin.

---

## [v0.19.0] · 2026-05-21 · completeness and hardening

**Stable, complete.** v0.18 shipped the polished UX surface backed by partially-wired primitives — token ledger was infrastructure-only, advisors were 50% wired, skill auto-injection and model routing were deferred, stress + upgrade test coverage was thin. v0.19 closes every gap. Workers self-report token usage, advisors actually spawn the provider subprocess, skill bodies are auto-injected into orientation digests, lanes and pipeline stages can prefer specific models, and synthetic stress + upgrade-matrix harnesses keep concurrency and upgrade invariants honest.

This is the **completeness + hardening release** on the path to v1.0.0. Purely additive. No hard rule violations. No new npm dependencies. Hard rule #9 (every auto-trigger crosses the gauntlet) is promoted candidate → permanent after a v0.18 slice + Phase 5 stress harness + upgrade-matrix coverage all produced zero false-positive refusals.

Shipped in 7 phases off `main`:

- **Phase 1 — worker token-usage emission.** Closes the v0.18 ledger gap. New wrapper scripts at `template/maddu/runtime/lib/runtimes/{claude,codex,gemini,_wrapper-common}.mjs` parse provider stream-json from inside the worker subprocess and emit `TOKEN_USAGE_REPORTED` events directly to the spine. Coverage: claude-code full (input/output/cache_read/cache_creation), codex partial (input + output where stable), gemini count-only with `unreportedTokens: true`. Runtime descriptors gain `wrapper` + `wrapperPath` opt-in; `spawnWorker` routes through `node <wrapper> <binary> [args...]` when set. Wrappers are transparent on parse failure (log to `.maddu/state/worker-logs/<workerId>.wrapper-errors.log`, never block the worker). New gate `token-ledger-populated` (warn) flags workers exiting clean with empty ledger. `token-ledger-schema` upgraded warn → critical. Hard rule #5 stays preserved by construction: framework never imports an SDK; the wrapper is a standalone JSON-stream parser inside the worker process.
- **Phase 2 — cross-runtime advisor subprocess spawn.** Closes the v0.18 advisor gap. `commands/advise.mjs` extends from stub-write to: resolve runtime descriptor (or built-in defaults for `claude`, `codex`, `gemini`), auth-check via `lib/auth.mjs#listProviders()` (refuse with exit 2 + actionable error when not signed in; bypassable with `--no-auth-check`), spawn the provider binary with `${prompt}` substitution, capture stdout into the artifact body after the header, emit `ADVISOR_INVOKED` (with `kind: 'advisor'`, binary, authProvider, timeoutSec) then `ADVISOR_ARTIFACT_WRITTEN` (with status + exitCode). 5-minute default timeout; override with `--timeout-sec N`. Hard rules #5 and #8 stay preserved.
- **Phase 3 — skill auto-injection.** Ships the v0.18 deferred feature. `.maddu/skills/*.md` frontmatter gains optional `triggers: [str]` and `tags: [str]` arrays (backward compatible). `maddu brief --for-agent --triggers a,b --tags x,y` matches skills against the active slice (lane claims auto-fold into both triggers and tags; active session focus folds into tags), ranks by trigger hits → tag hits → updated DESC, appends up to 3 matching bodies inline under a clearly-marked `## Skills injected for this slice` section, and emits one `SKILL_INJECTED` event per call that injects ≥1 skill. Cap enforced at 3 skills + 8 KB per skill = 24 KB total. New event types `SKILL_INJECTED` and `SPINE_LINE_REJECTED` (Phase 5 reserved). New gate `skill-injection-bounded` (critical) verifies the cap on every projection.
- **Phase 4 — model routing hints.** Ships the v0.18 deferred feature. `modelPreference` field on `.maddu/runtimes/<name>.json` descriptors, `.maddu/lanes/catalog.json` lane entries, and `.maddu/config/pipelines/*.json` stage definitions. May be a flat string or an object keyed by `default | plan | exec | verify | review`. Resolution precedence in `spawnWorker`: per-spawn override > pipeline stage > lane > runtime descriptor. Framework emits `MADDU_MODEL_HINT=<value>` env to the spawned worker; the worker decides whether to honor it (rule #5 preserved — framework makes zero SDK calls). New exports `resolveModelHint` + `validateModelPreference` + `VALID_MODEL_STAGES`. New gate `model-hint-shape` (safety) validates descriptors / lanes / pipelines.
- **Phase 5 — synthetic stress harness.** New `scripts/test/stress-harness.mjs` with 8 self-contained scenarios: `team-10-disjoint`, `team-10-collision`, `pipeline-halt-mid-stage`, `advisor-cannot-claim`, `large-spine-replay` (5001 events, < 10s projection rebuild), `malformed-event-recovery` (20 garbage NDJSON lines tolerated), `suggest-ambiguous`, `upgrade-marker-collision`. Each writes a JSON report under `.maddu/state/stress-reports/`. Aggregate runtime ~7.5s on dev hardware (budget 60s). Records last-run at `.maddu/state/stress-last-run.json` so the new gate `stress-harness-recent` (warn) can flag 30d+ coverage drift.
- **Phase 6 — upgrade-path matrix.** New `scripts/test/upgrade-matrix.mjs` with 4 scenarios: `fresh-install`, `from-v0.16.0`, `from-v0.17.1`, `from-v0.18.0` — all → v0.19.0. Uses `git worktree add --detach` to materialize each prior tag, runs that tag's `bin/maddu.mjs init` into a tmp consumer, then runs current source's `upgrade --force` and asserts doctor green. All 4 paths converge to 29 doctor passes with 0 fails. Each scenario writes a JSON report. New gate `upgrade-matrix-recent` (warn) flags drift since the last `maddu.json` install.
- **Phase 7 — doctor + docs sweep + tag.** Six new gates land: `token-ledger-populated`, `token-ledger-schema` (severity bump), `skill-injection-bounded`, `model-hint-shape`, `stress-harness-recent`, `upgrade-matrix-recent`. Doctor: **25 → 30 PASS** in the test consumer. README + 8 numbered docs refreshed. Three new docs ship: `docs/24-skills-auto-inject.md`, `docs/25-model-routing.md`, `docs/26-stress-testing.md`. Hard rule #9 promoted candidate → permanent in `docs/hard-rules.md`. CHANGELOG entry. Tag `v0.19.0` and push.

**Backward-compat.** Existing v0.16 / v0.17.1 / v0.18.0 consumers acquire the entire v0.19 surface by running `maddu upgrade`. Five new framework-managed files land under `template/maddu/runtime/lib/runtimes/` (the three wrappers + `_wrapper-common.mjs`), six new gates under `template/maddu/runtime/gates/builtin/`, the projection grows a `skillInjections` slot, `EVENT_TYPES` gains `SKILL_INJECTED` and `SPINE_LINE_REJECTED`. No spine surgery; pre-v0.19 spines remain readable. The upgrade-matrix harness verifies this on every run.

**What this release deliberately does NOT do.** No terminal HUD (cockpit covers live state). No tri-model synthesis (single-runtime advisor is the baseline). No plugin marketplace. No lifecycle hooks (gates + events cover post-facto). No streaming usage updates in the cockpit (tokenLedger projection rebuilds on read; live-update SSE is a v1.x explore).

**Verified end-to-end:** test consumer doctor 30 PASS · 1 WARN · 0 FAIL; layout-refusal 4/4; projection-roundtrip OK; token-wrapper 20/20; advise-spawn 16/16; skill-injection 16/16; model-hint 17/17; stress-harness 8/8 (22 assertions, 7.5s); upgrade-matrix 4/4 (19 assertions, ~5s); docs-in-sync gate green; no new npm dependencies; no SDK imports in framework code.

**v1.0.0 path.** v0.19.0 is the last coordinator-driven release before v1.0. The user runs Phase 8 — install Máddu from `v0.19.0` into a real foreign project (not the test consumer, not the source repo), ship one real slice end-to-end using only slash commands, capture friction in `.maddu/burn-in-report-v0.19.md`. If burn-in surfaces blocking friction → v0.19.x patch series → re-burn-in until clean. If burn-in goes clean → tag `v1.0.0` on the same commit as `v0.19.<latest>` with no code change. v1.0 is the public "stable" declaration: 8+1 hard rules committed to, spine NDJSON format stable, slash command names stable, cockpit routes stable.

---

## [v0.18.0] · 2026-05-21 · no-learning-curve UX shell

**Zero learning curve. Maximum power.** v0.17 made governance live by reducing session registration to one keystroke. v0.18 takes the same principle to every operation: an operator working in Claude Code or Codex CLI can type `/maddu-autopilot ship the login form` (or just *"ship the login form"* in natural language) and Máddu does the right thing — register the session, suggest the right lane, claim it, walk a plan-exec-verify-fix pipeline, slice-stop — without typing a single `--flag`. The verbose `maddu <cmd>` CLI stays first-class for scripts and CI; slash commands are the interactive surface.

OMC-inspired (Oh-my-claudecode), Máddu-shaped. The UX shell is **agent-side text plus markdown slash commands**, not a framework parser. The LLM does the natural-language routing the same way it does any other decision — preserving rule #5 (no provider SDKs in framework code) by construction.

Shipped in 7 phases off `main`:

- **Phase 1 — slash-command install mechanics.** `commands/_agent-files.mjs` gains `syncSlashCommands(repoRoot, frameworkRoot)`. `maddu init` and `maddu upgrade` create `.claude/commands/` and `.codex/commands/` and (in later phases) populate them with marker-wrapped `maddu-*.md` files. Operator-authored slash commands without the `maddu-` prefix are filtered out and never touched. New `SLASH_COMMANDS_SYNCED` event. New built-in gate `slash-commands-installed` (safety) verifies both dirs exist and (when templates ship) each `maddu-*.md` is present in both surfaces with marker-block body byte-equal to the template.
- **Phase 2 — intent-routing instructions in agent files.** `MADDU.md`, `CLAUDE.md`, `AGENTS.md` gain a "When the operator says X, do Y" table mapping phrase shapes ("autopilot …", "ship …", "plan …", "status", "tokens") to `/maddu-*` slash commands. Pure text instruction — the LLM classifies; no framework parser. The table degrades gracefully: if a slash command isn't installed yet in this repo, the agent falls back to `./maddu/run help` and the verbose CLI.
- **Phase 3 — `maddu help` + `maddu suggest` + `/maddu-help` + `/maddu-doctor`.** New `commands/help.mjs` renders a topic-grouped roster of every slash command with one-line descriptions, underlying CLI mapping, and phase tags (`--topic`, `--format json` supported). New `commands/suggest.mjs` — pure-local string-match heuristic with stopword filtering, whole-word token matching against lane id + scope, and recency tie-breaks from the spine. Deterministic by construction (gate enforces). Flags `--task "<text>"`, `--emit-lane`, `--emit-command`, `--json`. First two slash commands ship: `/maddu-help.md` (1.4 KB) and `/maddu-doctor.md` (1.2 KB).
- **Phase 4 — architectural backbone.** The OMC-parity primitives behind the friendly surface. 13 new event types (`TEAM_OPENED`, `TEAM_LANE_ALLOCATED`, `TEAM_MEMBER_JOINED`, `TEAM_MEMBER_LEFT`, `TEAM_CLOSED`; `PIPELINE_STARTED`, `PIPELINE_STAGE_ENTERED`, `PIPELINE_STAGE_EXITED`, `PIPELINE_COMPLETED`, `PIPELINE_HALTED`; `ADVISOR_INVOKED`, `ADVISOR_ARTIFACT_WRITTEN`; `TOKEN_USAGE_REPORTED`). 4 new projection slots (`teams`, `pipelines`, `advisors`, `tokenLedger`). 4 new commands: `maddu team open|status|close` (pre-allocates disjoint lanes for fan-out work), `maddu pipeline run|list` (walks declarative stages; bookkeeper only — the LLM executes intents), `maddu advise <runtime> "<prompt>"` (non-claiming advisor; writes an artifact stub, never imports an SDK), `maddu cost --by session|day|runtime|model` (token rollup with honest `--unreported-count`). 4 new gates: `rule-8-team-lane-disjoint` (critical), `pipeline-schema-valid` (safety), `token-ledger-schema` (warn), `advisor-non-claiming` (critical). Built-in pipeline `plan-exec-verify-fix.json` seeded by both init and upgrade.
- **Phase 5 — the 10 remaining slash commands.** `/maddu-autopilot`, `/maddu-plan`, `/maddu-review`, `/maddu-team`, `/maddu-advise`, `/maddu-status`, `/maddu-skill`, `/maddu-cost`, `/maddu-cancel`, `/maddu-note`. Each ≤ 2 KB, marker-wrapped, dispatches only existing `maddu <cmd>` CLI verbs. Total surface: 12 slash commands × 2 install targets = 24 marker-wrapped files. Discipline notes are baked into every command — "tell the operator which command you picked", "never silently dispatch", "never claim two lanes", "advisors never claim".
- **Phase 6 — cockpit reflection.** One new cockpit route `#pipelines` with a 4-card grid: Teams (`projection.teams`), Pipelines (`projection.pipelines`, last 10 with stage trail), Cost ledger (`projection.tokenLedger` rolled up by runtime, unreported count surfaced as a tag), and the slash-command cheatsheet. Purely additive — no existing route touched. Minimal additive CSS uses only existing tokens.
- **Phase 7 — doctor + docs sweep (mandatory).** Two new gates land: `intent-routing-current` (safety) verifies the v0.18 routing section is present in MADDU.md/CLAUDE.md/AGENTS.md; `suggest-engine-deterministic` (warn) runs `maddu suggest --emit-lane` twice against 4 fixed tasks and fails if results drift. Doctor moves to **25 PASS** in the test consumer. README + 8 numbered docs refreshed; two new docs ship — `docs/22-slash-commands.md` (full reference: invocation, arguments, underlying CLI mapping, marker discipline) and `docs/23-natural-language-routing.md` (the intent-routing pattern as standalone documentation for plugin authors).

**Backward-compat.** Existing v0.17.1 consumers acquire the entire v0.18 surface by running `maddu upgrade`: 13 framework-managed files land under `maddu/agent-files/commands/` (`README.md` + 12 slash commands), 4 new gates under `maddu/runtime/gates/builtin/`, the projection grows 4 new slots, and 6 new commands appear in `maddu/commands/`. `.claude/commands/` and `.codex/commands/` are created (or refreshed) with 12 marker-wrapped files each. `.maddu/config/pipelines/plan-exec-verify-fix.json` is seeded if absent (operator edits preserved). The 3 repo-root agent files gain a routing-table section between their existing markers. No spine surgery; pre-v0.18 spines remain readable.

**What this release deliberately does NOT do.** No terminal HUD (Windows escape-code fragility; cockpit covers live state). No tri-model synthesis (`/ccg` equivalent — single-runtime advisor ships first). No skill auto-injection (the `/maddu-skill` surface lists/searches today). No model routing hints (`MADDU_MODEL_HINT` env). No framework-level magic-keyword parser (LLM-level classification covers it without a code-level parser). No lifecycle hooks (gates + events cover post-facto). No plugin marketplace (Máddu is a framework, not a plugin host).

**Verified end-to-end against a fresh v0.17.1 → v0.18.0 upgrade in the test consumer:** doctor reports 25 PASS · 1 WARN · 0 FAIL; layout-refusal test 4/4 scenarios; all 4 backbone commands exercised cleanly (`team open → status → close`, `pipeline run`, `advise claude`, `cost`); spine verify 0 fails; docs-in-sync gate green; intent-routing-current green; suggest-engine-deterministic green across 4 fixed tasks; no new npm dependencies; no SDK imports in framework code.

## [v0.17.1] · 2026-05-20 · bulletproof init/upgrade refusal

**Patch: a real bug surfaced by user testing.** Running `./maddu/run init` (or `upgrade`) via a *consumer install's* bundled CLI used to either crash mid-way with `ERR_MODULE_NOT_FOUND` on `defaults.mjs` (after creating a half-installed `.maddu/` skeleton — non-recoverable without manual cleanup) or silently no-op while reporting success. Root cause: `commands/_manifest.mjs` resolves `TEMPLATE_MADDU` as `<FRAMEWORK_ROOT>/template/maddu/`, which exists in the source repo but **not** in a consumer install (the install flattens that prefix on the way in so the bridge can find `runtime/` at `maddu/runtime/`).

The fix is refuse-with-actionable-error, not magic-passthrough. A consumer install copying onto itself is meaningless; trying to make it "work" would mask future bugs. v0.17.1 detects the layout up front and exits with exit code 2 + a clear message naming the right way to invoke the command (`npx github:frdyx/maddu init` or via a source clone).

- **New `detectFrameworkLayout()` + `requireSourceLayout(commandName)`** helpers in `commands/_manifest.mjs`. Detect `source` (template/maddu/ present) vs. `installed` (runtime/ present directly under FRAMEWORK_ROOT) vs. `unknown`.
- **`maddu init`** refuses early when invoked from an installed layout. Was: crashed mid-way after creating a half-installed `.maddu/`. Now: exit 2 with a 12-line error naming the three correct ways to invoke.
- **`maddu upgrade`** refuses early when invoked from an installed layout. Was: silently no-op while reporting `Upgraded to vX.Y.Z` with 0 updates. Now: exit 2 with the same clear error.
- **New built-in gate `framework-layout`** (severity `critical`) surfaces the detected layout in `maddu doctor` output (e.g. `PASS framework layout — framework layout: installed`). FAILs on `unknown` so a broken/partial extraction surfaces immediately. Doctor in consumer installs goes 17 → 18 pass.
- **New end-to-end test** at `scripts/test/layout-refusal.mjs` locking the behavior down across 4 scenarios: source init succeeds, consumer-install init refuses, consumer-install upgrade refuses, source upgrade from inside consumer (via source bin) succeeds.

Verified by rebuilding `maddu-test-consumer` from scratch with v0.17.1: doctor reports `PASS framework layout: installed`, `./maddu/run init` refuses with exit 2 + full error, `./maddu/run upgrade` refuses with exit 2 + full error, and `node /path/to/source/bin/maddu.mjs upgrade` from inside the consumer still works correctly.

## [v0.17.0] · 2026-05-20 · agent-native bootstrap

**Turns dormant governance into live governance.** v0.16 layered governance on top of a spine that, in practice, no agent was writing to — operators had to remember to `maddu session register`, and most never did. v0.17 removes that friction. A code agent (Claude Code, Codex CLI, Gemini CLI, or any future LLM CLI that reads a root-level agent file) opening in a Máddu repo now learns the framework from a single canonical brief, auto-registers a session (with parent-session tree provenance for spawned children), uses Máddu primitives idiomatically, and is automatically cleaned up when stale — all preserving hard rules 1–8, candidate #9, and the project's existing agent-file content via merge-marker discipline.

Shipped in 8 phases off `main`:

- **Phase 0 — event types reserved.** 4 new types in `EVENT_TYPES`: `SESSION_AUTO_REGISTERED`, `SESSION_STALE_DETECTED`, `SESSION_AUTO_CLOSED`, `AGENT_FILE_SYNCED`. Optional `parentSessionId` extension to `SESSION_REGISTERED.data`. Full payload schemas in `docs/research/governance-event-taxonomy.md`.
- **Phase 1 — `maddu register`.** Zero-keystroke session bootstrap. Defaults to cwd-basename label, `implementer` role. Idempotent on `MADDU_SESSION_ID` (no-op when the referenced session is still active). Tier: mutating, autoTrigger: allowed.
- **Phase 2 — session tree provenance.** New `sessionsTree` projection slot keyed by sessionId, capturing `parentSessionId`, `source`, `state`, `lastHeartbeatAt`. New `maddu session tree [--root <id>]` ASCII renderer. `verify-spine` rejects orphan `parentSessionId` references (issue code: `unknown_parent_session`).
- **Phase 3 — `autoRegister: true` runtime descriptors.** When a runtime descriptor opts in, `spawnWorker` mints a fresh child session per spawn (linked to the caller as parent) and threads it via `MADDU_SESSION_ID`. A parent that fans out N workers shows N distinct branches in the tree instead of N events stamped with the parent's actor id. Backward-compat: descriptors without the flag behave identically to v0.16.
- **Phase 4 — root-level agent files.** `MADDU.md` (canonical, ~140 lines), `CLAUDE.md`, `AGENTS.md` ship at every consumer's repo root. Marker discipline (`<!-- BEGIN MADDU v1 -->` / `<!-- END MADDU v1 -->`) preserves operator content; only the section between markers is Máddu-owned. New built-in gate `agent-file-current` (severity `safety`) hashes the canonical templates against repo-root content and fails doctor on drift. New helper `commands/_agent-files.mjs` with three operations: `createIfAbsent`, `mergeBetweenMarkers`, `readSection`. Tested across 4 scenarios (clean install, existing file without markers, existing file with markers, idempotency).
- **Phase 5 — stale-session janitor.** Inline-on-projection-read (no new timer thread). Emits `SESSION_STALE_DETECTED` after `staleAfterMs` (default 30 min) and `SESSION_AUTO_CLOSED` after `autoCloseAfterMs` (default 4 hr). `SESSION_AUTO_CLOSED` carries `triggered_by:{kind:'janitor',id:'sessions',...}` for candidate rule #9 compliance. Config at `.maddu/config/janitor.json` (optional — baked-in defaults); trigger allowlist seeded in `.maddu/config/triggers.json`. Idempotent: re-reads don't churn the spine.
- **Phase 6 — `brief --for-agent` + `GET /bridge/agent-context`.** Single self-contained turn-start snapshot agents can read without opening multiple files. Same data, two transports: plain text via CLI, JSON via HTTP. Surfaces goal, phase, active session, open follow-ups, lane claims, recent slice-stops, session-tree summary, janitor counters. Pure builder; deterministic given the same projection.
- **Phase 7 — cockpit + docs + skills.** New "Sessions" panel in cockpit `#orientation` shows the live session tree (parent → child) and janitor activity. New `docs/21-agent-onboarding.md` (mirrored to bundled docs via the v0.16.2 docs-in-sync gate). Two new skill drafts: `docs/skills/auto-register-skill.md`, `docs/skills/agent-file-merge-skill.md`.

**Backward-compat.** Existing v0.16.2 consumers acquire the entire v0.17 surface by running `maddu upgrade`: 5 new framework-managed files land under `maddu/agent-files/` and `maddu/runtime/lib/{janitor,agent-context}.mjs`; the 3 repo-root agent files are created (or merged via marker discipline); `.maddu/config/triggers.json` gets the `janitor:sessions` allowlist entry; the `agent-file-current` gate goes live (doctor moves from 16 pass → 17 pass). No spine surgery, no manual fixup, pre-v0.17 spines remain readable.

**What this release deliberately does NOT do.** No auto-claim of lanes on register (hard rule #8 risk). No Cursor / Continue / non-`.md` agent files (the marker pattern is convention-agnostic — extend the helper later). No LLM API calls from framework code (rule #5). No new npm dependencies (rule #4). No daemon or scheduler thread (architecture invariant preserved).

Verified end-to-end against a fresh v0.16.2 → v0.17.0 upgrade in the test consumer: spine verify 0 fails; doctor 17 pass · 1 warn · 0 fail; projection round-trip 0; docs-in-sync gate green; agent-file-current gate green; no DPS-domain leak; no SDK leak; no `package.json` dep additions.

## [v0.16.2] · 2026-05-20 · docs-in-sync gate

**Closes the maintenance loop opened by v0.16.1.** That patch bundled `docs/*.md` into `template/maddu/docs/` so consumer installs render the docs popup. The discipline of keeping the two trees byte-equal was left manual. This patch adds a built-in gate that fails `maddu doctor` on drift.

- **New gate** `docs-in-sync` at `template/maddu/runtime/gates/builtin/docs-in-sync.mjs`. Severity `safety`. For every `.md` in `docs/`, hashes both the source and the bundled copy (after CRLF→LF normalization) and fails on any pair that differs, plus any orphan in either tree.
- **No-ops in consumer installs.** Detects `template/maddu/docs/` absence at the consumer's repo root and returns `ok:true` with `skipped` in the message — `maddu doctor` stays green for end users.
- **Failure message names the fix:** `docs out of sync: 1 drifted — run \`cp docs/*.md template/maddu/docs/\` and commit`. Evidence includes the explicit `drifted` / `onlyInSource` / `onlyInTemplate` lists.
- **20-governance.md** built-in gates table updated to list the gate.

Verified end-to-end: source repo in-sync → PASS; introduce drift → FAIL with explicit file list; revert → PASS; consumer install → PASS (no-op skip).

## [v0.16.1] · 2026-05-20 · ship docs to consumers

**Patch: the in-cockpit docs popup was empty in every consumer install since v0.10.** Root cause: `template/maddu/docs/` didn't exist, so `maddu init` shipped no markdown files. The bridge's `resolveDocsDir()` walked two candidate paths (`<consumer>/maddu/docs/` and the dev-only fallback `<source>/docs/`); neither resolved in a consumer install, and `/bridge/docs` returned `[]`. The "Take the five-minute tour →" header link and the `?` keyboard shortcut both landed on an empty docs page reading "No markdown files found under docs/".

This patch mirrors the 27 top-level `docs/*.md` files into `template/maddu/docs/` so they ship with every install. `frameworkOwnedFiles()` already walks the template tree — no code change in init or upgrade was needed; the files are picked up automatically.

- **Affects:** every consumer install since the docs popup was added. `maddu upgrade` brings the docs in without re-installing.
- **Doesn't ship:** `docs/research/`, `docs/releases/`, `docs/sessions/`, `docs/images/`, `docs/skills/` — those are repo-internal historical/draft material, not end-user docs.
- **Maintenance note:** keep `docs/*.md` and `template/maddu/docs/*.md` in sync at release time. A future patch may add a `docs-in-sync` gate to enforce this automatically.

## [v0.16.0] · 2026-05-20 · governance layer

**Máddu can be dropped into an arbitrary codebase and within a day provide
turn-start orientation, an extensible gate stack, optional scope discipline,
auto-trigger safety, and a post-stop review lane — with hard rules 1–8 still
passing, no new npm dependencies, and no domain content leaked into framework
code.** Six slices that layer governance onto the existing substrate without
changing what the substrate is.

Substrate is unchanged: append-only NDJSON spine, projections rebuilt on read,
approvals with `triggered_by` provenance, runtime descriptors, schedules,
multi-workspace, spine verify, doctor. Every layer below is **opt-in** — a
repo that ignores any phase keeps working exactly as before.

### Phase 0 — Foundation

**Zero behavior change. Reserves the schema.** Twelve new event types reserved
in `EVENT_TYPES`; optional `kind` field added to runtime descriptors. Event
taxonomy published at `docs/research/governance-event-taxonomy.md`. New
determinism test at `scripts/test/projection-roundtrip.mjs` proves every
projection file is byte-equal after deletion + rebuild.

### Phase 1 — Orientation digest

**Agents get one turn-start file instead of N.** `maddu goal set|show`,
`maddu phase set|show`, `maddu brief [--json|--drain]`. Goal and phase are
spine events (`GOAL_DECLARED`, `PHASE_DECLARED`); orientation and handoff
markdown are deterministic projections at `.maddu/state/orientation.json`
and `.maddu/state/handoff.md`. New bridge `GET /bridge/orientation`.

### Phase 2 — Gate runner + tracked-source drift

**Doctor is now a fan-out runner.** Ten built-in gates at
`template/maddu/runtime/gates/builtin/*.mjs`; operator gates discovered at
`.maddu/gates/*.mjs`. New `tracked-source-drift` gate driven by
`.maddu/config/tracked-sources.json` + `SOURCE_HASH_RECOMPUTED` events. New
`maddu sources rebuild|status` CLI. Each gate emits `GATE_RAN` per run;
bridge `GET /bridge/gates` surfaces recent history. Also fixes a pre-existing
`DOCTOR_REPORT` id collision (manual append with static suffix → use
`spine.append`).

### Phase 3 — Slice scope-lock (opt-in)

**Slices that declare scope enforce it.** `maddu slice scope-declare|expand|
approve-functional|show`. `slice-scope` gate runs before `slice-stop` and
refuses out-of-scope edits. Expansion bound `+5 files OR +30%` (configurable).
Doc-like paths (docs/, README, CHANGELOG, .maddu/state/, .maddu/reviews/) are
always permitted. After `SLICE_FUNCTIONAL_APPROVED`, only doc-like edits pass.
`verify-spine` checks `SLICE_SCOPE_EXPANDED.sliceId` resolves to a prior
`SLICE_SCOPE_DECLARED`. Slices that don't declare scope behave unchanged.

### Phase 4 — Trigger discipline + pending-actions queue

**No mutating command may auto-fire without a signature.** Tier manifest
covers all 30 top-level commands at `commands/_tiers.mjs`. New
`command-tier-discipline` gate enforces the manifest is complete.
`schedule.tick` evaluates an `action.kind:'command'` schedule through a
gauntlet: tier lookup → allowlist match in `.maddu/config/triggers.json` →
cooldown check → emit `TRIGGER_FIRED`. The pending-actions queue lets
read-only auto-actions surface to the next live agent via
`maddu brief --drain` (emits `PENDING_ACTION_DRAINED`).

### Phase 5 — Post-stop review lane

**Catch the semantic regressions structural gates can't see.** Runtime kind
`'reviewer'`; review-policy config at `.maddu/config/review-policy.json`;
parser handles JSON and YAML-frontmatter markdown. New `maddu review run
--slice <id> [--reviewer name]` synchronously spawns the configured reviewer,
parses stdout, writes a per-review markdown archive at
`.maddu/reviews/<slice-event-id>.md`, and emits `SLICE_REVIEWED`. Non-clean
verdicts auto-emit `FOLLOWUP_OPENED` with a draft scope drawn from finding
locations; follow-ups surface in `maddu brief` and on `/orientation`. Bridge
`GET /bridge/reviews?verdict=P2` filters by verdict. `verify-spine` checks
`SLICE_REVIEWED.sliceEventId → SLICE_STOP.id` and `FOLLOWUP_OPENED.
fromReviewEventId → SLICE_REVIEWED.id`.

### Phase 6 — Cockpit surfaces

**Three new read-only routes.** `/orientation` (goal, phase, last slice,
follow-ups, handoff markdown), `/gates` (recent `GATE_RAN` events + summary
counts), `/reviews` (recent `SLICE_REVIEWED` events + verdict counts + open
follow-ups). All live via the existing event stream; zero new long-poll
subscribers. Bridge endpoints documented in `docs/05-bridge-endpoints.md`.

### Documentation, candidate hard rule, skills

- **`docs/20-governance.md`** — single-page reference: turn-start orientation,
  gate authoring, tracked sources, slice scope-lock, trigger discipline,
  review lane, verification matrix, and "what to copy vs skip" relative to
  systems where the patterns were observed.
- **Candidate hard rule #9** — "Every auto-trigger crosses the gauntlet."
  Labeled as **candidate**; ratified after one slice of real use demonstrates
  no false-positive refusals on legitimate workflows.
- **Three SKILL.md drafts** under `docs/skills/`:
  - `orientation-skill.md` — when to run `maddu brief`, what to act on.
  - `gate-authoring-skill.md` — gate contract + recipe + severity guidance.
  - `review-lane-skill.md` — reviewer setup + verdict semantics.
  Copy any of these into a project's `.maddu/skills/` to make the recipe
  discoverable to agents in that repo.

### What was deliberately not built

No typed-invariant registry, no domain vocabulary, no mandatory adoption, no
new npm dependencies, no provider SDK imports in framework code, no web
socket / scheduler thread / daemon. Each opt-in mechanism is a thin contract
the operator supplies the content for; a repo that ships nothing under
`.maddu/config/` or `.maddu/gates/` behaves identically to v0.15.0.

Bridge load: 3 new endpoints, each a single `project()` read; zero new
long-poll subscribers; zero new background timers.

### Verify

```bash
maddu spine verify                                  # exits 0
maddu doctor                                        # exits 0 (16 pass · 0 warn · 0 fail)
node scripts/test/projection-roundtrip.mjs          # exits 0
grep -RIE '(5 Laws|IntentExecutor)' template/ commands/ bin/  # empty
grep -RIE 'import .*(anthropic|openai)' template/maddu commands  # empty
git diff package.json                               # empty
```

---

## [v0.15.0] · 2026-05-18 · audit foundation

**The spine is now genuinely the source of truth — and the operator can
prove it.** Two foundation slices that complete the audit chain rule #2
has always promised. With these in, every approval decision lives as a
real spine event (no projector inference), and the spine itself is
operator-verifiable from a single CLI call.

### Spine integrity verifier

**Trust the spine — and prove it.** With the previous slice making the
spine the sole source of truth for approval decisions, the cost of
silent spine corruption (botched manual edit, partial write on power
loss, bad `git merge` resolution, disk-level surprise) just went up.
This slice closes the audit chain: a read-only verifier that walks
every NDJSON segment and confirms the spine is the well-formed,
internally-consistent artifact the rest of the framework assumes it is.

- **New `lib/verify.mjs::verifySpine()`** — single-pass walker over
  every segment under `.maddu/events/`. Checks: parseability, envelope
  shape (`v`/`id`/`ts`/`type`/`actor`/`lane`/`data`), event-id uniqueness
  + format (exempts well-known fixed suffixes like `evt_…_init00`),
  timestamp monotonicity within each segment, timestamp sanity (not >
  now+60s, not before FRAMEWORK_INSTALLED), schema version (`v === 1`),
  segment continuity (`…001` to `…N` with no gaps), and referential
  integrity (orphan `APPROVAL_DECIDED`, dangling `LANE_RELEASED`,
  unknown-session `SESSION_CLOSED`, missing `TASK_CREATED` for updates,
  etc.). Doesn't call the projector — owns its own pass so verifier
  failures surface even if the projector is broken.
- **New `maddu spine` CLI verb** with two subcommands:
  - `maddu spine verify [--json]` — walk + report. Exit `1` on FAIL,
    `0` on PASS or WARN-only. `--json` emits the raw result for CI.
  - `maddu spine show <eventId>` — pretty-print a single event from
    the spine without piping NDJSON through `grep`. Useful when
    `verify` flags something.
- **Doctor `spine integrity` check** — runs `verifySpine` with a 50k
  event cap on every doctor invocation. PASS when clean; WARN on
  soft issues; FAIL bubbles to doctor's overall exit code. Above the
  cap, WARN points at the explicit CLI for a full pass.
- **`docs/hard-rules.md`** — adds the *Verifiable, not just declared*
  paragraph under rule #2. Codifies the principle: the spine's status
  as source of truth is operator-provable from a single CLI command.
- **Strictly read-only.** No `maddu spine repair`. If verify flags
  something, the operator decides remediation (manual edit + slice-stop,
  `maddu checkpoint rollback`, etc.). The spine is sacred.

Bridge load: zero new endpoints, zero new polls. The verifier is a
CLI-only walker; doctor runs it once per invocation. ~50ms for typical
spines, linear in event count.

### Spine-authoritative approvals (hard-rule-#2 alignment)

**The spine is now genuinely the source of truth for approval
decisions.** Before this slice, per-repo auto-decides were *synthesized
by the projector at read time* — no `APPROVAL_DECIDED` event ever
landed in the spine for them. That violated hard rule #2 in spirit:
forensic queries had no anchor event, projector logic changes could
silently rewrite history, and replay on a different machine could
produce a different ledger. The global-policy work in v0.13 quietly got
this right; the per-repo path was older and had not yet been brought up
to standard.

- **New `lib/approvals.mjs::maybeAutoDecide()`** — shared helper called
  by both the bridge handler (`/bridge/approvals/request`) and the CLI
  (`maddu approval request`) the moment an `APPROVAL_REQUESTED` event
  lands. On a per-repo or global policy match, it appends a real
  `APPROVAL_DECIDED` event with `actor: 'policy' | 'global-policy'`
  and a top-level `triggered_by: { kind, id, fired_at }` field.
- **Projector synthesis removed** — the auto-decide block in
  `projections.mjs` is gone. The projector is now a pure spine reader;
  every entry in `proj.approvals.ledger` traces back to a real
  `APPROVAL_DECIDED` event.
- **`maddu approval migrate-legacy-decisions [--dry-run]`** — one-shot,
  append-only, idempotent CLI tool. Streams the spine once, replays
  the historical policy map up to each `APPROVAL_REQUESTED`, and
  appends a real decision event for every legacy implicit decision
  with `actor: 'policy-migrated'` and
  `triggered_by: { kind: 'policy_migration', id, fired_at,
  original_request, original_ts }`. Refuses to run while the bridge is
  on port 4177 (avoids concurrent NDJSON writers).
- **Doctor `approval ledger completeness` check** — surfaces unpaired
  legacy auto-decisions as `WARN` with a one-line remediation hint
  (`run maddu approval migrate-legacy-decisions`). PASS when every
  auto-decision in the spine has its `APPROVAL_DECIDED` event.
- **Hard-rule documentation** — `docs/hard-rules.md` rule #2 gains a
  *Derived ≠ projected* clarification: projections summarize, they
  don't infer; decisions must be appended as real events.
- **API addition** — `/bridge/approvals/request` response now includes
  `autoDecideSource: 'policy' | 'global-policy' | null` so callers can
  distinguish per-repo from global matches. Backwards compatible.

Bridge load: zero new endpoints, zero new polls. The `maybeAutoDecide`
helper re-projects once per request (already the case before this
slice). The migration tool is a CLI-only one-shot.

## [v0.14.0] · 2026-05-18 · onboarding ergonomics

**Zero-friction first-run.** Closes the two biggest day-one frictions
on a fresh `maddu init`: needing a global install to invoke the CLI,
and having to track the `ses_…` id by hand across every subsequent
`heartbeat` / `close`.

- **Project-local CLI shim.** `init` now copies `bin/maddu.mjs` +
  `commands/*.mjs` + `version.json` into the installed `maddu/` tree
  and ships two byte-stable wrappers there too: **`maddu/run` (POSIX,
  chmod 755)** and **`maddu/run.cmd` (Windows)**. `./maddu/run <cmd>`
  works from the repo root with zero global state. No `npm link`
  collisions between workspaces — each repo carries its own bundled
  CLI. `maddu upgrade` keeps both the CLI and the shims in sync via
  the existing managed manifest; `init` and `upgrade` call
  `ensureShimExecutable()` to (re-)apply the POSIX execute bit, which
  `copyFile` doesn't preserve.

  (Earlier iterations of this slice dropped the shims at the repo
  root as `./maddu` + `./maddu.cmd`, but `./maddu` on disk is the same
  path as the `maddu/` runtime directory — every fresh init failed
  with `EISDIR`. Replaced before any tagged release went out.)
- **Active-session cache.** `session register` and the new
  `session start "<label>"` shorthand write the new id to
  `.maddu/state/session.active.json` (atomic via temp + rename).
  `session heartbeat` and `session close` default `--session` to that
  cached id; `close` clears the file on success. The cache
  self-heals — if it points at a session that's already closed in the
  spine, the CLI clears it and exits 3 with a helpful message. Spine
  stays authoritative; cache is a UX hint, never source of truth.
- **`session start "<label>"`.** One-line bootstrap for a fresh shell.
  Defaults `--role` to `implementer` and `--focus` to the label;
  positional label is the only required argument. Wraps `register`,
  populates the active cache.
- **`session active`.** Prints the cached session id or
  `(no active session)` + exit 1. Self-heals stale entries.
- **Doctor checks.** Two new WARN-only rows: (1) project-local CLI
  shim present + executable; (2) active-session cache integrity.
  Stale caches surface proactively without blocking a green report.
- **`spine.append()` triggered_by passthrough** carried forward from
  v0.13. New `session-active.mjs` helper is optional-load via
  `_spine.mjs`'s `loadSpineLib` — pre-v0.14 installs can run a v0.14
  global CLI without crashing (the active-cache features just stay
  disabled until they upgrade).

Bridge load: zero new endpoints, zero new polls. All work is per-CLI
invocation, ~50 ms of local filesystem reads.

## [v0.13.0] · 2026-05-17 · multi-workspace cockpit

**One bridge, every repo.** Lifts the bridge from one-bridge-per-repo to a
machine-wide service that mounts N repos via a device-bound registry. Each
repo's spine remains the sole source of truth for that repo.

- **`maddu workspace`** — new verb: `add | list | remove | activate | show`.
  Registry stored at `~/.config/maddu/workspaces.json` (Linux/macOS) or
  `%APPDATA%\maddu\workspaces.json` (Windows), same path pattern as auth.
- **Multi-tenant bridge** — `maddu start` loads the registry and mounts
  every workspace at once. Each `/bridge/*` request carries an
  `X-Maddu-Workspace` header naming which repo this call is for; missing
  header falls back to the registry's `active` field. With no registry,
  the bridge walks up from `cwd` as before — existing single-repo installs
  work unchanged.
- **Cockpit workspace switcher** — left-rail dropdown above the nav,
  visible whenever more than one workspace is registered. Selection
  persists in `localStorage`. A global `fetch` shim injects the header on
  every `/bridge/*` call, so all 100+ existing call sites stayed unmodified.
- **`Ctrl+K` workspace switching** — every registered workspace surfaces
  as a "Switch to workspace: <label>" action.
- **Per-workspace pollers** — scheduler / Telegram / Discord / Email
  tickers iterate every mounted workspace so per-repo `.maddu/state` stays
  authoritative.
- **`spawnWorker` cwd fix** — workers spawned via `/bridge/runtimes/<n>/spawn`
  now always run with `cwd = repoRoot` so they act on the correct
  `.maddu/` regardless of where the bridge was booted from.
- **Doctor extended** — validates the registry shape (paths exist, contain
  `.maddu/`, no duplicates, `active` is known). `maddu doctor --all` runs
  every per-rule check for every registered workspace; check rows are
  prefixed with `[<workspace-id>]`. Unreachable paths report `WARN`, not
  `FAIL`.
- **Backward compatibility** — no registry → legacy single-repo mode.
  Bridge identical to v0.12.0 behavior in that mode. Hard rules preserved
  per-repo (each spine remains independent, files-only, append-only).

- **"All workspaces" aggregate views** (slice 3) — five new read endpoints
  under `/bridge/_all/`: `projection`, `conductor`, `approvals`, `queue`,
  `events/recent`. Each fans out the existing single-workspace builder
  over every mounted workspace in parallel and tags every row with
  `workspace_id` + `workspace_label`. No subsystem module touched.
- **Scope pill toggle** on Conductor, Dashboard, Approvals, Agents, and
  Queue Board — flips the route from single-workspace to aggregate.
  Selection persists per-route in `localStorage`. Hidden in legacy /
  single-workspace mode. Rows render with a small workspace badge.
- **Cross-workspace approval decisions** — in "All" mode the decision
  POST sets `X-Maddu-Workspace` to the approval's origin workspace, so
  the `APPROVAL_DECIDED` event lands on the correct spine even when the
  active workspace differs.

- **Global crons + policies** (slice 4) — machine-scope orchestration
  state under `~/.config/maddu/global/` (or `%APPDATA%\maddu\global\`).
  `schedules.ndjson` follows the same put/remove projection as per-repo
  schedules with an added `targets: [workspaceId, ...]` field (omitted
  or empty = every mounted workspace). `policies.json` is a flat array
  of `{ tool, lane?, decision, setAt, setBy }` rows. A new
  `lib/global.mjs` module owns CRUD; `schedule.mjs` gains `tickGlobal()`
  which the bridge's 30 s scheduler loop invokes alongside the per-repo
  tick.
- **`triggered_by` ancestry on the spine** — `spine.append()` now passes
  an optional top-level `triggered_by` field straight through to the
  NDJSON line. Each event written *because of* a global trigger carries
  `triggered_by: { kind: 'global_schedule' | 'global_policy', id, fired_at }`,
  so per-repo spines remain authoritative but record the cross-workspace
  cause.
- **Approval auto-decide cascade** — `/bridge/approvals/request` now
  first lets the per-repo projector auto-decide (existing behavior); if
  no per-repo policy matches, it consults global policies and, on
  match, appends a real `APPROVAL_DECIDED` event with
  `actor: 'global-policy'`, `reason: 'global-policy:<tool>@<lane|*>'`,
  and the `triggered_by` field.
- **New `/bridge/_global/*` endpoints** — CRUD for global schedules
  (`GET`/`POST` `/bridge/_global/schedules`, `POST /…/parse`,
  `POST /…/<id>/enable|disable`, `DELETE /…/<id>`) and policies
  (`GET`/`POST` `/bridge/_global/policies`, `DELETE /…/<id>`). Routes
  bypass the workspace resolver — same machine-scope pattern as
  `/bridge/_workspaces`.
- **`maddu global` CLI** — new verb: `cron add|list|show|enable|disable|remove`
  and `policy add|list|remove`. Direct file I/O via `lib/global.mjs`;
  no bridge round-trip required. Bridge picks up changes on its next
  30 s tick (schedules) or the next `APPROVAL_REQUESTED` (policies).
- **Cockpit Schedule route** — scope pill flips list and create form
  between this-workspace and global. Global rows show a `targets` row
  with workspace chips (or `(all workspaces)` for empty).
- **Cockpit Approvals route** — new "Standing policies (global)" panel
  reads `/bridge/_global/policies`. Decision-ledger entries with
  `reason` starting `global-policy:` render a tinted "global" chip
  inline.

## [v0.12.0] · 2026-05-17 · depth-upgrade complete

**Programmatic palette destinations + UI alignment.**

- **Sub-target system** (3-layer registry: static manifest → render
  discovery → live data fetch). 10 panels in Settings, every Auth provider,
  every MCP server, every runtime, every active session, every lane, every
  open task, every skill — all palette-searchable by their own name.
- **Action palette entries** — 11 verbs (rebuild wiki, re-extract memory,
  pause stream, open hard rules, jump to each integration test sender,
  open the five-minute tour). Distinct `▷` glyph.
- **Design-system alignment pass** — every scrollbar (8 px, brand-toned
  thumb, electric-blue hover), every `<button>` and `<input>` (unified
  base + `.is-primary/.is-danger/.is-ghost` modifiers, focus rings).
- **Skeleton bones** — `loadingFor(kind, text)` with kpi/grid/table/
  donut/card variants so panels don't reflow on first paint.
- **Inspector fix** — every tab (overview/evidence/actions/related/raw)
  now reads top-level `{ raw, evidence, actions, related, label }` slots,
  fixing a bug where only Raw showed content for newer entities.
- **Outside-click closes Inspector** — pointerdown listener with
  `panel.contains(target)` gate.
- **First-run onboarding** — `docs/18-first-slice.md` plus a cockpit
  banner that surfaces when `counts.sliceStops === 0`.
- **WSL docs** — added Windows-prerequisites notes to installation,
  getting-started, troubleshooting, and validation-checklist.

## [v0.11.0] · 2026-05-16 · cockpit polish

**Six phases of polish applied to the cockpit shell.**

- **Phase 1+2** — grouped rail (Decide / Operate / Verify / Connect /
  Reference), tablet collapse to glyphs + flyout labels, mobile bottom
  dock + bottom sheet.
- **Phase 3** — `Ctrl+K` / `⌘K` command palette with fuzzy search,
  arrow navigation, score-ranked results.
- **Phase 4** — Inspector responsive: persistent ≥ 1440 px, slide-over
  with scrim 1024–1439, bottom sheet < 1024.
- **Phase 5** — unified empty/skeleton/error helpers propagate redesigns
  across all 28 routes from one site.
- **Phase 6** — signature motion: 900 ms lime line traces across the
  viewport top on every SLICE_STOP. Route content fades in 180 ms.
  Global `prefers-reduced-motion` kill switch.

## [v0.10.0] · 2026-05-16 · Discord + Email bridges

**Slice η — outbound-only chat integrations.**

- **Discord** — REST bot bridge, channel allowlist, `allowed_mentions: { parse: [] }`
  prevents `@everyone`. Gateway WebSocket NOT opened (no inbound surface).
- **Email** — SMTP outbound via built-in `node:net` + `node:tls`. TLS
  required (port 465 implicit / 587 STARTTLS). Recipient allowlist
  prevents open-relay abuse. No IMAP.
- Both off by default; refuse to enable until token + allowlist set.
- 230-line minimal SMTP client (EHLO / STARTTLS / AUTH LOGIN / DATA),
  no `nodemailer` dep.

## [v0.9.0] · 2026-05-16 · Telegram bridge

**Slice ζ — first chat integration.**

- Long-poll bot bridge (`getUpdates`, no public webhook).
- Allowlisted chat-ids; inbound from non-allowlisted senders silently
  dropped with content never logged.
- Outbound throttle 1.1 s/chat (under Telegram's 1 msg/s/chat cap).
- Bot token stored device-bound via `auth.mjs`; never returned over HTTP.
- Embedded self-scheduling loop (avoids `setInterval` overlap with the
  25 s long-poll).

## [v0.8.0] · 2026-05-16 · Workflows + Roadmap depth + Agents + Teams

**Slice ε — final depth-upgrade slice.**

- **Workflows** — pure-SVG bezier blueprint of the operator → BOSS →
  Enforcer → claims → fleet → gates → reports → learning → wiki flow.
  Each node opens its route via Inspector.
- **Roadmap** rewritten with KPI strip, 28-day cadence bar, lane-mix
  table, clickable slice index.
- **Agents** — coworker profile grid (role / focus / score / claims /
  heartbeat / last slice).
- **Teams** — lane ownership map with held/free pills.
- **Task #13** — native `<select>` brand pass (appearance:none chevron,
  brand-tinted option list).

## [v0.7.0] · 2026-05-16 · Learning Memory + Wiki Updater

**Slice δ.**

- Hindsight + Wiki Updater auto-fire on every `SLICE_STOP`.
- New `runtime/lib/wiki.mjs` — per-lane markdown pages, append-only,
  rebuildable from spine.
- **Learning route** — kind/lane/q filters, click-to-Inspector.
- **Wiki route** — drift drawer, page list, rendered viewer.

## [v0.6.0] · 2026-05-15 · BOSS / Enforcer duality

**Slice γ.**

- **BOSS route** — terminal-style transcript, action-proposal cards
  with risk pill, approve / reject / negotiate buttons.
- **Enforcer** — deterministic pure function in `runtime/lib/enforcer.mjs`.
  7 action kinds; every refusal cites a hard-rule slug.
- 7 proposals smoke-tested via curl (claim_conflict, write_to_auth_dir,
  session_required, allowed-once, etc.).

## [v0.5.0] · 2026-05-14 · Queue Board + Claim Map

**Slice β.**

- **Queue Board** — Scheduler / Queue / Dispatch / Preflights kanban
  with reason codes on every parked card.
- **Claim Map** — active claims with lease state, heartbeat age,
  competing-claim highlights, one-click handoff request.
- Lane policy strip (zones / lease / handoff rule).

## [v0.4.0] · 2026-05-14 · Conductor + Inspector

**Slice α.**

- **Conductor** — new default landing route. KPI strip, next-command,
  Operation Score Matrix, Now / Next / Waiting / Done board.
- **Inspector** — persistent right panel with overview / evidence /
  actions / related / raw tabs. No more modals.

---

## [v0.3.2] · 2026-05-14 · roadmap complete

The original v0.3.x design (Phases A–D from the AionUi/Hermes synthesis).
See `docs/releases/v0.3.2.md` for the full phase ledger.

---

## Tagged releases

```
v0.4.0  · Conductor + Inspector
v0.5.0  · Queue Board + Claim Map
v0.6.0  · BOSS / Enforcer
v0.7.0  · Learning Memory + Wiki Updater
v0.8.0  · Workflows + Roadmap depth + Agents + Teams
v0.9.0  · Telegram bridge
v0.10.0 · Discord + Email bridges
v0.11.0 · Cockpit polish (rail, dock, palette, motion, responsive)
v0.12.0 · Sub-target system + UI design-system alignment
```

`v1.0.0` is gated on the validation walkthrough in
[`docs/17-validation-checklist.md`](docs/17-validation-checklist.md).
