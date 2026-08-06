#!/usr/bin/env node
// pricing — S4 cost-provenance unit suite over lib/pricing.mjs.
//
//   (A) the embedded manifest passes its own validation pins.
//   (B) validatePricingDoc rejects every pin violation: duplicate
//       (authority, model), empty model, bad authority grammar, bad version
//       grammar, non-finite / negative rates, unknown keys (doc + entry).
//   (C) exact-match lookup: hit, model miss, authority miss (no fuzzy).
//   (D) classifyRow truth table: reported / estimated / all three unpriced
//       reasons; costUsd null is NOT reported; partial cache components are
//       excluded (never zeroed) and flagged.
//   (E) loadEffectivePricing: no override → embedded version; valid override
//       replaces by (authority, model) key and adds entries, version gains
//       '+override'; invalid JSON and schema-invalid overrides THROW.
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRICING_MANIFEST, PRICING_MANIFEST_VERSION, isValidAuthority,
  validatePricingDoc, loadEffectivePricing, lookupRate, classifyRow,
} from '../../template/maddu/runtime/lib/pricing.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function docWith(entries, version = '2026-01-01.1') {
  return { version, entries };
}
const goodEntry = (patch = {}) => ({
  authority: 'api.anthropic.com', model: 'claude-sonnet-4-5',
  inputUsdPerMTok: 3, outputUsdPerMTok: 15,
  cacheReadUsdPerMTok: 0.3, cacheCreationUsdPerMTok: 3.75,
  ...patch,
});

