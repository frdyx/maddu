---
name: maddu-lint
description: Audited linter. Auto-detects eslint or `npm run lint`. Emits tool events on the spine.
maddu-version-min: 1.1.0
---

The operator wants to lint the project via Máddu.

**Output discipline:**

1. Run `./maddu/run lint $ARGUMENTS` via Bash.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

Synthesis:

- On success, state plainly: "Lint clean: <runner> <args>."
- On exit≠0, surface the rule violations + file paths verbatim. Do not propose fixes inside this slash command — ask the operator first.
- On refusal `no-detector`, tell the operator no linter is wired (no `scripts.lint`, no `eslint` dep).
