// risk-assess (v1.17.0) — a deterministic change-risk classifier.
//
// Not every slice is equally dangerous. A docs typo and a rewrite of the auth
// token store both end in one SLICE_STOP, but only one of them should pull the
// reviewer in hard. This classifies a set of changed paths into a risk level
// from path shape alone — no LLM, no network, pure stdlib (rule #4). It is the
// signal slice-stop records on the spine and the review-trigger escalates on.
// Inspired by oh-my-claudecode's risk-assess, kept files-only + deterministic.
//
// Levels: none < low < medium < high < critical.
//   critical — a sensitive surface changed (auth / secrets / tokens / crypto /
//              schema / migrations). Touch these and review is non-negotiable.
//   high     — a broad change (many files) with no sensitive surface.
//   low      — docs/text only, regardless of size.
//   medium   — ordinary code change.
//   none     — nothing changed.

// Sensitive path/file segments. Matched on a word-ish boundary so `auth/` or
// `token-store.ts` or `.env` hit, but `author.md` or `database-of-jokes` don't
// over-fire on the bare stem (the boundary requires a separator or extent end).
const SENSITIVE_RE = /(^|[/._-])(auth|oauth|passwords?|passwd|secrets?|tokens?|credentials?|crypto|keystore|privatekey|private-key|schema|migrations?|\.env)([/._-]|$)/i;

const DOCS_RE = /(\.(md|mdx|markdown|txt|rst|adoc)$)|(^|\/)docs?\//i;

const ORDER = ['none', 'low', 'medium', 'high', 'critical'];

export function riskRank(level) {
  const i = ORDER.indexOf(level);
  return i < 0 ? 0 : i;
}

// A slice's risk escalates review past the cooldown when it's high or worse.
export function escalatesReview(level) {
  return riskRank(level) >= riskRank('high');
}

// paths: array of changed paths (any separator). opts.fileThreshold: the
// file-count above which a non-sensitive change is "high" (default 20).
export function assessRisk(paths = [], opts = {}) {
  const files = [...new Set((paths || []).map((p) => String(p).replace(/\\/g, '/').trim()).filter(Boolean))];
  if (files.length === 0) return { level: 'none', signals: [], files: 0, sensitive: 0 };

  const fileThreshold = Number.isFinite(opts.fileThreshold) ? opts.fileThreshold : 20;
  const sensitive = files.filter((p) => SENSITIVE_RE.test(p));
  const allDocs = files.every((p) => DOCS_RE.test(p));
  const broad = files.length > fileThreshold;

  const signals = [];
  if (sensitive.length) {
    signals.push(`sensitive surface: ${sensitive.slice(0, 3).join(', ')}${sensitive.length > 3 ? ` (+${sensitive.length - 3})` : ''}`);
  }
  if (broad) signals.push(`${files.length} files changed`);
  if (allDocs && !sensitive.length) signals.push('docs/text only');

  let level;
  if (sensitive.length) level = 'critical';
  else if (allDocs) level = 'low';
  else if (broad) level = 'high';
  else level = 'medium';

  return { level, signals, files: files.length, sensitive: sensitive.length };
}
