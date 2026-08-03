// memory-injection-bounded — memory-recall track, Phase 4 (hardened per
// Codex r1 findings 5/6/7).
//
// Verifies MEMORY_INJECTED events stay within bounds AND within trust:
//   - reads the UNCAPPED spine directly (never the projection's last-200
//     window — an old violation must not age out of a critical gate's view)
//   - factIds.length ≤ 8 (MAX_RECALL_ITEMS)
//   - bytes RECOMPUTED from the current fact texts (the event's claimed
//     totalBytes is cross-checked but never trusted; a missing/non-numeric
//     claim is itself a violation)
//   - every injected factId is a CURRENTLY approved (content-hash-valid),
//     non-superseded fact — re-derived from the spine via factsWithTrust
//   - FAIL CLOSED: if injections exist but trust cannot be re-derived
//     (hindsight lib unloadable), the gate fails — it never reports
//     "all approved" on a check it could not perform.
//
// Severity: critical — a violation means unattested or unbounded memory is
// reaching agent context: exactly the "integrity ledger becomes an automated
// truth amplifier" failure this track exists to prevent.
//
// Trust re-verification note: a fact legitimately injected and LATER revoked,
// superseded, or content-edited flags here — intended. The gate answers
// "would today's spine authorize what was fed?".

import { loadGateLib } from '../../lib/gate-libroot.mjs';

const MAX_ITEMS = 8;
const MAX_TOTAL_BYTES = 16384;

export default {
  id: 'memory-injection-bounded',
  label: 'memory injection bounded',
  severity: 'critical',
  description: 'Every MEMORY_INJECTED event (full spine, uncapped) stays within cap (≤8 facts, ≤16KB recomputed) and every injected fact is currently approved (hash-valid) + non-superseded.',
  run: async (ctx) => {
    // Uncapped view: read MEMORY_INJECTED straight off the spine.
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const injections = events.filter((e) => e.type === 'MEMORY_INJECTED');
    if (injections.length === 0) {
      return { ok: true, message: 'no memory injections recorded (skipped)' };
    }
    // Re-derive current trust + supersession + content bytes from the spine
    // via the lib. FAIL CLOSED on any load/derive failure: injections exist,
    // so the trust half of the check is not optional.
    let approvedBytes = null; // Map<factId, byteLength> for approved facts only
    let deriveError = null;
    try {
      const h = await loadGateLib(ctx.repoRoot, 'hindsight.mjs');
      if (!h?.factsWithTrust || !h?.factContentBytes) throw new Error('hindsight trust surface unavailable');
      // Byte measure = the canonical consumed-content serialization (same
      // string the approval hash covers) — text-only counting let a tiny
      // fact carry megabytes in its lane/tags (Codex r2 blocker 2).
      approvedBytes = new Map(
        (await h.factsWithTrust(ctx.repoRoot))
          .filter((f) => f.trust === 'approved')
          .map((f) => [f.id, h.factContentBytes(f)])
      );
    } catch (err) {
      deriveError = err.message || String(err);
    }
    if (!approvedBytes) {
      return {
        ok: false,
        message: `cannot re-derive fact trust (${deriveError}) while ${injections.length} injection event(s) exist — refusing to assume they were approved`,
        evidence: { deriveError, injectionCount: injections.length },
      };
    }
    const violations = [];
    for (const ev of injections) {
      const inj = { ts: ev.ts, factIds: ev.data?.factIds, totalBytes: ev.data?.totalBytes };
      if (!Array.isArray(inj.factIds)) {
        violations.push({ ts: inj.ts, reason: 'factIds not array' });
        continue;
      }
      if (inj.factIds.length > MAX_ITEMS) {
        violations.push({ ts: inj.ts, reason: `factIds.length=${inj.factIds.length} > ${MAX_ITEMS}` });
      }
      if (typeof inj.totalBytes !== 'number' || !Number.isFinite(inj.totalBytes)) {
        violations.push({ ts: inj.ts, reason: `totalBytes missing/non-numeric (${JSON.stringify(inj.totalBytes)})` });
      }
      let recomputed = 0;
      for (const fid of inj.factIds) {
        const bytes = approvedBytes.get(fid);
        if (bytes === undefined) {
          violations.push({ ts: inj.ts, reason: `fact ${fid} not currently approved` });
        } else {
          recomputed += bytes;
        }
      }
      if (recomputed > MAX_TOTAL_BYTES) {
        violations.push({ ts: inj.ts, reason: `recomputed bytes ${recomputed} > ${MAX_TOTAL_BYTES} (claimed ${inj.totalBytes})` });
      }
      // Witness integrity: fact text is immutable per id (idempotent ids;
      // supersession mints new ids; tamper already fails the hash check), so
      // an honest witness's claim equals the recompute EXACTLY — any
      // mismatch means the witness lies about what was fed.
      if (typeof inj.totalBytes === 'number' && Number.isFinite(inj.totalBytes)
          && inj.factIds.every((fid) => approvedBytes.has(fid)) && inj.totalBytes !== recomputed) {
        violations.push({ ts: inj.ts, reason: `claimed totalBytes ${inj.totalBytes} != recomputed ${recomputed} — witness mismatch` });
      }
    }
    if (violations.length === 0) {
      return { ok: true, message: `${injections.length} injection event(s), all within recomputed bounds and currently approved` };
    }
    return {
      ok: false,
      message: `${violations.length} violation(s) across ${injections.length} injection event(s)`,
      evidence: { violations: violations.slice(0, 10), totalViolations: violations.length },
    };
  },
};
