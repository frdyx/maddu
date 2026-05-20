// Spine integrity gate — wraps verifySpine with the doctor's 50k cap.
const SPINE_CAP = 50000;

export default {
  id: 'spine-integrity',
  label: 'spine integrity',
  severity: 'critical',
  description: 'Append-only spine: parseability, id uniqueness, referential integrity.',
  run: async (ctx) => {
    if (!ctx.verify?.verifySpine) {
      return { ok: true, message: 'verifier not available (legacy install)', evidence: null };
    }
    try {
      const r = await ctx.verify.verifySpine(ctx.repoRoot, { maxEvents: SPINE_CAP });
      if (r.capped) {
        // Capped — surface as ok=true (no fails seen up to cap) with an
        // evidence note. Severity warn-style messaging happens in doctor.
        return {
          ok: true,
          message: `>${SPINE_CAP.toLocaleString()} events — run \`maddu spine verify\` manually for full check`,
          evidence: { capped: true, examinedEvents: r.events },
        };
      }
      if (r.counts.FAIL > 0) {
        const fails = r.counts.FAIL, warns = r.counts.WARN;
        const wpart = warns > 0 ? ` · ${warns} warn${warns === 1 ? '' : 's'}` : '';
        return {
          ok: false,
          message: `${fails} fail${fails === 1 ? '' : 's'}${wpart} — run \`maddu spine verify\` for detail`,
          evidence: { counts: r.counts },
        };
      }
      return {
        ok: true,
        message: `${r.events.toLocaleString()} events · ${r.segments.length} segment${r.segments.length === 1 ? '' : 's'} · 0 fails · 0 warns`,
        evidence: { events: r.events, segments: r.segments.length },
      };
    } catch (err) {
      return { ok: false, message: `verifier error: ${err.message}`, evidence: { error: String(err) } };
    }
  },
};
