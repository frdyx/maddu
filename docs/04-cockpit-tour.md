# Cockpit tour

The cockpit is a single-page app served by the bridge at <http://127.0.0.1:4177>. It is hash-routed (`#workbench`, `#approvals`, etc.) and renders into a single view container. There is no build step — `cockpit.js` is vanilla JS, no framework.

Every route long-polls `/bridge/events/wait` for live updates and re-fetches `/bridge/status` once per wait turn so the badges, uptime, and counters stay current.

## Global chrome

The shell shows in every route:

- **Workspace switcher** *(v0.13)* — dropdown above the rail nav, visible when ≥ 2 workspaces are registered. Selecting one re-renders every route against that workspace's data and persists the choice in `localStorage`. `Ctrl+K` also lists "Switch to workspace: …" entries. With one or zero workspaces (legacy single-repo mode), the switcher hides entirely.
- **"All workspaces" scope pill** *(v0.13)* — on Conductor, Dashboard, Approvals, Agents, and Queue Board. Flips the route from the active workspace to an aggregate view across every mounted workspace; rows render with a small workspace badge. Approval decisions issued from "All" mode pin the write to the row's origin workspace via `X-Maddu-Workspace`, so the `APPROVAL_DECIDED` event lands on the correct spine. Hidden in single-workspace mode.
- **Bridge signal** — green dot when online, gray when offline.
- **Version, uptime, host, port** — from `/bridge/status`.
- **Approvals badge** — open approvals count.
- **Mailbox badge** — total unread across all lanes.
- **Tasks badge** — open tasks.
- **Stuck banner** — appears when any worker is silent >15 s. Dismiss via `/kill <workerId>` in the composer or `maddu worker kill <id>`.
- **Slash-command composer** — bottom of every route. Type `/` to see commands: `/resume`, `/steer`, `/goal`, `/rollback`, `/stop`, `/usage`, `/skills`, `/runtime`, `/approve`, `/kill`. (Phase B1 — some commands are still rolling out; see [maddu-v0.3-roadmap.md](maddu-v0.3-roadmap.md).)
- **`?` keyboard shortcut** — opens the Docs popup, which renders every page under `docs/` via `/bridge/docs`.

## Routes

### `#orientation` *(v0.16)*

