# Research Report — AionUi (GPT Deep Research, code-walk)

## 1. Repo Identity

- URL: https://github.com/iOfficeAI/AionUi
- Commit SHA read: not verified in code-walk session
- License: Apache-2.0 per SPDX header in core files including `src/process/index.ts:337-341` and `src/common/index.ts:259-263`
- Last commit date: not verified
- Primary language(s): TypeScript across main / process / worker / renderer chain. React in renderer. Electron bridges processes (`src/process/index.ts:344-413`, `src/common/index.ts:267-269`, `src/renderer/main.tsx:532-718`, `src/process/task/BaseAgentManager.ts:494-623`)
- Maintainer(s): source headers identify AionUi as copyright holder (`src/process/index.ts:337-341`, `src/common/index.ts:259-263`)
- One-paragraph elevator pitch: AionUi is an Electron-based agent cockpit where the renderer boots a routed UI with sidebar, conversation tabs, and preview contexts. The process layer initializes storage, extensions, and channels. Agent work is built as worker tasks via a factory that selects a manager per conversation type. Team mode adds an MCP-driven coordination layer on top with mailbox, task board, and agent slots. Core state persists in SQLite with complementary filesystem storage for images and large attachments (`src/process/index.ts:373-413`, `src/renderer/main.tsx:650-718`, `src/renderer/components/layout/Router.tsx:493-566`, `src/process/task/AgentFactory.ts:312-329`, `src/process/task/BaseAgentManager.ts:511-623`, `src/process/team/TeamSession.ts:745-871`, `src/process/services/database/README.md:247-276`, `src/process/services/database/schema.ts:623-774`).

## 2. Architecture Map

- Top-level directories:
  - `src/process/` — main / process logic with ACP / agent / channels / extensions / services / task / team / webserver / worker bindings (`src/process:239-299`).
  - `src/process/services/` — persistence, MCP services, conversation services, snapshots (`src/process/services:241-295`).
  - `src/process/task/` — agent factory, managers, worker task manager, agent types, IPC event emitter (`src/process/task:241-329`).
  - `src/renderer/pages/` — routed pages for conversation, cron, guid, login, settings, team (`src/renderer/pages:241-269`).
- Runtime entry points:
  - Process bootstrap: `initializeProcess()` runs `initStorage()`, `ExtensionRegistry.initialize()`, `ChannelManager.initialize()` (`src/process/index.ts:373-413`).
  - Renderer bootstrap: `createRoot(...).render(...)` with `AuthProvider`, `ThemeProvider`, `PreviewProvider`, `ConversationTabsProvider`, `Router` (`src/renderer/main.tsx:650-718`).
  - Worker bootstrap: `BaseAgentManager` runs `ForkTask` against `path.resolve(__dirname, type + '.js')`, binding each agent type to a separate worker entry (`src/process/task/BaseAgentManager.ts:511-623`).
  - Task orchestration: `WorkerTaskManager.getOrBuildTask()` fetches conversation from repo, builds manager via factory, caches/kills replaced tasks (`src/process/task/WorkerTaskManager.ts:589-689`).
- Build / packaging: clear Electron split between process, renderer, forked workers. Detailed inspection of `electron.vite.config.ts` and `electron-builder.yml` not verified in this walk. Code-evidence: app bootstraps process + renderer separately and runs provider/agent logic via worker files (`src/process/index.ts:344-413`, `src/renderer/main.tsx:532-718`, `src/process/task/BaseAgentManager.ts:544-552`, `src/worker:239-273`).
- ASCII data-flow:
```
Renderer React UI (Router + Sider + Tabs + Preview)
        |
        v
common/ipcBridge providers & emitters
        |
        v
Electron main/process bootstrap (initStorage -> Extensions -> Channels)
        |
        +--> Database service (SQLite + files)
        |
        +--> McpService (detect/sync/test OAuth)
        |
        +--> WorkerTaskManager
                |
                v
         AgentFactory -> BaseAgentManager/ForkTask -> type.js workers
                |
                v
           TeamSession / TeamMcpServer
           (mailbox + team_tasks + slot-tagged MCP stdio)
```
Evidence: `src/process/index.ts:344-413`, `src/common/index.ts:267-269`, `src/common/adapter/ipcBridge.ts:3018-3184`, `src/renderer/main.tsx:650-718`, `src/process/task/AgentFactory.ts:312-329`, `src/process/task/BaseAgentManager.ts:511-623`, `src/process/task/WorkerTaskManager.ts:589-689`, `src/process/team/TeamSession.ts:745-871`, `src/process/team/mcp/team/TeamMcpServer.ts:1598-1702`.

