// v1.10.0 invocation-logic pass 2 — auto-set the curated handoff at slice-stop.
//
// HANDOFF_SET was dead by *flow*: `maddu orient` reads the curated "▶ RESUME
// HERE" handoff, but nothing ever wrote one (only manual `maddu handoff set`),
// so orient was blank in every project. This wires the missing WHEN: after each
// slice-stop, derive a resume narrative from the slice (summary + next steps)
// and append HANDOFF_SET. Latest-wins, so every slice refreshes resume context;
// a manual `maddu handoff set` still overrides until the next slice.
//
// Rule-#9 gauntlet: only fires when `slice-stop:auto-handoff` is in the
// .maddu/config/triggers.json allowlist; emits TRIGGER_FIRED first, then
// HANDOFF_SET, both carrying `triggered_by` provenance. Best-effort — never
// breaks the slice-stop. No cooldown: the handoff is a latest-wins projection,
// so refreshing it on every slice is the whole point.

import { append, EVENT_TYPES } from './spine.mjs';

// Build the "▶ RESUME HERE" body from a SLICE_STOP event's data.
export function buildHandoffBody(ev) {
  const d = ev.data || {};
  const lines = [`▶ RESUME HERE  (auto · slice ${ev.id})`];
  lines.push(`Last: ${(d.summary || '—').replace(/\s+/g, ' ').trim()}`);
  const next = Array.isArray(d.next) ? d.next.filter(Boolean) : [];
  if (next.length) {
    lines.push('Next:');
    for (const n of next) lines.push(`- ${String(n).replace(/\s+/g, ' ').trim()}`);
  } else {
    lines.push('Next: (none recorded — pick the next slice)');
  }
  if (d.reason) lines.push(`Why: ${String(d.reason).replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n');
}

// Append TRIGGER_FIRED + HANDOFF_SET from a freshly-appended slice-stop event.
// Returns { ran: true } (or { skipped } on a malformed event).
export async function maybeSetHandoff(repoRoot, ev, sessionId = null, triggeredBy = null) {
  if (!ev || ev.type !== 'SLICE_STOP') return { skipped: 'not-a-slice-stop' };
  const fired_at = new Date().toISOString();
  const provenance = triggeredBy || { kind: 'slice-stop', id: 'auto-handoff', fired_at };
  const body = buildHandoffBody(ev);

  // TRIGGER_FIRED first — the rule-#9 provenance anchor.
  await append(repoRoot, {
    type: EVENT_TYPES.TRIGGER_FIRED,
    actor: sessionId,
    data: { triggerId: 'slice-stop:auto-handoff', reason: 'slice-stopped', sliceEventId: ev.id, triggered_by: provenance },
  });

  await append(repoRoot, {
    type: EVENT_TYPES.HANDOFF_SET,
    actor: sessionId,
    data: { body, by: sessionId, auto: true, sliceEventId: ev.id, triggered_by: provenance },
  });

  return { ran: true };
}
