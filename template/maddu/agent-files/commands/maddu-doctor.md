---
name: maddu-doctor
description: Run Máddu's hard-rule + integrity gates and surface findings clearly.
maddu-version-min: 0.18.0
---

The operator wants a Máddu health check.

**Output discipline (read carefully):**

1. Run `./maddu/run doctor` via Bash. If `$ARGUMENTS` is non-empty, forward it as `./maddu/run doctor --gate "$ARGUMENTS"`.
2. **After the bash call returns, re-print the doctor's complete output inside a fenced markdown code block (` ``` `) in your reply.** The operator's bash-output view collapses long output behind a `… +N lines (ctrl+o to expand)` affordance — the only way they actually see the per-gate verdicts is if you echo them back inside a code fence. Do not summarize, paraphrase, or omit any rows.

Then add a short post-print synthesis (one paragraph max):

1. If the summary line shows `0 fail`, say so explicitly — e.g. *"Máddu is healthy: 19 PASS · 1 WARN · 0 FAIL"*. Quote any WARN row verbatim so the operator can decide if it matters.
2. If there are FAILs, list each one with its `gateId` and the actionable hint from the gate message (most gate messages end in a `run \`maddu …\`` suggestion — surface that). Do NOT speculate about root causes the gate didn't name.
3. For deep diagnostics, suggest `./maddu/run doctor --verbose`.

Discipline:

- Never claim a gate passed that the doctor didn't actually report.
- Don't attempt to fix gate failures inside this command — surface the finding and ask the operator before mutating anything.
- If the doctor itself errors out (e.g. `.maddu/ not found`), say so plainly and suggest `maddu init` or running from the right cwd.
