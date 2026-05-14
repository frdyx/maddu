# Máddu v0.3 roadmap

The features below collectively constitute the **v0.3 baseline** of Máddu. They are distilled from four deep-research reports on AionUi and Hermes (see [`research/`](research/)). Each is **additive** — Máddu has no v0.2 production surface for them to disturb. They are ordered by ship-first priority within phases.

Every feature passes the 8 hard rules in [`hard-rules.md`](hard-rules.md). Every feature is files-only, local-only, and provider-SDK-free.

## Phase A — Foundations (ship first)

### A1. `/approvals` route and ledger
A new cockpit route surfacing every pending tool / subprocess approval request with three actions: `allow-once`, `allow-always`, `deny`. Decisions append to `.maddu/approvals/ledger.ndjson`. Policies live in `.maddu/approvals/policies.json`. Replay receipts in `.maddu/approvals/replays.ndjson`.

**Why first.** Smallest surface, two independent code-evidence references from the research, immediate operator value. Unblocks safer auto-mode for everything after.

**Tag:** `v0.3.0-alpha.1`.

### A2. `/events/live` route — cursor-based event panel
A real-time panel that long-polls a cursor over the NDJSON spine. New bridge endpoints `GET /events/poll?after=<cursor>` and `GET /events/wait?after=<cursor>&timeout=<ms>` over `.maddu/events/*.ndjson`. Becomes the substrate every later live panel reuses.

**Tag:** `v0.3.0-alpha.2`.

### A3. Hindsight extraction worker
A local Node subprocess that runs immediately after every `maddu slice-stop`. Reads the latest spine segment, extracts structured facts ("rule that emerged", "constraint discovered", "tool that hung"), appends to `.maddu/memory.ndjson` with provenance pointers back to the originating events. Projection at `.maddu/state/memory-index.json`.

**Tag:** `v0.3.0-alpha.3`.

## Phase B — Operator productivity

### B1. Slash-command composer
`/resume`, `/steer`, `/goal`, `/rollback`, `/stop`, `/usage`, `/skills`, `/runtime`, `/approve` in the cockpit chat input. Pure UI + bridge wiring; no new state primitives.

### B2. `/lanes/inbox` route — mailbox bus per lane
Each lane gets `.maddu/lanes/<lane>/mailbox.ndjson` with `to/from/type/content/summary/read/created_at` records. UI shows unread badge per lane. Async handoffs without simultaneous lane mutation.

### B3. `/lanes/tasks` route — dependency-aware task board
Tasks with `blockedBy[]`/`blocks[]`/`owner`/`status`/`metadata`. Auto-unblock on completion. Stored as `.maddu/tasks/graph.json` (projection) + `.maddu/events/tasks.ndjson` (event source).

### B4. `/skills` route — skill gallery
Reads `.maddu/skills/*.md` (`SKILL.md` format). Drag-and-drop into active sessions. Skills are operator-promoted entries from `.maddu/patterns/`. Provenance in `.maddu/skills/provenance.ndjson`.

### B5. Subprocess heartbeat watcher
15s idle ping/pong on spawned workers. Stuck-subprocess banner in cockpit status row. Status to `.maddu/state/runtime-health.json`.

### B6. `/search` route — spine search panel
Lightweight file-backed index over the spine + verification receipts. Segments under `.maddu/index/segments/*.json`, rebuilt incrementally on event append. Rebuild receipts in `.maddu/index/rebuild.ndjson`.

**Phase B completion tag:** `v0.3.0`.

## Phase C — Power-user

### C1. `/runtimes` route — runtime adapter contract
Registry of subprocess runtime adapters. Each adapter is a JSON capability descriptor (`name`, `binary`, `protocol`, `event-stream-format`, `approval-required`, `mcp-support`). Cockpit reads descriptors only — never imports runtime libraries.

### C2. `/tools/mcp-registry` route — bridge-owned MCP visual registry
Lists registered MCP servers, status, last error, hot-reload. All MCP traffic stays bridge-owned. Slot-tagged env injection so one server serves multiple lanes via `MADDU_LANE_ID`.

### C3. `/schedule` route — natural-language cron
Operator types "summarize the spine every evening at 6pm" → bridge converts to cron expression → stored in `.maddu/schedule.ndjson`. Local worker dispatches.

### C4. `/operations` checkpoint timeline — git worktrees
Sidebar showing automatic git-worktree checkpoints per lane. `/rollback` slash-command reverts. Uses `git worktree` only — zero new deps.

### C5. Multi-API-key rotation
Per-provider API-key list in OAuth-tokens store; bridge rotates on rate-limit error. Tokens stay device-bound, never exported.

## Phase D — Big additive vision (after A–C land)

### D1. `/workbench` route — multi-pane OS-like shell
Left rail: workspaces / lanes. Center: conversation tabs. Right rail: process / tool status + approval inbox. All tabs are projections over files-only state. Live status streams from A2's `/events/wait` endpoint.

**Why deferred.** Highest UX-leverage item but L complexity. Becomes trivial once A1+A2 + B2+B3 exist — at that point `/workbench` is mostly UI assembly.

### D2. `/imports` route — secret-rejection ledger
Import settings, workspace instructions, memory notes, skills — never provider secrets. Reject and log any payload containing keys to `.maddu/imports/rejected-secrets.ndjson`.

### D3. Office-artifact preview pane
Editable `.docx`/`.xlsx`/`.pptx` preview. Skip until truly needed — adds rendering dependencies; revisit after A–C ship.

## Execution sequence (slice-by-slice)

| Slice | Scope | Tag |
|---|---|---|
| 1 | Repo scaffold (this slice) | `v0.0.1` |
| 2 | Bridge + cockpit baseline | `v0.1.0` |
| 3 | Spine, slice-stop, lanes, sessions | `v0.2.0` |
| 4 | `init` / `upgrade` / `doctor` | `v0.2.1` |
| 5 | A1 `/approvals` | `v0.3.0-alpha.1` |
| 6 | A2 `/events/live` | `v0.3.0-alpha.2` |
| 7 | A3 hindsight | `v0.3.0-alpha.3` |
| 8 | Phase B (six slices, alpha.4–alpha.9) | `v0.3.0` |
| 9 | Integration test on a fresh empty repo | `v0.3.0` validated |

Phases C and D are scoped after v0.3.0 ships.
