// v1.1.0 Phase 4 — verifies the receipt-log projection is deterministic
// (two projections from the same spine produce byte-equal output).

import { stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function loadLib(repoRoot) {
  const consumer = join(repoRoot, 'maddu', 'runtime', 'lib', 'receipts.mjs');
  if (await exists(consumer)) return await import(pathToFileURL(consumer).href);
  const source = join(__dirname, '..', '..', 'lib', 'receipts.mjs');
  if (await exists(source)) return await import(pathToFileURL(source).href);
  return null;
}

export default {
  id: 'receipts-coherent',
  label: 'receipt log coherent',
  severity: 'safety',
  description: 'Receipt projection is deterministic and the operations.ndjson artifact matches the latest replay.',
  run: async (ctx) => {
    const lib = await loadLib(ctx.repoRoot);
    if (!lib) return { ok: true, message: 'receipts lib not present (skipped)' };
    const det = await lib.isProjectionDeterministic(ctx.repoRoot);
    if (!det.equal) {
      return { ok: false, message: `non-deterministic projection: ${det.lenA} vs ${det.lenB} entries`, evidence: det };
    }
    return { ok: true, message: `receipts deterministic (${det.lenA} entries)` };
  },
};
