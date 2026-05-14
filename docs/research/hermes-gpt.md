# Research Report — Hermes (GPT Deep Research, code-walk)

## 1. Repo Identity

- URL: https://github.com/NousResearch/hermes-agent
- Commit SHA read: latest at `https://github.com/NousResearch/hermes-agent/commit/6122a79aab45041d8b7c8d775f95be3ac6ce579f`
- License: MIT (`pyproject.toml:764-778`)
- Last commit date: see default branch
- Primary language(s): Python, with a Python package defining CLI / agent entrypoints
- Maintainer(s): `authors = [{ name = "Nous Research" }]` (`pyproject.toml:764-778`)
- One-paragraph elevator pitch: Hermes Agent is the most agentic-OS-relevant Nous Research repo. The code shows a Python runtime exposing multiple executables (`hermes`, `hermes-agent`, `hermes-acp`), persisting state in SQLite, and publishing a rich MCP layer for conversations, events, message sending, and approvals (`pyproject.toml:764-778`, `pyproject.toml:1151-1159`, `hermes_state.py:2762-2786`, `hermes_state.py:3067-3176`, `mcp_serve.py:2090-2100`, `mcp_serve.py:2857-3378`).

## 2. Architecture Map

- Top-level directories: `acp_adapter/`, `acp_registry/`, `agent/`, `providers/`, `plugins/`, `skills/`, `tools/`, `hermes_cli/`, `ui-tui/`, `tui_gateway/`, `web/`. Rot files: `run_agent.py`, `mcp_serve.py`, `hermes_state.py`, `cli.py`, `pyproject.toml`.
- Runtime entry points:
  - `hermes = "hermes_cli.main:main"` (`pyproject.toml:1151-1154`)
  - `hermes-agent = "run_agent:main"` (`pyproject.toml:1153-1156`)
  - `hermes-acp = "acp_adapter.entry:main"` (`pyproject.toml:1155-1157`)
- Build / packaging: `pyproject.toml` with `setuptools.build_meta`, Python >=3.11. Scripts block installs multiple executables. Optional extras (`mcp`, `acp`, `google`, `web`, `homeassistant`, `sms`, `youtube`) reveal a broad runtime surface (`pyproject.toml:758-778`, `pyproject.toml:868-874`, `pyproject.toml:1151-1159`).
- ASCII data-flow:
```
CLI / TUI / Web / ACP entrypoints
        |
        v
  Python runtime scripts (hermes / hermes-agent / hermes-acp)
        |
        +--> hermes_state.py  (SQLite + WAL + schema reconciliation)
        |
        +--> mcp_serve.py     (FastMCP tool surface)
                                conversation_get / messages_read /
                                attachments_fetch / events_poll /
                                events_wait / permissions_respond
```

## 3. Core Primitives

- **Agent** — primary form is an installable executable, not a verified internal class. `pyproject.toml` defines `hermes`, `hermes-agent`, `hermes-acp` as separate entrypoints. Internal agent class not deeply walked in this pass.
- **Session** — clearest primitive: conversation identified by `session_key`. Used in `conversation_get`, `messages_read`, `attachments_fetch` (`mcp_serve.py:2857-3077`).
- **Task** — no standalone task class verified equivalent to a lane work item. Closest workload surface in this walk: pending approvals in the MCP bridge and the event stream describing conversation progress (`mcp_serve.py:3079-3181`, `mcp_serve.py:3333-3378`).
- **Tool** — strongest area. `mcp_serve.py` lazy-imports `FastMCP` and declares `@mcp.tool()` decorations: `conversation_get`, `messages_read`, `attachments_fetch`, `events_poll`, `events_wait`, `messages_send`, `channels_list`, `permissions_list_open`, `permissions_respond` (`mcp_serve.py:2090-2100`, `mcp_serve.py:2857-3378`).
- **Memory** — no separate "semantic memory" engine verified. `hermes_state.py` shows persistent state in SQLite: connection to `DEFAULT_DB_PATH`, WAL checkpoint on close, declarative schema reconciliation via `SCHEMA_SQL` (`hermes_state.py:2762-2786`, `hermes_state.py:2968-2988`, `hermes_state.py:2992-3176`).
- **Workspace** — no first-class primitive verified in the walked files.
- **Event** — clear primitive in MCP bridge. `events_poll` and `events_wait` use cursor-based event flow with `after_cursor`, optional `session_key`, timeout/long-poll (`mcp_serve.py:3079-3181`).

## 4. State & Persistence Model

