# Changelog

All notable changes to Máddu. Versions follow the depth-upgrade slice plan
documented in `.claude/plans/so-let-me-revise-lazy-floyd.md` (slices α–ε)
plus the integration slices (ζ–η) and the cockpit polish pass.

The format roughly follows [Keep a Changelog](https://keepachangelog.com/),
adapted to the slice-stop ritual: every release is a `SLICE_STOP` event in
the spine, so the canonical log lives in `.maddu/events/`. This file is the
narrative summary.

---

## [Unreleased]

_No changes yet._

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
