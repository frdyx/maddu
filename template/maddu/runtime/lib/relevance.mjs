// Pure lexical relevance scoring — BM25 + exact-match boosts.
//
// v1.115.0 (memory-recall track, Phase 2): search ranked by relevance instead
// of timestamp. Deliberately in-memory and dependency-free: corpus statistics
// (df, avgdl) are computed per-kind over the FULL corpus at query time — a
// substring prefilter would corrupt IDF — and no persistent index exists yet.
// The golden relevance suite (scripts/test/search-relevance-golden.mjs) carries
// the latency tripwire that would justify a persistent .maddu/index/ later.
//
// Everything here is pure and deterministic: no I/O, no wall clock, no
// randomness. Callers own reading the corpora and assembling doc blobs.

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
// Additive boosts on top of the BM25 score. Exact tag/lane hits are strong
// relevance signals the bag-of-words score underweights.
export const TAG_BOOST = 1.5;
export const LANE_BOOST = 1.0;

const MIN_TOKEN_LEN = 2;

// Tokenize: lowercase, split on non-[a-z0-9_./-] runs. Tokens containing
// dots/slashes/dashes (paths, filenames like `hindsight.mjs`, flags) are
// emitted BOTH raw and as their alphanumeric parts, so `hindsight.mjs`
// matches the exact filename and the bare word `hindsight`.
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const raw = text.toLowerCase().split(/[^a-z0-9_./-]+/);
  for (let tok of raw) {
    tok = tok.replace(/^[./-]+|[./-]+$/g, '');
    if (tok.length < MIN_TOKEN_LEN) continue;
    out.push(tok);
    if (/[./-]/.test(tok)) {
      for (const part of tok.split(/[^a-z0-9_]+/)) {
        if (part.length >= MIN_TOKEN_LEN) out.push(part);
      }
    }
  }
  return out;
}

// Build corpus statistics for one kind. docsTokens: array of token arrays
// (one per document, order preserved). Returns { n, avgdl, df } where df
// maps token → number of documents containing it.
export function buildCorpusStats(docsTokens) {
  const df = new Map();
  let totalLen = 0;
  for (const tokens of docsTokens) {
    totalLen += tokens.length;
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const n = docsTokens.length;
  return { n, avgdl: n ? totalLen / n : 0, df };
}

// Standard BM25 over one document. queryTokens should be deduplicated by the
// caller if repeated query terms must not double-count (we keep duplicates:
// repeating a term in the query is an intent signal).
export function scoreBM25(docTokens, queryTokens, stats, { k1 = BM25_K1, b = BM25_B } = {}) {
  if (!docTokens.length || !queryTokens.length || !stats || !stats.n) return 0;
  const tf = new Map();
  for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
  const dl = docTokens.length;
  const norm = k1 * (1 - b + b * (dl / (stats.avgdl || 1)));
  let score = 0;
  for (const q of queryTokens) {
    const f = tf.get(q);
    if (!f) continue;
    const df = stats.df.get(q) || 0;
    // BM25+-style idf floor: never negative, so ubiquitous terms contribute
    // ~0 instead of dragging the score below unrelated documents.
    const idf = Math.log(1 + (stats.n - df + 0.5) / (df + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + norm));
  }
  return score;
}

// Exact-match boost: query tokens that equal a tag value verbatim.
// Tags are compared lowercased; each distinct hit adds TAG_BOOST once.
export function tagBoostFor(queryTokens, tags) {
  if (!Array.isArray(tags) || !tags.length) return 0;
  const tagSet = new Set(tags.map((t) => String(t).toLowerCase()));
  let hits = 0;
  const seen = new Set();
  for (const q of queryTokens) {
    if (seen.has(q)) continue;
    seen.add(q);
    if (tagSet.has(q)) hits++;
  }
  return hits * TAG_BOOST;
}

// Lane affinity boost: the result's lane matches the caller-supplied active
// or filter lane.
export function laneBoostFor(resultLane, activeLane) {
  if (!resultLane || !activeLane) return 0;
  return String(resultLane) === String(activeLane) ? LANE_BOOST : 0;
}
