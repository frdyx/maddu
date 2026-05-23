---
name: maddu-log
description: Show the audited receipt log (operations.ndjson). Filters by --since, --lane, --op. Pure projection from the spine.
maddu-version-min: 1.1.0
---

The operator wants to inspect the operations receipt log.

**Output discipline:**

1. Run `./maddu/run log $ARGUMENTS` via Bash.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

Common filters:

- `--since 2026-05-24T00:00:00Z` — only entries after this ISO timestamp.
- `--lane <id>` — only entries for one lane.
- `--op TOOL_INVOKED` — only one event type, or any substring match on summary.
- `--rebuild` — re-projects the log from the spine + refreshes `.maddu/log/README.md`.
- `--json` — raw JSON for piping.

Reminder: the receipt log is a **derived projection** — the append-only spine at `.maddu/events/*.ndjson` is the only source of truth. The `receipts-coherent` gate enforces deterministic re-projection.
