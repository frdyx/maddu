// `maddu review <run|status|list>` — Governance Phase 5.
//
// run --slice <eventId>: invoke the configured reviewer (a runtime with
//                        kind:'reviewer') and parse stdout. Emits SLICE_REVIEWED.
//                        Non-clean verdicts also emit FOLLOWUP_OPENED.
// status: print counts per verdict + last N reviews.
// list:   alias for `status --limit N`.

import { spawn } from 'node:child_process';
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

async function readReviewPolicy(repoRoot) {
  try {
    return JSON.parse(await fs.readFile(path.join(repoRoot, '.maddu', 'config', 'review-policy.json'), 'utf8'));
  } catch {
    return { defaultReviewer: null, lanesRequiringReview: [], severityToFollowupMap: {} };
  }
}

function runReviewer(binary, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (b) => { out += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { err += b.toString('utf8'); });
    const t = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      resolve({ code: null, out, err, timedOut: true });
    }, timeoutMs);
    proc.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, out, err, timedOut: false });
    });
    proc.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: err + String(e), timedOut: false });
    });
  });
}

export default async function command(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections, runtimes } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'run') {
    const { flags } = parseFlags(rest);
    const sliceEventId = requireFlag(flags, 'slice');
    const policy = await readReviewPolicy(repoRoot);
    const reviewerName = (typeof flags.reviewer === 'string' ? flags.reviewer : null) || policy.defaultReviewer;
    if (!reviewerName) {
      console.error('error: no reviewer configured (set review-policy.json:defaultReviewer or pass --reviewer NAME)');
      process.exit(2);
    }
    const desc = await runtimes.readRuntime(repoRoot, reviewerName);
    if (!desc) {
      console.error(`error: runtime "${reviewerName}" not found`);
      process.exit(2);
    }
    if (desc.kind && desc.kind !== 'reviewer') {
      console.error(`error: runtime "${reviewerName}" has kind=${desc.kind} (expected 'reviewer')`);
      process.exit(2);
    }
    const reviewLib = await loadReviewLib(repoRoot);
    const TIMEOUT_MS = 10 * 60 * 1000;

    const args = (desc.args || []).map((a) =>
      String(a)
        .replace('${SLICE_EVENT_ID}', sliceEventId)
        .replace('${REPO_ROOT}', repoRoot)
    );
    const env = { MADDU_SLICE_EVENT_ID: sliceEventId, MADDU_REPO_ROOT: repoRoot };
    const startedAt = new Date().toISOString();
    const result = await runReviewer(desc.binary || 'node', args, env, TIMEOUT_MS);

    let parsed;
    if (result.timedOut || result.code !== 0) {
      parsed = {
        verdict: 'INFO',
        findings: [],
        body: result.timedOut ? `# Reviewer timeout after ${TIMEOUT_MS}ms` : `# Reviewer exited ${result.code}\n\n${result.err}`,
      };
    } else {
      parsed = reviewLib.parseReview(result.out);
    }

    const reviewPath = await reviewLib.writeReviewArchive(repoRoot, sliceEventId, {
      verdict: parsed.verdict,
      findings: parsed.findings,
      body: parsed.body,
      reviewerRuntime: reviewerName,
      reviewedAt: new Date().toISOString(),
    });

    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SLICE_REVIEWED,
      data: {
        sliceEventId,
        verdict: parsed.verdict,
        findingsCount: parsed.findings.length,
        reviewerRuntime: reviewerName,
        reviewPath,
        ...(result.timedOut || result.code !== 0 ? { evidence: { error: result.err || `exit ${result.code}` } } : {}),
      },
    });

    console.log(`review run: slice=${sliceEventId} verdict=${parsed.verdict} findings=${parsed.findings.length}`);
    console.log(`  archive: ${reviewPath}`);
    console.log(`  event: ${ev.id}`);

    // Optional FOLLOWUP_OPENED
    const severity = (policy.severityToFollowupMap && policy.severityToFollowupMap[parsed.verdict])
      || reviewLib.VERDICT_TO_FOLLOWUP[parsed.verdict];
    if (severity) {
      const draftScope = parsed.findings
        .map((f) => (typeof f === 'object' && f.location ? String(f.location).split(':')[0] : null))
        .filter(Boolean);
      const fev = await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.FOLLOWUP_OPENED,
        data: { fromReviewEventId: ev.id, severity, draftScope },
      });
      console.log(`  follow-up: severity=${severity} event=${fev.id}`);
    }
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
