# 27 — Transcript import (`maddu usage import`)

Introduced in **v0.19.1**. Backfills Máddu's token ledger from your
own Claude Code session transcripts, so `maddu cost` reflects actual
usage instead of "no token usage reported yet".

## Why this exists

Máddu's bridge can only observe workers it spawns. When you use
`claude` directly from your shell — i.e. the operator's Claude Code
session itself — the bridge isn't the parent process, so no
`TOKEN_USAGE_REPORTED` event is emitted. The ledger stays empty even
though you've clearly used the model.

This isn't a bug, it's an architectural boundary (the bridge would
have to attach to arbitrary parent processes to capture them, which
violates the "files-only, append-only" hard rules). The escape hatch
is retroactive import: Claude Code stores transcripts as JSONL under
`~/.claude/projects/<slug>/<session-uuid>.jsonl`, and `maddu usage
import` walks them, extracts usage data from each assistant turn, and
emits one `TOKEN_USAGE_REPORTED` event per turn with
`source: "claude-code-transcript"`.

## Usage

```bash
# Dry-run — parse everything, report counts, write nothing.
$ maddu usage import --from claude-code --dry-run
[dry-run] Claude Code transcript import:
  files examined: 123
  lines scanned:  151413
  imported:       57878
  skipped (already imported): 0

  (no events written — re-run without --dry-run to commit)

# Commit the import.
$ maddu usage import --from claude-code

# Only import a specific Claude Code session (substring match on UUID).
$ maddu usage import --from claude-code --session 21f43c48

# Skip lines older than a date.
$ maddu usage import --from claude-code --since 2026-04-01
```

## Idempotency

Every line we'd emit an event for gets a stable `importHash`:
`sha256(sessionUuid + lineNumber + usage payload).slice(0, 16)`.

Before writing, we walk the spine for prior
`TOKEN_USAGE_REPORTED` events with `source: "claude-code-transcript"`
and skip any line whose `importHash` already appears. Running the
import three times in a row is safe — only new lines (or lines added
to a session since the last import) flow through.

## What the imported rows look like

```json
{
  "type": "TOKEN_USAGE_REPORTED",
  "actor": "<claude-code-session-uuid>",
  "data": {
    "runtime": "claude-code",
    "sessionId": "<claude-code-session-uuid>",
    "model": "claude-sonnet-4-5-20250929",
    "ts": "2026-05-21T07:48:00.000Z",
    "inputTokens": 1234,
    "outputTokens": 567,
    "cacheRead": 4096,
    "cacheCreation": 0,
    "source": "claude-code-transcript",
    "importHash": "a1b2c3d4e5f60718"
  }
}
```

After import, `maddu cost` rolls these up the same way native worker
emissions are rolled up. The `--by` axis still works: `runtime` shows
"claude-code" as a row alongside any Máddu-spawned workers; `model`
breaks down by Sonnet vs Opus etc.; `session` shows the Claude Code
session UUIDs alongside Máddu session ids.

## Flags

| Flag | Effect |
|---|---|
| `--from claude-code` | **Required.** The only source supported in v0.19.1. |
| `--dry-run` | Parse and report counts; don't write events. |
| `--since <iso-date>` | Skip lines older than `<iso-date>` (parsed by `new Date(...)`). |
| `--session <substring>` | Only import lines from session UUIDs containing `<substring>`. |

## Hard-rule compliance

- **Rule #1 (files-only state).** Reads JSONL transcripts (plain
  files), writes spine events. No DB.
- **Rule #4 (no broad new deps).** Pure Node stdlib: `fs/promises`,
  `node:readline`, `node:crypto`, `node:os`, `node:path`.
- **Rule #5 (no provider SDKs in framework code).** Parsing is
  `JSON.parse` on transcript lines. No `@anthropic-ai/sdk` import.

## When to use it

- **First-time setup.** You've been using Claude Code for months
  before installing Máddu — pull in the historical ledger so `maddu
  cost` looks right.
- **After heavy direct use.** Even with Máddu installed, your daily
  driver session is probably running `claude` directly. Periodic
  imports keep the dashboard honest.
- **NOT for live monitoring.** The import is point-in-time. Live
  observability requires the bridge to spawn the worker — that's what
  `maddu pipeline run`, `maddu advise`, etc. do.

## See also

- [`05-bridge-endpoints.md`](05-bridge-endpoints.md) — `/bridge/cost`
  serves the same projection over HTTP.
- [`10-skills-and-hindsight.md`](10-skills-and-hindsight.md) — how
  skill injection events differ from token usage events.
- [`docs/cost.md`](03-cli-reference.md#cost) — the rollup itself.
