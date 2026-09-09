// Pricing manifest + provenance-honest USD estimation for `maddu cost`.
//
// NIP-AM accounting semantics (buzz-steals S4): a row is priced only when
// provable, estimated and reported dollars are never merged, and
// null ≠ zero ≠ omitted survives end-to-end.
//
// The manifest is EMBEDDED and versioned — estimation is a read-time
// presentation over the factual record, never written to the spine (writing
// an estimate would bake a stale price into append-only history). The spine
// records only facts: `pricingIdentity {authority, model}` when provable at
// emission time, and `costUsd` + `costProvenance:'wire-reported'` only if a
// provider ever reports wire cost (no emitter does today; contract-ready).
//
// Hard-rule compliance: stdlib-only (rule #4), no provider SDK (rule #5) —
// this file is pure data + arithmetic; it never calls a provider.
//
// Override: `.maddu/config/pricing.json` is read if present (NOT seeded).
// Same schema as the manifest; entries REPLACE embedded entries by
// (authority, model) key and may add new ones. A parse error or
// schema-invalid override makes `cost --usd` fail loudly (exit 2, reason
// printed) — silent fallback to embedded prices would misprice rows the
// operator explicitly re-priced.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Authority = lowercase hostname, byte-exact match. Model = byte-exact match
// on the emitted model string. Lookup is exact (authority, model) or nothing.
const AUTHORITY_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const MANIFEST_VERSION_RE = /^\d{4}-\d{2}-\d{2}\.\d+$/;

// Published Anthropic API list prices as of the manifest date. Deliberately
// small: the mechanism is exact-match-or-unpriced, and "unpriced" is the
// honest answer for any (authority, model) pair not listed here — the
// operator extends via the override file, never by guessing.
export const PRICING_MANIFEST = {
  version: '2026-08-06.1',
  entries: [
    { authority: 'api.anthropic.com', model: 'claude-sonnet-4-5', inputUsdPerMTok: 3, outputUsdPerMTok: 15, cacheReadUsdPerMTok: 0.3, cacheCreationUsdPerMTok: 3.75 },
    { authority: 'api.anthropic.com', model: 'claude-haiku-4-5', inputUsdPerMTok: 1, outputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.1, cacheCreationUsdPerMTok: 1.25 },
    { authority: 'api.anthropic.com', model: 'claude-opus-4-1', inputUsdPerMTok: 15, outputUsdPerMTok: 75, cacheReadUsdPerMTok: 1.5, cacheCreationUsdPerMTok: 18.75 },
  ],
};

export const PRICING_MANIFEST_VERSION = PRICING_MANIFEST.version;

const ENTRY_KEYS = ['authority', 'model', 'inputUsdPerMTok', 'outputUsdPerMTok', 'cacheReadUsdPerMTok', 'cacheCreationUsdPerMTok'];
const RATE_KEYS = ['inputUsdPerMTok', 'outputUsdPerMTok', 'cacheReadUsdPerMTok', 'cacheCreationUsdPerMTok'];
const DOC_KEYS = ['version', 'entries'];

// Validity follows the pinned grammar EXACTLY (funnel r2-F2) — no extra
// length ceiling: a descriptor authority that matches the regex must round-
// trip through the seam identically to how the manifest validator judges it.
export function isValidAuthority(s) {
  return typeof s === 'string' && AUTHORITY_RE.test(s);
}

