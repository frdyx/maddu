---
name: maddu-search
description: Cross-corpus search over events, memory, skills, and the mailbox. Read-only projection from the spine.
maddu-version-min: 1.3.0
---

The operator wants to search the Máddu corpus for: **$ARGUMENTS**.

**Output discipline:**

1. Run `./maddu/run search "$ARGUMENTS"` via Bash.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

What it covers:

- `events` — typed events in the append-only spine.
- `memory` — hindsight-extracted facts under `.maddu/memory/`.
- `skills` — SKILL.md-pattern recipes under `.maddu/skills/`.
- `mailbox` — operator inbox + per-lane mailbox lines.

Reminder: this is a **read-only** lookup across derived projections of the
append-only spine at `.maddu/events/*.ndjson` — the only source of truth.
Surface the most relevant hits first and tell the operator which corpus
each came from.