## 3. Core Primitives

- **Agent** — not a single class; a combination of `conversation.type → factory creator → agent manager → forked worker`. `AgentFactory.create()` picks a creator per `conversation.type`; `BaseAgentManager` is the common base running a `ForkTask` against `type + '.js'`. In practice "agent" is a process-bound runtime per conversation, not just a UI object (`src/process/task/AgentFactory.ts:312-329`, `src/process/task/BaseAgentManager.ts:511-623`). In team mode, the same agent becomes a `TeamAgent` with `slotId`, `agentType`, `status`, `model`, optional `customAgentId` (`src/common/types/teamTypes.ts:621-642`).
- **Session** — two types. Regular chat: conversation row in `conversations` with `id`, `type`, `extra`, `model`, `status`, `created_at`, `updated_at`. Team mode: `TeamSessionService.getOrStartSession(teamId)` caches a session only after the MCP server starts and `teamMcpStdioConfig` is written to agent conversations. Buys a stronger "living workspace/session" than a single bridge, since the team session binds mailbox, tasks, team-MCP, and worker lifecycle to a team id (`src/process/services/database/schema.ts:623-646`, `src/process/team/TeamSessionService.ts:3209-3347`, `src/process/team/TeamSession.ts:752-871`).
- **Task** — two task concepts. Team's explicit work board in `team_tasks` — `TaskManager.create()` makes tasks with `status`, `owner`, `blockedBy`, `blocks`, `metadata`. Runtime tasks in `WorkerTaskManager` — each conversation maps to an active agent manager that can be built, replaced, killed, idle-swept (`src/process/services/database/schema.ts:743-772`, `src/process/team/TaskManager.ts:489-628`, `src/process/task/WorkerTaskManager.ts:520-689`).
- **Tool** — two layers. `mcpService` in main/process offers detection, connection test, sync/remove, OAuth status/login/logout. Team mode `TeamMcpServer` builds its own MCP server layer for coordination tools — message send, agent spawn, channeled events, agent wakeup. Tool in AionUi is both external MCP management and internal team coordination over MCP (`src/common/adapter/ipcBridge.ts:3018-3085`, `src/process/services/mcpServices/McpService.ts:1139-1551`, `src/process/team/mcp/team/TeamMcpServer.ts:1598-1702`, `src/process/team/mcp/team/TeamMcpServer.ts:1992-3378`).
- **Memory** — no separate "semantic memory" class verified. Verified persistent conversation/message storage in SQLite, mailbox history per agent, team state in `teams`, `mailbox`, `team_tasks`. Closest equivalent to Máddu's event/context surface is table persistence + mailbox history, not a files-only event spine (`src/process/services/database/schema.ts:623-774`, `src/process/team/Mailbox.ts:352-433`, `src/process/team/types.ts:395-465`).
- **Workspace** — explicit in team model. `TTeam` contains `workspace` and `workspaceMode` (`shared | isolated`); `resolveWorkspace()` returns empty string if workspace not set, with a comment that downstream agent factory creates a temporary one. Clearest additive mapping for Máddu multi-workspace without breaking routes: workspace is a team- or lane-bound field, not necessarily a new data concept (`src/common/types/teamTypes.ts:615-670`, `src/process/team/TeamSessionService.ts:1988-2003`, `src/process/services/database/schema.ts:689-710`).
- **Event** — multiple explicit primitives. Renderer gets `conversation.responseStream`, team status / MCP status events via `ipcBridge`. Team MCP defines phases like `tcp_ready`, `session_injecting`, `session_ready`, `config_write_failed`, `mcp_tools_ready`. Mailbox messages and idle notifications are own types. Máddu's closest analogs: IPC stream for live progress, mailbox for inter-agent messaging, idle notification with `summary`/`completedTaskId` for work completion (`src/common/adapter/ipcBridge.ts:3097-3184`, `src/common/types/teamTypes.ts:728-779`, `src/process/team/Mailbox.ts:360-433`, `src/process/team/types.ts:395-465`, `src/process/team/TeamSession.ts:942-1049`).

