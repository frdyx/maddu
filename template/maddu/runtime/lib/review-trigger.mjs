// v1.10.0 invocation-logic pass 2 — auto-review-on-slice-stop trigger.
//
// The review lane was dead by *flow*: `maddu review run` works (emits
// SLICE_REVIEWED / FOLLOWUP_OPENED), but nothing invoked it, so the
// semantic-regression safety net never ran. This wires the missing WHEN: after
// a slice-stop, run the configured reviewer over that slice.
//
// Safe on-by-default: runSliceReview GRACEFULLY SKIPS when no `kind:'reviewer'`
// runtime is configured (the common case), so the trigger only ever spawns a
// (billed) reviewer when an operator deliberately set one up. A cooldown guards
// against per-rapid-slice spam.
//
// Rule-#9 gauntlet: gated on `slice-stop:auto-review` in the allowlist; the
// SLICE_REVIEWED/FOLLOWUP_OPENED events carry `triggered_by`, and a
// TRIGGER_FIRED anchors the cooldown. Best-effort — never breaks the slice-stop.

import { readAll, append, EVENT_TYPES } from './spine.mjs';
import { runSliceReview } from './review.mjs';
import { escalatesReview } from './risk-assess.mjs';

const COOLDOWN_MS = 10 * 60 * 1000; // 10 min — don't re-review on every rapid slice.

async function lastFiredAt(repoRoot) {
  let last = 0;
  for (const ev of await readAll(repoRoot)) {
    if (ev.type === 'TRIGGER_FIRED' && ev.data?.triggerId === 'slice-stop:auto-review') {
      const t = new Date(ev.ts).getTime();
      if (Number.isFinite(t) && t > last) last = t;
    }
  }
  return last;
}

// Review the just-stopped slice IFF a reviewer is configured and the cooldown
// has elapsed. Returns:
//   { skipped: 'cooldown' | 'no-reviewer-configured' | <reason> }
//   { ran: true, verdict, findingsCount }
export async function maybeReviewSliceStop(repoRoot, ev, sessionId = null, triggeredBy = null) {
  if (!ev || ev.type !== 'SLICE_STOP') return { skipped: 'not-a-slice-stop' };

  // v1.17.0 — a high/critical-risk slice (touched auth/secrets/schema, or a
  // broad change) escalates past the cooldown: the one case where re-reviewing
  // a rapid slice is worth the spend. Ordinary slices still respect the window.
  const riskLevel = ev.data?.risk?.level || null;
  const escalate = escalatesReview(riskLevel);

  // Cooldown FIRST — never spawn a (billed) reviewer within the window, unless
  // the slice's risk escalates it.
  const now = Date.now();
  if (!escalate && now - (await lastFiredAt(repoRoot)) < COOLDOWN_MS) return { skipped: 'cooldown' };

  const fired_at = new Date().toISOString();
  const provenance = triggeredBy || { kind: 'slice-stop', id: 'auto-review', fired_at, risk: riskLevel };

  // runSliceReview no-ops cleanly when no reviewer is configured (no spawn, no
  // cost) and stamps SLICE_REVIEWED/FOLLOWUP_OPENED with the provenance.
  const res = await runSliceReview(repoRoot, { sliceEventId: ev.id, triggeredBy: provenance });
  if (res.skipped) return { skipped: res.reason };

  // It ran — anchor the cooldown with a TRIGGER_FIRED record.
  await append(repoRoot, {
    type: EVENT_TYPES.TRIGGER_FIRED,
    actor: sessionId,
    data: { triggerId: 'slice-stop:auto-review', reason: escalate ? `slice-stopped (risk: ${riskLevel})` : 'slice-stopped', risk: riskLevel, escalated: escalate, sliceEventId: ev.id, verdict: res.verdict, triggered_by: provenance },
  });

  return { ran: true, verdict: res.verdict, findingsCount: res.findingsCount };
}
