// event-dispositions-complete (DD1, roadmap #3, F3) — the no-undisposed-type
// invariant.
//
// F3: 34 event types accumulated as "dead" because nothing forced a verdict
// when a type was defined. This gate holds the definition-site disposition
// registry (event-dispositions.mjs) in 1:1 parity with spine.mjs EVENT_TYPES:
//
//   * a type with NO disposition FAILs (you cannot add an EVENT_TYPES key
//     without deciding active / dormant / plugin — the recurrence-prevention);
//   * a disposition for an UNKNOWN type FAILs (drift after a retire);
//   * an invalid disp kind, or a non-active entry with no reason, FAILs.
//
// Because DORMANT_BY_DESIGN is derived from this registry, an accepted-dormant
// type can never silently re-read as "dead" in `maddu insights` again.

import { loadGateLib } from '../../lib/gate-libroot.mjs';

export default {
  id: 'event-dispositions-complete',
  label: 'event dispositions complete',
  severity: 'safety',
  description: 'Every spine.mjs EVENT_TYPES key carries a definition-site disposition (active/dormant/plugin) with a reason where required.',
  run: async (ctx) => {
    const spine = await loadGateLib(ctx.repoRoot, 'spine.mjs');
    const disp = await loadGateLib(ctx.repoRoot, 'event-dispositions.mjs');
    if (!spine?.EVENT_TYPES || !disp?.validateDispositions) {
      return { ok: true, message: 'disposition registry not present (skipped — install predates DD1)' };
    }
    const res = disp.validateDispositions(Object.keys(spine.EVENT_TYPES), disp.EVENT_DISPOSITIONS);
    if (res.ok) {
      const n = Object.keys(disp.EVENT_DISPOSITIONS).length;
      return { ok: true, message: `${n} event type(s) all dispositioned` };
    }
    const parts = [];
    if (res.missing.length) parts.push(`${res.missing.length} type(s) with NO disposition — add to event-dispositions.mjs: ${res.missing.slice(0, 8).join(', ')}`);
    if (res.extra.length) parts.push(`${res.extra.length} disposition(s) for unknown type(s) — retired? remove: ${res.extra.slice(0, 8).join(', ')}`);
    if (res.badKind.length) parts.push(`${res.badKind.length} invalid disp kind(s): ${res.badKind.slice(0, 8).join(', ')}`);
    if (res.noReason.length) parts.push(`${res.noReason.length} non-active disposition(s) missing a reason: ${res.noReason.slice(0, 8).join(', ')}`);
    return { ok: false, message: parts.join('; '), evidence: res };
  },
};
