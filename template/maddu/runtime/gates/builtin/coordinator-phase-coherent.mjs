// v1.1.0 Phase 7 — every COORDINATOR_PHASE_STARTED has a matching
// COORDINATOR_PHASE_COMPLETED or COORDINATOR_HALTED on the same
// coordinatorId.

import { readAll, EVENT_TYPES } from '../../lib/spine.mjs';

export default {
  id: 'coordinator-phase-coherent',
  label: 'coordinator phase coherent',
  severity: 'safety',
  description: 'Every COORDINATOR_PHASE_STARTED has a matching _PHASE_COMPLETED or _HALTED.',
  run: async (ctx) => {
    const all = await readAll(ctx.repoRoot);
    const started = all.filter((e) => e.type === EVENT_TYPES.COORDINATOR_PHASE_STARTED);
    if (started.length === 0) return { ok: true, message: 'no coordinator phase starts (skipped)' };
    const completedKeys = new Set();
    for (const ev of all) {
      if (ev.type === EVENT_TYPES.COORDINATOR_PHASE_COMPLETED) completedKeys.add(`${ev.data?.coordinatorId}::${ev.data?.phase}`);
      if (ev.type === EVENT_TYPES.COORDINATOR_HALTED && ev.data?.phase) completedKeys.add(`${ev.data?.coordinatorId}::${ev.data?.phase}`);
    }
    // Halted coordinators terminate the whole walk — any phase started under
    // a halted coordinator but not yet completed is still considered closed.
    const haltedCoordinators = new Set(all.filter((e) => e.type === EVENT_TYPES.COORDINATOR_HALTED).map((e) => e.data?.coordinatorId));
    const dangling = [];
    for (const ev of started) {
      const key = `${ev.data?.coordinatorId}::${ev.data?.phase}`;
      if (completedKeys.has(key)) continue;
      if (haltedCoordinators.has(ev.data?.coordinatorId)) continue;
      dangling.push({ coordinatorId: ev.data?.coordinatorId, phase: ev.data?.phase });
    }
    if (dangling.length === 0) return { ok: true, message: `${started.length} phase start(s), all closed` };
    return { ok: false, message: `${dangling.length} dangling coordinator phase(s)`, evidence: { dangling } };
  },
};
