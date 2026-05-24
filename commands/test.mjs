// `maddu test [argv…]` — audited test runner (v1.1.0 Phase 1).
//
// Auto-detects the test runner from package.json (npm script `test`,
// vitest, jest, mocha). Operator can override with `--command <runner>
// --runner-arg=<a> --runner-arg=<b>`. Emits the standard tool events.
// v1.3.0 — shares the wrapper body via _tools.mjs#runWrapper.

import { runWrapper } from './_tools.mjs';

export default async function testCmd(argv) {
  await runWrapper('test', argv, { parseRunner: true });
}
