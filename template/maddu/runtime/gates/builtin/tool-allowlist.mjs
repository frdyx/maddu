// v1.1.0 Phase 1 — verifies every TOOL_REFUSED event on the spine carries
// a structured `reason` and `detail`. Gate runs in WARN severity because
// absence of refusals is a normal state.

import { readAll, EVENT_TYPES } from '../../lib/spine.mjs';

const VALID_REASONS = new Set([
  'allowlist-deny',
  'allowlist-not-allowed',
  'dangerous-form',
  'no-detector',
  // v1.2.0 Phase 3 — refusal when argv matches a known-secret pattern.
  'secret-detected',
]);

export default {
  id: 'tool-allowlist',
  label: 'tool allowlist coherent',
  severity: 'warn',
  description: 'Every TOOL_REFUSED carries a reason from the known set.',
  run: async (ctx) => {
    let events;
    try { events = await readAll(ctx.repoRoot); }
    catch { return { ok: true, message: 'no spine — skipped' }; }

    const refused = events.filter((e) => e.type === EVENT_TYPES.TOOL_REFUSED);
    if (refused.length === 0) {
      return { ok: true, message: 'no tool refusals on the spine' };
    }
    const malformed = [];
    for (const ev of refused) {
      const r = ev?.data?.reason;
      const d = ev?.data?.detail;
      if (!r || !VALID_REASONS.has(r) || !d) malformed.push({ id: ev.id, reason: r || null });
    }
    if (malformed.length === 0) {
      return { ok: true, message: `${refused.length} tool refusal(s) — all carry valid reason + detail` };
    }
    return {
      ok: false,
      message: `${malformed.length}/${refused.length} TOOL_REFUSED event(s) malformed (missing reason or detail)`,
      evidence: { malformed: malformed.slice(0, 10), totalRefused: refused.length },
    };
  },
};
