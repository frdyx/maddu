// Auto-decide cascade for APPROVAL_REQUESTED events.
//
// Why this lives in its own module:
//   Before this slice, per-repo policy auto-decide happened inside the
//   projector — it manufactured a synthetic ledger entry at read time
//   for any APPROVAL_REQUESTED whose tool/lane matched an
//   APPROVAL_POLICY_SET. The decision lived only in projector code,
//   never in the spine. That violated hard rule #2 (the spine wins
//   over any projection): replay on a different machine with different
//   projector logic could produce a different ledger; the decision had
//   no anchor event for forensic audit.
//
// What changed:
//   Every code path that appends APPROVAL_REQUESTED now also calls
//   maybeAutoDecide() right after. If a policy matches, a *real*
//   APPROVAL_DECIDED event is appended to the spine with a
//   triggered_by field pointing at the rule that produced it. The
//   projector no longer synthesizes anything — the spine is genuinely
//   the source of truth.
//
// Match priority:
//   1. Per-repo policy (actor 'policy', triggered_by.kind 'policy')
//   2. Global policy (actor 'global-policy', triggered_by.kind 'global_policy')
//   3. No match → request stays in the open queue, awaiting operator
//
// Wildcard semantics: exact > tool@* > *@lane > *@*.
// Only allow-always and deny auto-decide; allow-once never does (it
// requires an explicit per-request operator action by definition).

import { append, EVENT_TYPES } from './spine.mjs';
import { project } from './projections.mjs';
import { listGlobalPolicies, matchGlobalPolicy } from './global.mjs';

function policyKey(tool, lane) {
  return `${tool || '*'}@${lane || '*'}`;
}

// Mirrors matchGlobalPolicy in global.mjs but operates on the
// projection's policies array (per-repo state). Kept here rather than
// imported because the shapes are subtly different (projection rows
// don't carry an `id` field).
export function matchRepoPolicy(policies, tool, lane) {
  if (!policies || !policies.length) return null;
  const exact = policies.find((p) => p.tool === tool && p.lane === lane);
  if (exact) return exact;
  const toolStar = policies.find((p) => p.tool === tool && (p.lane == null || p.lane === '*'));
  if (toolStar) return toolStar;
  const starLane = policies.find((p) => (p.tool === '*' || p.tool == null) && p.lane === lane);
  if (starLane) return starLane;
  const both = policies.find((p) => (p.tool === '*' || p.tool == null) && (p.lane == null || p.lane === '*'));
  return both || null;
}

// Given a freshly-written APPROVAL_REQUESTED event, see if any policy
// (per-repo first, then global) auto-decides it. On a match, append a
// real APPROVAL_DECIDED event with a triggered_by field. Returns
//   { decided: bool, source: 'policy'|'global-policy'|null, event?: <APPROVAL_DECIDED> }
//
// The caller (bridge handler / CLI) decides whether to re-project and
// surface the new state in its response.
export async function maybeAutoDecide(repoRoot, requestEv) {
  const proj = await project(repoRoot);

  // ─── per-repo policy ───
  const repoMatch = matchRepoPolicy(proj.approvals.policies, requestEv.data.tool, requestEv.lane);
  if (repoMatch && (repoMatch.decision === 'allow-always' || repoMatch.decision === 'deny')) {
    const id = policyKey(repoMatch.tool, repoMatch.lane);
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.APPROVAL_DECIDED,
      actor: 'policy',
      lane: requestEv.lane || null,
      data: {
        approvalId: requestEv.id,
        decision: repoMatch.decision,
        reason: `policy:${id}`,
        tool: requestEv.data.tool || null
      },
      triggered_by: { kind: 'policy', id, fired_at: new Date().toISOString() }
    });
    return { decided: true, source: 'policy', event: ev };
  }

  // ─── global policy ───
  const gPolicies = await listGlobalPolicies();
  const gMatch = matchGlobalPolicy(gPolicies, requestEv.data.tool, requestEv.lane);
  if (gMatch && (gMatch.decision === 'allow-always' || gMatch.decision === 'deny')) {
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.APPROVAL_DECIDED,
      actor: 'global-policy',
      lane: requestEv.lane || null,
      data: {
        approvalId: requestEv.id,
        decision: gMatch.decision,
        reason: `global-policy:${gMatch.id}`,
        tool: requestEv.data.tool || null
      },
      triggered_by: { kind: 'global_policy', id: gMatch.id, fired_at: new Date().toISOString() }
    });
    return { decided: true, source: 'global-policy', event: ev };
  }

  return { decided: false, source: null };
}
