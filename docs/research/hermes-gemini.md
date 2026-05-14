# Research Report — Hermes (Gemini Deep Research)

## 1. Repo Identity

- URL: https://github.com/NousResearch/hermes-agent
- Commit SHA read: `0cf7d570e2be48e125d101c6a41aca837bb0b91c`
- License: Apache-2.0
- Last commit date: May 2026
- Primary language(s): Python (88%), TypeScript (9%)
- Maintainer(s): Nous Research / Teknium
- One-paragraph elevator pitch: Hermes Agent is a sophisticated agentic OS designed to "grow with the user" by synthesizing new skills and memories from conversation trajectories. It features a robust "Learning Loop" that autonomously extracts facts and patterns into a persistent "Hindsight Memory," a multi-platform gateway supporting 16+ messaging services (Telegram, Discord, Slack), and a powerful execution engine capable of running Python scripts via RPC to collapse complex multi-step pipelines into single turns. Model-agnostic foundation unifying diverse LLM providers (Anthropic, Bedrock, OpenAI) and local inference (Ollama), with a high-performance terminal UI (TUI) and a visual web dashboard.

## 2. Architecture Map

- Top-level directories:
  - `agent/` — core reasoning engine, `AIAgent` class, transport adapters.
  - `hermes_cli/` — CLI including React-like Ink TUI and command registry.
  - `gateway/` — session management, bridges to external messaging platforms, persistent WebSocket connections.
  - `skills/` — human-readable skills following `agentskills.io` standard.
  - `tools/` — built-ins (terminal, write_file, web_search) + central `ToolRegistry`.
  - `environments/` — Docker, SSH, Singularity, serverless sandboxes (Modal).
- Runtime entry points:
  - `hermes` — primary interactive CLI.
  - `hermes gateway start` — launches multi-platform messaging service.
  - `run_agent.py` — `AIAgent` class, core tool-orchestration + inference loop.
- Build / packaging: `uv` for Python dependency management. Interactive TUI is a React/Ink rewrite (`ui-tui/`) communicating via JSON-RPC with a Python gateway. One-liner install script for Linux/macOS/WSL2.
- ASCII data-flow:
```
[ User Prompt ] <-> (JSON-RPC / WS) <-> [ Gateway / TUI ]
                                            |
                                  [ Hindsight Memory ]  <-- (Trajectory Extract)
                                            |
                                  [ AIAgent (run_agent.py) ]
                                            |
                              +-------------+-------------+
                              v                           v
                       [ Model Adapter ]          [ Subprocess Tools ]
                              |                           |
                              v                           v
                   [ LLM Providers (Native) ]   [ Local Filesystem ]
```

## 3. Core Primitives

- **AIAgent** — central long-lived reasoning loop with provider, model, toolset config. Has `iteration_budget` + "grace call" to prevent infinite loops.
- **Skill** — version-controlled `SKILL.md` Markdown file following `agentskills.io` standard. Defines behavioral rules + tool sequences.
- **Learning Loop (Hindsight)** — prunes raw transcripts and extracts structured facts into persistent memory store.
- **Session** — isolated conversation thread persistently stored in JSONL + SQLite, supporting cross-channel resume + full-text search.
- **Gateway** — unified platform bridge managing concurrent sessions across 16+ messaging platforms with cross-platform conversation continuity.
- **Iteration Budget** — security/cost-control limit on autonomous turns before user intervention required.
- **Worktree** — filesystem isolation. Multiple parallel agents work on the same repo via disposable Git worktrees.

## 4. State & Persistence Model

- Where state lives: conversation metadata + searchable history in SQLite (`~/.hermes/state.db`) with FTS5 indexing. Raw transcripts + tool calls for active sessions in JSONL files (`~/.hermes/sessions/`).
- Schema shape: `state.db` has `sessions` (metadata), `messages` (full content), `messages_fts` (search index).
- Durability + recovery: active sessions persisted in real-time to JSONL, surviving gateway restarts. "Auto-Save Checkpoints" provide `/rollback` for filesystem changes.
- Compatibility with Máddu's files-only rule: ✅. Highly compatible. While SQLite is used for search acceleration, the source of truth is the JSONL transcripts — aligns with Máddu's invariant. The SQLite layer can be replaced by a file-backed index in Máddu's port.

