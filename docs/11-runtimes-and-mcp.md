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

### Harness capability doctor

`maddu runtime doctor` answers a different question from `detect`. `detect` asks "does this descriptor's binary run?"; `doctor` asks "what is this *harness* understood to be able to do, and does the copy installed here still match that understanding?"

```bash
$ maddu runtime doctor codex          # one harness
$ maddu runtime doctor --all          # every harness in the manifest
$ maddu runtime doctor codex --json   # machine-readable
```

The comparison is against `maddu/runtime/lib/harness-capabilities.mjs` — a repo-versioned manifest describing each supported harness's native lifecycle-hook surface. It currently carries `claude-code`, `codex`, `hermes`, `openhands`, and `gemini`.

**Doctor observes. It does not enforce, install, or modify anything.** It probes for the CLI, checks whether the harness's config files exist and whether they already carry a Máddu stanza, appends one `HARNESS_CAPABILITY_OBSERVED` event, and refreshes `.maddu/state/harness-capabilities.json` (a projection, rebuildable from the spine). It never writes to a harness's own configuration, and it deliberately does not ride `runtime detect` — asking a question should not write another surface's state as a side effect.

#### Observed vs. assumed

Every capability in the output carries one of three statuses, and none of them is a guarantee:

| Status | What it means |
|---|---|
| `verified` | The detected CLI version fell **inside** the version window the manifest's review actually covered. |
| `assumed` | The reading could not be placed inside that window. The `drift` field says why. |
| `not-installed` | No such CLI was found. This is a **valid observation**, not a failure — the command still exits 0. |

A claim is only ever held back, never upgraded. Drift reasons are `below-range`, `above-range`, `unparsable`, `prerelease`, `no-verified-range` (the review never established a version window for that harness), and `probe-failed`.

A timeout or a permission error is reported as `assumed` with a `probeFailure`, never as `not-installed` — a probe that could not run says nothing at all about whether the CLI is there. For the same reason, a harness probed through a *registered runtime descriptor* (whose `detect.command` is a shell command line) can never read `not-installed`: the shell's own exit code is what comes back, so a missing binary and a failing one are indistinguishable. Only the manifest's shell-free probe, which resolves the command against `PATH` directly, can be definitive.

#### Enforcement ceiling

`enforcementCeiling` is the **strongest honest claim** about a harness — `block` when a blocking pre-tool surface was verified, `observe` when the surface is understood to report only. It describes the harness, not Máddu: an `observe` surface is never described as enforcement, and a `block` ceiling is not a promise that anything will be blocked.

#### The two-source rule

A `block` claim is the one claim that could lead Máddu to tell you a harness will refuse something, so it is held to a higher bar: the manifest's shape validator **rejects** any `block` ceiling or `block` hook unless `verifiedAgainst.sources` carries at least two distinct entries. One vendor documentation page is testimony, not verification — harnesses whose blocking half reached only a single source are recorded with an `observe` ceiling instead.

#### Volatile surfaces

Entries carry a `volatile` marker when the surface is known to be moving — for example `gemini` (announced transition toward an "Antigravity CLI") and `hermes` (documentation says hooks register in both CLI and gateway, but a reported issue says `hermes serve` does not register shell hooks, so the serve/desktop surface is treated as observe-only). The marker is shown in the output so staleness is visible rather than silent.

#### Config observation

Every candidate config path in the manifest is reported, in manifest order, with `absent`, `present-no-stanza`, or `stanza-present`. `configPath` is the first candidate that is not absent. PR1 scans for the Máddu stanza marker only — it does not parse a harness's own configuration semantics.

Repo-local candidates resolve against the **work** root (the checkout being inspected) while the event and projection are written against the **state** root, so inside a lane worktree the reading describes the right checkout.

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
