---
name: maddu-format
description: Audited formatter. Auto-detects prettier or `npm run format`. Emits tool events on the spine.
maddu-version-min: 1.1.0
---

The operator wants to format the project via Máddu.

**Output discipline:**

1. Run `./maddu/run format $ARGUMENTS` via Bash.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

Synthesis:

- On success, state plainly: "Formatted via <runner> <args>."
- On refusal `no-detector`, tell the operator no formatter is wired (no `scripts.format`, no `prettier` dep). Suggest `./maddu/run format --command <runner>` or wiring prettier.
- Never reformat by hand-editing files; that would bypass the audit trail.
