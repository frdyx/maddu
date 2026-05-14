# Research Report — AionUi (Gemini Deep Research)

## 1. Repo Identity

- URL: https://github.com/iOfficeAI/AionUi
- Commit SHA read: 1.9.25
- License: Apache-2.0
- Last commit date: May 2026
- Primary language(s): TypeScript (90.1%), Rust
- Maintainer(s): iOfficeAI / IceyLiu / piorpua
- One-paragraph elevator pitch: AionUi is a cross-platform desktop "Cowork" application that functions as a sophisticated agentic-OS layer, transforming the standard computing environment into a unified command center for autonomous AI agents. Built on an Electron and React foundation with a high-performance Rust backend, it unifies disparate terminal-based tools like Claude Code, Codex, and Hermes into a single graphical cockpit, enabling multi-agent orchestration, parallel session management, and 24/7 automated task execution via natural-language scheduling. The system distinguishes itself through native "OfficeCLI" integration, allowing agents to generate production-ready, editable Word, Excel, and PowerPoint documents while providing users with deep "Human-in-the-Loop" controls over filesystem operations and Model Context Protocol (MCP) tool usage.

## 2. Architecture Map

- Top-level directories:
  - `src/main`: Electron main process — system-level window management and backend communication.
  - `src/renderer`: React frontend — dashboard, chat, file preview.
  - `src/process/worker`: Forked worker threads for compute-heavy tasks.
  - `assistant/`: Metadata for 20+ professional assistant presets.
  - `skills/`: Modular capability blocks including OfficeCLI document skills.
  - `.aionui`, `.claude`, `.gemini`: Per-engine persistent state directories.
- Runtime entry points:
  - Desktop launch: `src/main/index.js` (compiled from TS) initializes Electron + Aion-backend service.
  - v2.0+ backend (`aionrs`) is a standalone Rust service over HTTP/WebSocket; embedded in desktop or deployed headless.
- Build / packaging: Vite for frontend bundling, electron-vite for Electron pipeline. Dependencies via Bun. Production binaries via electron-builder (DMG / EXE / DEB; x64 + ARM64).
- ASCII data-flow:
```
[ User ] <-> [ Renderer UI ] <-> (WebSocket/IPC) <-> [ Aion Backend ]
                                                           |
                                            +--------------+--------------+
                                            v              v              v
                                     [ SQLite DB ]   [ Process Spawn ]  [ MCP Servers ]
                                                     (Claude Code,
                                                      Codex via ACP)
```

## 3. Core Primitives

- **Agent** — autonomous entity with multi-step task execution, FS operations, web navigation. Possesses "Agent Client Protocol" (ACP) capability — reports progress, requests permissions, communicates with a leader.
- **Session** — persistent conversation + context unit, isolated by workspace and agent type. Independent history in local DB.
- **Task** — concrete objective managed through coordinated multi-agent pipelines. In "Team Mode," a leader agent decomposes a task and delegates to teammates.
- **Tool / Skill** — discrete capability (PDF manipulation, image generation, Excel formatting). Modular blocks extending the base engine.
- **Memory** — local, session-bound, SQLite-backed. "Autocompact" logic manages context windows for long sessions.
- **Workspace** — local directory assigned to an agent session. First-class — file changes and history surface to UI.
- **Event** — backend↔frontend communication via persistent WebSocket bus: thinking messages, tool-execution status, turn completion, token-usage stats, real-time HUD updates.

## 4. State & Persistence Model

- Where state lives: local device, single SQLite DB (`local.db`) in app data dir.
- Schema shape: session-based retrieval — conversations (metadata + model settings), messages (roles, content, tool calls), tasks (scheduling + execution).
- Durability + recovery: atomic DB writes; "heartbeat" ping/pong monitors agent subprocesses; failure detection allows resume from last checkpoint.
- Compatibility with Máddu's files-only rule: ⚠️. AionUi's SQLite reliance violates the rule. *Patterns* — separation of conversation metadata from "message extras," JSON snapshots for skill state — could be adapted to Máddu's NDJSON spine by treating DB transactions as append-only log events.

## 5. Orchestration Model

