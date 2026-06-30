// can-read-old-state (roadmap #13, compat spine) — reading an old install is total.
//
// `maddu fleet upgrade` now delivers new framework code into installs as old as
// v1.15. New code that reads a projection shaped by old code can crash on a key
// the old shape never carried — a silent, field-by-field surprise discovered one
// install at a time. This gate holds the invariant that the versioned reader
// (projections.normalizeProjection) turns ANY old/partial/garbage projection into
// a TOTAL current-shape object: every top-level key present and the known nested
// objects deep-defaulted, never a throw.
//
// The fixtures are representative LEGACY shapes (pre-stamp, pre-gates, pre-focus,
// and empty) — synthesized rather than vendored from real installs so no private
// spine content lands in this public repo, while still exercising the old shapes.

import { loadGateLib } from '../../lib/gate-libroot.mjs';

// Top-level keys + the nested objects a reader must be able to touch blindly.
const REQUIRED_TOP = [
  'schemaVersion', 'lastEventId', 'eventCount', 'sessions', 'claims', 'sliceStops',
  'approvals', 'tasks', 'workers', 'goal', 'gates', 'sourceHashes', 'reviews',
  'janitor', 'teams', 'pipelines', 'tokenLedger', 'skillInjections',
];

// Legacy projection shapes a new reader will meet in the field.
const OLD_SHAPES = {
  'empty (brand-new install)': {},
  'pre-stamp legacy (no schemaVersion, no gates/focus)': {
    lastEventId: 'evt_20240101000000_abc', eventCount: 3,
    sessions: [{ id: 'ses_x', status: 'active' }], claims: [],
  },
  'partial gates (gates present but missing summary)': {
    schemaVersion: 0, gates: { runs: [{ gateId: 'a', ok: true }] },
  },
  'garbage / wrong types': { sessions: null, gates: 'nope', approvals: 42 },
};

export default {
  id: 'can-read-old-state',
  label: 'can read old state',
  severity: 'safety',
  description: 'The versioned projection reader normalizes any old/partial projection into a total current-shape object (no missing keys, no throw).',
  run: async (ctx) => {
    const proj = await loadGateLib(ctx.repoRoot, 'projections.mjs');
    if (!proj?.normalizeProjection || !proj?.projectionDefaults) {
      return { ok: true, message: 'compat reader not present (skipped — install predates roadmap #13)' };
    }
    const problems = [];
    for (const [name, raw] of Object.entries(OLD_SHAPES)) {
      let out;
      try { out = proj.normalizeProjection(raw); }
      catch (err) { problems.push(`${name}: threw (${err.message})`); continue; }
      for (const k of REQUIRED_TOP) {
        if (!(k in out)) { problems.push(`${name}: missing top-level "${k}"`); }
      }
      // The nested touch-points a reader dereferences blindly must be safe.
      if (!Array.isArray(out.gates?.runs)) problems.push(`${name}: gates.runs not an array`);
      if (!out.gates?.summary || typeof out.gates.summary.ok !== 'number') problems.push(`${name}: gates.summary.ok not numeric`);
      if (!Array.isArray(out.approvals?.open)) problems.push(`${name}: approvals.open not an array`);
      if (!Array.isArray(out.reviews?.recent)) problems.push(`${name}: reviews.recent not an array`);
      if (out.schemaVersion !== proj.SCHEMA_VERSION) problems.push(`${name}: not stamped to current SCHEMA_VERSION`);
    }
    if (problems.length) {
      return { ok: false, message: `compat reader leaves gaps: ${problems.slice(0, 6).join('; ')}`, evidence: { problems } };
    }
    return { ok: true, message: `${Object.keys(OLD_SHAPES).length} legacy projection shape(s) read total (schema v${proj.SCHEMA_VERSION})` };
  },
};
