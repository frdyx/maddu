// `maddu format [argv…]` — audited formatter (v1.1.0 Phase 1).
// Auto-detects prettier or `npm run format`. Emits the standard tool events.
// v1.3.0 — shares the wrapper body via _tools.mjs#runWrapper.

import { runWrapper } from './_tools.mjs';

export default async function formatCmd(argv) {
  await runWrapper('format', argv, { parseRunner: true });
}
