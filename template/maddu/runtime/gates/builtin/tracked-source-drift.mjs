// Tracked-source drift — verdict-machinery drift detection.
//
// Operator declares a pin set in .maddu/config/tracked-sources.json (literals
// and/or globs). `maddu sources rebuild --reason "…"` snapshots their hashes
// onto the spine as SOURCE_HASH_RECOMPUTED. This gate compares the current tree
// to that snapshot. It watches the machinery that PRODUCES verdicts (gates,
// verifier libs, CI profile) for stable-harness/config drift — it is NOT an
// "oracle integrity" proof: test BODIES are not pinned by default, and the
// actor who can edit these files can re-pin them.
//
// WHAT THIS IS FOR
// The artifacts that decide pass/fail — tests, gate definitions, the CI profile,
// the verifier itself — are ordinary files an agent can edit. This gate does not
// PREVENT that; it makes it impossible to do silently. Re-pinning is allowed but
// must be an explicit, reasoned, spine-recorded act.
//
// HONEST LIMITS (see docs/34-threat-model.md):
//   - An actor may re-baseline via `sources rebuild --reason` and this gate goes
//     green again. It is bounded by VISIBILITY, not by construction.
//   - `.maddu/*` is gitignored, so operator gates under `.maddu/gates/` never
//     reach a PR diff or a CI checkout. The `unpinned` class below is the only
//     thing that sees them, and only on the machine where they were written.
//
// Hashing and glob expansion are delegated to lib/content-pins.mjs so this gate,
// `maddu sources`, and the install manifest can never disagree about what a
// file's hash is.

import {
  computeDrift,
  expandPins,
  pinPatterns,
  readPinConfig,
} from '../../lib/content-pins.mjs';

const REASON_LABEL = {
  missing: 'missing',
  unpinned: 'unpinned (new file matching a pinned pattern)',
  changed: 'changed',
  removed: 'removed from the pin set',
};

export default {
  id: 'tracked-source-drift',
  label: 'tracked source drift',
  // `warn`, deliberately not `critical`: this is a cooperative drift SIGNAL,
  // not a trust boundary. An actor who can edit the pinned files can re-pin
  // them too, so `critical` would falsely lend it trust-boundary weight
  // (Codex review, 2026-07-20). Note `maddu ci pin` only accepts fail-capable
  // gates, so a warn gate cannot be promoted to required; an operator who
  // wants a blocking variant must shadow it with a fail-capable operator gate
  // under `.maddu/gates/` — a local-only mechanism with its own caveats (see
  // docs/34-threat-model.md §12).
  severity: 'warn',
  description: 'Pinned verdict-machinery files unchanged since the last `maddu sources rebuild`.',
  run: async (ctx) => {
    const config = await readPinConfig(ctx.repoRoot);
    const patterns = pinPatterns(config);
    if (!patterns.length) {
      // Not ok:true — "nothing is pinned" must stay visibly distinct from
      // "pinned and clean". An empty config greening over nothing is the same
      // failure mode as a gate scanning zero files and reporting success.
      return {
        ok: false,
        message: 'nothing pinned — no tracked sources configured (declare pins in .maddu/config/tracked-sources.json)',
      };
    }

    const declared = await expandPins(ctx.repoRoot, patterns);

    // A pattern set that resolves to nothing is a silent no-op — the same
    // failure mode as rule-5 scanning a nonexistent directory and reporting
    // green over zero files. Treat it as a misconfiguration, not a pass.
    if (!declared.length) {
      return {
        ok: false,
        message: `pin set declares ${patterns.length} pattern(s) but matched 0 files — misconfigured`,
        evidence: { patterns },
      };
    }

    const proj = await ctx.projections.project(ctx.repoRoot);
    const recorded = proj.sourceHashes?.paths || {};
    if (!Object.keys(recorded).length) {
      return {
        ok: false,
        message: `${declared.length} file(s) declared but nothing pinned yet — run \`maddu sources rebuild --reason "…"\``,
        evidence: { declared: declared.length },
      };
    }

    const drifted = await computeDrift(ctx.repoRoot, declared, recorded);
    if (drifted.length === 0) {
      return { ok: true, message: `${declared.length} pinned file(s) clean` };
    }

    const byReason = drifted.reduce((m, d) => { m[d.reason] = (m[d.reason] || 0) + 1; return m; }, {});
    const summary = Object.entries(byReason)
      .map(([r, n]) => `${n} ${REASON_LABEL[r] || r}`)
      .join(' · ');

    return {
      ok: false,
      message: `${drifted.length} pinned file(s) drifted — ${summary}`,
      evidence: { drifted: drifted.slice(0, 40), totalDrifted: drifted.length },
    };
  },
};
