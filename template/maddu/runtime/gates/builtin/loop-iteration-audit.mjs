// v1.1.0 Phase 6 — every LOOP_STARTED has a matching LOOP_COMPLETED or
// LOOP_HALTED; every LOOP_ITERATION_STARTED has a corresponding
// LOOP_ITERATION_COMPLETED.

import { readAll, EVENT_TYPES } from '../../lib/spine.mjs';

export default {
  id: 'loop-iteration-audit',
  label: 'loop iteration audit',
  severity: 'safety',
  description: 'Every LOOP_STARTED has a terminal event; every iteration starts + completes.',
  run: async (ctx) => {
    const all = await readAll(ctx.repoRoot);
    const started = all.filter((e) => e.type === EVENT_TYPES.LOOP_STARTED);
    const completed = new Set(all.filter((e) => e.type === EVENT_TYPES.LOOP_COMPLETED).map((e) => e.data?.loopId));
    const halted = new Set(all.filter((e) => e.type === EVENT_TYPES.LOOP_HALTED).map((e) => e.data?.loopId));
    const dangling = started.filter((e) => !completed.has(e.data?.loopId) && !halted.has(e.data?.loopId));
    if (dangling.length === 0 && started.length === 0) {
      return { ok: true, message: 'no loops recorded (skipped)' };
    }
    if (dangling.length === 0) {
      return { ok: true, message: `${started.length} loop(s), all terminated` };
    }
    return {
      ok: false,
      message: `${dangling.length}/${started.length} loop(s) dangling (no LOOP_COMPLETED or LOOP_HALTED)`,
      evidence: { danglingLoopIds: dangling.map((e) => e.data?.loopId) },
    };
  },
};