## 5. Orchestration Model

- Scheduler / queue / lane equivalent: built-in "Cron" for natural-language automation + `/goal` target-lock primitive keeping agents persistent across turns.
- Concurrency: via `delegate_tool` — spawns child `AIAgent` instances with isolated context + restricted toolsets.
- Supervision + failure: "Confirm/Rollback" pattern for self-updates; "YOLO" flag bypasses confirmation. SIGINT escape hatch + hard timeouts for tools like `session_search`.

## 6. Provider / Model Integration

- Configuration: `hermes model` wizard or `config.yaml`. Supports model aliases + first-class provider catalogs.
- Credentials flow: stored in `~/.hermes/auth/` with restricted permissions + cross-process `fcntl` locks.
- API execution: in the main Python process via provider-specific adapters (`AnthropicTransport`, `ChatCompletionsTransport`).
- Compatibility with Máddu's "no provider SDK in app code" rule: ⚠️. Hermes includes native transport adapters for providers. While decoupled from UI, they exist within core application logic — **do-not-copy** for the Máddu cockpit shell itself; treat Hermes as an external subprocess runtime if integrated at all.

## 7. UI / Cockpit Layer

- Shell metaphor: "Agentic-OS-style" terminal UI (TUI) or visual local dashboard.
- Window / pane / tab / workspace: TUI provides "Sticky Composer," live streaming status, per-turn stopwatch. Web Dashboard for sessions, skills, model configs.
- Navigation: slash commands (`/resume`, `/model`, `/clear`) + session picker in TUI.
- Keyboard: standard terminal navigation + stable picker keys for session management.
- Theming: Ink-based React components, light-theme presets, status-bar HUDs.
- Accessibility: localized 8+ languages; Termux-friendly for mobile.

## 8. Tool / MCP Integration Surface

- Discovery: `discover_builtin_tools()` uses AST parsing to find `registry.register()` calls in `tools/*.py`. Zero-config discovery of new tools.
- Registration: MCP host integration reads `config.yaml` to register external servers via `stdio`, `sse`, or `http`.
- Invocation flow: model `tool_call` → central registry dispatch → execution in forked child process or via RPC script.
- Permissions: `detect_dangerous_command()` triggers interactive prompts for sensitive commands (`rm -rf`, `git push`) with "allow permanently" option.
- Sandboxing: env scrubbing, resource limits, Unix domain socket RPC isolating code execution from the main agent loop.
- Hot-reload: MCP servers + plugins reloadable without restarting the main agent gateway.

## 9. Strengths (ranked, copyable patterns)

- **Autonomous Hindsight Memory** — fact extraction + skill synthesis from conversation trajectories. High feasibility.
- **RPC-backed Python interpreter** — collapses complex tool workflows into single turns via isolated Python scripts over sockets. High feasibility.
- **agentskills.io skill standard** — portable, human-readable format for agent behavior + specialized capabilities. High feasibility.
- **Git Worktree isolation** — disposable worktrees prevent parallel-agent clobbering. Medium feasibility.
- **Multi-platform gateway sync** — single conversation thread across Telegram/Slack/Discord with cross-channel resume. Medium feasibility (do-not-copy for cloud bridges, but local-pubsub adaptation is interesting).

## 10. Weaknesses / Gaps

- **Monolithic reasoning loop** — `run_agent.py` is 16k LOC, leading to high complexity and side-effect risk.
- **Search latency regressions** — recent issues show `session_search` hanging for 5+ minutes on large SQLite databases.
- **No native GUI** — terminal-first; web dashboard is supplementary, unlike AionUi's unified visual shell.

## 11. Máddu Compatibility Matrix

