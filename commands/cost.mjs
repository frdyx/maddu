// `maddu cost` — token / call rollup per session, day, runtime.
//
// Reads the `tokenLedger` projection (TOKEN_USAGE_REPORTED events) and
// prints a rollup. Honesty rule: rows missing input/output token counts
// are surfaced as "unreported" — never silently zeroed.
//
// Flags:
//   --by <axis>          session | day | runtime | model (default: runtime)
//   --unreported-count   print only the count of rows missing token data
//   --json               machine-readable rollup
//   --usd                add provenance-honest USD columns (S4): reported
//                        (wire cost the provider itself stated) and estimated
//                        (read-time arithmetic over the embedded pricing
//                        manifest) are NEVER merged; rows that can't be
//                        proven land in the unpriced bucket with a reason.
//                        Blank ≠ 0: blank means the bucket has no members.
//
// **Hard rule #5 (no provider SDKs):** preserved. This command never
// calls a provider; workers emit TOKEN_USAGE_REPORTED themselves with
// whatever metadata they have. The framework owns the rollup.

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLibOptional } from './_libroot.mjs';

function pickAxis(row, axis) {
  switch (axis) {
    case 'session': return row.sessionId || '(unknown-session)';
    case 'day':     return (row.ts || '').slice(0, 10) || '(unknown-day)';
    case 'model':   return row.model || '(unknown-model)';
    case 'runtime':
    default:        return row.runtime || '(unknown-runtime)';
  }
}

function rollup(ledger, axis, pricing = null) {
  const groups = new Map();
  let unreported = 0;
  for (const row of ledger) {
    const key = pickAxis(row, axis);
    if (!groups.has(key)) {
      const g0 = { key, calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, unreported: 0 };
      // S4 USD buckets — null = "no members", NEVER conflated with a proven
      // zero-valued bucket. Reported and estimated stay separate forever.
      if (pricing) g0.usd = { reported: null, estimated: null, unpricedCount: 0, unpricedReasons: {}, partialComponentsCount: 0 };
      groups.set(key, g0);
    }
    const g = groups.get(key);
    g.calls++;
    if (row.inputTokens != null) g.input += row.inputTokens; else { g.unreported++; unreported++; }
    if (row.outputTokens != null) g.output += row.outputTokens;
    if (row.cacheRead != null) g.cacheRead += row.cacheRead;
    if (row.cacheCreation != null) g.cacheCreation += row.cacheCreation;
    if (pricing) {
      const c = pricing.lib.classifyRow(row, pricing.effective);
      if (c.bucket === 'reported') {
        g.usd.reported = addFiniteUsd(g.usd.reported, c.usd, 'reported');
      } else if (c.bucket === 'estimated') {
        g.usd.estimated = addFiniteUsd(g.usd.estimated, c.usd, 'estimated');
        if (c.partialComponents) g.usd.partialComponentsCount++;
      } else {
        g.usd.unpricedCount++;
        g.usd.unpricedReasons[c.reason] = (g.usd.unpricedReasons[c.reason] || 0) + 1;
      }
    }
  }
  return { groups: Array.from(groups.values()).sort((a, b) => a.key.localeCompare(b.key)), unreported, total: ledger.length };
}

function fmt(n) { return n.toLocaleString(); }

// r3-F1: a bucket sum that leaves IEEE-double range must FAIL LOUDLY —
// JSON.stringify(Infinity) emits null, which falsely reads as an empty
// bucket. Individual row values are finite by construction (JSON.parse
// never yields Infinity/NaN), but their SUM can still overflow.
function addFiniteUsd(current, add, label) {
  const next = (current ?? 0) + add;
  if (!Number.isFinite(next)) {
    throw new Error(`${label} USD total overflows IEEE double — the ledger carries absurd dollar values; inspect the spine rows`);
  }
  return next;
}

// USD cell: blank for an empty bucket (null), '0.00' for a proven zero,
// 4 decimals when 2 would falsely display a nonzero value as 0.00, and an
// explicit '<0.0001' floor beyond that (funnel r2-F1) — a proven-nonzero
// amount must NEVER render as zero, however tiny.
function fmtUsd(v) {
  if (v == null) return '';
  if (v === 0) return '0.00';
  const two = v.toFixed(2);
  if (two !== '0.00' && two !== '-0.00') return two;
  const four = v.toFixed(4);
  if (four !== '0.0000' && four !== '-0.0000') return four;
  return v > 0 ? '<0.0001' : '>-0.0001';
}

