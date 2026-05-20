// `maddu phase <set|show>` — Governance Phase 1.
//
// Set:  emits PHASE_DECLARED with { name, notes? }.
// Show: prints the current phase (latest PHASE_DECLARED) from the projection.

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

export default async function command(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'set') {
    const { flags } = parseFlags(rest);
    const name = requireFlag(flags, 'name');
    const notes = flags.notes === undefined || flags.notes === true ? null : flags.notes;
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.PHASE_DECLARED,
      actor: process.env.MADDU_SESSION_ID || null,
      data: { name, notes },
    });
    console.log(`phase set: ${name}`);
    if (notes) console.log(`notes: ${notes}`);
    console.log(`event: ${ev.id}`);
    return;
  }

  if (sub === 'show') {
    const proj = await projections.project(repoRoot);
    console.log(JSON.stringify(proj.phase ?? null, null, 2));
    return;
  }

  console.error('Usage: maddu phase <set|show> [--name "…"] [--notes "…"]');
  process.exit(2);
}
