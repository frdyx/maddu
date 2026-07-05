// event-schema-complete (roadmap #12b phase 7) — the published-contract parity
// invariant. Máddu publishes an explicit per-event data schema
// (event-schema.mjs → docs/event-schema.{md,json}, semver'd by
// EVENT_CONTRACT_VERSION). This gate holds that registry in 1:1 parity with
// spine.mjs EVENT_TYPES so the contract can never silently drift from the code:
//
//   * a type with NO schema entry FAILs (you cannot add an EVENT_TYPES key
//     without deciding its published contract);
//   * a schema entry for an UNKNOWN type FAILs (drift after a retire);
//   * a malformed entry (no summary, no data spec, or an invalid field type)
//     FAILs.
//
// The complementary half — that docs/event-schema.{md,json} are byte-equal to a
// fresh render of this registry — is proved by `generated-artifacts-current`
// (both are module-backed generators). Together they close the loop: EVENT_TYPES
// ↔ EVENT_SCHEMA ↔ published docs, all three in lockstep.

import { loadGateLib } from '../../lib/gate-libroot.mjs';

export default {
  id: 'event-schema-complete',
  label: 'event schema complete',
  severity: 'safety',
  description: 'Every spine.mjs EVENT_TYPES key carries an explicit, well-formed entry in the published event contract (event-schema.mjs).',
  run: async (ctx) => {
    const spine = await loadGateLib(ctx.repoRoot, 'spine.mjs');
    const sch = await loadGateLib(ctx.repoRoot, 'event-schema.mjs');
    if (!spine?.EVENT_TYPES || !sch?.validateSchema) {
      return { ok: true, message: 'event contract not present (skipped — install predates #12b)' };
    }
    const res = sch.validateSchema(Object.keys(spine.EVENT_TYPES), sch.EVENT_SCHEMA);
    if (res.ok) {
      const n = Object.keys(sch.EVENT_SCHEMA).length;
      return { ok: true, message: `contract v${sch.EVENT_CONTRACT_VERSION}: ${n} event type(s) all schematized` };
    }
    const parts = [];
    if (res.missing.length) parts.push(`${res.missing.length} type(s) with NO schema — add to event-schema.mjs: ${res.missing.slice(0, 8).join(', ')}`);
    if (res.extra.length) parts.push(`${res.extra.length} schema(s) for unknown type(s) — retired? remove: ${res.extra.slice(0, 8).join(', ')}`);
    if (res.badShape.length) parts.push(`${res.badShape.length} malformed entr(ies): ${res.badShape.slice(0, 6).join('; ')}`);
    return { ok: false, message: parts.join('; '), evidence: res };
  },
};
