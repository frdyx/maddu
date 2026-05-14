// `maddu slice-stop` — append a structured slice-stop event to the spine.
//
// Usage:
//   maddu slice-stop --session <id> --summary "..." [--lane <id>]
//                    [--action "..."] [--targets "a,b,c"] [--paths "a/,b/"]
//                    [--gates "g1,g2"] [--learnings "A;B;C"] [--next "X;Y"]
//                    [--reason "..."]
//
// Comma-separated for plain lists; semicolon-separated for learnings/next
// (because those entries often contain commas themselves).

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

function csv(s) {
  if (!s || s === true) return [];
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}
function ssv(s) {
  if (!s || s === true) return [];
  return String(s).split(';').map((x) => x.trim()).filter(Boolean);
}

export default async function sliceStop(argv) {
  const { flags } = parseFlags(argv);
  const summary = requireFlag(flags, 'summary');
  const sessionId = requireFlag(flags, 'session');

  const { paths, spine, hindsight } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  const ev = await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.SLICE_STOP,
    actor: sessionId,
    lane: flags.lane || null,
    data: {
      summary,
      action: flags.action || null,
      targets: csv(flags.targets),
      paths: csv(flags.paths),
      gates: csv(flags.gates),
      learnings: ssv(flags.learnings),
      next: ssv(flags.next),
      reason: flags.reason || null
    }
  });

  console.log(`slice-stop  ${ev.id}  [${ev.lane || '—'}]`);
  console.log(`  ${summary}`);
  if (ev.data.next.length) {
    console.log(`  next:`);
    for (const n of ev.data.next) console.log(`    - ${n}`);
  }

  // Hindsight: auto-extract facts from this slice-stop into .maddu/memory.ndjson.
  try {
    const added = await hindsight.extractEvent(repoRoot, ev);
    if (added > 0) console.log(`  hindsight: ${added} fact(s) → .maddu/state/memory.ndjson`);
  } catch (err) {
    console.error(`  hindsight failed (non-fatal): ${err.message}`);
  }
}