// Validate a pricing document (embedded manifest or override). Returns an
// array of human-readable error strings; empty = valid. Every pin from the
// plan: unique (authority, model), non-empty exact model, authority grammar,
// all four rates finite and >= 0, version grammar, unknown keys rejected.
export function validatePricingDoc(doc, label = 'pricing') {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return [`${label}: document must be an object`];
  }
  for (const k of Object.keys(doc)) {
    if (!DOC_KEYS.includes(k)) errors.push(`${label}: unknown top-level key "${k}"`);
  }
  if (typeof doc.version !== 'string' || !MANIFEST_VERSION_RE.test(doc.version)) {
    errors.push(`${label}: version must match YYYY-MM-DD.N (got ${JSON.stringify(doc.version)})`);
  }
  if (!Array.isArray(doc.entries)) {
    errors.push(`${label}: entries must be an array`);
    return errors;
  }
  const seen = new Set();
  doc.entries.forEach((e, i) => {
    const at = `${label}: entries[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(`${at}: must be an object`); return; }
    for (const k of Object.keys(e)) {
      if (!ENTRY_KEYS.includes(k)) errors.push(`${at}: unknown key "${k}"`);
    }
    if (!isValidAuthority(e.authority)) errors.push(`${at}: authority must be a lowercase hostname (got ${JSON.stringify(e.authority)})`);
    if (typeof e.model !== 'string' || e.model.length === 0) errors.push(`${at}: model must be a non-empty exact string`);
    for (const k of RATE_KEYS) {
      if (typeof e[k] !== 'number' || !Number.isFinite(e[k]) || e[k] < 0) {
        errors.push(`${at}: ${k} must be a finite number >= 0 (got ${JSON.stringify(e[k])})`);
      }
    }
    if (typeof e.authority === 'string' && typeof e.model === 'string') {
      const key = rateKey(e.authority, e.model);
      if (seen.has(key)) errors.push(`${at}: duplicate (authority, model) pair ${e.authority} / ${e.model}`);
      seen.add(key);
    }
  });
  return errors;
}

function rateKey(authority, model) {
  return `${authority}\u0000${model}`;
}

// Load the effective pricing table: embedded manifest, with the override file
// (if present) replacing entries by (authority, model) key. Throws with a
// printable message when the override exists but is unparseable or invalid —
// callers surface it and exit 2, never fall back silently.
export async function loadEffectivePricing(repoRoot) {
  const rates = new Map();
  for (const e of PRICING_MANIFEST.entries) rates.set(rateKey(e.authority, e.model), e);

  const overridePath = join(repoRoot, '.maddu', 'config', 'pricing.json');
  let text = null;
  try { text = await readFile(overridePath, 'utf8'); }
  catch (err) {
    if (err && err.code !== 'ENOENT') {
      throw new Error(`pricing override unreadable (${overridePath}): ${err.message}`);
    }
  }
  if (text === null) {
    return { rates, version: PRICING_MANIFEST_VERSION, overrideActive: false };
  }

  let doc;
  try { doc = JSON.parse(text); }
  catch (err) {
    throw new Error(`pricing override is not valid JSON (${overridePath}): ${err.message}`);
  }
  const errors = validatePricingDoc(doc, 'pricing override');
  if (errors.length > 0) {
    throw new Error(`pricing override invalid (${overridePath}):\n  ${errors.join('\n  ')}`);
  }
  for (const e of doc.entries) rates.set(rateKey(e.authority, e.model), e);
  return { rates, version: `${PRICING_MANIFEST_VERSION}+override`, overrideActive: true };
}

export function lookupRate(effective, authority, model) {
  if (typeof authority !== 'string' || typeof model !== 'string') return null;
  return effective.rates.get(rateKey(authority, model)) || null;
}

// Classify ONE ledger row per the S4 truth table. Row fields follow the
// tokenLedger projection shape: token fields are number | null | ABSENT, and
// the distinction is load-bearing (Object.hasOwn threading upstream).
//
//   costUsd number + costProvenance 'wire-reported'      → reported
//   else pricingIdentity ∧ exact rate match ∧ input AND
//        output tokens both numbers                       → estimated
//   else                                                  → unpriced, with
//        reason no-pricing-identity | no-manifest-match | unreported-tokens
//
// Estimated = input·inRate/1e6 + output·outRate/1e6 + cache terms for cache
// fields that ARE numbers; a null/absent cache component contributes nothing
// and flags partialComponents — excluded, never zeroed.
export function classifyRow(row, effective) {
  if (typeof row.costUsd === 'number' && row.costProvenance === 'wire-reported') {
    return { bucket: 'reported', usd: row.costUsd };
  }
  const pid = row.pricingIdentity;
  const hasIdentity = pid && typeof pid === 'object' && typeof pid.authority === 'string' && typeof pid.model === 'string';
  if (!hasIdentity) return { bucket: 'unpriced', reason: 'no-pricing-identity' };
  const rate = lookupRate(effective, pid.authority, pid.model);
  if (!rate) return { bucket: 'unpriced', reason: 'no-manifest-match' };
  if (typeof row.inputTokens !== 'number' || typeof row.outputTokens !== 'number') {
    return { bucket: 'unpriced', reason: 'unreported-tokens' };
  }
  // Divide BEFORE multiplying (funnel r3-F1): tokens * 1e308-scale rate
  // overflows the intermediate even when the true product is representable.
  // Per-term underflow guard (funnel r4-F1): nonzero tokens at a nonzero
  // (denormal-tiny) rate can underflow a POSITIVE component to exactly 0 —
  // which would then render as a proven zero ('0.00'), a fabricated zero.
  // Both directions fail LOUDLY: a dollar figure is exact or absent, never
  // a rounded lie.
  const term = (tokens, r, label) => {
    const t = (tokens / 1e6) * r;
    if (t === 0 && tokens > 0 && r > 0) {
      throw new Error(`USD estimate underflows to zero for (${pid.authority}, ${pid.model}) ${label} term — a positive amount must never render as a proven zero; fix the pricing rates`);
    }
    return t;
  };
  let usd = term(row.inputTokens, rate.inputUsdPerMTok, 'input')
          + term(row.outputTokens, rate.outputUsdPerMTok, 'output');
  let partialComponents = false;
  if (typeof row.cacheRead === 'number') usd += term(row.cacheRead, rate.cacheReadUsdPerMTok, 'cacheRead');
  else partialComponents = true;
  if (typeof row.cacheCreation === 'number') usd += term(row.cacheCreation, rate.cacheCreationUsdPerMTok, 'cacheCreation');
  else partialComponents = true;
  // A non-finite dollar amount must FAIL LOUDLY, never serialize:
  // JSON.stringify(Infinity) emits null, which falsely reads as "bucket has
  // no members" — a fabricated absence (r3-F1).
  if (!Number.isFinite(usd)) {
    throw new Error(`non-finite USD estimate for (${pid.authority}, ${pid.model}) — token counts × rates overflow IEEE double; fix the pricing rates`);
  }
  return { bucket: 'estimated', usd, partialComponents };
}
