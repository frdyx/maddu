// Slice scope-lock gate — Governance Phase 3.
//
// Honors `MADDU_SLICE_ID` env to identify the in-flight slice. Caller
// (slice-stop) may also pass ctx.touchedPaths + ctx.sliceId + ctx.docOnly
// to short-circuit auto-detection. Out-of-scope edits fail.
// After SLICE_FUNCTIONAL_APPROVED, non-doc edits fail.

const DOC_RE = /^(docs\/|README|CHANGELOG|\.maddu\/state\/|\.maddu\/reviews\/)/i;

function isDocLike(p) {
  return DOC_RE.test(p);
}

function isWithinScope(touched, scope) {
  // A touched path is within scope if it matches exactly one declared
  // path OR is contained under a declared directory prefix.
  for (const s of scope) {
    if (touched === s) return true;
    if (s.endsWith('/') && touched.startsWith(s)) return true;
    if (touched.startsWith(s + '/')) return true;
  }
  return false;
}

export default {
  id: 'slice-scope',
  label: 'slice scope',
  severity: 'critical',
  description: 'Touched files stay within declared slice scope; post-functional edits stay doc-only.',
  run: async (ctx) => {
    const sliceId = ctx.sliceId || process.env.MADDU_SLICE_ID || null;
    const touched = Array.isArray(ctx.touchedPaths) ? ctx.touchedPaths : [];

    // No scope declared, or no slice id: gate is a no-op (opt-in).
    if (!sliceId) return { ok: true, message: 'no slice scope declared (opt-in)' };

    const proj = await ctx.projections.project(ctx.repoRoot);
    const lock = proj.sliceLocks?.[sliceId];
    if (!lock) {
      return {
        ok: true,
        message: `slice ${sliceId} has no scope-declare (opt-in)`,
      };
    }

    if (touched.length === 0) {
      return { ok: true, message: `slice ${sliceId} — no touched paths reported` };
    }

    // Doc-like paths (docs/, README, CHANGELOG, .maddu/state/, .maddu/reviews/)
    // are always permitted: they are out-of-band from the slice's functional
    // surface and represent narration / state-projection / reviewer output.
    const nonDoc = touched.filter((p) => !isDocLike(p));
    const outOfScope = nonDoc.filter((p) => !isWithinScope(p, lock.scope));
    if (outOfScope.length) {
      return {
        ok: false,
        message: `${outOfScope.length} file(s) outside declared scope of ${sliceId}: ${outOfScope.join(', ')}`,
        evidence: { sliceId, outOfScope, declaredScope: lock.scope },
      };
    }

    // Post-functional-approval: only doc-like edits allowed (no functional
    // changes after sign-off).
    if (lock.functionalApproved && nonDoc.length > 0) {
      return {
        ok: false,
        message: `slice ${sliceId} functionally approved — only doc edits allowed; got: ${nonDoc.join(', ')}`,
        evidence: { sliceId, nonDoc, functionallyApprovedAt: lock.functionallyApprovedAt },
      };
    }

    return { ok: true, message: `slice ${sliceId} — ${touched.length} file(s) within scope` };
  },
};
