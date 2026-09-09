// Pending-actions queue — Governance Phase 4.
//
// Auto-triggered read-only actions (review-prompts, drift-checks, brief
// refreshes) are NOT executed in-band. They land in the spine as
// PENDING_ACTION_ENQUEUED and surface to the next live agent via
// `maddu brief --drain`. The agent decides whether to act; draining
// emits PENDING_ACTION_DRAINED with an outcome.

export async function enqueue(spine, repoRoot, { kind, payload = {}, triggered_by = null } = {}) {
  // Use the injected spine's canonical id factory (preserves act_<ts14>_<hex6>).
  const actionId = spine.makeId('act');
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.PENDING_ACTION_ENQUEUED,
    data: { actionId, kind, payload },
    triggered_by,
  });
  return actionId;
}

export async function drain(spine, projections, repoRoot, { limit = 50 } = {}) {
  const proj = await projections.project(repoRoot);
  const open = (proj.pendingActions || []).filter((a) => !a.drained).slice(0, limit);
  const drained = [];
  for (const a of open) {
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.PENDING_ACTION_DRAINED,
      data: { actionId: a.actionId, outcome: 'ok', detail: 'drained-by-brief' },
    });
    drained.push(a);
  }
  return drained;
}
