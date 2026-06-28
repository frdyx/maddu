// focus-ledger-coherent — the Focus Director projection stays well-formed.
//
// Validates the focus{} slot rebuilt from FOCUS_TAGGED / DRIFT_FLAGGED: every
// window tag is a valid direction (toward/lateral/away), the window respects its
// cap (12), lastTag agrees with the window tail, and an open flag carries a
// non-empty menu + reason. Advisory (warn): a malformed focus slot signals an
// emitter/projector bug, not an operator-safety issue — and the director is
// opt-in, so most repos have no focus activity at all (clean skip).

export default {
  id: 'focus-ledger-coherent',
  label: 'focus ledger coherent',
  severity: 'warn',
  description: 'The focus{} projection slot is well-formed (valid tags, window cap, open-flag shape).',
  run: async (ctx) => {
    let proj;
    try { proj = await ctx.project(ctx.repoRoot); }
    catch (err) { return { ok: true, message: `projection unavailable (skipped): ${err.message}` }; }

    const f = proj && proj.focus;
    const window = Array.isArray(f && f.window) ? f.window : [];
    if (!f || (!window.length && !f.openFlag && !f.lastTag)) {
      return { ok: true, message: 'no focus activity (opt-in director off, or unused) — skipped' };
    }

    const VALID = new Set(['toward', 'lateral', 'away']);
    const CAP = 12;
    const problems = [];

    if (window.length > CAP) problems.push(`window length ${window.length} exceeds cap ${CAP}`);
    const badTags = window.filter((w) => !w || !VALID.has(w.tag)).length;
    if (badTags) problems.push(`${badTags} window entr(ies) with an invalid tag`);
    if (f.lastTag && !VALID.has(f.lastTag)) problems.push(`lastTag "${f.lastTag}" is not a valid direction`);
    if (window.length && f.lastTag && window[window.length - 1].tag !== f.lastTag) {
      problems.push(`lastTag "${f.lastTag}" disagrees with window tail "${window[window.length - 1].tag}"`);
    }
    if (f.openFlag) {
      if (!Array.isArray(f.openFlag.menu) || !f.openFlag.menu.length) problems.push('open flag has no menu');
      if (!f.openFlag.reason) problems.push('open flag has no reason');
    }

    if (problems.length === 0) {
      return { ok: true, message: `focus slot coherent (${window.length} tag(s)${f.openFlag ? ', 1 open flag' : ''})` };
    }
    return { ok: false, message: `focus ledger drift — ${problems.length} issue(s)`, evidence: { problems } };
  },
};
