// memory-injection-bounded — memory-recall track, Phase 4.
// Hardened across Codex rounds r1 (5/6/7), r3 (major 2), r4 (blocker 1 /
// major 3): the gate is now a PURE CHRONOLOGICAL SPINE FOLD — no projection
// window, no current-state lib, no epoch confusion.
//
// Verifies every MEMORY_INJECTED event on the UNCAPPED spine:
//   - factIds.length ≤ 8 (MAX_RECALL_ITEMS)
//   - claimed totalBytes present, numeric, ≤ 16384
//   - data.facts[] present, one {id, sha256} per fed fact, ids matching
//     factIds — the witness records WHAT CONTENT was fed
//   - AT INJECTION TIME (fold order): each fed fact had a live approval
//     whose recorded content-hash equals the witness's sha256 — so a
//     revoke–edit–reapprove around an injection cannot launder content
//     (r4 blocker 1), and a later legitimate revoke/supersede/reapproval
//     never reds a historical witness (r3 major 2 / r4 major 3).
//
// Severity: critical — a violation means unattested or unbounded memory
// reached agent context: the "integrity ledger becomes an automated truth
// amplifier" failure this track exists to prevent. Live tamper detection is
// the recall surface's job (hindsight.trustFor demotes hash-mismatched rows
// before they can ever be fed again).

const MAX_ITEMS = 8;
const MAX_TOTAL_BYTES = 16384;

export default {
  id: 'memory-injection-bounded',
  label: 'memory injection bounded',
  severity: 'critical',
  description: 'Every MEMORY_INJECTED event (full spine, uncapped) stays within cap (≤8 facts, ≤16KB claimed) and every fed fact carried a live approval whose content-hash matches the witness at injection time.',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    let injectionCount = 0;
    const violations = [];
    const approvalHash = new Map(); // factId → sha256 while approved (fold state)
    const retired = new Set();      // factId → superseded at this point
    for (const ev of events) {
      if (ev.type === 'MEMORY_FACT_APPROVED' && ev.data?.factId) {
        approvalHash.set(ev.data.factId, typeof ev.data.sha256 === 'string' ? ev.data.sha256 : null);
      } else if (ev.type === 'MEMORY_FACT_REVOKED' && ev.data?.factId) {
        approvalHash.delete(ev.data.factId);
      } else if (ev.type === 'MEMORY_FACT_SUPERSEDED' && ev.data?.supersedes) {
        retired.add(ev.data.supersedes);
      } else if (ev.type === 'MEMORY_INJECTED') {
        injectionCount += 1;
        const d = ev.data || {};
        if (!Array.isArray(d.factIds)) {
          violations.push({ ts: ev.ts, reason: 'factIds not array' });
          continue;
        }
        if (d.factIds.length > MAX_ITEMS) {
          violations.push({ ts: ev.ts, reason: `factIds.length=${d.factIds.length} > ${MAX_ITEMS}` });
        }
        if (typeof d.totalBytes !== 'number' || !Number.isFinite(d.totalBytes)) {
          violations.push({ ts: ev.ts, reason: `totalBytes missing/non-numeric (${JSON.stringify(d.totalBytes)})` });
        } else if (d.totalBytes > MAX_TOTAL_BYTES) {
          violations.push({ ts: ev.ts, reason: `claimed totalBytes ${d.totalBytes} > ${MAX_TOTAL_BYTES}` });
        }
        const factRows = Array.isArray(d.facts) ? d.facts : null;
        if (!factRows) {
          violations.push({ ts: ev.ts, reason: 'facts[] (per-fact approval hashes) missing from witness' });
          continue;
        }
        const rowIds = new Set(factRows.map((r) => r?.id));
        if (rowIds.size !== d.factIds.length || !d.factIds.every((id) => rowIds.has(id))) {
          violations.push({ ts: ev.ts, reason: 'facts[]/factIds mismatch' });
        }
        for (const row of factRows) {
          const fid = row?.id;
          if (typeof fid !== 'string' || typeof row?.sha256 !== 'string') {
            violations.push({ ts: ev.ts, reason: `witness row malformed (${JSON.stringify(row).slice(0, 80)})` });
            continue;
          }
          if (retired.has(fid) || !approvalHash.has(fid)) {
            violations.push({ ts: ev.ts, reason: `fact ${fid} was not approved (or already superseded) at injection time` });
          } else if (approvalHash.get(fid) !== row.sha256) {
            violations.push({ ts: ev.ts, reason: `fact ${fid} fed with content-hash ${row.sha256.slice(0, 12)}… but the live approval at that time bound ${String(approvalHash.get(fid)).slice(0, 12)}…` });
          }
        }
      }
    }
    if (injectionCount === 0) {
      return { ok: true, message: 'no memory injections recorded (skipped)' };
    }
    if (violations.length === 0) {
      return { ok: true, message: `${injectionCount} injection event(s), all bounded and hash-authorized at injection time` };
    }
    return {
      ok: false,
      message: `${violations.length} violation(s) across ${injectionCount} injection event(s)`,
      evidence: { violations: violations.slice(0, 10), totalViolations: violations.length },
    };
  },
};
