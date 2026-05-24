// `maddu coordinator <plan-id>` — runtime-agnostic multi-phase driver.
//
// Usage:
//   maddu coordinator <plan-id> [--runtime <name>] [--dry-run]
//                                [--synthetic-cmd "<bash>"] [--iter-cap N]
//
// --dry-run     each phase succeeds immediately (smoke test).
// --synthetic-cmd "<bash>"  run this command per phase; exit 0 = phase
//                            done. The command sees MADDU_COORDINATOR_*
//                            env vars and can branch on the phase name.

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m', pass: '\x1b[32m', fail: '\x1b[31m' };

async function loadCoordinator() {
  return loadLib('coordinator.mjs');
}

export default async function coordinatorCmd(argv) {
  const { flags, positional } = parseFlags(argv);
  const planId = positional[0];
  if (!planId) {
    console.error('usage: maddu coordinator <plan-id> [--runtime <name>] [--dry-run] [--synthetic-cmd "<bash>"] [--iter-cap N]');
    process.exit(2);
  }
  const lib = await loadCoordinator();
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  const opts = {
    planId,
    runtime: typeof flags.runtime === 'string' ? flags.runtime : null,
    dryRun: !!flags['dry-run'],
    syntheticPhaseCmd: typeof flags['synthetic-cmd'] === 'string' ? flags['synthetic-cmd'] : null,
    iterCap: typeof flags['iter-cap'] === 'string' ? Number(flags['iter-cap']) : null,
    sessionId: process.env.MADDU_SESSION_ID || null,
  };

  console.log(`${ANSI.bold}coordinator${ANSI.reset}  plan: ${planId}  ${opts.dryRun ? '(dry-run)' : (opts.syntheticPhaseCmd ? '(synthetic)' : `(runtime: ${opts.runtime || 'shell'})`)}`);

  try {
    const res = await lib.runCoordinator(repoRoot, opts);
    if (res.ok) {
      console.log(`${ANSI.pass}completed${ANSI.reset}  ${res.coordinatorId}  ${res.phaseCount} phase(s)`);
      process.exit(0);
    }
    console.error(`${ANSI.fail}halted${ANSI.reset}     ${res.coordinatorId}  reason=${res.reason}  phase=${res.phase}`);
    process.exit(1);
  } catch (err) {
    console.error(`${ANSI.fail}error${ANSI.reset}      ${err.message}`);
    process.exit(1);
  }
}
