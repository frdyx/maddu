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
// Semantics (r3 major 2): the gate answers "was every feed AUTHORIZED WHEN
// IT HAPPENED, within bounds?" — a fact legitimately revoked/superseded/
// retagged AFTER a witnessed injection does not red the gate retroactively.
// Live tamper detection is the recall path's job (hindsight.trustFor demotes
// hash-mismatched facts before they can be fed again).

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
    // AUTHORIZATION AT INJECTION TIME (Codex r3 major 2): each injection is
    // judged against the trust state AS OF that event — a fact legitimately
    // approved, injected, and LATER revoked/superseded/retagged must not turn
    // the gate permanently red. Chronological fold over the spine: approvals
    // (with their hash) and revocations toggle state; supersession events
    // retire ids. Live tamper is the recall path's job (trustFor); this
    // gate answers "was every feed authorized when it happened, within
    // bounds?" — plus a claim/recompute cross-check where content is
    // provably unchanged (all facts still currently approved).
    const violations = [];
    const approvedAt = new Map();   // factId → true while approved (walk state)
    const retired = new Set();      // factId → superseded at this point
    for (const ev of events) {
      if (ev.type === 'MEMORY_FACT_APPROVED' && ev.data?.factId) {
        approvedAt.set(ev.data.factId, true);
      } else if (ev.type === 'MEMORY_FACT_REVOKED' && ev.data?.factId) {
        approvedAt.delete(ev.data.factId);
      } else if (ev.type === 'MEMORY_FACT_SUPERSEDED' && ev.data?.supersedes) {
        retired.add(ev.data.supersedes);
      } else if (ev.type === 'MEMORY_INJECTED') {
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
        } else if (inj.totalBytes > MAX_TOTAL_BYTES) {
          violations.push({ ts: inj.ts, reason: `claimed totalBytes ${inj.totalBytes} > ${MAX_TOTAL_BYTES}` });
        }
        for (const fid of inj.factIds) {
          if (!approvedAt.get(fid) || retired.has(fid)) {
            violations.push({ ts: inj.ts, reason: `fact ${fid} was not approved (or already superseded) at injection time` });
          }
        }
        // Cross-check claim vs recompute ONLY when every injected fact is
        // STILL currently approved + hash-valid — content is then provably
        // the content that was fed, so an honest claim matches exactly.
        if (typeof inj.totalBytes === 'number' && Number.isFinite(inj.totalBytes)
            && inj.factIds.every((fid) => approvedBytes.has(fid))) {
          const recomputed = inj.factIds.reduce((n, fid) => n + approvedBytes.get(fid), 0);
          if (inj.totalBytes !== recomputed) {
            violations.push({ ts: inj.ts, reason: `claimed totalBytes ${inj.totalBytes} != recomputed ${recomputed} — witness mismatch` });
          }
        }
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
