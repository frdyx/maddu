// `maddu log` — receipt-log viewer + rebuilder (v1.1.0 Phase 4).
//
// Usage:
//   maddu log                        # last 50, newest first
//   maddu log --since <iso>          # everything since the given ISO timestamp
//   maddu log --lane <id>            # filter by lane
//   maddu log --op <type|substring>  # filter by event type or summary substring
//   maddu log --rebuild              # re-project from the spine, refresh artifacts
//   maddu log --json                 # raw JSON output

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m', accent: '\x1b[35m' };
const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = pathResolve(__dirname, '..');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function loadReceipts() {
  const candidates = [
    join(process.cwd(), 'maddu', 'runtime', 'lib', 'receipts.mjs'),
    join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib', 'receipts.mjs'),
  ];
  for (const c of candidates) { if (await exists(c)) return await import(pathToFileURL(c).href); }
  throw new Error('receipts.mjs not found. Run `maddu upgrade`.');
}

export default async function logCmd(argv) {
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const receiptsLib = await loadReceipts();
  const { flags } = parseFlags(argv);

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
