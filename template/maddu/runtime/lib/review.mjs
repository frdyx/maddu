// Review parser + persistence — Governance Phase 5.
//
// Reviewers emit either JSON or YAML-frontmatter markdown. Parser normalizes
// to { verdict, findings, body }. Persistence writes the review markdown
// archive at .maddu/reviews/<slice-event-id>.md with a YAML frontmatter.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { append, EVENT_TYPES } from './spine.mjs';
import { readRuntime } from './runtimes.mjs';
import { redactText } from './secret-scan.mjs';

const VALID_VERDICTS = new Set(['CLEAN', 'P1', 'P2', 'P3', 'INFO']);

export function parseReview(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return normalize({ verdict: 'INFO', findings: [], body: '' });

  // JSON branch
  if (trimmed.startsWith('{')) {
    try { return normalize(JSON.parse(trimmed)); } catch {}
  }

  // YAML-frontmatter + body branch
  const m = trimmed.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (m) {
    const front = parseSimpleYaml(m[1]);
    return normalize({ ...front, body: m[2] });
  }

  // Plain text → INFO with body
  return normalize({ verdict: 'INFO', findings: [], body: trimmed });
}

function parseSimpleYaml(src) {
  // Minimal: key: value pairs; arrays via `- ` lines under a key.
  const out = {};
  const lines = src.split('\n');
  let currentArrKey = null;
  for (const ln of lines) {
    if (/^\s*$/.test(ln) || ln.startsWith('#')) continue;
    const arr = ln.match(/^\s*-\s+(.*)$/);
    if (arr && currentArrKey) {
      if (!Array.isArray(out[currentArrKey])) out[currentArrKey] = [];
      out[currentArrKey].push(arr[1].trim());
      continue;
    }
    const kv = ln.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) {
      currentArrKey = null;
      const k = kv[1];
      let v = kv[2].trim();
      if (v === '' || v === null) { currentArrKey = k; continue; }
      if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      else if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else v = v.replace(/^['"]|['"]$/g, '');
      out[k] = v;
    }
  }
  return out;
}

function normalize(o) {
  const verdict = String(o.verdict || 'INFO').toUpperCase();
  const safe = VALID_VERDICTS.has(verdict) ? verdict : 'INFO';
  const findings = Array.isArray(o.findings) ? o.findings : [];
  return { verdict: safe, findings, body: typeof o.body === 'string' ? o.body : '' };
}

export async function writeReviewArchive(repoRoot, sliceEventId, { verdict, findings, body, reviewerRuntime, reviewedAt }) {
  const dir = path.join(repoRoot, '.maddu', 'reviews');
  await fs.mkdir(dir, { recursive: true });
  const yaml = [
    '---',
    `verdict: ${verdict}`,
    `findings: ${findings.length}`,
    `sliceEventId: ${sliceEventId}`,
    `reviewerRuntime: ${reviewerRuntime}`,
    `reviewedAt: ${reviewedAt}`,
    '---',
    '',
  ].join('\n');
  const findingsBlock = findings.length
    ? '\n## Findings\n\n' + findings.map((f, i) => formatFinding(f, i + 1)).join('\n') + '\n'
    : '';
  const out = yaml + (body || `# Review of ${sliceEventId}`) + findingsBlock;
  const rel = path.posix.join('.maddu', 'reviews', `${sliceEventId}.md`);
  // Write-boundary redaction: reviewer body/findings are runtime-produced prose
  // that can echo a secret. Value-pattern scrub of the markdown; clean text is
  // returned unchanged.
  await fs.writeFile(path.join(dir, `${sliceEventId}.md`), redactText(out).text);
  return rel;
}

function formatFinding(f, n) {
  if (typeof f === 'string') return `${n}. ${f}`;
  const sev = f.severity ? `**[${f.severity}]** ` : '';
  const loc = f.location ? `${f.location} — ` : '';
  return `${n}. ${sev}${loc}${f.message || JSON.stringify(f)}`;
}

// Map verdict → follow-up severity (default policy).
export const VERDICT_TO_FOLLOWUP = {
  CLEAN: null,
  P1:    'P1',
  P2:    'P2',
  P3:    'P3',
  INFO:  null,
};

export async function readReviewPolicy(repoRoot) {
  try {
    return JSON.parse(await fs.readFile(path.join(repoRoot, '.maddu', 'config', 'review-policy.json'), 'utf8'));
  } catch {
    return { defaultReviewer: null, lanesRequiringReview: [], severityToFollowupMap: {} };
  }
}

function spawnReviewer(binary, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (b) => { out += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { err += b.toString('utf8'); });
    const t = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} resolve({ code: null, out, err, timedOut: true }); }, timeoutMs);
    proc.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err, timedOut: false }); });
    proc.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + String(e), timedOut: false }); });
  });
}