export default async function cost(argv) {
  const { flags } = parseFlags(argv);
  const axis = flags.by || 'runtime';
  if (!['session', 'day', 'runtime', 'model'].includes(axis)) {
    console.error(`maddu cost: --by must be session | day | runtime | model (got "${axis}")`);
    process.exit(2);
  }

  const { paths, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const proj = await projections.project(repoRoot);
  const ledger = Array.isArray(proj.tokenLedger) ? proj.tokenLedger : [];

  // S4: --usd loads the pricing library + effective table up front — BEFORE
  // every early return (funnel r2-F3: `--usd --unreported-count` must still
  // fail loudly on a malformed override, never exit 0 past the validation).
  // An unparseable or schema-invalid override file is a LOUD exit 2 (the
  // operator explicitly re-priced; a silent fallback would misprice), and a
  // pre-S4 install without pricing.mjs is an honest "upgrade first".
  let pricing = null;
  if (flags.usd) {
    const lib = await loadLibOptional('pricing.mjs');
    if (!lib) {
      console.error('maddu cost --usd: pricing.mjs not found in the installed runtime — run `maddu upgrade` first.');
      process.exit(2);
    }
    let effective;
    try { effective = await lib.loadEffectivePricing(repoRoot); }
    catch (err) {
      console.error(`maddu cost --usd: ${err.message}`);
      process.exit(2);
    }
    pricing = { lib, effective };
  }

  if (flags['unreported-count']) {
    const unreported = ledger.filter((r) => r.inputTokens == null).length;
    process.stdout.write(String(unreported) + '\n');
    return;
  }

  // r3-F1: classification/aggregation overflow throws — surface it as the
  // same loud exit 2 as an invalid override, never serialize a lie.
  let r;
  try { r = rollup(ledger, axis, pricing); }
  catch (err) {
    console.error(`maddu cost${flags.usd ? ' --usd' : ''}: ${err.message}`);
    process.exit(2);
  }

  if (flags.json) {
    const out = { axis, ...r };
    if (pricing) out.pricing = { manifestVersion: pricing.effective.version, overrideActive: pricing.effective.overrideActive };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  if (r.total === 0) {
    // v0.19.1 PR-C1: be honest about WHY the ledger is empty.
    console.log('(no token usage reported yet)');
    console.log('');
    console.log('Why this is empty:');
    console.log('  The ledger only sees workers spawned by Máddu\'s bridge — direct');
    console.log('  Claude Code / Codex CLI sessions (the operator\'s own shell) are not');
    console.log('  captured here because the bridge isn\'t their parent process. This is');
    console.log('  an architectural boundary, not a bug.');
    console.log('');
    console.log('To populate the ledger:');
    console.log('  • Spawn workers through Máddu (`maddu pipeline run`, `maddu advise`,');
    console.log('    `maddu team open`) — those workers emit TOKEN_USAGE_REPORTED.');
    console.log('  • Or retroactively import your Claude Code transcripts:');
    console.log('      maddu usage import --from claude-code [--session <id>] [--dry-run]');
    console.log('    Each transcript line becomes a TOKEN_USAGE_REPORTED event with');
    console.log('    source: "claude-code-transcript".');
    if (pricing) {
      // r2-F3: --usd promised pricing metadata — surface it on the empty
      // ledger too, so the operator knows which manifest WOULD price rows.
      console.log('');
      console.log(`Pricing: manifest ${pricing.effective.version}  (estimates are read-time presentation, never written to the spine)`);
    }
    return;
  }

  console.log(`Token rollup by ${axis}  (${fmt(r.total)} call(s), ${fmt(r.unreported)} unreported)`);
  console.log('');
  const usdCols = pricing ? `  ${'usdRep'.padStart(9)}  ${'usdEst'.padStart(9)}  ${'unpriced'.padStart(8)}` : '';
  const header = ` ${axis.padEnd(28)}  ${'calls'.padStart(8)}  ${'input'.padStart(12)}  ${'output'.padStart(12)}  ${'cacheR'.padStart(10)}  ${'cacheC'.padStart(10)}  ${'unrep'.padStart(7)}${usdCols}`;
  console.log(header);
  console.log(' ' + '-'.repeat(header.length - 1));
  for (const g of r.groups) {
    const usdCells = pricing
      ? `  ${fmtUsd(g.usd.reported).padStart(9)}  ${fmtUsd(g.usd.estimated).padStart(9)}  ${fmt(g.usd.unpricedCount).padStart(8)}`
      : '';
    console.log(` ${g.key.padEnd(28)}  ${fmt(g.calls).padStart(8)}  ${fmt(g.input).padStart(12)}  ${fmt(g.output).padStart(12)}  ${fmt(g.cacheRead).padStart(10)}  ${fmt(g.cacheCreation).padStart(10)}  ${fmt(g.unreported).padStart(7)}${usdCells}`);
  }
  if (r.unreported > 0) {
    console.log('');
    console.log(`Note: ${fmt(r.unreported)} call(s) reported only minimum-schema metadata`);
    console.log('  (runtime/sessionId/model/ts) without token counts. Their calls are');
    console.log('  counted; token columns are not zeroed — they are excluded from the sum.');
  }
  if (pricing) {
    const reasons = {};
    let unpricedTotal = 0, partialTotal = 0;
    for (const g of r.groups) {
      unpricedTotal += g.usd.unpricedCount;
      partialTotal += g.usd.partialComponentsCount;
      for (const [reason, n] of Object.entries(g.usd.unpricedReasons)) {
        reasons[reason] = (reasons[reason] || 0) + n;
      }
    }
    console.log('');
    console.log(`Pricing: manifest ${pricing.effective.version}  (estimates are read-time presentation, never written to the spine)`);
    if (unpricedTotal > 0) {
      const breakdown = Object.entries(reasons).sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `${k}: ${fmt(n)}`).join(', ');
      console.log(`Unpriced: ${fmt(unpricedTotal)} call(s) — ${breakdown}`);
      console.log('  A row is priced only when provable: it needs a pricingIdentity (the');
      console.log('  spawn seam injects one when the runtime descriptor declares its');
      console.log('  authority), an exact manifest match, and reported token counts.');
    }
    if (partialTotal > 0) {
      console.log(`Partial estimates: ${fmt(partialTotal)} call(s) missing cache components — those terms are excluded, never zeroed.`);
    }
  }
}
