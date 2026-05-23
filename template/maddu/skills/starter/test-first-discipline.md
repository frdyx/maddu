---
id: test-first-discipline
tags: test, tdd, verify
triggers: test, vitest, jest, mocha, run tests
---

# Test-first discipline

Before changing behaviour:
1. Add a failing test that captures the new contract.
2. Implement until `maddu test` (v1.1.0 Phase 1) passes.
3. Slice-stop with the test names in `targets`.

`maddu test` auto-detects the runner (npm test → vitest → jest → mocha) and emits tool events on the spine. Use `--command <runner>` to override.

If `maddu test` refuses with `no-detector`, the project has no test runner wired — that's the operator's call to make before adding behaviour.