## 4. State & Persistence Model

- Where state lives:
  - Process DB in `better-sqlite3` for accounts, conversations, messages, configuration (`src/process/services/database/README.md:247-276`, `src/process/services/database/README.md:359-368`).
  - Renderer `localStorage` for temporary UI preferences (`src/process/services/database/README.md:342-358`).
  - Filesystem for images, large attachments, and the DB file itself (`src/process/services/database/README.md:270-276`, `src/process/services/database/README.md:359-368`).
  - Team persistence in tables `teams`, `mailbox`, `team_tasks` (`src/process/services/database/schema.ts:689-772`).
- Schema shape:
  - `conversations(id, user_id, name, type, extra, model, status, created_at, updated_at)` (`src/process/services/database/schema.ts:623-653`).
  - `messages(id, conversation_id, msg_id, type, content, position, status, created_at)` (`src/process/services/database/schema.ts:655-685`).
  - `teams(id, user_id, name, workspace, workspace_mode, lead_agent_id, agents, created_at, updated_at)` (`src/process/services/database/schema.ts:687-714`).
  - `mailbox(id, team_id, to_agent_id, from_agent_id, type, content, summary, read, created_at)` (`src/process/services/database/schema.ts:716-741`).
  - `team_tasks(id, team_id, subject, description, status, owner, blocked_by, blocks, metadata, created_at, updated_at)` (`src/process/services/database/schema.ts:743-772`).
- Durability + recovery: README states first startup migrates earlier file storage to DB. Schema init sets `busy_timeout`, attempts `journal_mode = WAL`. Team sessions register only after successful MCP start + config injection — giving session-level recoverability (`src/process/services/database/README.md:286-301`, `src/process/services/database/schema.ts:578-596`, `src/process/team/TeamSessionService.ts:3270-3345`).
- Compatibility with Máddu's files-only rule: ❌. Core feature state lives in SQLite/`better-sqlite3`; renderer also uses `localStorage` for UI state. Patterns like mailbox, task board, workspaceMode, slot-tagged tool injection can be ported to files. AionUi's actual persistence implementation directly violates the files-only invariant (`src/process/services/database/README.md:247-276`, `src/process/services/database/README.md:342-368`, `src/process/services/database/schema.ts:623-774`).

## 5. Orchestration Model

- Scheduler / queue / lane equivalent: closest lane-like analogs — `TeamAgent.slotId`, task ownership via `owner`, mailbox's `toAgentId`/`fromAgentId`, MCP injection that can tag `TEAM_AGENT_SLOT_ID` in stdio config. TeamSession is a lane-aware coordinator over mailbox, task board, agent-wake. Closest mapping to Máddu's lane idea but without a verified "claim before edit" rule (`src/common/types/teamTypes.ts:621-670`, `src/process/team/Mailbox.ts:360-433`, `src/process/team/TaskManager.ts:489-628`, `src/process/team/mcp/team/TeamMcpServer.ts:1682-1702`, `src/process/team/TeamSession.ts:745-871`).
- Concurrency: `McpService` serializes heavy MCP operations via `operationQueue`. Team service holds per-team mutex for `addAgent`. MCP sync then runs parallel with `Promise.all`. Worker manager has its own idle sweep loop and replacement logic for tasks (`src/process/services/mcpServices/McpService.ts:1050-1071`, `src/process/services/mcpServices/McpService.ts:1456-1551`, `src/process/team/TeamSessionService.ts:1971-1976`, `src/process/task/WorkerTaskManager.ts:512-582`, `src/process/task/WorkerTaskManager.ts:589-689`).
- Supervision + failure: team sessions don't cache before full init, so broken MCP start can retry later. `wakeAfterAcceptedDelivery()` separates durable message acceptance from wake failure to avoid duplicate delivery. Worker cache replacement kills the old process before installing the new one. `clear()` waits for internal cleanup after kill (`src/process/team/TeamSessionService.ts:3270-3345`, `src/process/team/TeamSession.ts:875-895`, `src/process/task/WorkerTaskManager.ts:616-686`).