- Where state lives: `hermes_state.py` opens SQLite connection against `DEFAULT_DB_PATH`, creates directory if missing, uses thread locks, runs schema via `SCHEMA_SQL`. Local DB, not files-only projections (`hermes_state.py:2762-2786`, `hermes_state.py:3067-3176`).
- Schema shape: `SCHEMA_SQL` is single source of truth. `_reconcile_columns()` diffs live schema against declared DSL and auto-adds missing columns (`hermes_state.py:2992-3176`).
- Durability + recovery: `threading.Lock`, short SQLite timeout with app-level retry intent, PASSIVE WAL checkpoint on close, self-healing column reconciliation at startup. Robust embedded state, but not Máddu-compatible (`hermes_state.py:2762-2786`, `hermes_state.py:2968-2988`, `hermes_state.py:3067-3176`).
- Compatibility with Máddu's files-only rule: ❌. Core state for Hermes in verified code is SQLite-based and depends on a schema + migration chain (`hermes_state.py:2762-2786`, `hermes_state.py:3067-3176`).

## 5. Orchestration Model

- Scheduler / queue / lane equivalent: no explicit lane or task scheduler verified in walked files. Closest orchestration pattern: the session-keyed MCP conversation surface and cursor-based events / approval queues. Hermes is more a runtime + protocol layer than a multi-lane cockpit shell in these files (`mcp_serve.py:2857-3181`, `mcp_serve.py:3333-3378`).
- Concurrency: `hermes_state.py` uses `threading.Lock`, `check_same_thread=False`, short SQLite timeout. Shared state handled in-process with locks and SQLite contention rather than append-only files or explicit lane claims (`hermes_state.py:2764-2786`, `hermes_state.py:2968-2988`).
- Supervision + failure: state close does WAL checkpoint best-effort; schema handling is declaratively self-repairing for column additions; approvals in `permissions_list_open` are live-session-only, limiting historical recovery in that bridge surface (`hermes_state.py:2968-2988`, `hermes_state.py:3067-3176`, `mcp_serve.py:3333-3348`).

## 6. Provider / Model Integration

- Configuration: verified surface is packaging — extras for `mcp`, `acp`, `google`, `web`, `homeassistant`, `sms`, `youtube`. Exact model switches and provider config not fully walked (`pyproject.toml:868-874`, `pyproject.toml:1128-1149`).
- Credentials flow: not verified in walked files.
- API execution: verified Hermes here is a Python runtime with installed entrypoints and an in-process MCP server. Exact provider call site not verified; nothing suggests a renderer/main/subprocess three-tier split — rather a unified Python agent layer (`pyproject.toml:1151-1159`, `mcp_serve.py:2090-2100`).
- Compatibility with Máddu's "no provider SDK in app code" rule: ⚠️. Read code is insufficient to pin every provider call site. The verified architecture is a monolithic Python package with broad optional integration surfaces — not Máddu's subprocess-only-provider boundary. Treat as **adapt with caution**, not direct copy (`pyproject.toml:868-874`, `pyproject.toml:1128-1159`).

## 7. UI / Cockpit Layer

- Shell metaphor: repo root has `hermes_cli`, `ui-tui`, `tui_gateway`, `web` — fronted by CLI/TUI and web. UI implementations not walked in this pass (`pyproject.toml:1151-1159`).
- Other UI fields: not verified in walked files.

## 8. Tool / MCP Integration Surface

- Discovery: `mcp_serve.py` lazy-imports `FastMCP`; Hermes exposes its own MCP server interface when the SDK is available (`mcp_serve.py:2086-2100`).
- Registration: tools registered directly via `@mcp.tool()` decorators (`mcp_serve.py:2857-3378`).
- Invocation flow: tools read session index, load messages and attachments, poll/wait for events, respond to approvals. A clear bridge surface that an AionUi-style UI could consume as a runtime protocol (`mcp_serve.py:2857-3378`).
- Permissions: `permissions_list_open()` lists pending approval requests seen during the current bridge session; `permissions_respond()` sends decisions `allow-once`, `allow-always`, `deny`. Most direct Hermes contribution to a cockpit shell — an explicit approval API surface (`mcp_serve.py:3333-3378`).
- Sandboxing / hot-reload: not verified.

## 9. Strengths (ranked, copyable patterns)

- **MCP event bridge** — cursor-based `events_poll`/`events_wait` enables live observability without UI needing to understand internal runtime. High feasibility (`mcp_serve.py:3079-3181`).
- **Approval API as first-class tool** — `permissions_list_open`/`permissions_respond` give a concrete operator interface for exec/plugin approvals. High feasibility (`mcp_serve.py:3333-3378`).
- **Session history over tools** — `conversation_get`, `messages_read`, `attachments_fetch` expose history + replay as tool surface. High feasibility (`mcp_serve.py:2857-3077`).
- **Declarative schema reconciliation** — state layer self-heals columns from `SCHEMA_SQL` instead of long imperative migration chain. Medium feasibility — adapt the *pattern* to projection rebuilds (`hermes_state.py:2992-3176`).
- **Modular packaging surface** — scripts + extras let runtime functions be enabled gradually instead of hardcoded in a UI. Medium feasibility (`pyproject.toml:764-778`, `pyproject.toml:1128-1159`).

