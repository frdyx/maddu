---
name: maddu-doctor
description: Run Máddu's hard-rule + integrity gates and surface findings clearly.
maddu-version-min: 0.18.0
---

The operator wants a Máddu health check.

Run `./maddu/run doctor` and surface the output. If the operator passed
an argument (`$ARGUMENTS`), treat it as the gate id to focus on:
forward it as `./maddu/run doctor --gate "$ARGUMENTS"`.

After running:

1. If the summary line shows `0 fail`, say so explicitly — e.g.
   *"Máddu is healthy: 19 PASS · 1 WARN · 0 FAIL"*. Quote any WARN row
   verbatim so the operator can decide if it matters.
2. If there are FAILs, list each one with its `gateId` and the
   actionable hint from the gate message (most gate messages end in a
   `run \`maddu …\`` suggestion — surface that). Do NOT speculate about
   root causes the gate didn't name.
3. For deep diagnostics, run `./maddu/run doctor --verbose`.

Discipline:

- Never claim a gate passed that the doctor didn't actually report.
- Don't attempt to fix gate failures inside this command — surface the
  finding and ask the operator before mutating anything.
- If the doctor itself errors out (e.g. `.maddu/ not found`), say so
  plainly and suggest `maddu init` or running from the right cwd.