## 6. Provider / Model Integration

- Configuration: providers/models appear in persisted conversations + team agents via `conversation.type`, `model`, `agentType`, `customAgentId`, `sessionMode`. UI routes have special settings surfaces for gemini, model, assistants, agent, capabilities (`src/process/services/database/schema.ts:623-646`, `src/common/types/teamTypes.ts:621-670`, `src/renderer/components/layout/Router.tsx:514-558`).
- Credentials flow: exact provider-token flow not verified in this walk. Renderer uses `ipcBridge` for MCP OAuth status/login/logout against the process layer — not direct network calls from route files (`src/common/adapter/ipcBridge.ts:3064-3085`).
- API execution: verified pattern — renderer talks over IPC, process layer builds a manager per conversation, agent manager runs a forked worker file `type + '.js'`. MCP discovery/sync sits in process/main, while agent work goes via workers (`src/process/task/AgentFactory.ts:312-329`, `src/process/task/BaseAgentManager.ts:544-552`, `src/process/task/WorkerTaskManager.ts:589-689`, `src/process/services/mcpServices/McpService.ts:1139-1551`).
- Compatibility with Máddu's "no provider SDK in app code" rule: ⚠️. Walked code clearly shows execution not in renderer but in process/workers — positive. But AionUi remains an integrated app runtime with main-process services, DB state, in-app OAuth/MCP — vs Máddu's clean subprocess-only-provider boundary. Therefore **adapt**, not **copy** (`src/common/adapter/ipcBridge.ts:3064-3085`, `src/process/task/BaseAgentManager.ts:544-552`, `src/process/services/database/README.md:247-276`).

## 7. UI / Cockpit Layer

- Shell metaphor: routed shell with `Sider`, `Layout`, conversation tabs, preview provider, route pages for guid, conversation, settings, scheduled, team. Looks more like a cockpit shell than a simple chat page (`src/renderer/main.tsx:650-718`, `src/renderer/components/layout/Router.tsx:499-566`, `src/renderer/pages:241-269`).
- Window / pane / tab / workspace: verified — sidebar + route-based pages + `ConversationTabsProvider`. Workspace is a team field, not a verified top-level multi-pane workspace manager in walked files (`src/renderer/main.tsx:544-718`, `src/common/types/teamTypes.ts:615-670`).
- Navigation: `HashRouter` with protected layout, routes for `/guid`, `/conversation/:id`, `/team/:id`, settings sub-routes, `/scheduled`/`/scheduled/:jobId` (`src/renderer/components/layout/Router.tsx:493-566`).
- Keyboard / theming / a11y: `ThemeProvider` + Arco `ConfigProvider` with locale-eval and `primaryColor: '#4E5969'` (`src/renderer/main.tsx:544-679`). Other fields not verified.

## 8. Tool / MCP Integration Surface

