// `maddu lint [argv…]` — audited linter (v1.1.0 Phase 1).
// Auto-detects eslint or `npm run lint`. Emits the standard tool events.
// v1.3.0 — shares the wrapper body via _tools.mjs#runWrapper.

import { runWrapper } from './_tools.mjs';

export default async function lintCmd(argv) {
  await runWrapper('lint', argv, { parseRunner: true });
}
