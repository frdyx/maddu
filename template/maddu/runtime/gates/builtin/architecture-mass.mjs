// v1.23.0 — structural-mass ratchet. The import-graph gate (architecture-drift)
// is blind to file MASS: a 9000-line file is one node. This gate enforces the
// monolith ratchet — with options.mass.failOn:"new", a NEW file over the
// threshold or a baselined monolith that GREW fails, so monoliths may only
// shrink. Skips cleanly when there's no contract or no mass config.

import { loadGateLib } from '../../lib/gate-libroot.mjs';

export default {
  id: 'architecture-mass',
  label: 'architecture mass',
  severity: 'safety',
  description: 'No new or grown monolith (file over the mass threshold); the ratchet only allows monoliths to shrink.',
  run: async (ctx) => {
    const arch = await loadGateLib(ctx.repoRoot, 'architecture.mjs');
    if (!arch || !arch.scanMass) return { ok: true, message: 'architecture lib not present (skipped)' };
    let contract = null;
    try { ({ contract } = await arch.loadContract(ctx.repoRoot)); }
    catch { return { ok: true, message: 'invalid architecture contract (skipped)' }; }
    if (!contract) return { ok: true, message: 'no architecture contract (skipped)' };
    const mopts = arch.massOptions(contract);
    if (mopts.failOn === 'none') return { ok: true, message: 'mass ratchet not enforced (options.mass.failOn:none)' };
    const scan = await arch.scanMass(ctx.repoRoot, { maxLines: mopts.maxLines, ignore: mopts.ignore });
    const baseline = await arch.loadMassBaseline(ctx.repoRoot);
    const ev = arch.evaluateMass(scan, baseline, mopts.failOn);
    if (ev.blocking) {
      const bits = [];
      if (ev.fresh.length) bits.push(`${ev.fresh.length} new: ${ev.fresh.map((f) => `${f.path} (${f.lines})`).join(', ')}`);
      if (ev.grown.length) bits.push(`${ev.grown.length} grown: ${ev.grown.map((f) => `${f.path} (${f.lines})`).join(', ')}`);
      return {
        ok: false,
        message: `monolith ratchet (> ${scan.maxLines} lines): ${bits.join('; ')} — split it, or re-baseline with \`maddu architecture mass --baseline\``,
        evidence: { fresh: ev.fresh, grown: ev.grown },
      };
    }
    return { ok: true, message: `${scan.oversize.length} baselined monolith(s), 0 new/grown — ${scan.totals.files} code file(s), threshold ${scan.maxLines}` };
  },
};