- Discovery: `McpService.getAgentMcpConfigs()` builds detection list over agents, adds native Gemini CLI if needed, detects servers per agent, merges results per source so UI sees a row per agent/source (`src/process/services/mcpServices/McpService.ts:1278-1355`).
- Registration: `McpService` holds `Map` of agent protocols for `claude`, `codebuddy`, `qwen`, `iflow`, `gemini`, `aionui`, `codex`, `opencode`, `aionrs`. `TeamMcpServer` creates a separate local team MCP server, exposing slot-tagged stdio config to agent conversations (`src/process/services/mcpServices/McpService.ts:1139-1205`, `src/process/team/TeamSession.ts:806-869`, `src/process/team/mcp/team/TeamMcpServer.ts:1598-1702`).
- Invocation flow: UI calls `ipcBridge.mcpService.*`. Process layer filters `enabled` servers and syncs them parallel to all detected agents. Team mode starts MCP server, writes `teamMcpStdioConfig` to each agent conversation's `extra`, then rebuilds worker task cache (`src/common/adapter/ipcBridge.ts:3018-3085`, `src/process/services/mcpServices/McpService.ts:1456-1551`, `src/process/team/TeamSessionService.ts:3281-3345`).
- Permission / approval: explicit confirmation layer in `BaseAgentManager`. When `yoloMode` is active, first allowing option is auto-confirmed; otherwise confirmation is saved and emitted to UI as add/update. Real approval surface — but manager-centric rather than a general OMC-style policy plane (`src/process/task/BaseAgentManager.ts:530-623`).
- Sandboxing / hot-reload: not verified in walked files.

## 9. Strengths (ranked, copyable patterns)

- **Team session bootstrap-gate** — don't cache live session until team MCP actually started and agent conversations updated. High feasibility (`src/process/team/TeamSessionService.ts:3270-3345`).
- **Slot-tagged tool surface** — same MCP server serves multiple agents by tagging stdio config with `TEAM_AGENT_SLOT_ID`. High feasibility (`src/process/team/mcp/team/TeamMcpServer.ts:1682-1702`).
- **Team mailbox as async lane bus** — inter-agent messages are first-class records with unread/read atomicity + history. High feasibility (`src/process/team/Mailbox.ts:352-433`, `src/process/team/types.ts:395-417`).
- **Dependency-aware task board** — tasks have `blockedBy`/`blocks` and `checkUnblocks()` releasing dependencies on completion. High feasibility (`src/process/team/TaskManager.ts:489-628`).
- **IPC-first renderer boundary** — renderer uses providers/emitters over `ipcBridge` rather than carrying process logic itself. Medium feasibility (`src/common/index.ts:267-269`, `src/common/adapter/ipcBridge.ts:3018-3184`).
- **Forked agent runtime per conversation** — provider/agent work runs via forked worker entries, monitorable/replaceable/killable separately. High feasibility (`src/process/task/BaseAgentManager.ts:544-552`, `src/process/task/WorkerTaskManager.ts:589-689`, `src/worker:239-273`).
- **UI shell with routes + sider + tabs** — cockpit feel emerges from chat, team, settings, scheduling coexisting under a shared shell. Medium feasibility (`src/renderer/main.tsx:650-718`, `src/renderer/components/layout/Router.tsx:499-566`).

## 10. Weaknesses / Gaps

- **SQLite core** — core state in `better-sqlite3`, directly violating files-only (`src/process/services/database/README.md:247-276`, `src/process/services/database/schema.ts:623-774`).
- **`localStorage` in renderer** — UI state also leaks outside files-only discipline (`src/process/services/database/README.md:342-358`).
- **No verified lane lock** — team tasks have `owner` but no walked code shows a hard "claim before edit / no double-edit" mechanism (`src/process/services/database/schema.ts:745-772`, `src/process/team/TaskManager.ts:559-628`).
- **Slice-stop only indirect** — `idle_notification.summary` and `completedTaskId` imply final reports, but no verified event-sourced slice-stop ritual like Máddu's NDJSON stop summary (`src/process/team/types.ts:446-465`).
- **MCP model is agent/installation-centric** — detection/sync writes config to multiple local agent backends, colliding with Máddu's assumption that MCP is consumed via bridge, not by renderer or per-provider app state (`src/process/services/mcpServices/McpService.ts:1139-1551`, `src/process/team/TeamSessionService.ts:3281-3345`).

## 11. Máddu Compatibility Matrix

