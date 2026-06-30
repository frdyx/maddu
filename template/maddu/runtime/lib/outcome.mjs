// outcome.mjs (roadmap #11) — the prevented-fault counter (CATCHES half).
//
// Everything else in the audit program counts EVENTS (fired/not-fired,
// delivered/pending) or DISPOSITIONS. Nothing measured whether the guardrails
// actually change an OUTCOME. This counts the faults the gates caught: every
// gate run that FAILED is a moment a guardrail blocked something from passing —
// a recorded PREVENTED_FAULT. It is the evidence the whole guardrail edifice
// earns its weight.
//
// `isCatch` is the single source of truth for "this gate run caught a fault",
// shared by the full-spine counter here and the fleet view (which counts over
// the projection's recent gate runs) so the two never diverge.
//
// Pure over plain data: `buildOutcome(events)` for an all-time, single-repo
// tally from the spine; `isCatch(run)` for one gate-run record.

// A gate run that did not pass caught something. `ok === false` is the signal
// both the GATE_RAN event payload and the projection's gate-run records carry.
// A warn-severity gate that fails is a SOFT catch (advisory); anything else is
// a HARD catch (would block a land).
export function isCatch(run) {
  return !!run && run.ok === false;
}
export function isHardCatch(run) {
  return isCatch(run) && run.severity !== 'warn';
}

// Tally prevented faults from a full event list (the spine). Returns
// { total, hard, soft, byGate } where total = hard + soft.
export function buildOutcome(events) {
  const list = Array.isArray(events) ? events : [];
  const byGate = new Map(); // gateId -> { hard, soft }
  let hard = 0, soft = 0;
  for (const ev of list) {
    if (!ev || ev.type !== 'GATE_RAN') continue;
    const d = ev.data || {};
    if (!isCatch(d)) continue;
    const gateId = d.gateId || '(unknown)';
    const slot = byGate.get(gateId) || { hard: 0, soft: 0 };
    if (isHardCatch(d)) { slot.hard++; hard++; } else { slot.soft++; soft++; }
    byGate.set(gateId, slot);
  }
  return {
    total: hard + soft,
    hard,
    soft,
    byGate: Object.fromEntries([...byGate.entries()].sort((a, b) => (b[1].hard + b[1].soft) - (a[1].hard + a[1].soft))),
  };
}

// Count catches in a list of projection gate-run records (the recent, capped
// window) — what the fleet view surfaces per repo without re-reading the spine.
export function countCatches(runs) {
  const list = Array.isArray(runs) ? runs : [];
  let hard = 0, soft = 0;
  for (const r of list) {
    if (!isCatch(r)) continue;
    if (isHardCatch(r)) hard++; else soft++;
  }
  return { total: hard + soft, hard, soft };
}
