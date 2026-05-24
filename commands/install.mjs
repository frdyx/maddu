// `maddu install <packages…>` — audited dep installer (v1.1.0 Phase 1).
//
// Resolves npm / pnpm / yarn from lockfiles. Refuses empty package lists
// (rule #4 — no broad new deps without an explicit operator decision).
// v1.3.0 — shares the wrapper body via _tools.mjs#runWrapper; the
// strict-mode approval gate (v1.2.0 Phase 5) rides in as the `strict`
// callback so the behavior is identical.

import { runWrapper } from './_tools.mjs';
import { requireStrictApprovalIfNeeded } from './_strict-approval.mjs';

function printInstallHelp() {
  console.log([
    'Usage: maddu install <package> [<package> ...]',
    '',
    '  Audited dep installer (resolves npm/pnpm/yarn from lockfiles).',
    '  Refuses empty package lists and empty-string args (rule #4 guard).',
  ].join('\n'));
}

export default async function installCmd(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printInstallHelp(); return; }
  await runWrapper('install', argv, {
    // v1.2.0 Phase 5 — strict-mode approval enforcement. Closes the
    // v1.1.0 burn-in note: strict governance must actually gate
    // `maddu install` behind explicit operator approval.
    strict: ({ spineLib, repoRoot, lane, sessionId, argv: a }) =>
      requireStrictApprovalIfNeeded(spineLib, repoRoot, { tool: 'install', argv: a, lane, sessionId }),
  });
}
