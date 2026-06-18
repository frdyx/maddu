---
name: maddu-test
description: Project test runner. Plain mode keeps legacy auto-detect; adaptive profiles are available with --profile smoke|quick|full.
maddu-version-min: 1.1.0
---

The operator wants to run the project's test suite via Maddu.

**Output discipline:**

1. Run `./maddu/run test $ARGUMENTS` via Bash. Pass through any extra args.
2. After the call returns, re-print the wrapper's complete output inside a fenced markdown code block so the operator can see the runner verdict.

Useful forms:

- `./maddu/run test` keeps the legacy single detected-runner path.
- `./maddu/run test --profile quick --bail` runs the adaptive project-test profile.
- `./maddu/run test --profile full` runs the broader adaptive project-test profile.
- `./maddu/run test --changed` uses configured changed-file mappings when present.
- `./maddu/run test --command <runner>` is the legacy override path. Do not combine it with adaptive flags.

Synthesis (one short paragraph):

- If exit=0 and no failures appear in the captured output, state plainly: "Tests passed: <runner/profile> in <ms>ms."
- If exit!=0, surface the failing test ids, names, and file paths verbatim when present. Do not invent fixes. Ask the operator how they want to proceed.
- If the refusal reason is `no-detector`, tell the operator that no test runner is detected in the project. Suggest `./maddu/run test --command <runner>` for legacy override or `.maddu/config/test-harness.json` for adaptive profiles.
- If adaptive mode reports no selected runnable tests, explain that the profile/filter/change mapping selected nothing.

Never call raw `npm test` for the same operation in the same turn.
