// `maddu git <argv…>` — audited git wrapper (v1.1.0 Phase 1).
//
// Spawns the local `git` binary via child_process.spawn (no shell), emits
// TOOL_INVOKED / TOOL_COMPLETED / TOOL_REFUSED on the spine. Refuses
// known-dangerous forms: empty commit message, `git push -f` (must spell
// --force literally). v1.3.0 — shares the wrapper body via
// _tools.mjs#runWrapper. The pre-spawn secret scan (the contract checked
// by the `secret-scan-active` doctor gate) lives in runWrapper.
//
// Raw argv is passed straight to the tool (no --command/--runner-arg
// parsing): `maddu git` is a verbatim git passthrough.

import { runWrapper } from './_tools.mjs';

export default async function gitCmd(argv) {
  await runWrapper('git', argv);
}