Turn-start digest. Goal, phase, active session, last slice, counters, open follow-ups, plus the rendered handoff markdown from the most recent slice-stop. Top of the **Decide** group. Reads `GET /bridge/orientation` — pure projection from the spine, deterministic across restarts. Pair with the CLI: `maddu brief` prints the same data. Set goal/phase with `maddu goal set` / `maddu phase set`. See [20-governance.md](20-governance.md#turn-start-orientation).

### `#gates` *(v0.16)*

Recent `GATE_RAN` events with summary counts (ok / fail / warn / last run). One row per gate run. Operator gates dropped at `.maddu/gates/*.mjs` show alongside the ten framework built-ins (hard-rule extractions + `tracked-source-drift` + `slice-scope` + `command-tier-discipline`). Reads `GET /bridge/gates?limit=N`. See [20-governance.md](20-governance.md#authoring-gates).

### `#reviews` *(v0.16)*

Post-stop reviews. Verdict counts (`CLEAN`/`P1`/`P2`/`P3`/`INFO`), recent `SLICE_REVIEWED` events, open follow-ups. Per-review markdown archived at `.maddu/reviews/<slice-event-id>.md`. Configured via `.maddu/config/review-policy.json`; the reviewer is a runtime with `kind: 'reviewer'`. Non-clean verdicts auto-open `FOLLOWUP_OPENED` events that surface in `#orientation`. Reads `GET /bridge/reviews?limit=N&verdict=P2`. See [20-governance.md](20-governance.md#post-stop-review-lane).

### `#workbench`

The default landing route. OS-like three-pane shell:

- **Left** — lanes and sessions.
- **Center** — live event stream filtered by the current selection.
- **Right** — status counts, open approvals, mailbox digest, schedule.

Use this when you want a single screen that captures "what is happening right now."

### `#dashboard`

Snapshot of every lane, every spawned worker, every open approval. Fewer real-time updates than Workbench; useful for daily check-ins.

### `#approvals`

Pending tool / subprocess approval requests. Three buttons per row: `allow-once`, `allow-always`, `deny` (plus `deny-always` from the CLI). Below the queue: recent decisions (the ledger) and standing policies.

Operator flow: an agent calls `POST /bridge/approvals/request`, the request appears here, you click a decision, the worker's polling loop sees the decided approval and proceeds. See [09-approvals-and-permissions.md](09-approvals-and-permissions.md).

### `#events`

Live cursor stream of the append-only spine. Filter by type. Pause/resume. Each row shows timestamp, type, lane, actor, and a short summary. Click an event for the full JSON.

### `#mailbox`

Per-lane mailbox bus. The left list shows lanes sorted by unread count. Click a lane to read its messages. Unread messages have an orange dot. Compose a message by selecting a target lane, picking a type (`note`, `info`, `request`, `handoff`, `question`, `ack`), and writing a subject + body.

### `#tasks`

Dependency-aware task board. Tasks group by status: `in-progress`, `todo`, `blocked`, `done`, `cancelled`. Each card shows blockers and dependents. Completing a task auto-unblocks tasks that depended on it; the unblocked dependents flash briefly in the dashboard.

### `#skills`

Skill gallery. Reads `.maddu/skills/*.md` (SKILL.md format). Filter by tag. Click a skill to view its body, provenance (which slice-stops contributed), and metadata. Drag-and-drop into a chat (Phase B4) to apply a skill to an active session.

### `#search`

Cross-corpus search. Query box on top; results grouped by kind (`event`, `slice`, `memory`, `skill`, `mailbox`, `inbox`). Each result links back to the originating event or file.

### `#runtimes`

Registered subprocess runtimes (Claude Code, Codex, custom Node workers, etc.). Each row: name, binary, args, detect-command health badge, capabilities (`mcp`, `tools`, `streaming`, `approval`). Actions: register, detect-all, spawn, remove.

### `#mcp`

MCP server registry. Each row: name, transport (`stdio` / `sse` / `http`), enabled state, visible lanes, last health check. Actions: register, enable/disable, test, remove. The `visible_for(lane)` filter shows which servers a given lane sees — useful for sanity-checking lane scoping.

### `#schedule`

NL→cron scheduler. Create schedules with natural-language ("every evening at 6pm") or raw cron strings. Each schedule fires an action — by default an inbox note — when the bridge's 30-second tick matches. Disable a schedule to pause it without deleting.

### `#auth`

Multi-API-key store. Per provider: total keys, active-key masked tail, last-used timestamps, rate-limit state. Keys are stored under `~/.config/maddu/auth/` (Linux/macOS) or `%APPDATA%\maddu\auth\` (Windows) and **never** served raw over HTTP — the bridge returns only `…tail4` masks. Reveal requires the CLI with `--confirm`.

### `#imports`

Safe import gateway. Submit a JSON payload + kind; the bridge scans for key-shaped values and either accepts (logging the path) or rejects the whole payload (logging the offending JSON path and pattern name, never the value). Two tabs: accepted and rejected.

### `#operations`

Live work in flight: recent slice-stops, verification reports, active checkpoints.

### `#swarm`

Multi-agent fan-out view. Lane-bound workers grouped by lane; each worker shows its mailbox digest and last heartbeat.

### `#chats`

Conversation surfaces. The inbox stream rendered as chat bubbles. History scrollback, attachment metadata, and replay. New messages append-only via `POST /bridge/inbox`.

### `#roadmap`

Planned slices, tagged versions, dependency graph between roadmap items. Reads from the project's planning notes plus the spine's `FRAMEWORK_UPGRADED` events.

### `#docs`

End-user docs popup. Reads `docs/*.md` via `/bridge/docs` and `/bridge/docs/<slug>`. The `?` keyboard shortcut anywhere in the cockpit opens this route.

### `#settings`

Bridge config, lane catalog, provider auth shortcuts, MCP registry shortcuts. The "edit" surfaces here are convenience wrappers around the same endpoints used by the other routes.

## Common operator flows

- **Triage a new approval.** Stuck banner or badge → click Approvals → decide → return to whatever route you were on.
- **Watch a slice in real time.** Workbench → select the lane in the left pane → center pane shows only events for that lane.
- **Distill a skill from a good slice.** Operations → find the slice-stop → click "Distill skill" (or run `maddu skill from-slice <eventId>`) → review and tag in Skills.
- **Recover after a bad slice.** Operations → find the relevant checkpoint → "Rollback (inspect)" → review the commands → "Apply" if they look right.
- **Wire a new MCP server.** MCP → Register → set transport and command/url → Test → Enable.