| Feature | What it is | Máddu analog | Verdict | Rationale |
|---|---|---|---|---|
| Electron renderer/process split | UI separated from process service | `server.js` + cockpit | adapt | Good pattern; Máddu already has shell/bridge-split without Electron req (`src/process/index.ts:373-413`, `src/renderer/main.tsx:650-718`). |
| IPC bridge providers/emitters | Typed UI→process calls | bridge endpoints | copy | Near Máddu's bridge idea; copyable as naming/contract pattern (`src/common/index.ts:267-269`, `src/common/adapter/ipcBridge.ts:3018-3184`). |
| Route shell with sider | Cockpit navigation in same app | existing routes | adapt | Additive as new route-shell, not replacement (`src/renderer/main.tsx:694-706`). |
| Conversation tabs | Multiple open chats in same shell | `/chats` | copy | High UX win, easy to do file-backed (`src/renderer/main.tsx:549-718`). |
| Team session cache gate | Only start "live session" when tool surface complete | lane/session startup ritual | copy | Strong robustness pattern for Máddu lanes (`src/process/team/TeamSessionService.ts:3270-3345`). |
| Slot-tagged team MCP | One tool surface, multiple agent identities via env | lane-owned MCP context | adapt | Copy the idea, but write lane-id in file/context pack rather than DB extra (`src/process/team/mcp/team/TeamMcpServer.ts:1682-1702`). |
| Mailbox bus | Async agent messages | event spine + lane inbox | copy | Storable as NDJSON per lane (`src/process/team/Mailbox.ts:352-433`). |
| Team task board | BlockedBy/blocks/owner | roadmap/slice tasks | adapt | Good model; port to JSON/NDJSON in `.maddu/` (`src/process/team/TaskManager.ts:489-628`). |
| SQLite conversations/messages | DB persistence for chat | `.maddu/` spine + projections | skip | **do-not-copy**: violates files-only (`src/process/services/database/README.md:247-276`). |
| `localStorage` UI state | Temporary renderer state | browser in-memory | skip | **do-not-copy**: violates files-only for new state (`src/process/services/database/README.md:353-358`). |
| MCP sync to installed agent CLIs | detect/sync/remove configs per backend | bridge-side MCP wiring | adapt | Discovery only in bridge; renderer/process shouldn't write provider config as source of truth (`src/process/services/mcpServices/McpService.ts:1288-1551`). |
| Confirmation queue + yolo | Approval flow with auto-approve | focused-gate harness | adapt | Good UI/worker contract; Máddu should keep gates explicit and lane-aware (`src/process/task/BaseAgentManager.ts:530-623`). |
| WorkerTaskManager cache/rebuild | One runtime per conversation, rebuild/killable | subprocess registry | copy | Highly relevant for monitoring spawned workers (`src/process/task/WorkerTaskManager.ts:589-689`). |
| Idle kill sweep | Clean up finished idle CLI agents | slice-stop cleanup | adapt | Good hygiene; tie to slice-stop in Máddu (`src/process/task/WorkerTaskManager.ts:512-582`). |
| WorkspaceMode shared/isolated | Team workspace policy | future multi-workspace | adapt | Portable as files-only policy field (`src/common/types/teamTypes.ts:615-670`). |
| Team routes | `/team/:id` workspace/team view | future `/lanes` or `/workspaces` | adapt | Good additive shell pattern (`src/renderer/components/layout/Router.tsx:514-525`). |
| Scheduled tasks route | Own page for cron/scheduled work | `/operations` | already-have | Máddu already has operations/roadmap surface (`src/renderer/components/layout/Router.tsx:557-558`). |
| Images/files outside DB | Attachments in FS, metadata in records | `.maddu/attachments` | copy | Close to Máddu discipline, safe to reuse (`src/process/services/database/README.md:270-276`). |
| Team MCP phase events | `tcp_ready`, `session_ready`, `config_write_failed` | verification reports | copy | Strong inspiration for lane-level verification panels (`src/common/types/teamTypes.ts:745-779`, `src/process/team/TeamSessionService.ts:3312-3322`). |

## 12. Additive-Only Proposals for Máddu

