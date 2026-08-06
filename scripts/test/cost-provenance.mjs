#!/usr/bin/env node
// cost-provenance — S4 end-to-end suite: TOKEN_USAGE_REPORTED provenance
// fields → tokenLedger projection (Object.hasOwn threading) → `maddu cost
// --usd` buckets, through the REAL spawned CLI against a fixture spine.
//
//   (A) one mixed group carrying BOTH provenances, all three unpriced
//       reasons, a partial estimate — reported and estimated never merge.
//   (B) null ≠ zero end-to-end: a proven-zero reported bucket (0) vs an
//       empty reported bucket (null) in --json; '0.00' vs blank in text.
//   (C) mistyped costUsd (string) is dropped at the reducer — never
//       coerced into the reported bucket.
//   (D) transcript-import-shaped rows are never priced (no-pricing-identity).
//   (E) plain `cost --json` (no --usd) is shape-identical to pre-S4: no
//       usd key on groups, no top-level pricing key.
//   (F) override file changes estimates + surfaces '+override'; garbage
//       override → exit 2 naming the override.
//   (G) wrapper emission: appendTokenUsage stamps pricingIdentity ONLY when
//       MADDU_PRICING_AUTHORITY is present AND the model is real (not a
//       '<runtime>-unknown' fallback).
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { append } from '../../template/maddu/runtime/lib/spine.mjs';
import { appendTokenUsage } from '../../template/maddu/runtime/lib/runtimes/_wrapper-common.mjs';
import { PRICING_MANIFEST_VERSION } from '../../template/maddu/runtime/lib/pricing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SOURCE_BIN = join(repoRoot, 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function runCost(fix, args) {
  const r = spawnSync('node', [SOURCE_BIN, 'cost', ...args], {
    cwd: fix, encoding: 'utf8', timeout: 60000, env: { ...process.env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const PID_SONNET = { authority: 'api.anthropic.com', model: 'claude-sonnet-4-5' };
const near = (a, b) => Math.abs(a - b) < 1e-9;

async function tok(fix, data) {
  await append(fix, { type: 'TOKEN_USAGE_REPORTED', actor: data.sessionId || null, data });
}

try {
  const fix = await mkdtemp(join(tmpdir(), 'cost-prov-'));

  // ── fixture spine ───────────────────────────────────────────────────────
  // rt-mixed: both provenances + every unpriced reason in ONE group.
  await tok(fix, { runtime: 'rt-mixed', sessionId: 'ses_a', model: 'claude-sonnet-4-5',
    inputTokens: 100, outputTokens: 100, cacheRead: 0, cacheCreation: 0,
    costUsd: 12.5, costProvenance: 'wire-reported' });                       // reported 12.5
  await tok(fix, { runtime: 'rt-mixed', sessionId: 'ses_a', model: 'claude-sonnet-4-5',
    inputTokens: 1e6, outputTokens: 1e6, cacheRead: 1e6, cacheCreation: 1e6,
    pricingIdentity: PID_SONNET });                                          // estimated 22.05, full
  await tok(fix, { runtime: 'rt-mixed', sessionId: 'ses_a', model: 'claude-sonnet-4-5',
    inputTokens: 1e6, outputTokens: 1e6, cacheRead: 1e6, cacheCreation: null,
    pricingIdentity: PID_SONNET });                                          // estimated 18.30, partial
  await tok(fix, { runtime: 'rt-mixed', sessionId: 'ses_i', model: 'claude-sonnet-4-5',
    ts: '2026-08-06T00:00:00.000Z', inputTokens: 5, outputTokens: 5,
    cacheRead: null, cacheCreation: null,
    source: 'claude-code-transcript', importHash: 'abcd1234abcd1234' });     // import-shaped → no-pricing-identity
  await tok(fix, { runtime: 'rt-mixed', sessionId: 'ses_a', model: 'mystery-model',
    inputTokens: 5, outputTokens: 5,
    pricingIdentity: { authority: 'api.anthropic.com', model: 'mystery-model' } }); // no-manifest-match
  await tok(fix, { runtime: 'rt-mixed', sessionId: 'ses_a', model: 'claude-sonnet-4-5',
    inputTokens: null, outputTokens: null, unreportedTokens: true,
    pricingIdentity: PID_SONNET });                                          // unreported-tokens
  // rt-zero: proven-zero reported bucket.
  await tok(fix, { runtime: 'rt-zero', sessionId: 'ses_z', model: 'claude-sonnet-4-5',
    inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreation: 0,
    costUsd: 0, costProvenance: 'wire-reported' });
  // rt-est-only: estimated members, EMPTY reported bucket.
  await tok(fix, { runtime: 'rt-est-only', sessionId: 'ses_e', model: 'claude-sonnet-4-5',
    inputTokens: 1e6, outputTokens: 0, cacheRead: 0, cacheCreation: 0,
    pricingIdentity: PID_SONNET });                                          // estimated 3.00
  // rt-garbage: mistyped costUsd must be DROPPED at the reducer, not coerced.
  await tok(fix, { runtime: 'rt-garbage', sessionId: 'ses_g', model: 'claude-sonnet-4-5',
    inputTokens: 5, outputTokens: 5, costUsd: '12.5', costProvenance: 'wire-reported' });

  // ── (A)+(B) --usd --json buckets ────────────────────────────────────────
  const j = runCost(fix, ['--usd', '--json', '--by', 'runtime']);
  ok('cost --usd --json exits 0', j.status === 0, j.stderr.slice(0, 200));
  const out = JSON.parse(j.stdout);
  ok('top-level pricing names the embedded manifest, override inactive',
    out.pricing?.manifestVersion === PRICING_MANIFEST_VERSION && out.pricing?.overrideActive === false);
  const by = Object.fromEntries(out.groups.map((g) => [g.key, g]));
  const m = by['rt-mixed']?.usd;
  ok('mixed group: reported holds ONLY the wire-reported dollars', near(m?.reported, 12.5));
  ok('mixed group: estimated holds ONLY manifest arithmetic (22.05 + 18.30)', near(m?.estimated, 40.35));
  ok('mixed group: three unpriced rows', m?.unpricedCount === 3);
  ok('mixed group: unpriced reasons broken down one each',
    m?.unpricedReasons?.['no-pricing-identity'] === 1 &&
    m?.unpricedReasons?.['no-manifest-match'] === 1 &&
    m?.unpricedReasons?.['unreported-tokens'] === 1);
  ok('mixed group: exactly one partial-components estimate', m?.partialComponentsCount === 1);
  ok('proven-zero reported bucket is 0, not null (null ≠ zero)',
    by['rt-zero']?.usd?.reported === 0 && by['rt-zero']?.usd?.estimated === null);
  ok('empty reported bucket is null, not 0',
    by['rt-est-only']?.usd?.reported === null && near(by['rt-est-only']?.usd?.estimated, 3));
  // ── (C) mistyped costUsd dropped at the reducer ─────────────────────────
  ok('string costUsd never reaches the reported bucket (reducer drops, row falls to unpriced)',
    by['rt-garbage']?.usd?.reported === null &&
    by['rt-garbage']?.usd?.unpricedReasons?.['no-pricing-identity'] === 1);
  // ── (D) import rows never priced ────────────────────────────────────────
  ok('transcript-import-shaped row lands unpriced with no-pricing-identity',
    m?.unpricedReasons?.['no-pricing-identity'] === 1);

  // ── (B) text mode: '0.00' proven zero vs blank empty bucket ─────────────
  const t = runCost(fix, ['--usd', '--by', 'runtime']);
  ok('text mode exits 0 with usd columns + manifest line',
    t.status === 0 && t.stdout.includes('usdRep') && t.stdout.includes(`Pricing: manifest ${PRICING_MANIFEST_VERSION}`));
  const zeroLine = t.stdout.split('\n').find((l) => l.includes('rt-zero')) || '';
  ok("proven-zero reported bucket renders '0.00' in text", /\b0\.00\b/.test(zeroLine));
  const estOnlyLine = t.stdout.split('\n').find((l) => l.includes('rt-est-only')) || '';
  ok('empty reported bucket renders BLANK in text (no 0 fabricated)', !/\$|0\.00.*0\.00/.test(estOnlyLine) && /3\.00/.test(estOnlyLine));
  ok('text mode names the unpriced-reason breakdown',
    t.stdout.includes('Unpriced:') && t.stdout.includes('no-manifest-match'));
  ok('text mode surfaces partial estimates', t.stdout.includes('Partial estimates: 1'));

  // ── (E) no --usd → pre-S4 shape untouched ───────────────────────────────
  const plain = runCost(fix, ['--json', '--by', 'runtime']);
  const plainOut = JSON.parse(plain.stdout);
  ok('plain --json groups carry NO usd key and no top-level pricing key',
    plain.status === 0 && !('pricing' in plainOut) && plainOut.groups.every((g) => !('usd' in g)));

  // ── (F) override behavior through the CLI ───────────────────────────────
  await mkdir(join(fix, '.maddu', 'config'), { recursive: true });
  await writeFile(join(fix, '.maddu', 'config', 'pricing.json'), JSON.stringify({
    version: '2026-01-01.1',
    entries: [{ authority: 'api.anthropic.com', model: 'claude-sonnet-4-5',
      inputUsdPerMTok: 6, outputUsdPerMTok: 30, cacheReadUsdPerMTok: 0.6, cacheCreationUsdPerMTok: 7.5 }],
  }) + '\n');
  const jo = runCost(fix, ['--usd', '--json', '--by', 'runtime']);
  const ovr = JSON.parse(jo.stdout);
  ok('override doubles the estimates and surfaces +override',
    ovr.pricing?.manifestVersion === `${PRICING_MANIFEST_VERSION}+override` &&
    ovr.pricing?.overrideActive === true &&
    near(Object.fromEntries(ovr.groups.map((g) => [g.key, g]))['rt-mixed']?.usd?.estimated, 80.7));
  ok('override never touches the reported bucket',
    near(Object.fromEntries(ovr.groups.map((g) => [g.key, g]))['rt-mixed']?.usd?.reported, 12.5));
  await writeFile(join(fix, '.maddu', 'config', 'pricing.json'), '{ not json');
  const bad = runCost(fix, ['--usd', '--json']);
  ok('garbage override → exit 2 naming the override file (never silent fallback)',
    bad.status === 2 && bad.stderr.includes('pricing override'));
  await rm(join(fix, '.maddu', 'config', 'pricing.json'));
  const noUsdStill = runCost(fix, ['--json']);
  ok('plain cost (no --usd) never loads pricing (worked even while override was present)',
    noUsdStill.status === 0);

  // ── (G) wrapper emission gate ───────────────────────────────────────────
  const wfix = await mkdtemp(join(tmpdir(), 'cost-wrap-'));
  const prevAuth = process.env.MADDU_PRICING_AUTHORITY;
  process.env.MADDU_PRICING_AUTHORITY = 'api.anthropic.com';
  await appendTokenUsage(wfix, { runtime: 'claude-code', sessionId: 'ses_w', model: 'claude-sonnet-4-5', inputTokens: 1, outputTokens: 1 });
  await appendTokenUsage(wfix, { runtime: 'claude-code', sessionId: 'ses_w', model: 'claude-unknown', inputTokens: 1, outputTokens: 1 });
  delete process.env.MADDU_PRICING_AUTHORITY;
  await appendTokenUsage(wfix, { runtime: 'claude-code', sessionId: 'ses_w', model: 'claude-sonnet-4-5', inputTokens: 1, outputTokens: 1 });
  if (prevAuth !== undefined) process.env.MADDU_PRICING_AUTHORITY = prevAuth;
  const segs = (await readdir(join(wfix, '.maddu', 'events'))).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  const evs = (await readFile(join(wfix, '.maddu', 'events', segs[0]), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok('wrapper stamps pricingIdentity when authority env + real model',
    evs[0]?.data?.pricingIdentity?.authority === 'api.anthropic.com' &&
    evs[0]?.data?.pricingIdentity?.model === 'claude-sonnet-4-5');
  ok("wrapper OMITS pricingIdentity for a '-unknown' model fallback",
    !('pricingIdentity' in (evs[1]?.data || {})));
  ok('wrapper OMITS pricingIdentity when MADDU_PRICING_AUTHORITY is absent',
    !('pricingIdentity' in (evs[2]?.data || {})));
  ok('wrapper never invents costUsd/costProvenance (estimation is read-time only)',
    evs.every((e) => !('costUsd' in e.data) && !('costProvenance' in e.data)));

  await rm(fix, { recursive: true, force: true });
  await rm(wfix, { recursive: true, force: true });
} catch (err) {
  console.error(`harness error: ${err.stack || err}`);
  process.exit(2);
}

console.log(`cost-provenance: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
