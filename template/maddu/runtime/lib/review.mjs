// Review parser + persistence — Governance Phase 5.
//
// Reviewers emit either JSON or YAML-frontmatter markdown. Parser normalizes
// to { verdict, findings, body }. Persistence writes the review markdown
// archive at .maddu/reviews/<slice-event-id>.md with a YAML frontmatter.

import { promises as fs } from 'node:fs';
import path from 'node:path';

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
  await fs.writeFile(path.join(dir, `${sliceEventId}.md`), out);
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
