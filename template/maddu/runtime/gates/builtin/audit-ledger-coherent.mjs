// audit-ledger-coherent (roadmap #2) — the self-verifying audit circuit.
//
// Holds docs/audit/LEDGER.json to discipline: every finding has a valid status;
// a `fixed` finding names the guardrail (gate) that enforces it; and every named
// gate is a REGISTERED gate id, so a guardrail can't be renamed/deleted while
// the ledger still claims the fault class is handled (the backref goes dangling
// → FAIL). This makes the audit self-proving instead of a one-off manual act.
//
// SOURCE-ONLY: the ledger ships only in a Máddu source checkout (docs/audit/),
// never in a consumer install — skip on its absence.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGateLib } from '../../lib/gate-libroot.mjs';

export default {
  id: 'audit-ledger-coherent',
  label: 'audit ledger coherent',
  severity: 'safety',
  description: 'docs/audit/LEDGER.json findings are well-formed and every `fixed` finding backref-links to a registered guardrail gate.',
  run: async (ctx) => {
    const path = join(ctx.repoRoot, 'docs', 'audit', 'LEDGER.json');
    let ledger;
    try {
      ledger = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return { ok: true, message: 'no docs/audit/LEDGER.json — audit circuit inactive (consumer install or pre-feature)' };
    }
    const lib = await loadGateLib(ctx.repoRoot, 'audit-ledger.mjs');
    const gatesLib = await loadGateLib(ctx.repoRoot, 'gates.mjs');
    if (!lib?.validateLedger || !gatesLib?.discoverGates) {
      return { ok: true, message: 'audit-ledger libs not present (skipped)' };
    }
    const gateIds = (await gatesLib.discoverGates(ctx.repoRoot)).map((g) => g.id);
    const res = lib.validateLedger(ledger.findings, gateIds);
    if (res.ok) {
      return { ok: true, message: lib.summarizeLedger(res) };
    }
    return { ok: false, message: lib.summarizeLedger(res), evidence: res };
  },
};
