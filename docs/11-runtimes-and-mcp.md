# Runtimes and MCP

Two pluggable extension surfaces:

- **Runtimes** — subprocess capabilities Máddu can `spawn` (Claude Code, Codex, node, custom workers).
- **MCP** — the Model Context Protocol server registry, owned by the bridge.

Both are descriptor-driven, both are file-backed under `.maddu/`, and both are exposed in the cockpit (`#runtimes` and `#mcp`) and the CLI (`maddu runtime …`, `maddu mcp …`).

## Runtimes

A runtime descriptor lives at `.maddu/runtimes/<name>.json`. It describes:

- `binary` — executable name (resolved via PATH or absolute).
- `args` — default args appended on spawn.
- `protocol` — typically `stdio-json`.
- `capabilities` — `{mcp, tools, streaming, approval}`.
- `detect` — a quick `command` Máddu runs to verify the runtime is installed (e.g. `claude --version`).
- `lanes` — which lanes are allowed to spawn this runtime (`["*"]` = all).
- `spawn.env` — extra env keys to inject at spawn.

### Register a runtime

```bash
$ maddu runtime register \
    --name claude-code \
    --display "Claude Code" \
    --binary claude \
    --args exec \
    --detect "claude --version" \
    --mcp --streaming --approval per-tool
registered  claude-code
```

### Detect

```bash
$ maddu runtime detect              # detect-all
$ maddu runtime detect claude-code  # one runtime
```

The detect command runs the descriptor's `detect.command` and records the result in `.maddu/runtimes/.health.json`. The health badge in the cockpit reflects this.

### Spawn a worker

```bash
$ maddu runtime spawn claude-code --session ses_... --lane cockpit-shell --args "--task,Implement route X"
spawned  wkr_2026...  pid:12345
  log: .maddu/workers/wkr_2026.../stdout.log
```

What happens on spawn:

1. Bridge looks up the descriptor.
2. Bridge resolves credentials (OAuth tokens from `.maddu/auth/` and/or `~/.config/maddu/auth/`).
3. Bridge appends a `WORKER_SPAWNED` event with a deterministic `wkr_...` id.
4. Bridge spawns the binary with `extraArgs` appended, env injected, cwd set to the repo root.
5. The worker is expected to heartbeat to `POST /bridge/workers/<id>/heartbeat` at least every 15 seconds. Silence beyond that surfaces as `stuck` in the cockpit.

### List / show / remove

```bash
$ maddu runtime list
$ maddu runtime show claude-code
$ maddu runtime remove claude-code
```

HTTP equivalents: `GET /bridge/runtimes`, `GET /bridge/runtimes/<name>`, etc. See [05-bridge-endpoints.md](05-bridge-endpoints.md).

### The `#runtimes` cockpit route

Each registered runtime is a card with:

- Detect-command health badge (green check, red cross, or dash).
- Capability chips (`mcp`, `tools`, `streaming`, `approval:per-tool`).
- Actions: Detect, Spawn, Remove.

## MCP

MCP server descriptors live at `.maddu/mcp/<name>.json`. Three transports are supported:

- `stdio` — a local binary the bridge spawns. `stdio.command` + `stdio.args`.
- `sse` — a URL the bridge connects to via Server-Sent Events. `sse.url`.
- `http` — a plain HTTP MCP endpoint. `http.url`.

### Register

```bash
# stdio
$ maddu mcp register \
    --name fs-tools \
    --transport stdio \
    --command /usr/local/bin/mcp-fs \
    --args "--root,/tmp" \
    --lanes "bridge-server,harness" \
    --display "Filesystem tools"

# http
$ maddu mcp register \
    --name remote-search \
    --transport http \
    --url http://127.0.0.1:9001/mcp \
    --lanes "*"
```

### Enable / disable / test / remove

```bash
$ maddu mcp enable fs-tools
$ maddu mcp disable fs-tools
$ maddu mcp test fs-tools       # one server
$ maddu mcp test                # test all
$ maddu mcp remove fs-tools
```

`test` runs a minimal MCP handshake (or HTTP HEAD/GET, depending on transport) and records the result. The cockpit health badge reflects the latest test.

### Per-lane visibility

The `lanes` field on a descriptor controls which lanes see the server. `["*"]` = all lanes. Otherwise, only listed lanes get the server injected when spawning workers for that lane.

```bash
$ maddu mcp visible bridge-server
VISIBLE for lane "bridge-server"  (3)
  fs-tools  (stdio)
  …
```

This is the "slot-tagged env injection" pattern adapted from AionUi's `TeamMcpServer`.

### The `#mcp` cockpit route

Each server is a card with:

- Transport, enabled state, allowed lanes, last health check.
- Actions: Test, Enable, Disable, Remove.

## Where credentials go

Both runtimes and MCP servers receive credentials via env injection **at spawn time**. Tokens live under `~/.config/maddu/auth/<provider>.json` (Linux/macOS) or `%APPDATA%\maddu\auth\<provider>.json` (Windows). The bridge reads them, sets the appropriate env vars (`ANTHROPIC_API_KEY`, etc.), and spawns the subprocess. Tokens never travel over the HTTP API — see [12-auth-and-imports.md](12-auth-and-imports.md).

## See also

- [12-auth-and-imports.md](12-auth-and-imports.md) — where credentials live.
- [03-cli-reference.md](03-cli-reference.md) — full flag reference.
- [05-bridge-endpoints.md](05-bridge-endpoints.md) — `/bridge/runtimes` and `/bridge/mcp` endpoints.
