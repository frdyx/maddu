// `maddu review <run|status|list>` — Governance Phase 5.
//
// run --slice <eventId>: invoke the configured reviewer (a runtime with
//                        kind:'reviewer') and parse stdout. Emits SLICE_REVIEWED.
//                        Non-clean verdicts also emit FOLLOWUP_OPENED.
// status: print counts per verdict + last N reviews.
// list:   alias for `status --limit N`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadReviewLib(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'maddu', 'runtime', 'lib', 'review.mjs'),
    path.resolve(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'review.mjs'),
  ];
  for (const p of candidates) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  throw new Error('review.mjs not found');
}

// Reviewer spawn + policy read + SLICE_REVIEWED emit now live in the review lib
// (runSliceReview), shared with the slice-stop + coordinator auto-triggers.

function printReviewHelp() {
  console.log([
    'usage: maddu review <subcommand> [args]',
    '',
    'subcommands:',
    '  run --slice <eventId> [--reviewer <name>]',
    '      Invoke the configured reviewer against a slice-stop event. Emits',
    '      SLICE_REVIEWED; non-clean verdicts also emit FOLLOWUP_OPENED.',
    '  status [--limit N]',
    '  list   [--limit N]   (alias of status)',
  ].join('\n'));
}

export default async function command(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printReviewHelp(); return; }
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'run') {
    const { flags } = parseFlags(rest);
    const sliceEventId = requireFlag(flags, 'slice');
    const reviewLib = await loadReviewLib(repoRoot);
    const reviewer = (typeof flags.reviewer === 'string' ? flags.reviewer : null);
    // Shared core (template/maddu/runtime/lib/review.mjs#runSliceReview) — same
    // path the slice-stop + coordinator auto-triggers use.
    const res = await reviewLib.runSliceReview(repoRoot, { sliceEventId, reviewer });
    if (res.skipped) {
      const hint = res.reason === 'no-reviewer-configured'
        ? 'no reviewer configured (set review-policy.json:defaultReviewer or pass --reviewer NAME)'
        : res.reason;
      console.error(`error: ${hint}`);
      process.exit(2);
    }
    console.log(`review run: slice=${sliceEventId} verdict=${res.verdict} findings=${res.findingsCount}`);
    console.log(`  archive: ${res.reviewPath}`);
    console.log(`  event: ${res.eventId}`);
    if (res.followupId) console.log(`  follow-up: event=${res.followupId}`);
    return;
  }

  if (sub === 'status' || sub === 'list' || sub === undefined) {
    const { flags } = parseFlags(rest);
    const limit = Math.max(1, parseInt(flags.limit || '20', 10) || 20);
    const proj = await projections.project(repoRoot);
    const reviews = proj.reviews || { byVerdict: {}, recent: [] };
    console.log(`reviews: ${reviews.recent.length} recent`);
    console.log(`by verdict: ${JSON.stringify(reviews.byVerdict)}`);
    for (const r of reviews.recent.slice(-limit).reverse()) {
      console.log(`  ${r.ts}  ${r.verdict.padEnd(5)} findings=${r.findingsCount}  ${r.sliceEventId}  ${r.reviewPath}`);
    }
    return;
  }

  console.error('Usage: maddu review <run --slice <id> [--reviewer name] | status [--limit N]>');
  process.exit(2);
}
