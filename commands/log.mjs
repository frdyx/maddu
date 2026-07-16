// `maddu log` — receipt-log viewer + rebuilder (v1.1.0 Phase 4).
//
// Usage:
//   maddu log                        # last 50, newest first
//   maddu log --since <iso>          # everything since the given ISO timestamp
//   maddu log --lane <id>            # filter by lane
//   maddu log --op <type|substring>  # filter by event type or summary substring
//   maddu log --rebuild              # re-project from the spine, refresh artifacts
//   maddu log --window               # invocation-receipts corpus: retention window + counts
//   maddu log --json                 # raw JSON output

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib, loadLibOptional } from './_libroot.mjs';

const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m', accent: '\x1b[35m' };

async function loadReceipts() {
  return loadLib('receipts.mjs');
}

export default async function logCmd(argv) {
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const receiptsLib = await loadReceipts();
  const { flags } = parseFlags(argv);

  // --window (Tier 2, v1.101.0): declare the invocation-receipts corpus —
  // the observed retention window, receipt/drop counts, and the rotation cap.
  // This is the honesty surface for the execution-telemetry corpus: receipts
  // are an observed-window signal (fail-open writes + rotation make gaps
  // structural), never lifetime totals, and this readout says exactly what
  // window the counts cover.
  if (flags.window) {
    const ir = await loadLibOptional('invocation-receipts.mjs');
    if (!ir) {
      console.error('maddu log --window: invocation-receipts lib not found. Run `maddu upgrade` to get v1.101.0+.');
      process.exit(2);
    }
    const stats = await ir.readReceiptStats(repoRoot);
    if (flags.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
      return;
    }
    console.log(`${ANSI.bold}INVOCATION RECEIPTS  (observed window, not lifetime totals)${ANSI.reset}`);
    console.log(`  corpus:    .maddu/state/invocation-receipts.ndjson  ${ANSI.dim}(+ one rotated generation)${ANSI.reset}`);
    console.log(`  receipts:  ${stats.count}  ${ANSI.dim}(${stats.failures} non-zero exit)${ANSI.reset}`);
    console.log(`  dropped:   ${stats.dropped} unparseable line(s)`);
    console.log(`  window:    ${stats.window ? `${stats.window.oldest} → ${stats.window.newest}` : '(no receipts yet)'}`);
    console.log(`  retention: size-capped rotation at ${Math.round(stats.rotateBytes / 1024 / 1024)}MB/file, one prev generation kept  ${ANSI.dim}(${stats.bytes} bytes on disk)${ANSI.reset}`);
    for (const v of stats.verbs.slice(0, 15)) {
      console.log(`    ${v.verb.padEnd(24)} ${String(v.count).padStart(5)}×${v.fail ? `  ${ANSI.dim}${v.fail} failed${ANSI.reset}` : ''}`);
    }
    return;
  }

  if (flags.rebuild) {
    const res = await receiptsLib.writeReceiptLog(repoRoot);
    console.log(`rebuilt receipt log: ${res.count} entries → ${res.ndjsonPath}`);
    console.log(`README refreshed:                  ${res.readmePath}`);
    return;
  }

  // Always re-project so the read reflects current spine state.
  await receiptsLib.writeReceiptLog(repoRoot);

  const opts = {};
  if (typeof flags.since === 'string') opts.since = flags.since;
  if (typeof flags.lane === 'string') opts.lane = flags.lane;
  if (typeof flags.op === 'string') opts.op = flags.op;

  const lines = await receiptsLib.readReceiptLog(repoRoot, opts);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ count: lines.length, receipts: lines }, null, 2) + '\n');
    return;
  }

  const slice = lines.slice(-50).reverse();
  console.log(`${ANSI.bold}OPERATIONS  (${lines.length} total, showing ${slice.length})${ANSI.reset}`);
  for (const r of slice) {
    const ts = (r.ts || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    console.log(`  ${ANSI.dim}${ts}${ANSI.reset}  ${ANSI.accent}${r.type.padEnd(22)}${ANSI.reset}  ${ANSI.dim}lane:${r.lane || '—'}${ANSI.reset}`);
    console.log(`    ${r.summary || ''}`);
  }
}
