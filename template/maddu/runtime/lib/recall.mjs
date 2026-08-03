// Recall packet — the one bounded, trust-gated seam that feeds memory facts
// back into agent context.
//
// v1.115.0 (memory-recall track, Phase 4). Pure and deterministic: the caller
// supplies the pre-read fact view (hindsight.factsWithTrust output); no I/O,
// no wall clock. Consumers: `maddu brief --for-agent`, `maddu memory recall`,
// GET /bridge/recall, and the MCP facade — all render the SAME packet, so
// there is exactly one place where injection eligibility is decided.
//
// Eligibility law: ONLY `trust: 'approved'` facts may land in `items`.
// Asserted facts stay searchable elsewhere but are withheld here with reason
// 'not-approved' — searchable ≠ injectable. Revoked facts are withheld with
// reason 'revoked'. Superseded facts never reach this module (factsWithTrust
// builds on currentFacts). Approved facts beyond the caps are withheld with
// 'budget-rows' / 'budget-bytes'. Bounds are rows + bytes, hard-enforced
// here and re-verified by the critical `memory-injection-bounded` gate.
// Per-turn call counts stay advisory by design — "turn" is not observable
// across runtimes.

import { tokenize, buildCorpusStats, scoreBM25, tagBoostFor, laneBoostFor } from './relevance.mjs';

export const MAX_RECALL_ITEMS = 8;
export const MAX_RECALL_BYTES = 16384; // hard packet cap, below the 24KB skill budget
export const MAX_WITHHELD_LISTED = 20;

// With no query, the packet is a standing rules/constraints digest: kinds
// carry a base weight so operational law outranks narrative recall.
const KIND_WEIGHT = {
  rule: 2.0,
  constraint: 2.0,
  correction: 1.5,
  discovery: 0.5,
  vendor: 0.25,
  gate: 0.1,
  followup: 0.1,
  touched: 0,
  summary: 0,
};

const byteLen = (s) => Buffer.byteLength(String(s || ''), 'utf8');

// buildRecallPacket({ facts, query, lane, tags, budget }) → packet.
//   facts:  hindsight.factsWithTrust output (each fact carries `trust`)
//   query:  optional free text; empty → digest mode (kind-weight + tag/lane)
//   lane:   active lane id (boosts same-lane facts)
//   tags:   context tags (exact-match boost against fact tags)
//   budget: { maxItems, maxBytes } — clamped to the exported caps, never above
export function buildRecallPacket({ facts = [], query = '', lane = null, tags = [], budget = {} } = {}) {
  const maxItems = Math.min(Number(budget.maxItems) || MAX_RECALL_ITEMS, MAX_RECALL_ITEMS);
  const maxBytes = Math.min(Number(budget.maxBytes) || MAX_RECALL_BYTES, MAX_RECALL_BYTES);
  const qTokens = tokenize(query || '');
  const ctxTags = (tags || []).map((t) => String(t).toLowerCase());

  // Score every fact against the context. Corpus stats over ALL facts so IDF
  // stays honest (same law as search.mjs).
  const docs = facts.map((f) => ({ f, tokens: tokenize(`${f.text} ${(f.tags || []).join(' ')}`) }));
  const stats = buildCorpusStats(docs.map((d) => d.tokens));
  const scored = [];
  for (const { f, tokens } of docs) {
    let score = (KIND_WEIGHT[f.kind] ?? 0);
    if (qTokens.length) score += scoreBM25(tokens, qTokens, stats);
    score += tagBoostFor(ctxTags, f.tags || []);
    score += laneBoostFor(f.source?.lane || null, lane);
    if (score <= 0) continue; // not relevant to this context at all
    scored.push({ f, score: Number(score.toFixed(4)) });
  }
  scored.sort((a, b) => (b.score - a.score) || ((b.f.ts || '').localeCompare(a.f.ts || '')));

  const items = [];
  const withheld = [];
  let totalBytes = 0;
  for (const { f, score } of scored) {
    const trust = f.trust || 'asserted';
    if (trust !== 'approved') {
      withheld.push({ id: f.id, kind: f.kind, trust, score, reason: trust === 'revoked' ? 'revoked' : 'not-approved' });
      continue;
    }
    if (items.length >= maxItems) {
      withheld.push({ id: f.id, kind: f.kind, trust, score, reason: 'budget-rows' });
      continue;
    }
    const bytes = byteLen(f.text);
    if (totalBytes + bytes > maxBytes) {
      withheld.push({ id: f.id, kind: f.kind, trust, score, reason: 'budget-bytes' });
      continue;
    }
    totalBytes += bytes;
    items.push({
      id: f.id, kind: f.kind, text: f.text, score,
      trust: 'approved',
      sourceEvent: f.source?.event || null,
      lane: f.source?.lane || null,
      ts: f.ts || null,
      reason: 'fed',
    });
  }

  return {
    v: 1,
    query: query || '',
    lane: lane || null,
    budget: { maxItems, maxBytes },
    items,
    withheld: withheld.slice(0, MAX_WITHHELD_LISTED),
    withheldTotal: withheld.length,
    totalBytes,
  };
}
