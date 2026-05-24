---
name: maddu-memory
description: List, search, or extract hindsight memory — facts the framework distilled from past slices. Read-mostly projection from the spine.
maddu-version-min: 1.3.0
---

The operator wants to work with Máddu's hindsight memory: **$ARGUMENTS**.

**Output discipline:**

1. If `$ARGUMENTS` starts with a verb (`list`, `search`, `extract`), forward
   it as `./maddu/run memory $ARGUMENTS`. If `$ARGUMENTS` looks like a free-text
   query (no leading verb), run `./maddu/run memory search "$ARGUMENTS"`.
   If empty, run `./maddu/run memory list`.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

Common patterns:

- `list` — every extracted memory fact, newest first.
- `search "<query>"` — substring match across the memory corpus.
- `extract` — re-run the hindsight extractor over recent slice-stops to
  distill new facts. This is the only mutating verb here.

Reminder: memory under `.maddu/memory/` is a **derived projection** of the
append-only spine at `.maddu/events/*.ndjson` — the only source of truth.
Never hand-edit memory files; let `extract` rebuild them.
