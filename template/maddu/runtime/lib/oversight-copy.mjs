// oversight-copy.mjs — the reason→plain-English map for the Oversight surface.
//
// This is the whole UX of the non-coder oversight readout: a non-expert can't
// inspect a skill's code, but they can be told, in plain language, what Máddu
// WITHHELD and why. Single source of truth so the bridge, the CLI, and the
// product mock all render identical copy.
//
// Pure + deterministic: no IO, no wall-clock. The map keys on a SINGLE reason
// code (the per-item `refused[].reason`), never the comma-joined batch `reason`
// on the event envelope — feeding it the batch string would miss every key.

// Known inject-time refusal reason codes (commands/brief.mjs) → operator copy.
export const REASON_COPY = Object.freeze({
  'unacknowledged-external-refs': 'blocked — points off-box to an unreviewed link',
  'untrusted-provenance': 'blocked — from a source you hadn’t trusted',
});

// The reassuring empty state — a fresh repo has withheld nothing, and that is
// itself a signal, not an error.
export const EMPTY_STATE = '0 withheld — nothing blocked yet';

// Map one single reason code to plain language. Unknown codes degrade
// gracefully to a neutral, honest sentence — never `undefined`, so a reason
// code added in a future release still renders something legible.
export function plainReason(code) {
  if (typeof code !== 'string' || code === '') return 'blocked';
  return REASON_COPY[code] || `blocked — ${code}`;
}

// Map a refusal's per-item `refused[]` array to plain-language rows. Each item
// keeps its raw fields and gains a `plain` string. Safe on missing/empty input.
export function plainRefused(refused) {
  if (!Array.isArray(refused)) return [];
  return refused.map((r) => ({
    id: r?.id || null,
    provenance: r?.provenance || null,
    reason: r?.reason || null,
    plain: plainReason(r?.reason),
  }));
}
