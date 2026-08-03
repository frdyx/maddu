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
    // VALIDATION BY REFERENCE (Codex r5 major 2): each witness row names its
    // approval EVENT (`approvalEvent`), so the check survives cross-partition
    // team-sync merges that reorder events by (ts, replicaId). The hard law:
    // the referenced approval must exist and bind THIS fact to THIS content
    // hash. Ordering (approval before injection in readAll order) is enforced
    // as a hard violation when broken WITHOUT a valid reference, and as a
    // WARN when the reference is valid but appears later — a legitimate
    // cross-partition reorder and an approve-after-feed sequence are
    // indistinguishable from the merged spine, so it surfaces, never hides.
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const approvalsById = new Map(); // approval event id → {factId, sha256, index}
    const revocations = new Map();   // factId → [indices]
    const supersessions = new Map(); // superseded factId → [indices] (r6 blocker 1)
    events.forEach((ev, i) => {
      if (ev.type === 'MEMORY_FACT_APPROVED' && ev.data?.factId) {
        approvalsById.set(ev.id, { factId: ev.data.factId, sha256: typeof ev.data.sha256 === 'string' ? ev.data.sha256 : null, index: i });
      } else if (ev.type === 'MEMORY_FACT_REVOKED' && ev.data?.factId) {
        if (!revocations.has(ev.data.factId)) revocations.set(ev.data.factId, []);
        revocations.get(ev.data.factId).push(i);
      } else if (ev.type === 'MEMORY_FACT_SUPERSEDED' && ev.data?.supersedes) {
        if (!supersessions.has(ev.data.supersedes)) supersessions.set(ev.data.supersedes, []);
        supersessions.get(ev.data.supersedes).push(i);
      }
    });
    let injectionCount = 0;
    const violations = [];
    const reorders = [];
    events.forEach((ev, i) => {
      if (ev.type !== 'MEMORY_INJECTED') return;
      injectionCount += 1;
      const d = ev.data || {};
      if (!Array.isArray(d.factIds)) {
        violations.push({ ts: ev.ts, reason: 'factIds not array' });
        return;
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
        violations.push({ ts: ev.ts, reason: 'facts[] (per-fact approval references) missing from witness' });
        return;
      }
      const rowIds = new Set(factRows.map((r) => r?.id));
      if (rowIds.size !== d.factIds.length || !d.factIds.every((id) => rowIds.has(id))) {
        violations.push({ ts: ev.ts, reason: 'facts[]/factIds mismatch' });
      }
      for (const row of factRows) {
        if (typeof row?.id !== 'string' || typeof row?.sha256 !== 'string' || typeof row?.approvalEvent !== 'string') {
          violations.push({ ts: ev.ts, reason: `witness row incomplete (${JSON.stringify(row).slice(0, 100)})` });
          continue;
        }
        const appr = approvalsById.get(row.approvalEvent);
        if (!appr) {
          violations.push({ ts: ev.ts, reason: `fact ${row.id}: referenced approval ${row.approvalEvent} not found on the spine` });
          continue;
        }
        if (appr.factId !== row.id || appr.sha256 !== row.sha256) {
          violations.push({ ts: ev.ts, reason: `fact ${row.id}: approval reference mismatch (binds ${appr.factId}@${String(appr.sha256).slice(0, 12)}…, witness claims ${row.id}@${row.sha256.slice(0, 12)}…)` });
          continue;
        }
        // TEMPORAL ordering on a merged spine is advisory (Codex r6 major 2:
        // team-sync merges by (ts, replicaId), so "between" cannot be proven
        // causal). One consistent rule: hash-binding by reference is the hard
        // law above; every ordering anomaly — approval-after-feed,
        // revoked-between, superseded-between — surfaces as WARN: detected
        // and named, never a false critical, never hidden.
        if (appr.index > i) {
          reorders.push({ ts: ev.ts, reason: `fact ${row.id}: valid approval ${row.approvalEvent} appears AFTER the injection in merged order — cross-partition reorder or approve-after-feed` });
        } else if ((revocations.get(row.id) || []).some((ri) => ri > appr.index && ri < i)) {
          reorders.push({ ts: ev.ts, reason: `fact ${row.id}: a revocation appears between approval ${row.approvalEvent} and this injection in merged order — stale feed or cross-partition reorder` });
        } else if ((supersessions.get(row.id) || []).some((si) => si > appr.index && si < i)) {
          // r6 blocker 1: a supersession retiring the fact between approval
          // and feed means retired content may have reached agent context.
          reorders.push({ ts: ev.ts, reason: `fact ${row.id}: a supersession retires this fact between approval ${row.approvalEvent} and this injection in merged order — retired feed or cross-partition reorder` });
        }
      }
    });
    if (injectionCount === 0) {
      return { ok: true, message: 'no memory injections recorded (skipped)' };
    }
    if (violations.length === 0 && reorders.length === 0) {
      return { ok: true, message: `${injectionCount} injection event(s), all bounded and approval-referenced with matching content hashes` };
    }
    if (violations.length === 0) {
      return {
        ok: false, status: 'warn',
        message: `${reorders.length} injection(s) whose valid approval appears later in merged order — verify team-sync partitions or investigate approve-after-feed`,
        evidence: { reorders: reorders.slice(0, 10) },
      };
    }
    return {
      ok: false,
      message: `${violations.length} violation(s) across ${injectionCount} injection event(s)`,
      evidence: { violations: violations.slice(0, 10), totalViolations: violations.length, reorders: reorders.slice(0, 5) },
    };
  },
};
