// v1.19.0 — verifies every single-sourced artifact is current: its generated
// target is byte-equal to a fresh render from its authored source. This is the
// generated-artifact discipline's enforcement: drift between a source and its
// derived copy fails here instead of silently shipping. As the rule registry
// and doc tree move behind generators, this gate SUPERSEDES the hand-mirroring
// drift gates (docs-in-sync, rule-invariant) — they get retired once their
// content is generated. Skips cleanly when authored sources are absent (a
// consumer install never carries them).

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
      return {
        ok: false,
        message: `${drifted.length} generated artifact(s) out of date — run \`node scripts/generate.mjs\``,
        evidence: { drifted: drifted.map((d) => ({ id: d.id, target: d.target })) },
      };
    }
    const all = await lib.runGenerators(ctx.repoRoot, { mode: 'check' });
    const live = all.filter((r) => !r.skipped);
    if (!live.length) return { ok: true, message: 'no authored sources present (skipped)' };
    return { ok: true, message: `${live.length} generated artifact(s) current` };
  },
};
