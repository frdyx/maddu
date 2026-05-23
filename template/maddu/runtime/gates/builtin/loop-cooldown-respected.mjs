// v1.1.0 Phase 6 — between LOOP_ITERATION_COMPLETED (ok=false) and the
// next LOOP_ITERATION_STARTED on the same loopId, the cooldown declared
// at LOOP_STARTED must have elapsed (within 100ms tolerance).

import { readAll, EVENT_TYPES } from '../../lib/spine.mjs';

const TOLERANCE_MS = 200;

export default {
  id: 'loop-cooldown-respected',
  label: 'loop cooldown respected',
  severity: 'warn',
  description: 'Cooldown between failing iterations matches the governance-tier default.',
  run: async (ctx) => {
    const all = await readAll(ctx.repoRoot);
    const byLoop = new Map();
    for (const ev of all) {
      const id = ev.data?.loopId;
      if (!id) continue;
      if (!byLoop.has(id)) byLoop.set(id, []);
      byLoop.get(id).push(ev);
    }
    const violations = [];
    let checked = 0;
    for (const [loopId, events] of byLoop) {
      const started = events.find((e) => e.type === EVENT_TYPES.LOOP_STARTED);
      if (!started) continue;
      const cooldownMs = started.data?.cooldownMs;
      if (!cooldownMs) continue;
      const iters = events.filter((e) => e.type === EVENT_TYPES.LOOP_ITERATION_STARTED || e.type === EVENT_TYPES.LOOP_ITERATION_COMPLETED);
      for (let i = 0; i < iters.length - 1; i++) {
        const cur = iters[i];
        const nxt = iters[i + 1];
        if (cur.type !== EVENT_TYPES.LOOP_ITERATION_COMPLETED || cur.data?.ok) continue;
        if (nxt.type !== EVENT_TYPES.LOOP_ITERATION_STARTED) continue;
        const dt = new Date(nxt.ts).getTime() - new Date(cur.ts).getTime();
        checked += 1;
        if (dt + TOLERANCE_MS < cooldownMs) {
          violations.push({ loopId, between: [cur.id, nxt.id], expectedMs: cooldownMs, actualMs: dt });
        }
      }
    }
    if (checked === 0) return { ok: true, message: 'no failing-iteration cooldowns to check (skipped)' };
    if (violations.length === 0) return { ok: true, message: `${checked} cooldown gap(s), all respect tier default` };
    return {
      ok: false,
      message: `${violations.length}/${checked} cooldown(s) too short`,
      evidence: { violations: violations.slice(0, 5) },
    };
  },
};
