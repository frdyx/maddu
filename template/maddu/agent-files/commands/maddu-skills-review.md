---
name: maddu-skills-review
description: List skill candidates the autonomous detector found; materialize or reject. Suggest-only (operator decides). (v1.1.0)
maddu-version-min: 1.1.0
---

The operator wants to review the autonomous skill curation queue.

**Output discipline:**

1. Run `./maddu/run skill candidates list` via Bash.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

If candidates exist:

- For each `pending` row, briefly state what the tag set suggests (e.g. "git + commit + audit → commit-discipline pattern").
- Ask the operator which to materialize. Materialize via `./maddu/run skill from-candidate <hash> --title "..."`.
- Reject (with `./maddu/run skill candidate-reject <hash> --reason "..."`) only when the operator explicitly says no.

Reminder: the detector is suggest-only (per `feedback_no_learning_curve_ux.md`). Never auto-write a skill file. The operator has final say.
