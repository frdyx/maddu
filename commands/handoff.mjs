// `maddu handoff <set|show>` — curated cross-session handoff (v1.6.0).
//
// The "▶ RESUME HERE" narrative a fresh session needs: current state, the exact
// next slice, blockers, the work queue, decisions-pending. Unlike the auto-derived
// trail in `brief`, this is curated by the operator/agent — and `maddu orient`
// surfaces it first. Latest HANDOFF_SET wins.
//
//   maddu handoff set "<markdown>"   (or --body "<markdown>")
//   maddu handoff show               print the current curated handoff

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

export default async function handoff(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'set') {
    const { flags, positional } = parseFlags(rest);
    const body = (typeof flags.body === 'string' && flags.body.length > 0)
      ? flags.body
      : (positional[0] || requireFlag(flags, 'body'));
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.HANDOFF_SET,
      actor: process.env.MADDU_SESSION_ID || null,
      data: { body, by: process.env.MADDU_SESSION_ID || null },
    });
    console.log(`handoff set (${body.length} chars)`);
    console.log(`event: ${ev.id}`);
    console.log(`(surfaced first by \`maddu orient\` / \`maddu brief\`)`);
    return;
  }

  if (sub === 'show') {
    const proj = await projections.project(repoRoot);
    const h = proj.handoff;
    if (!h || !h.body) {
      console.log('(no curated handoff — set one with: maddu handoff set "<RESUME HERE …>")');
      return;
    }
    if (parseFlags(rest).flags.json) { process.stdout.write(JSON.stringify(h, null, 2) + '\n'); return; }
    console.log(h.body);
    console.log(`\n(set ${h.setAt}${h.by ? ' by ' + h.by : ''})`);
    return;
  }

  console.error('Usage: maddu handoff <set "<markdown>" | show>');
  process.exit(2);
}