try {
  // ── (A) embedded manifest is self-valid ─────────────────────────────────
  ok('embedded manifest passes validatePricingDoc',
    validatePricingDoc(PRICING_MANIFEST, 'embedded').length === 0);
  ok('PRICING_MANIFEST_VERSION matches the manifest and the grammar',
    PRICING_MANIFEST_VERSION === PRICING_MANIFEST.version && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(PRICING_MANIFEST_VERSION));

  // ── (B) validation pins ─────────────────────────────────────────────────
  ok('duplicate (authority, model) rejected',
    validatePricingDoc(docWith([goodEntry(), goodEntry()])).some((e) => e.includes('duplicate')));
  ok('empty model rejected',
    validatePricingDoc(docWith([goodEntry({ model: '' })])).some((e) => e.includes('model')));
  ok('uppercase authority rejected (lowercase hostname grammar)',
    validatePricingDoc(docWith([goodEntry({ authority: 'API.Anthropic.com' })])).some((e) => e.includes('authority')));
  ok('leading-dot authority rejected',
    validatePricingDoc(docWith([goodEntry({ authority: '.anthropic.com' })])).some((e) => e.includes('authority')));
  ok('bad version grammar rejected',
    validatePricingDoc(docWith([goodEntry()], 'v1.2.3')).some((e) => e.includes('version')));
  ok('NaN rate rejected',
    validatePricingDoc(docWith([goodEntry({ inputUsdPerMTok: NaN })])).some((e) => e.includes('inputUsdPerMTok')));
  ok('Infinity rate rejected',
    validatePricingDoc(docWith([goodEntry({ outputUsdPerMTok: Infinity })])).some((e) => e.includes('outputUsdPerMTok')));
  ok('negative rate rejected',
    validatePricingDoc(docWith([goodEntry({ cacheReadUsdPerMTok: -1 })])).some((e) => e.includes('cacheReadUsdPerMTok')));
  ok('string rate rejected',
    validatePricingDoc(docWith([goodEntry({ cacheCreationUsdPerMTok: '3.75' })])).some((e) => e.includes('cacheCreationUsdPerMTok')));
  ok('unknown entry key rejected',
    validatePricingDoc(docWith([goodEntry({ discount: 0.5 })])).some((e) => e.includes('unknown key "discount"')));
  ok('unknown top-level key rejected',
    validatePricingDoc({ ...docWith([goodEntry()]), currency: 'USD' }).some((e) => e.includes('unknown top-level key')));
  ok('non-object doc rejected', validatePricingDoc([]).length > 0 && validatePricingDoc(null).length > 0);
  ok('zero rates are VALID (a free tier is a proven zero, not an error)',
    validatePricingDoc(docWith([goodEntry({ inputUsdPerMTok: 0, outputUsdPerMTok: 0, cacheReadUsdPerMTok: 0, cacheCreationUsdPerMTok: 0 })])).length === 0);
  ok('isValidAuthority accepts a plain hostname and rejects schemes/paths',
    isValidAuthority('api.anthropic.com') && !isValidAuthority('https://api.anthropic.com') && !isValidAuthority('api.anthropic.com/v1') && !isValidAuthority(''));

  // ── (C) exact-match lookup ──────────────────────────────────────────────
  const fix0 = await mkdtemp(join(tmpdir(), 'pricing-'));
  const eff = await loadEffectivePricing(fix0);
  ok('no override → embedded version, overrideActive false',
    eff.version === PRICING_MANIFEST_VERSION && eff.overrideActive === false);
  ok('exact (authority, model) hit',
    lookupRate(eff, 'api.anthropic.com', 'claude-sonnet-4-5')?.inputUsdPerMTok === 3);
  ok('model miss → null (byte-exact, no prefix match)',
    lookupRate(eff, 'api.anthropic.com', 'claude-sonnet-4-5-20250929') === null);
  ok('authority miss → null',
    lookupRate(eff, 'bedrock.us-east-1.amazonaws.com', 'claude-sonnet-4-5') === null);
  ok('non-string inputs → null', lookupRate(eff, null, 'x') === null && lookupRate(eff, 'a.b', null) === null);

  // ── (D) classifyRow truth table ─────────────────────────────────────────
  const pid = { authority: 'api.anthropic.com', model: 'claude-sonnet-4-5' };
  const rep = classifyRow({ costUsd: 12.5, costProvenance: 'wire-reported' }, eff);
  ok('wire-reported number → reported bucket', rep.bucket === 'reported' && rep.usd === 12.5);
  const repZero = classifyRow({ costUsd: 0, costProvenance: 'wire-reported' }, eff);
  ok('wire-reported ZERO → reported bucket with usd 0 (proven zero)', repZero.bucket === 'reported' && repZero.usd === 0);
  const repNull = classifyRow({ costUsd: null, costProvenance: 'wire-reported', pricingIdentity: pid, inputTokens: 1e6, outputTokens: 1e6, cacheRead: 0, cacheCreation: 0 }, eff);
  ok('costUsd NULL is NOT reported — falls through to estimation', repNull.bucket === 'estimated');
  const noProv = classifyRow({ costUsd: 5, pricingIdentity: pid, inputTokens: 1e6, outputTokens: 1e6, cacheRead: 0, cacheCreation: 0 }, eff);
  ok('costUsd without wire-reported provenance is NOT reported', noProv.bucket === 'estimated');

  const est = classifyRow({ pricingIdentity: pid, inputTokens: 1e6, outputTokens: 1e6, cacheRead: 1e6, cacheCreation: 1e6 }, eff);
  ok('full estimate = in + out + both cache terms',
    est.bucket === 'estimated' && Math.abs(est.usd - (3 + 15 + 0.3 + 3.75)) < 1e-9 && est.partialComponents === false);
  const part = classifyRow({ pricingIdentity: pid, inputTokens: 1e6, outputTokens: 1e6, cacheRead: 1e6, cacheCreation: null }, eff);
  ok('null cache component excluded (never zeroed) + partialComponents flagged',
    part.bucket === 'estimated' && Math.abs(part.usd - (3 + 15 + 0.3)) < 1e-9 && part.partialComponents === true);
  const partAbsent = classifyRow({ pricingIdentity: pid, inputTokens: 1e6, outputTokens: 1e6 }, eff);
  ok('ABSENT cache components also flag partial (omitted ≠ null ≠ zero, all non-numbers excluded)',
    partAbsent.bucket === 'estimated' && Math.abs(partAbsent.usd - 18) < 1e-9 && partAbsent.partialComponents === true);

  ok('no pricingIdentity → unpriced/no-pricing-identity',
    classifyRow({ inputTokens: 1e6, outputTokens: 1e6 }, eff).reason === 'no-pricing-identity');
  ok('identity without a manifest match → unpriced/no-manifest-match',
    classifyRow({ pricingIdentity: { authority: 'api.anthropic.com', model: 'nope' }, inputTokens: 1e6, outputTokens: 1e6 }, eff).reason === 'no-manifest-match');
  ok('identity + match but missing outputTokens → unpriced/unreported-tokens',
    classifyRow({ pricingIdentity: pid, inputTokens: 1e6, outputTokens: null }, eff).reason === 'unreported-tokens');
  ok('malformed pricingIdentity (non-string model) → unpriced/no-pricing-identity',
    classifyRow({ pricingIdentity: { authority: 'a.b', model: 7 }, inputTokens: 1, outputTokens: 1 }, eff).reason === 'no-pricing-identity');

  // ── (E) override behavior ───────────────────────────────────────────────
  const fix1 = await mkdtemp(join(tmpdir(), 'pricing-ovr-'));
  await mkdir(join(fix1, '.maddu', 'config'), { recursive: true });
  await writeFile(join(fix1, '.maddu', 'config', 'pricing.json'), JSON.stringify(docWith([
    goodEntry({ inputUsdPerMTok: 99 }),                                         // replaces embedded sonnet
    goodEntry({ authority: 'proxy.internal', model: 'claude-sonnet-4-5' }),     // adds a new pair
  ])) + '\n');
  const effOvr = await loadEffectivePricing(fix1);
  ok('override version surfaces as <embedded>+override with overrideActive',
    effOvr.version === `${PRICING_MANIFEST_VERSION}+override` && effOvr.overrideActive === true);
  ok('override REPLACES the embedded entry by (authority, model) key',
    lookupRate(effOvr, 'api.anthropic.com', 'claude-sonnet-4-5')?.inputUsdPerMTok === 99);
  ok('override ADDS new (authority, model) pairs',
    lookupRate(effOvr, 'proxy.internal', 'claude-sonnet-4-5')?.inputUsdPerMTok === 3);
  ok('non-overridden embedded entries survive',
    lookupRate(effOvr, 'api.anthropic.com', 'claude-haiku-4-5')?.inputUsdPerMTok === 1);

  const fix2 = await mkdtemp(join(tmpdir(), 'pricing-bad-'));
  await mkdir(join(fix2, '.maddu', 'config'), { recursive: true });
  await writeFile(join(fix2, '.maddu', 'config', 'pricing.json'), '{ not json');
  let threwParse = false;
  try { await loadEffectivePricing(fix2); } catch (err) { threwParse = /not valid JSON/.test(err.message); }
  ok('unparseable override THROWS (loud, never silent fallback)', threwParse);
  await writeFile(join(fix2, '.maddu', 'config', 'pricing.json'), JSON.stringify(docWith([goodEntry({ inputUsdPerMTok: -5 })])) + '\n');
  let threwSchema = false;
  try { await loadEffectivePricing(fix2); } catch (err) { threwSchema = /invalid/.test(err.message) && /inputUsdPerMTok/.test(err.message); }
  ok('schema-invalid override THROWS with the failing field named', threwSchema);

  await rm(fix0, { recursive: true, force: true });
  await rm(fix1, { recursive: true, force: true });
  await rm(fix2, { recursive: true, force: true });
} catch (err) {
  console.error(`harness error: ${err.stack || err}`);
  process.exit(2);
}

console.log(`pricing: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
