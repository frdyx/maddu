// `maddu goal <set|show>` — Governance Phase 1; success conditions v1.6.0.
//
// Set:  emits GOAL_DECLARED with { objective, constraints[], success[] }.
// Show: prints the current goal (latest GOAL_DECLARED) from the projection.
//
// v1.6.0 — `--success "<verify-cmd>::<text>"` (repeatable, soft cap 5): a
// measurable success condition. The part before `::` is a shell command that
// exits 0 when met (consumed by `maddu orient`); the part after is the human
// description. No `::` → text-only, unverifiable.

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

function parseSuccess(raw) {
  const items = raw === undefined || raw === true ? [] : (Array.isArray(raw) ? raw : [raw]);
  return items
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => {
      const idx = s.indexOf('::');
      if (idx === -1) return { text: s.trim(), verify: null };
      return { verify: s.slice(0, idx).trim() || null, text: s.slice(idx + 2).trim() };
    });
}

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
    const success = parseSuccess(flags.success);
    if (success.length > 5) {
      console.error(`warning: ${success.length} success conditions — keep it to ≤5 measurable ones (keep it to a few measurable ones); recording all anyway.`);
    }
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.GOAL_DECLARED,
      actor: process.env.MADDU_SESSION_ID || null,
      data: { objective, constraints, success },
    });
    console.log(`goal set: ${objective}`);
    console.log(`constraints: ${constraints.length}  ·  success conditions: ${success.length} (${success.filter((s) => s.verify).length} verifiable)`);
    console.log(`event: ${ev.id}`);
    return;
  }

  if (sub === 'show') {
    const proj = await projections.project(repoRoot);
    console.log(JSON.stringify(proj.goal ?? null, null, 2));
    return;
  }

  console.error('Usage: maddu goal <set|show> [--objective "…"] [--constraint "…" …] [--success "<verify-cmd>::<text>" …]');
  process.exit(2);
}
