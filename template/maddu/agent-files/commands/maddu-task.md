---
name: maddu-task
description: List, show, create, update, or complete tasks on the Máddu task board. State lives in the append-only spine.
maddu-version-min: 1.3.0
---

The operator wants to work with the task board: **$ARGUMENTS**.

**Output discipline:**

1. If `$ARGUMENTS` starts with a verb (`list`, `show`, `create`, `update`,
   `complete`), forward it as `./maddu/run task $ARGUMENTS`. If empty, run
   `./maddu/run task list`.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

Common patterns:

- `list` — open tasks, newest first.
- `show <task-id>` — full detail for one task.
- `create "<title>" [--lane <id>]` — open a new task (`--title "…"` also works).
- `update <task-id> --status <state>` — move a task along the board.
- `complete <task-id>` — close a task.

Reminder: tasks are projected from typed events in the append-only spine at
`.maddu/events/*.ndjson` — the only source of truth. `create`, `update`, and
`complete` are mutating: claim the relevant lane first and slice-stop after.
