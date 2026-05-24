// `maddu goal <set|show>` — Governance Phase 1.
//
// Set:  emits GOAL_DECLARED with { objective, constraints[] }.
// Show: prints the current goal (latest GOAL_DECLARED) from the projection.

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

export default async function command(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'set') {
    const { flags, positional } = parseFlags(rest);
    // Forgiving form: `maddu goal set "<objective>"` — first positional is
    // the objective when --objective is absent. --objective stays canonical.
    const objective = (typeof flags.objective === 'string' && flags.objective.length > 0)
      ? flags.objective
      : (positional[0] || requireFlag(flags, 'objective'));
    const raw = flags.constraint;
    const constraints = raw === undefined || raw === true
      ? []
      : (Array.isArray(raw) ? raw : [raw]);
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.GOAL_DECLARED,
      actor: process.env.MADDU_SESSION_ID || null,
      data: { objective, constraints },
    });
    console.log(`goal set: ${objective}`);
    console.log(`constraints: ${constraints.length}`);
    console.log(`event: ${ev.id}`);
    return;
  }

  if (sub === 'show') {
    const proj = await projections.project(repoRoot);
    console.log(JSON.stringify(proj.goal ?? null, null, 2));
    return;
  }

  console.error('Usage: maddu goal <set|show> [--objective "…"] [--constraint "…" …]');
  process.exit(2);
}