- Scheduler / queue / lane equivalent: "Cron" scheduler with natural-language scheduling on a dedicated worker thread (`Cron WorkerTaskManagerJobExecutor`). Runs 24/7 in unattended "Full-Auto" mode.
- Concurrency: "Parallel Sessions" — backend spawns independent subprocesses per active agent. "Team Mode" — hierarchical Leader/Teammate.
- Supervision + failure: "YOLO Mode" auto-approves agent actions; "Manual Mode" requires user confirmation per write/command. 15-second idle fallback + process-exit handlers recover from stuck executions.

## 6. Provider / Model Integration

- Configuration: unified settings UI for Gemini, OpenAI, Claude, Bedrock, Ollama. API-key rotation + model-selection persistence per conversation.
- Credentials flow: stored locally in app config dir. Google accounts use Desktop OAuth with PKCE.
- API execution: backend service or forked workers. External CLI agents (Claude Code) run the API call entirely in the subprocess; AionUi only sees the standardized ACP event stream.
- Compatibility with Máddu's "no provider SDK in app code" rule: ✅ for external-agent path (black-box CLI). ❌ for "Built-in Agent" which uses internal libraries (`gemini-cli` logic) — that path is do-not-copy.

## 7. UI / Cockpit Layer

- Shell metaphor: "Cowork Dashboard" / "Command Center" — unified workspace replacing scattered OS windows.
- Window / pane / tab: multi-tab session management + "Preview Panel" for syntax-highlighted code, PDFs, editable Office docs. Sidebar with agent gallery + scheduling.
- Navigation: left sidebar + top-level tab bar.
- Keyboard: standard Electron shortcuts; slash-command autocompletion in chat.
- Theming: React + UnoCSS. Semantic CSS tokens in `uno.config.ts`.
- Accessibility: multi-language via centralized i18n (no hardcoded strings).

## 8. Tool / MCP Integration Surface

- Discovery: auto-scans PATH for installed CLIs (`claude`, `codex`, `qwen`); one-click init for ACP-compatible agents.
- Registration: MCP servers registered via visual UI; supports `stdio`, `sse`, `http`.
- Invocation flow: agent tool request → "ACP 2.0" layer → permission check → dispatch to local system or MCP server.
- Permissions: granular — `allow` / `deny` / "always approve" per tool category (Read, Write, WebSearch, Bash).
- Sandboxing: broad FS access; certain dirs whitelistable/restrictable.
- Hot-reload: MCP UI supports auto-testing + reloading.

## 9. Strengths (ranked, copyable patterns)

- **OfficeCLI document generation** — native `.pptx`/`.docx`/`.xlsx` generation with complex formatting and animations. High feasibility.
- **Unified MCP synchronization** — central dashboard configs auto-sync to all integrated CLI agents. High feasibility.
- **Natural-language cron scheduling** — conversational requests → standard cron. High feasibility.
- **Agent Client Protocol (ACP) abstraction** — standardized communication layer making diverse CLIs "pluggable." Medium feasibility.
- **Multi-pane visual dashboard** — chat + file previews + agent status HUD in one workspace. Medium feasibility.

## 10. Weaknesses / Gaps

- **SQLite centralization** — relational DB for conversation history is harder to port/audit than per-workspace files.
- **Electron memory footprint** — significant overhead vs raw terminals; limits parallel agents on low-spec machines.
- **Complex backend-frontend sync** — recent PRs reveal challenges keeping skill caches in sync between Rust backend and React frontend, causing stale-cache bugs.

## 11. Máddu Compatibility Matrix