| Feature | What it is | Máddu analog | Verdict | Rationale |
|---|---|---|---|---|
| Hindsight memory | Fact extraction | slice-stop ritual | copy | Enhances slice-stop pattern detection. |
| agentskills.io | Skill standard | context packs | adapt | Align context packs with `SKILL.md` spec. |
| `/resume` | Session resumption | none | copy | Essential for long-running workflows across restarts. |
| `execute_code` (RPC) | Socket-based tools | spawned exec | adapt | Port socket RPC to `server.js` for faster tool calling. |
| Git worktrees | Task isolation | lane ownership | adapt | Use worktrees to enforce lane-owner rule. |
| `/steer` | Mid-turn nudge | none | copy | Critical for supervising long subprocess runs. |
| `/goal` | Target persistence | none | copy | Prevents agent drift during multi-step swarm tasks. |
| `/rollback` | FS checkpointing | none | copy | High-value safety net for operations. |
| SQLite (FTS5) | Search index | NDJSON spine | skip | Violates files-only. |
| Gateway | Messaging bridge | none | skip | Security / brand-boundary risk. |
| `uv` package mgmt | Venv isolation | none | copy | Dramatically improves spawn reliability for Python runtimes. |
| PKCE OAuth | Local-only auth | none | copy | Matches tokens-never-travel invariant. |
| `/debug share` | Pastebin upload | none | skip | Violates no-hosted-backends and security rules. |
| `/fast` | Priority routing | none | adapt | Prioritize campaign vs routine swarm tasks. |
| Ink TUI | React terminal | cockpit shell | adapt | Port multiline / slash-command UI patterns. |

## 12. Additive-Only Proposals for Máddu

**Hindsight Extraction Worker**
Local Node subprocess running after every `maddu slice-stop`. Reads the NDJSON spine and extracts structured facts into `.maddu/memory.ndjson`.
- Where: `server.js` (internal worker) + `/roadmap` (UI view).
- Hard-rule check: files-only ✅, local-only ✅, brand boundary ✅.
- Complexity: M. Lane: analyst-agent.

**Skill Gallery View**
A `/skills` cockpit route displaying `SKILL.md` files from the workspace. Drag-and-drop into active lanes.
- Where: `/skills`.
- Hard-rule check: files-only ✅, no SQLite ✅.
- Complexity: S. Lane: manager-agent.

**Context-Aware Composer**
Enhanced multiline chat input with slash-command autocompletion (`/resume`, `/rollback`, `/goal`).
- Where: `omc-cockpit.html` chat bottom bar — but wired into Máddu's `cockpit/index.html`.
- Hard-rule check: stdlib node ✅, brand boundary ✅.
- Complexity: S. Lane: cockpit-agent.

**Checkpoint Timeline HUD**
Visual sidebar on `/operations` showing filesystem checkpoints created by agents via git worktree. Revert with `/rollback`.
- Where: `/operations`.
- Hard-rule check: files-only ✅, no broad deps ✅.
- Complexity: L. Lane: git-agent.

## 13. Risks of Adoption

- **Python dependency** — Hermes primitives are Python-centric while Máddu is Node-centric. *Mitigation:* run Hermes logic as isolated subprocess (`python3 extract_memory.py`) rather than rewriting in Node.
- **State entropy** — the learning loop can generate massive metadata. *Mitigation:* retention period (e.g. 30 days) prunes `.maddu/memory.ndjson`.
- **Process deadlocks** — Unix domain sockets for RPC can deadlock if not managed carefully. *Mitigation:* standard Node `net` modules with strict timeouts for the RPC listener.

## 14. Máddu Strengths Worth Preserving

- **NDJSON event spine** — Hermes's SQLite/JSONL split is more complex than Máddu's unified append-only spine; easier to verify and back up.
- **Worker-only API calls** — Máddu's rule that the app shell never imports provider SDKs is more secure than Hermes's centralized `run_agent.py`.
- **Brand boundary discipline** — Máddu's three-layer boundary ensures agents never adopt the identity of the runtime unless explicitly told to.

## 15. Evidence Appendix

- `run_agent.py` — `AIAgent` class + iteration budget logic.
- `https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md` — session persistence; SQLite/JSONL split.
- `tools/delegate_tool.py` — subagent spawning + isolation.
- `hermes_cli/auth.py` — OAuth resolution + auth-store locking.
- `https://github.com/NousResearch/hermes-agent/issues/28` — hindsight memory + fact extraction architecture.
