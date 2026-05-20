// Pending-actions queue — Governance Phase 4.
//
// Auto-triggered read-only actions (review-prompts, drift-checks, brief
// refreshes) are NOT executed in-band. They land in the spine as
// PENDING_ACTION_ENQUEUED and surface to the next live agent via
// `maddu brief --drain`. The agent decides whether to act; draining
// emits PENDING_ACTION_DRAINED with an outcome.

import { randomBytes } from 'node:crypto';

function genActionId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `act_${ts}_${r}`;
}

export async function enqueue(spine, repoRoot, { kind, payload = {}, triggered_by = null } = {}) {
  const actionId = genActionId();
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
