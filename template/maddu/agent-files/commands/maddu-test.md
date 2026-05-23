---
name: maddu-test
description: Audited test runner. Auto-detects npm test, vitest, jest, or mocha. Emits tool events on the spine.
maddu-version-min: 1.1.0
---

The operator wants to run the project's test suite via Máddu.

**Output discipline:**

1. Run `./maddu/run test $ARGUMENTS` via Bash. Pass through any extra args.
2. After the call returns, re-print the wrapper's complete output inside a fenced markdown code block so the operator can see the runner's verdict.

Synthesis (one short paragraph):

- If exit=0 and no failures appear in the captured output, state plainly: "Tests passed: <runner> <args> in <ms>ms."
- If exit≠0, surface the failing test names and the file paths verbatim. Do not invent fixes. Ask the operator how they want to proceed.
- If the refusal reason is `no-detector`, tell the operator that no test runner is detected in `package.json` (no `scripts.test`, no `vitest`/`jest`/`mocha` dep). Suggest `./maddu/run test --command <runner>` to override.

Never call raw `npm test` for the same operation in the same turn.