## 10. Weaknesses / Gaps

- **SQLite in core state** — directly violates Máddu's files-only rule (`hermes_state.py:2762-2786`, `hermes_state.py:3067-3176`).
- **Monolithic runtime feel** — verified model is a large Python package with many extras, not a small shell + clean subprocess workers (`pyproject.toml:1128-1159`).
- **Workspace / lane semantics unclear** — walked files have session and event APIs but no verified workspace or lane-ownership model (`mcp_serve.py:2857-3181`).
- **Approval history is live-session-only** — older approvals from before bridge connection are dropped, limiting audit trail in the verified tool surface (`mcp_serve.py:3339-3348`).

## 11. Máddu Compatibility Matrix

| Feature | What it is | Máddu analog | Verdict | Rationale |
|---|---|---|---|---|
| `hermes-agent` runtime entry | Installable agent runner | subprocess spawn adapters | adapt | Interesting as a runtime idea, but Máddu owns spawn via its own workers (`pyproject.toml:1151-1156`). |
| `hermes` CLI entry | Operator / CLI surface | future CLI helper | adapt | Possible as a separate operator binary, not as cockpit core (`pyproject.toml:1151-1154`). |
| `hermes-acp` entry | ACP adapter | bridge-side protocol adapter | adapt | Study for runtime handshake; not direct cockpit port (`pyproject.toml:1155-1157`). |
| SQLite state core | Central persistent state | `.maddu/` events + projections | skip | Violates files-only (`hermes_state.py:2762-2786`). |
| WAL checkpointing | DB durability hygiene | none | skip | Builds on forbidden DB base (`hermes_state.py:2968-2988`). |
| Declarative column reconciliation | Self-healing schema additions | projection regeneration | adapt | Port the idea to JSON projection reconciliation without SQLite (`hermes_state.py:2992-3176`). |
| MCP `conversation_get` | Fetch conversation metadata via tool | `/chats` projections | copy | Strong read-only cockpit-panel idea (`mcp_serve.py:2857-2907`). |
| MCP `messages_read` | Read message history via tool | spine replay viewer | copy | Bridge tool over Máddu's NDJSON spine (`mcp_serve.py:2911-2998`). |
| MCP `attachments_fetch` | Fetch message attachments | attachments viewer | copy | Fits files-only attachments well (`mcp_serve.py:3000-3077`). |
| MCP `events_poll` | Cursor-based event poll | spine tail / event feed | copy | Near-perfect additive panel for observability (`mcp_serve.py:3079-3123`). |
| MCP `events_wait` | Long-poll next event | live updates | copy | Minimal real-time feed for new cockpit panels (`mcp_serve.py:3125-3181`). |
| MCP `messages_send` | Send to external channels | none | adapt | External messaging needs separate policy (`mcp_serve.py:3183-3239`). |
| MCP `channels_list` | List targets across platforms | none | adapt | Read-only discovery OK; external messaging surfaces need policy (`mcp_serve.py:3241-3331`). |
| `permissions_list_open` | Live approval queue | focused-gate harness | copy | Directly usable inspiration for operator approvals (`mcp_serve.py:3333-3356`). |
| `permissions_respond` | Reply allow/deny to pending approval | gate response action | copy | Good pattern for explicit gate panel (`mcp_serve.py:3358-3378`). |
| Broad optional extras | mcp / acp / google / web / homeassistant / sms / youtube | plugin adapters | adapt | Module split is good, but broad deps in core should be avoided (`pyproject.toml:1128-1149`). |
| Multi-surface repo | CLI / TUI / Web / TUI gateway | cockpit + ev. CLI | adapt | Máddu can add panels / CLI without importing Hermes UI itself (`repository root:247-308`). |

## 12. Additive-Only Proposals for Máddu

**`/events/live`**
Real-time panel using cursor / wait semantics inspired by Hermes `events_poll`/`events_wait`. Reads bridge-generated projections over Máddu's NDJSON spine — gives operator the key OS-feel: streaming, observable work lifecycle.
- Where: new route `/events/live`; files under `.maddu/events/live-index.json` and `.maddu/events/spine.ndjson`.
- Hard-rule check: files-only ✅, no SQLite ✅, no hosted ✅, no provider SDK ✅, brand boundary ✅.
- Complexity: S. Lane: observability.