**`/workbench`**
A new OS-like workspace with left sidebar for workspaces/lane selection, center for conversation tabs, right sidebar for process/tool status. Takes AionUi's shell metaphor but keeps Máddu's existing routes intact by living as a completely new cockpit view. Tabs reference only files-only projections in `.maddu/`; all live status comes from the bridge process's existing subprocess registry. Key idea copied: shell + tabs + lane-aware process roster, not AionUi's DB (`src/renderer/main.tsx:650-718`, `src/renderer/components/layout/Router.tsx:499-566`).
- Where: new route `/workbench`; new SPA panel module in cockpit; projections under `.maddu/ui/workbench/*.json`.
- Hard-rule check: files-only ✅, no SQLite ✅, no hosted ✅, brand boundary ✅, no provider SDK ✅, no token export ✅.
- Complexity: M. Lane: shell.

**`/lanes/inbox`**
Mailbox bus per lane inspired by AionUi's `Mailbox`. Operator sees "to/from/summary/files/read" entries and subprocess agents can leave handoff messages to each other without mutating the same lane simultaneously. Storage as NDJSON per lane, not SQL — information shape directly copyable (`src/process/team/Mailbox.ts:360-433`, `src/process/team/types.ts:395-417`).
- Where: new route `/lanes/inbox`; files under `.maddu/lanes/<lane>/mailbox.ndjson`.
- Hard-rule check: files-only ✅, no SQLite ✅, no hosted ✅, brand boundary ✅, lane ownership ✅.
- Complexity: S. Lane: coordination.

**`/lanes/tasks`**
Dependency-aware task board with `blockedBy`, `blocks`, `owner`, `status`, plus automatic "unblock" when a slice stops or completes. AionUi's `TaskManager` ported to JSON projections + NDJSON events (`src/process/team/TaskManager.ts:489-628`, `src/process/services/database/schema.ts:745-772`).
- Where: new route `/lanes/tasks`; files under `.maddu/tasks/graph.json` + `.maddu/events/tasks.ndjson`.
- Hard-rule check: files-only ✅, no SQLite ✅, no hosted ✅, lane ownership ✅, slice-stop ✅.
- Complexity: M. Lane: roadmap.

**`/tools/mcp-registry`**
Bridge-driven MCP registry view showing which MCP servers exist, which lanes/workspaces request them, status per tool surface. Copies AionUi's discovery/sync/status-phase idea but not agent-config-writing or app-driven OAuth (`src/process/services/mcpServices/McpService.ts:1278-1551`, `src/common/types/teamTypes.ts:745-779`).
- Where: new route `/tools/mcp-registry`; files under `.maddu/mcp/registry.json` + `.maddu/mcp/status.ndjson`.
- Hard-rule check: files-only ✅, no SQLite ✅, no hosted ✅, no token export ✅, bridge-owned MCP ✅.
- Complexity: M. Lane: tools.

**`/verification`**
Verification view collecting lane-start/status/stop phases, equivalent to AionUi's `TeamMcpPhase`. Máddu uses it to make slice-stop, handoff quality, and tool readiness visible as an audit panel (`src/common/types/teamTypes.ts:745-779`, `src/process/team/TeamSessionService.ts:3312-3322`).
- Where: new route `/verification`; files under `.maddu/verification/*.ndjson`.
- Hard-rule check: files-only ✅, no SQLite ✅, no hosted ✅, brand boundary ✅, slice-stop ✅.
- Complexity: S. Lane: verification.

**Ship-first recommendation: `/workbench`.** Captures the biggest OS-like UX win fastest — multi-workspace feel, tabs, process status without requiring DB, hosted backend, or route-breaking redesign of existing cockpit pages. Underlying inspiration: AionUi's shell + tabs + live-process separation, not its persistence stack (`src/renderer/main.tsx:650-718`, `src/renderer/components/layout/Router.tsx:499-566`, `src/process/task/WorkerTaskManager.ts:589-689`).

## 13. Risks of Adoption