| Feature | What it is | Máddu analog | Verdict | Rationale |
|---|---|---|---|---|
| OfficeCLI | Doc/XLS/PPT engine | none | copy | Massive value for campaign/roadmap exports. |
| Unified MCP sync | Centralized tool config | none | copy | Simplifies tool discovery for spawned workers. |
| NL→cron | Scheduling via chat | none | copy | Fits the swarm-automation logic. |
| ACP 2.0 layer | Standard agent protocol | bridge server | adapt | Standardize the "exec" interface for subprocesses. |
| YOLO Mode | Global auto-approval | none | copy | Essential for unattended swarm operations. Scope it per-lane. |
| Multi-tab GUI | Parallel session views | dashboard route | adapt | Enhance single-page layout for multitasking. |
| File preview panel | Syntax-highlighted viewer | none | copy | Improves visibility for verification reports. |
| SQLite persistence | Relational DB | NDJSON spine | skip | Violates files-only. |
| Rust backend | Standalone service | bridge server | skip | Node.js invariant; keep bridge in Node. |
| Google OAuth (app) | Integrated identity | none | skip | Violates no-cloud/hosted rule. |
| Remote WebUI | Browser-based access | none | skip | Security/token-leak risk. |
| Attachment pathing | Preserved binary paths | context packs | adapt | Port "safer path" logic. |
| Tool heartbeat | Stuck-process check | none | copy | Increases reliability for long-running workers. |
| i18n skill | Multi-language rules | none | skip | Already handled by standard Node/React patterns. |
| Skill auto-discovery | Scanning folders | none | copy | Portable agent capabilities across workspaces. |
| Multi-key rotation | API-key high availability | none | copy | Critical for avoiding rate-limits in swarms. |
| Team Leader role | Task delegation agent | swarm route | adapt | Align swarm route with Leader UI. |
| Task status HUD | Visual progress bar | none | copy | Essential for monitoring unattended agents. |
| Git history view | Visual versioning | roadmap route | adapt | Integrate into operations route. |
| Sub-agent spawn | Child process scaling | exec workers | already-have | Máddu spawns workers as subprocesses by design. |

## 12. Additive-Only Proposals for Máddu

**Office Artifact Panel**
A visual pane for viewing/managing generated Word/Excel/PPT files. Agents generate via a new `office-gen` skill.
- Where: `/dashboard` (new panel) or `/operations/artifacts`.
- Hard-rule check: files-only ✅, local-only ✅, brand boundary ✅.
- Complexity: M. Lane: designer-agent.

**Conversation Heartbeat Watcher**
Low-level process-monitoring loop in `server.js` using ping/pong to detect hung worker subprocesses.
- Where: `server.js` (internal) + `/settings/status` (UI).
- Hard-rule check: stdlib node ✅, no broad deps ✅.
- Complexity: S. Lane: cockpit-agent.

**MCP Visual Registry**
Dashboard panel for registering and enabling MCP servers globally. Injects relevant `mcp.json` config into every spawned agent.
- Where: `/settings/tools`.
- Hard-rule check: no provider SDKs in app code ✅, local-only ✅.
- Complexity: M. Lane: bridge-server.

**Natural-Language Scheduler**
Command bar accepting "Summarize the spine every evening at 6pm." Saves to `.maddu/schedule.ndjson`.
- Where: `/swarm`.
- Hard-rule check: files-only ✅, no hosted backends ✅.
- Complexity: S. Lane: ops-agent.

## 13. Risks of Adoption

- **Complexity overhead** — introducing ACP and complex MCP syncing might over-engineer the lean bridge. *Mitigation:* implement as optional feature flags in `.maddu/config/cockpit-flags.json`.
- **State desync** — moving between Aion-style JSON snapshots and Máddu's NDJSON spine could cause data loss if not handled atomically. *Mitigation:* treat the spine as absolute source of truth; use JSON only for read-model projections.
- **Dependency bloat** — syntax highlighting / Office rendering may increase frontend size. *Mitigation:* lightweight, zero-dep browser libraries.

## 14. Máddu Strengths Worth Preserving

- **Append-only event spine** — Máddu's NDJSON spine is more resilient to corruption and easier to audit manually than AionUi's centralized SQLite.
- **Three-layer brand boundary** — strict isolation prevents the "generic AI personality" leak that often occurs in integrated agent dashboards.
- **Worker-only provider calls** — keeping all API calls in subprocess workers is architecturally superior for security and rate-limiting compared to AionUi's "Built-in Agent" path.

## 15. Evidence Appendix

- `src/main/index.js` — main Electron entry.
- `src/process/task/TaskManager.ts` — core subprocess management logic.
- `https://github.com/iOfficeAI/AionUi/releases/tag/v1.9.21` — heartbeat protocol + process-exit handler.
- `https://github.com/iOfficeAI/AionUi/wiki/MCP-Configuration-Guide` — MCP transport methods.
- `https://github.com/iOfficeAI/OfficeCli` — Office generation engine docs.