**`/approvals`**
Explicit approval queue for subprocess actions, MCP tools, or cross-lane intents. From Hermes `permissions_list_open`/`permissions_respond`. Máddu persists approvals as NDJSON with decision, actor, lane, timestamp for full audit.
- Where: new route `/approvals`; `.maddu/approvals/open.ndjson` + `.maddu/approvals/history.ndjson`.
- Hard-rule check: files-only ✅, no SQLite ✅, no hosted ✅, focused-gate ✅, lane ownership ✅.
- Complexity: S. Lane: governance.

**`/chats/history-bridge`**
Read-only history + attachments panel exposing `conversation_get`/`messages_read`/`attachments_fetch`-like affordances over Máddu's own spine + attachments files. Better replay and support debugging without altering storage discipline.
- Where: `/chats/history-bridge`; projections under `.maddu/projections/chats/*.json`.
- Hard-rule check: files-only ✅, no SQLite ✅, no hosted ✅, token-never-travel ✅.
- Complexity: M. Lane: chats.

**`/runtime/adapters`**
Route to register and inspect subprocess adapters inspired by Hermes scripts/extras — as Máddu worker profiles, not in-app integrations. Hermes as a study reference for adapter packaging without importing its monolithic runtime.
- Where: `/runtime/adapters`; `.maddu/runtime/adapters.json`.
- Hard-rule check: files-only ✅, no SQLite ✅, no hosted ✅, provider subprocess-only ✅.
- Complexity: S. Lane: runtime.

**Ship-first recommendation: `/approvals`.** Smallest addition with the biggest immediate "agentic OS" feel from Hermes — operator gets a visible control point over tool/subprocess decisions without adopting Hermes's state or packaging models (`mcp_serve.py:3333-3378`).

## 13. Risks of Adoption

- **Importing SQLite thinking instead of just MCP affordances.** *Mitigation:* only pattern-port event cursor, approvals, history APIs; all Máddu state stays in files (`hermes_state.py:2762-2786`).
- **Hermes broad extras tempting Máddu into a large integrated app.** *Mitigation:* keep adapters as small subprocess profiles; no provider SDKs in cockpit code (`pyproject.toml:1128-1159`).
- **Approvals becoming live-temporary instead of auditable.** *Mitigation:* write every approval intent + response to NDJSON history, not just in-memory during bridge session (`mcp_serve.py:3339-3356`).
- **Event panels without lane semantics creating noise.** *Mitigation:* bind every event to lane / workspace / slice-id in Máddu's spine; UI filters from there, not from a global bus.

## 14. Máddu Strengths Worth Preserving

- Máddu's files-only NDJSON spine is stricter and more portable than Hermes's verified SQLite core.
- Máddu's subprocess-only provider boundary is cleaner than Hermes's broad Python-package + extras model.
- Máddu's slice-stop ritual is more explicit as a learning loop than the verified Hermes surface — where event and approval APIs don't themselves yield a structured stop summary.
- Máddu's lane-ownership discipline is stronger than any verified lane / workspace contract in the walked Hermes files.
- Máddu's tokens-never-travel rule is sharper than what was verified in Hermes.

## 15. Evidence Appendix

- `pyproject.toml:764-778` — project name, version, Python requirement, author, MIT license.
- `pyproject.toml:868-874` — optional dependencies block.
- `pyproject.toml:1128-1159` — extras (`mcp`, `acp`, `google`, `web`, `homeassistant`, `sms`, `youtube`) and scripts (`hermes`, `hermes-agent`, `hermes-acp`).
- `hermes_state.py:2762-2786` — SQLite connection against `DEFAULT_DB_PATH`, directory creation, lock, timeout.
- `hermes_state.py:2968-2988` — PASSIVE WAL checkpoint on close.
- `hermes_state.py:2992-3176` — `SCHEMA_SQL` as source of truth + declarative column reconciliation.
- `mcp_serve.py:2086-2100` — lazy import of `FastMCP`.
- `mcp_serve.py:2857-2907` — `conversation_get(session_key)`.
- `mcp_serve.py:2911-2998` — `messages_read(session_key, limit)`.
- `mcp_serve.py:3000-3077` — `attachments_fetch(session_key, message_id)`.
- `mcp_serve.py:3079-3181` — `events_poll` and `events_wait`.
- `mcp_serve.py:3183-3239` — `messages_send`.
- `mcp_serve.py:3241-3331` — `channels_list`.
- `mcp_serve.py:3333-3378` — `permissions_list_open` and `permissions_respond`.
- `repository root:207-308` — top-level directories.
- `repository root:427-527` — root entry files (`cli.py`, `hermes_state.py`, `mcp_serve.py`, `run_agent.py`, `pyproject.toml`).
