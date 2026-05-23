# 29. MCP server template gallery

Máddu v1.1.0 ships five curated MCP server templates as JSON
descriptors. The operator opts in to install — the framework does not
ship MCP servers as runtime dependencies.

## Catalog

```
maddu mcp templates list
```

| Template       | Transport | Requires       | Purpose |
|---|---|---|---|
| `local-fs`        | stdio | npx        | Standard MCP filesystem server, sandboxed to cwd |
| `local-search`    | stdio | node, curl | RSS/curl-based local search (no API key, no provider SDK) |
| `calculator`      | stdio | node       | Local arithmetic, stdlib only |
| `git-advanced`    | stdio | node, git  | `git log --graph`, blame, rev-list. Read-only by design |
| `time-and-date`   | stdio | node       | Time, date arithmetic, timezone lookups |

## Install path

```bash
maddu mcp install calculator
# → scaffolded  .maddu/mcp/calculator/server.mjs
# → installed   calculator  (stdio)  ← template:calculator
```

The installer:

1. Reads the template descriptor at
   `template/maddu/mcp-templates/<name>.json`.
2. Checks every entry in `requires` via `which` (POSIX) or `where`
   (Windows). Refuses with install instructions if any binary is
   missing.
3. Scaffolds any companion `scaffold.files` into the consumer's
   `.maddu/mcp/<name>/`. Idempotent — won't clobber operator edits.
4. Registers the descriptor through the existing `saveMcp` path,
   emitting `MCP_REGISTERED` on the spine.

`maddu mcp uninstall <name>` removes the registration. The companion
files under `.maddu/mcp/<name>/` are left for the operator to inspect.

## Why JSON descriptors

Per rule #4, Máddu cannot ship MCP server source as a runtime
dependency. JSON descriptors + a `requires` check + scaffold-on-demand
keep the framework rule-compliant while making the gallery
operator-discoverable.

Templates that need external binaries declare them up-front. The
install refuses cleanly when anything's missing — no half-broken
installs.

## Cockpit Tools route

The cockpit `tools` route (connect group, rank 7) shows:
- 5 default tools (git / test / format / lint / install)
- All registered MCP servers + their health
- Last 20 `TOOL_INVOKED/COMPLETED/REFUSED` events

GET `/bridge/tools` returns the unified view.

## Adding your own

Templates are JSON, so operators can add custom ones without framework
changes:

1. Drop a JSON file into `.maddu/mcp-templates/` (or contribute one
   upstream into `template/maddu/mcp-templates/`).
2. Match the shape validated by the `mcp-template-shape` gate:
   `template`, `displayName`, `summary`, `transport`, `stdio|sse|http`,
   `requires`, `lanes`, optional `scaffold.files`, `notes`,
   `hardRuleNotes`.

## Gate

- **`mcp-template-shape`** (safety) — every shipped descriptor parses,
  declares transport + requires, and refuses anything mentioning a new
  `package.json` dep (rule #4).
