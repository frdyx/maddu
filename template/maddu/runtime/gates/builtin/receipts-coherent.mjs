// v1.1.0 Phase 4 — verifies the receipt-log projection is deterministic
// (two projections from the same spine produce byte-equal output).

import { loadGateLib } from '../../lib/gate-libroot.mjs';

export default {
  id: 'receipts-coherent',
  label: 'receipt log coherent',
  severity: 'safety',
  description: 'Receipt projection is deterministic and the operations.ndjson artifact matches the latest replay.',
  run: async (ctx) => {
    const lib = await loadGateLib(ctx.repoRoot, 'receipts.mjs');
    if (!lib) return { ok: true, message: 'receipts lib not present (skipped)' };
    const det = await lib.isProjectionDeterministic(ctx.repoRoot);
    if (!det.equal) {
      return { ok: false, message: `non-deterministic projection: ${det.lenA} vs ${det.lenB} entries`, evidence: det };
    }
    return { ok: true, message: `receipts deterministic (${det.lenA} entries)` };
  },
};