// Reusable review-run core (v1.4.0). Extracted from commands/review.mjs so both
// the CLI and auto-triggers (slice-stop, coordinator) share one path. Returns
// { skipped, reason } when no reviewer is configured/usable (callers treat this
// as a graceful no-op), or { ok, verdict, findingsCount, reviewPath, eventId,
// followupId }. `triggeredBy` rides the SLICE_REVIEWED event for rule-#9
// provenance when this runs as an auto-trigger.
export async function runSliceReview(repoRoot, { sliceEventId, reviewer = null, triggeredBy = null, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (!sliceEventId) return { skipped: true, reason: 'no-slice-event-id' };
  const policy = await readReviewPolicy(repoRoot);
  const reviewerName = reviewer || policy.defaultReviewer;
  if (!reviewerName) return { skipped: true, reason: 'no-reviewer-configured' };
  const desc = await readRuntime(repoRoot, reviewerName);
  if (!desc) return { skipped: true, reason: `runtime-not-found:${reviewerName}` };
  if (desc.kind && desc.kind !== 'reviewer') return { skipped: true, reason: `wrong-kind:${desc.kind}` };

  const args = (desc.args || []).map((a) =>
    String(a).replace('${SLICE_EVENT_ID}', sliceEventId).replace('${REPO_ROOT}', repoRoot));
  const env = { MADDU_SLICE_EVENT_ID: sliceEventId, MADDU_REPO_ROOT: repoRoot };
  const result = await spawnReviewer(desc.binary || 'node', args, env, timeoutMs);

  const parsed = (result.timedOut || result.code !== 0)
    ? { verdict: 'INFO', findings: [], body: result.timedOut ? `# Reviewer timeout after ${timeoutMs}ms` : `# Reviewer exited ${result.code}\n\n${result.err}` }
    : parseReview(result.out);

  const reviewPath = await writeReviewArchive(repoRoot, sliceEventId, {
    verdict: parsed.verdict, findings: parsed.findings, body: parsed.body,
    reviewerRuntime: reviewerName, reviewedAt: new Date().toISOString(),
  });

  const ev = await append(repoRoot, {
    type: EVENT_TYPES.SLICE_REVIEWED,
    triggered_by: triggeredBy,
    data: {
      sliceEventId, verdict: parsed.verdict, findingsCount: parsed.findings.length,
      reviewerRuntime: reviewerName, reviewPath,
      ...(result.timedOut || result.code !== 0 ? { evidence: { error: result.err || `exit ${result.code}` } } : {}),
    },
  });

  let followupId = null;
  const severity = (policy.severityToFollowupMap && policy.severityToFollowupMap[parsed.verdict]) || VERDICT_TO_FOLLOWUP[parsed.verdict];
  if (severity) {
    const draftScope = parsed.findings
      .map((f) => (typeof f === 'object' && f.location ? String(f.location).split(':')[0] : null))
      .filter(Boolean);
    const fev = await append(repoRoot, {
      type: EVENT_TYPES.FOLLOWUP_OPENED,
      triggered_by: triggeredBy,
      data: { fromReviewEventId: ev.id, severity, draftScope },
    });
    followupId = fev.id;
  }

  return { ok: true, verdict: parsed.verdict, findingsCount: parsed.findings.length, reviewPath, eventId: ev.id, followupId };
}
