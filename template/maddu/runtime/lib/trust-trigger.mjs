// v1.7.0 invocation-logic — trust-audit-on-deps-change auto-trigger.
//
// The supply-chain trust audit was never dead by bug: `maddu trust audit`
// works and emits TRUST_AUDIT_RAN. It was dead by *flow* — nothing ran it
// when it mattered (when the dependency surface changed), so freshness/pin
// violations on newly-added deps went uncaught. This wires the missing
// WHEN: at slice-stop, if the deps fingerprint differs from the one stamped
// on the last TRUST_AUDIT_RAN, run a fresh audit.
//
// Rule-#9 gauntlet: only fires when `slice-stop:trust-audit` is in the
// .maddu/config/triggers.json allowlist (operator opts out by removing it),
// respects a cooldown, and every emission carries `triggered_by` provenance
// plus a TRIGGER_FIRED record. Best-effort — never breaks the slice-stop.

import { readAll, append, EVENT_TYPES } from './spine.mjs';
import { auditRepo, depsFingerprint } from './trust.mjs';

const COOLDOWN_MS = 10 * 60 * 1000; // 10 min — loop guard; the hash gate is the real trigger.

// Most recent TRUST_AUDIT_RAN depsHash + the last time this trigger fired.
async function readState(repoRoot) {
  let lastDepsHash = null;
  let lastFiredAt = 0;
  const events = await readAll(repoRoot);
  for (const ev of events) {
    if (ev.type === 'TRUST_AUDIT_RAN' && ev.data && typeof ev.data.depsHash === 'string') {
      lastDepsHash = ev.data.depsHash;
    }
    if (ev.type === 'TRIGGER_FIRED' && ev.data?.triggerId === 'slice-stop:trust-audit') {
      const t = new Date(ev.ts).getTime();
      if (Number.isFinite(t) && t > lastFiredAt) lastFiredAt = t;
    }
  }
  return { lastDepsHash, lastFiredAt };
}

// Run a trust audit IFF the dependency surface changed since the last audit.
// `triggeredBy` is the {kind,id,fired_at} provenance stamp from the caller.
// Returns one of:
//   { skipped: 'no-package-json' | 'unchanged' | 'cooldown' }
//   { ran: true, depsHash, violations, audited }
export async function auditIfDepsChanged(repoRoot, sessionId = null, triggeredBy = null) {
  const depsHash = await depsFingerprint(repoRoot);
  if (!depsHash) return { skipped: 'no-package-json' };

  const { lastDepsHash, lastFiredAt } = await readState(repoRoot);
  if (lastDepsHash === depsHash) return { skipped: 'unchanged', depsHash };

  const now = Date.now();
  if (now - lastFiredAt < COOLDOWN_MS) return { skipped: 'cooldown', depsHash };

  const audit = await auditRepo(repoRoot, { fresh: false, includeCves: false });
  if (!audit.ok) return { skipped: 'no-package-json', reason: audit.reason };

  const fired_at = new Date().toISOString();
  const provenance = triggeredBy || { kind: 'slice-stop', id: 'trust-audit', fired_at };

  // TRIGGER_FIRED first — the rule-#9 provenance + cooldown anchor.
  await append(repoRoot, {
    type: EVENT_TYPES.TRIGGER_FIRED,
    sessionId,
    data: { triggerId: 'slice-stop:trust-audit', reason: 'deps-changed', depsHash, triggered_by: provenance },
  });

  await append(repoRoot, {
    type: EVENT_TYPES.TRUST_AUDIT_RAN,
    sessionId,
    data: {
      audited: audit.rows.length,
      freshDays: audit.audit.freshness_warn_days,
      blockDays: audit.audit.freshness_block_days,
      warns: audit.warns.length,
      violations: audit.violations.length,
      cacheHits: audit.cacheHits,
      cacheMisses: audit.cacheMisses,
      cveTotal: audit.cveSummary?.total ?? null,
      depsHash,
      triggered_by: provenance,
    },
  });

  for (const v of audit.violations) {
    await append(repoRoot, {
      type: EVENT_TYPES.TRUST_VIOLATION_DETECTED,
      sessionId,
      data: {
        kind: v.pinViolation ? 'pin-drift' : 'freshness-block',
        pkg: v.name,
        expected: v.pinned?.version || null,
        actual: v.installedVersion,
        detail: v.pinViolation
          ? `installed ${v.installedVersion} != pinned ${v.pinned?.version}`
          : `package published ${v.ageDays}d ago (block threshold ${audit.audit.freshness_block_days}d)`,
        triggered_by: provenance,
      },
    });
  }

  return { ran: true, depsHash, violations: audit.violations.length, audited: audit.rows.length };
}
