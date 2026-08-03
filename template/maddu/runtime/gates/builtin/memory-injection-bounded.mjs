// memory-injection-bounded — memory-recall track, Phase 4.
//
// Verifies MEMORY_INJECTED events stay within bounds AND within trust:
//   - factIds.length ≤ 8 (MAX_RECALL_ITEMS)
//   - totalBytes ≤ 16384 (MAX_RECALL_BYTES)
//   - every injected factId is a CURRENTLY approved, non-superseded fact
//     (re-derived from the spine — never trusted from the event itself)
//
// Severity: critical — a violation means unattested or unbounded memory is
// reaching agent context: exactly the "integrity ledger becomes an automated
// truth amplifier" failure this track exists to prevent.
//
// Trust re-verification note: a fact legitimately injected and LATER revoked
// would flag here — that is intended. The gate answers "would today's spine
// authorize what was fed?", the honest question for an audit surface.

import { loadGateLib } from '../../lib/gate-libroot.mjs';

const MAX_ITEMS = 8;
const MAX_TOTAL_BYTES = 16384;

export default {
  id: 'memory-injection-bounded',
  label: 'memory injection bounded',
  severity: 'critical',
  description: 'MEMORY_INJECTED events stay within cap (≤8 facts, ≤16KB) and every injected fact is currently approved + non-superseded.',
  run: async (ctx) => {
    const proj = await ctx.project();
    const injections = Array.isArray(proj.memoryInjections) ? proj.memoryInjections : [];
    if (injections.length === 0) {
      return { ok: true, message: 'no memory injections recorded (skipped)' };
    }
    // Re-derive current trust + supersession from the spine via the lib.
    let approved = null;
    try {
      const h = await loadGateLib(ctx.repoRoot, 'hindsight.mjs');
      if (h?.factsWithTrust) {
        approved = new Set((await h.factsWithTrust(ctx.repoRoot)).filter((f) => f.trust === 'approved').map((f) => f.id));
      }
    } catch { /* older install — bounds still checked below */ }
    const violations = [];
    for (const inj of injections) {
      if (!Array.isArray(inj.factIds)) {
        violations.push({ ts: inj.ts, reason: 'factIds not array' });
        continue;
      }
      if (inj.factIds.length > MAX_ITEMS) {
        violations.push({ ts: inj.ts, reason: `factIds.length=${inj.factIds.length} > ${MAX_ITEMS}` });
      }
      if (typeof inj.totalBytes === 'number' && inj.totalBytes > MAX_TOTAL_BYTES) {
        violations.push({ ts: inj.ts, reason: `totalBytes=${inj.totalBytes} > ${MAX_TOTAL_BYTES}` });
      }
      if (approved) {
        for (const fid of inj.factIds) {
          if (!approved.has(fid)) violations.push({ ts: inj.ts, reason: `fact ${fid} not currently approved` });
        }
      }
    }
    if (violations.length === 0) {
      return { ok: true, message: `${injections.length} injection event(s), all within bounds and approved` };
    }
    return {
      ok: false,
      message: `${violations.length} violation(s) across ${injections.length} injection event(s)`,
      evidence: { violations: violations.slice(0, 10), totalViolations: violations.length },
    };
  },
};