- **Accidentally porting SQLite-centric patterns instead of just UX/shape.** *Mitigation:* limit porting to shape/flow; all new state writes as NDJSON/JSON in `.maddu/`; no DB adapter allowed (`src/process/services/database/README.md:247-276`).
- **AionUi's MCP model pulling Máddu toward agent-backend sync rather than bridge-owned MCP.** *Mitigation:* keep discovery, permissions, status in the bridge process; renderer gets projections + intents only (`src/process/services/mcpServices/McpService.ts:1278-1551`).
- **Auto-approve / YOLO-like behaviors eroding Máddu's focused-gate harness.** *Mitigation:* keep explicit operator gate as default; make auto mode lane- or tool-specific, never global (`src/process/task/BaseAgentManager.ts:573-590`).
- **Team/workspace abstraction smearing lane ownership.** *Mitigation:* map AionUi's `slotId`/`owner` to Máddu lane-id but keep lane claim as a separate files-only lock contract (`src/common/types/teamTypes.ts:621-670`, `src/process/team/TaskManager.ts:559-628`).
- **UI shell growing larger than its value if attempting to recreate all of AionUi.** *Mitigation:* start with `/workbench` as a read-mostly shell on top of existing routes; add mailbox/tasks/status gradually (`src/renderer/main.tsx:650-718`).

## 14. Máddu Strengths Worth Preserving

- Files-only event spine is stricter and more portable than AionUi's mix of SQLite, `localStorage`, and filesystem.
- Slice-stop learning loop is clearer than AionUi's verified model, where the closest analog is just `idle_notification.summary` and various status phases.
- Three-layer brand boundary has no verified counterpart in the walked AionUi files.
- Token-never-travel discipline is sharper than AionUi's integrated OAuth/MCP surface.
- Lane ownership is more strictly defined than AionUi's verified task/mailbox model, where exclusive claim-before-edit couldn't be substantiated.

## 15. Evidence Appendix

- `src/process/index.ts:344-413` — process bootstrap runs storage, extension registry, channels.
- `src/common/index.ts:257-269` — common export of IPC bridge.
- `src/renderer/main.tsx:532-718` — renderer boot, providers, tabs, theme, router.
- `src/renderer/components/layout/Router.tsx:493-566` — routes for guid, conversation, team, settings, scheduled.
- `src/process/services/database/README.md:247-368` — DB architecture, renderer `localStorage`, filesystem, DB file location.
- `src/process/services/database/schema.ts:578-774` — WAL, conversations/messages/teams/mailbox/team_tasks schema.
- `src/process/services/mcpServices/McpService.ts:1050-1551` — service lock, backend registry, detect/merge/sync-test for MCP.
- `src/process/team/TeamSession.ts:745-1115` — session coordinator, team MCP, sendMessage/sendMessageToAgent, dispose.
- `src/process/team/TeamSessionService.ts:1971-2003` — workspace resolution.
- `src/process/team/TeamSessionService.ts:3209-3347` — `getOrStartSession`, `spawnAgent`, init-gating, config injection.
- `src/process/team/Mailbox.ts:352-433` — mailbox write/read/history.
- `src/process/team/TaskManager.ts:489-628` — task create/update/list/checkUnblocks.
- `src/process/team/types.ts:395-465` — mailbox message, team task, idle notification.
- `src/process/team/mcp/team/TeamMcpServer.ts:1598-1702` — local team MCP server, auth token, stdio config, slot tagging.
- `src/process/team/mcp/team/TeamMcpServer.ts:1992-3378` — team tools like `send_message`, `spawn_agent`, permission-like handling.
- `src/common/types/teamTypes.ts:571-583` — team-capable backend detection.
- `src/common/types/teamTypes.ts:609-779` — WorkspaceMode, TeamAgent, TTeam, team status/message/MCP phase events.
- `src/process/task/AgentFactory.ts:312-329` — factory mapping `conversation.type` to manager.
- `src/process/task/BaseAgentManager.ts:511-623` — ForkTask-based agent runtime, confirmations, yolo mode.
- `src/process/task/WorkerTaskManager.ts:520-689` — task cache, idle kill, getOrBuildTask, replace/kill/clear.
- `src/common/adapter/ipcBridge.ts:3018-3184` — mcpService providers, conversation/openclaw/database bridge API.
- `src/common/adapter/ipcBridge.ts:3239-3340` — preview, ppt preview, task/webui/system bridge API.
