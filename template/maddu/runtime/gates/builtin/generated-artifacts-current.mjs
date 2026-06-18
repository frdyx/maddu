// v1.19.0 — verifies every single-sourced artifact is current: its generated
// target is byte-equal to a fresh render from its authored source, and no
// payload file is an orphan (a target with no source). This is the
// generated-artifact discipline's enforcement: drift between a source and its
// derived copy fails here instead of silently shipping. With the rule registry
// and doc tree now behind generators, this gate SUPERSEDED and RETIRED the
// hand-mirror docs-in-sync gate (v1.22.0) — it covers both byte-equality
// (stronger than the old LF-normalized compare) and orphan detection. Skips
// cleanly when authored sources are absent (a consumer install never carries
// them).

import { loadGateLib } from '../../lib/gate-libroot.mjs';

export default {
  id: 'generated-artifacts-current',
  label: 'generated artifacts current',
  severity: 'safety',
  description: 'Every generated artifact is byte-equal to a fresh render of its authored source (run `node scripts/generate.mjs`).',
  run: async (ctx) => {
    const lib = await loadGateLib(ctx.repoRoot, 'generate.mjs');
    if (!lib || !lib.checkGenerators) return { ok: true, message: 'generation engine not present (skipped)' };
    const drifted = await lib.checkGenerators(ctx.repoRoot);
    if (drifted.length) {
      const orphans = drifted.filter((d) => d.orphan);
      const stale = drifted.filter((d) => !d.orphan);
      const parts = [];
      if (stale.length) parts.push(`${stale.length} out of date — run \`node scripts/generate.mjs\``);
      if (orphans.length) parts.push(`${orphans.length} orphan(s) with no source — remove or add the source: ${orphans.map((o) => o.target).join(', ')}`);
      return {
        ok: false,
        message: `generated artifacts: ${parts.join('; ')}`,
        evidence: { drifted: drifted.map((d) => ({ id: d.id, target: d.target, orphan: !!d.orphan })) },
      };
    }
    const all = await lib.runGenerators(ctx.repoRoot, { mode: 'check' });
    const live = all.filter((r) => !r.skipped);
    if (!live.length) return { ok: true, message: 'no authored sources present (skipped)' };
    return { ok: true, message: `${live.length} generated artifact(s) current` };
  },
};
