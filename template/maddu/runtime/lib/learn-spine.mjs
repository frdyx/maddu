// learn-spine.mjs — EXP phase 4: the spine as a learn corpus.
//
// `maddu learn` v1 mines runtime TRANSCRIPTS for failed→succeeded tool-call
// pairs. v2 adds the SPINE as a second corpus — deterministic, read-only,
// stdlib-only. This module is the SINGLE SOURCE OF TRUTH for spine pair
// extraction: `maddu learn --spine` wraps these pairs into learn-shaped
// candidates for the existing digest→judge→write pipeline, and `maddu
// evolve`'s detectors consume the SAME extraction (design §7: "learn stays
// independently usable; evolve consumes its output, never the reverse") —
// so a recommendation's evidence ids and a mined candidate's provenance can
// never disagree about what the spine says.
//
// Pairing laws (mirroring evolve's red-teamed phase-3 semantics exactly):
//   • TOOL pAIRS: a TOOL_REFUSED opens a slot for its tool; the NEXT
//     TOOL_COMPLETED of the same tool closes it (spine order, first-match).
//     Session linkage is NOT required (live TOOL_* events carry null
//     sessionId — census); the pair carries whatever linkage exists.
//   • GATE ARCS: per gateId, fails queue; each ok consumes the OLDEST
//     queued fail (fail→ok arc). Unconsumed fails are reported as such.
//   • REVIEW FINDINGS: every SLICE_REVIEWED whose verdict is not CLEAN/INFO
//     is a finding referencing its slice (explicit sliceEventId).
// Candidate ids are content-addressed (the learn candidateId discipline) so
// re-mining never duplicates.

import { createHash } from 'node:crypto';

function argvSummary(d) {
  const argv = Array.isArray(d.argv) ? d.argv.join(' ') : '';
  return `${d.tool || ''} ${argv}`.trim().slice(0, 160);
}

function spineCandidateId(kind, parts) {
  const h = createHash('sha256').update(['spine', kind, ...parts].join('\x00')).digest('hex').slice(0, 16);
  return 'lrn_' + h;
}

// ── raw pair extraction (shared with evolve's detectors) ───────────────────

// TOOL_REFUSED → next TOOL_COMPLETED of the same tool, spine order.
// Returns [{ tool, refusal, completion }] where refusal/completion are the
// RAW events. First-match pairing: a newer refusal of the same tool replaces
// an unconsumed older one (the older had no completion — it stays unpaired).
export function mineToolPairs(events) {
  const pairs = [];
  const openRefusals = new Map(); // tool → event
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || !ev.id) continue;
    const d = ev.data || {};
    if (ev.type === 'TOOL_REFUSED' && d.tool) openRefusals.set(d.tool, ev);
    else if (ev.type === 'TOOL_COMPLETED' && d.tool && openRefusals.has(d.tool)) {
      pairs.push({ tool: d.tool, refusal: openRefusals.get(d.tool), completion: ev });
      openRefusals.delete(d.tool);
    }
  }
  return pairs;
}

// GATE_RAN fail → ok arcs per gateId. Returns { arcs, unresolvedFails }.
export function mineGateArcs(events) {
  const byGate = new Map(); // gateId → { openFails: [ev], arcs: [{fail, ok}] }
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || !ev.id || ev.type !== 'GATE_RAN') continue;
    const d = ev.data || {};
    if (!d.gateId) continue;
    const g = byGate.get(d.gateId) || { openFails: [], arcs: [] };
    // Strict booleans only: the sole framework emitter coerces ok = !!result.ok
    // (gates.mjs), so non-boolean ok exists only on hand-authored events —
    // those are ignored (neither fail nor ok) rather than guessed (red-team F2).
    if (d.ok === false) g.openFails.push(ev);
    else if (d.ok === true && g.openFails.length) g.arcs.push({ fail: g.openFails.shift(), ok: ev });
    byGate.set(d.gateId, g);
  }
  const arcs = [];
  let unresolvedFails = 0;
  const perGate = {};
  for (const [gateId, g] of byGate) {
    for (const a of g.arcs) arcs.push({ gateId, ...a });
    unresolvedFails += g.openFails.length;
    perGate[gateId] = { arcs: g.arcs.length, unresolvedFails: g.openFails.length };
  }
  return { arcs, unresolvedFails, gatesSeen: byGate.size, perGate };
}

// SLICE_REVIEWED with a non-clean verdict → a finding referencing its slice.
export function mineReviewFindings(events) {
  const findings = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || !ev.id || ev.type !== 'SLICE_REVIEWED') continue;
    const d = ev.data || {};
    const verdict = String(d.verdict || '').toUpperCase();
    if (!verdict || verdict === 'CLEAN' || verdict === 'INFO') continue;
    findings.push({ review: ev, verdict, sliceEventId: d.sliceEventId ?? null });
  }
  return findings;
}

// ── learn-shaped candidates (the digest→judge→write pipeline's input) ──────
// Same field names candidatesFromCalls produces, so buildJudgePrompt /
// renderDigest / the judge→write loop consume them unchanged. slug is the
// literal corpus marker '(spine)'; sessionUuid carries the actor when the
// event has one (null otherwise — the judge sees provenance, not a blank).
export function spineCandidates(events) {
  const evs = Array.isArray(events) ? events : [];
  const out = [];
  for (const p of mineToolPairs(evs)) {
    const fd = p.refusal.data || {};
    const sd = p.completion.data || {};
    out.push({
      id: spineCandidateId('tool', [p.tool, argvSummary(fd), argvSummary(sd)]),
      category: 'spine-tool-recovery',
      slug: '(spine)',
      sessionUuid: p.refusal.actor || p.completion.actor || null,
      tool: p.tool,
      failure: argvSummary(fd),
      failureError: [fd.reason, fd.detail].filter(Boolean).join(': ') || null,
      success: argvSummary(sd),
      ts: p.completion.ts || p.refusal.ts || null,
      sourceEvents: [p.refusal.id, p.completion.id],
    });
  }
  const gates = mineGateArcs(evs);
  for (const a of gates.arcs) {
    out.push({
      id: spineCandidateId('gate', [a.gateId, a.fail.id, a.ok.id]),
      category: 'spine-gate-recovery',
      slug: '(spine)',
      sessionUuid: a.fail.actor || a.ok.actor || null,
      tool: `gate:${a.gateId}`,
      failure: `${a.gateId} ${a.fail.data?.status || 'fail'}${a.fail.data?.severity ? ` (${a.fail.data.severity})` : ''}`,
      failureError: null,
      success: `${a.gateId} ${a.ok.data?.status || 'pass'}`,
      ts: a.ok.ts || a.fail.ts || null,
      sourceEvents: [a.fail.id, a.ok.id],
    });
  }
  for (const f of mineReviewFindings(evs)) {
    out.push({
      id: spineCandidateId('review', [f.review.id]),
      category: 'spine-review-finding',
      slug: '(spine)',
      sessionUuid: f.review.actor || null,
      tool: 'review',
      failure: `slice ${f.sliceEventId || '(unknown)'} reviewed ${f.verdict} (${f.review.data?.findingsCount ?? '?'} finding(s))`,
      failureError: null,
      success: '(operator follow-up — see the review artifact)',
      ts: f.review.ts || null,
      sourceEvents: [f.review.id],
    });
  }
  return out;
}
