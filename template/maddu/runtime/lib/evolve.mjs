// evolve.mjs — EXP phase 3: the recommend-only evolution planner.
//
// PURE detector engine over the experience projection + the raw spine
// (design: docs/research/exp-experience-protocol-design.md §6):
//   planEvolution(events) → { recommendations, noOp, scanned }
//
// Laws:
//   • Recommend, NEVER apply. This module computes; the ONLY write path is
//     the explicit operator verb `maddu evolve adopt` (commands/evolve.mjs),
//     which routes through EXISTING emit paths — mirroring the earned-
//     autonomy precedent (compute + recommend, never apply).
//   • Deterministic: no clock, no randomness. Recommendation ids are
//     CONTENT-ADDRESSED — sha256(detector + sorted evidence event ids) — so
//     re-running the planner on the same spine yields the same ids and an
//     `adopt <rec-id>` reference stays stable. There is NO recommendation
//     store; `plan` re-derives (nothing to rot).
//   • Evidence thresholds (design §6): a non-no-op recommendation requires
//     ≥ MIN_OCCURRENCES independent occurrences across ≥ MIN_SCOPES distinct
//     trajectories (or lanes, for lane-scoped patterns). Confidence is the
//     Wilson lower bound over supporting-vs-contradicting occurrences —
//     wilsonLower reused VERBATIM from autonomy.mjs, no private tuning.
//   • No-op honesty: when nothing clears a threshold the output IS the no-op
//     recommendation, stating what was scanned and why nothing cleared —
//     never manufacture findings from a corpus that doesn't contain them
//     (reflect-sensor v1 lesson). On this repo's current spine the honest
//     first output IS a no-op (predicted by the phase-0 census).
//   • Prior-art dedup: recommendations that duplicate an existing learn
//     correction (matched by CONTENT against the live emit-site fields
//     data.fact.text / data.correction.text — the contract lacks these two
//     fields, a flagged additive-PATCH candidate) are suppressed, not
//     re-recommended.

import { createHash } from 'node:crypto';
import { wilsonLower } from './autonomy.mjs';
import { deriveExperience } from './experience.mjs';

export const MIN_OCCURRENCES = 3;
export const MIN_SCOPES = 2;

export const CATEGORIES = ['memory', 'skill', 'agent-file', 'gate', 'workflow', 'tool-pattern', 'no-op'];
// NOTE: no v1 detector emits category 'agent-file' — the agent-file
// DESTINATION is reached via `evolve adopt --to agent-file` on a
// correction-class (memory) rec; the category stays declared for the
// design's full taxonomy and future detectors.

function recIdFor(detector, evidenceIds) {
  const h = createHash('sha256').update([detector, ...[...evidenceIds].sort()].join('\x00')).digest('hex').slice(0, 12);
  return `rec_${h}`;
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Existing learn corrections, by normalized content — the prior-art set.
function priorArt(events) {
  const texts = new Set();
  for (const ev of events) {
    if (!ev || ev.type !== 'LEARN_CORRECTION_WRITTEN') continue;
    const d = ev.data || {};
    const t = d.fact?.text ?? d.correction?.text ?? null;
    if (t) texts.add(normText(t));
  }
  return texts;
}

// Occurrence scope: the trajectory if session-linked, else the lane, else null
// (null scopes never satisfy the ≥ MIN_SCOPES requirement on their own).
function scopeOf(step) {
  if (step.trajectoryId && step.trajectoryId !== 'env') return `traj:${step.trajectoryId}`;
  if (step.lane) return `lane:${step.lane}`;
  return null;
}

function meetsThreshold(occurrences) {
  if (occurrences.length < MIN_OCCURRENCES) return false;
  const scopes = new Set(occurrences.map((o) => o.scope).filter(Boolean));
  return scopes.size >= MIN_SCOPES;
}

function makeRec({ detector, category, summary, evidence, supporting, contradicting, draft, why }) {
  return {
    recId: recIdFor(detector, evidence),
    detector,
    category,
    summary,
    evidence: [...evidence].sort(),
    confidence: Math.round(wilsonLower(supporting, supporting + contradicting) * 10000) / 10000,
    draft,
    why,
  };
}

// ── detectors — each returns { candidates: rec[], scanned: {...} } ─────────

// D1: TOOL_REFUSED → later TOOL_COMPLETED for the same tool (spine order).
// A repeated refusal that the agent then works around is a correction
// candidate (memory / agent-file). Pairing is by tool in spine order — NOT by
// session (census: sessionId is null on every live TOOL_* event). HONESTY
// NOTE: because live TOOL_* events carry null session AND null lane, their
// occurrence scope is null and the >=2-scopes threshold makes this detector
// UNREACHABLE on today's real spines — by design it stays dormant until the
// tool wrappers attach a session/lane scope, rather than firing on evidence
// whose independence cannot be established.
function detectToolCorrections(steps) {
  const pairs = [];
  const openRefusals = new Map(); // tool → refusal step
  for (const s of steps) {
    if (s.kind !== 'tool' || !s.action?.tool) continue;
    if (s.meta.type === 'TOOL_REFUSED') openRefusals.set(s.action.tool, s);
    else if (s.meta.type === 'TOOL_COMPLETED' && openRefusals.has(s.action.tool)) {
      const ref = openRefusals.get(s.action.tool);
      pairs.push({ tool: s.action.tool, refusal: ref, completion: s, scope: scopeOf(ref) || scopeOf(s) });
      openRefusals.delete(s.action.tool);
    }
  }
  const byTool = new Map();
  for (const p of pairs) {
    const list = byTool.get(p.tool) || [];
    list.push(p);
    byTool.set(p.tool, list);
  }
  const candidates = [];
  for (const [tool, list] of byTool) {
    if (!meetsThreshold(list.map((p) => ({ scope: p.scope })))) continue;
    const evidence = list.flatMap((p) => [p.refusal.stepId, p.completion.stepId]);
    candidates.push(makeRec({
      detector: 'tool-correction',
      category: 'memory',
      summary: `\`${tool}\` was refused then completed ${list.length}× — a recurring workaround worth recording as a correction`,
      evidence,
      supporting: list.length,
      contradicting: 0,
      draft: `When \`${tool}\` is refused, the recorded history shows the invocation succeeds after adjustment — capture the exact adjustment as a project correction (see the paired refusal/completion events for the concrete argv delta).`,
      why: `${list.length} refusal→completion pair(s) for \`${tool}\` across ${new Set(list.map((p) => p.scope).filter(Boolean)).size} scope(s); the pattern repeats, so the workaround belongs in durable memory rather than being rediscovered.`,
    }));
  }
  return { candidates, scanned: { refusalCompletionPairs: pairs.length, toolsWithPairs: byTool.size } };
}

// D2: GATE_RAN fail → later ok for the same gateId (workflow candidate).
function detectGateFlaps(steps) {
  const byGate = new Map(); // gateId → { fails: [step], flaps: [{fail, ok}] }
  for (const s of steps) {
    if (s.meta.type !== 'GATE_RAN' || !s.observation?.summary) continue;
    const gateId = s.observation.summary;
    const g = byGate.get(gateId) || { openFails: [], flaps: [], fails: 0 };
    if (s.outcome?.ok === false) { g.openFails.push(s); g.fails++; }
    else if (s.outcome?.ok === true && g.openFails.length) {
      g.flaps.push({ fail: g.openFails.shift(), ok: s });
    }
    byGate.set(gateId, g);
  }
  const candidates = [];
  let flapTotal = 0;
  for (const [gateId, g] of byGate) {
    flapTotal += g.flaps.length;
    const occ = g.flaps.map((f) => ({ scope: scopeOf(f.fail) || scopeOf(f.ok) }));
    if (!meetsThreshold(occ)) continue;
    const evidence = g.flaps.flatMap((f) => [f.fail.stepId, f.ok.stepId]);
    candidates.push(makeRec({
      detector: 'gate-flap',
      category: 'workflow',
      summary: `gate \`${gateId}\` failed then passed ${g.flaps.length}× — the failure is being fixed reactively each time`,
      evidence,
      supporting: g.flaps.length,
      contradicting: g.openFails.length,
      draft: `Add the check behind \`${gateId}\` to the pre-slice-stop routine (or a pre-commit step) so it is satisfied BEFORE the gate runs instead of after it fails.`,
      why: `${g.flaps.length} fail→ok arc(s) on \`${gateId}\`; recurring reactive fixes indicate a missing habitual step in the workflow.`,
    }));
  }
  return { candidates, scanned: { gatesSeen: byGate.size, failOkArcs: flapTotal } };
}

// D3: the same learning recurring across sessions (skill candidate).
// v1 recurrence is exact-normalized-string equality — deterministic; n-gram
// fuzz would trade determinism for recall and is deliberately not done.
function detectRecurringLearnings(steps) {
  const byText = new Map(); // norm → { text, occ: [{stepId, scope}] }
  for (const s of steps) {
    if (s.kind !== 'slice-stop' || !Array.isArray(s.observation?.learnings)) continue;
    for (const raw of s.observation.learnings) {
      const norm = normText(raw);
      if (norm.length < 12) continue; // too short to be a reusable lesson
      const e = byText.get(norm) || { text: String(raw), occ: [] };
      e.occ.push({ stepId: s.stepId, scope: scopeOf(s) });
      byText.set(norm, e);
    }
  }
  const candidates = [];
  let recurring = 0;
  for (const e of byText.values()) {
    if (e.occ.length < 2) continue;
    recurring++;
    if (!meetsThreshold(e.occ)) continue;
    candidates.push(makeRec({
      detector: 'recurring-learning',
      category: 'skill',
      summary: `the same learning recurs ${e.occ.length}× across sessions: "${e.text.slice(0, 80)}"`,
      evidence: e.occ.map((o) => o.stepId),
      supporting: e.occ.length,
      contradicting: 0,
      draft: `# ${e.text.slice(0, 60)}\n\nwhen: (derive from the recurring context)\n\n${e.text}\n\n(Provenance: recurs across ${e.occ.length} slice-stops — see evidence event ids.)`,
      why: `A lesson relearned ${e.occ.length}× is a skill candidate — the repetition itself is the evidence it isn't sticking as tacit knowledge.`,
    }));
  }
  return { candidates, scanned: { distinctLearnings: byText.size, recurringLearnings: recurring } };
}

// D4: a gate failing repeatedly with NO correction on record (gate/tool-pattern).
function detectUncorrectedGates(steps, prior) {
  const byGate = new Map();
  for (const s of steps) {
    if (s.meta.type !== 'GATE_RAN' || s.outcome?.ok !== false || !s.observation?.summary) continue;
    const g = byGate.get(s.observation.summary) || [];
    g.push({ stepId: s.stepId, scope: scopeOf(s) });
    byGate.set(s.observation.summary, g);
  }
  const candidates = [];
  for (const [gateId, occ] of byGate) {
    if (!meetsThreshold(occ)) continue;
    // Prior-art: any existing correction mentioning the gate id suppresses.
    let corrected = false;
    for (const t of prior) { if (t.includes(gateId.toLowerCase())) { corrected = true; break; } }
    if (corrected) continue;
    candidates.push(makeRec({
      detector: 'uncorrected-gate',
      category: 'tool-pattern',
      summary: `gate \`${gateId}\` failed ${occ.length}× with no correction on record`,
      evidence: occ.map((o) => o.stepId),
      supporting: occ.length,
      contradicting: 0,
      draft: `Investigate why \`${gateId}\` keeps failing (${occ.length}×) and record the fix as a correction (maddu learn) or automate it — repeated uncorrected failures are unbudgeted rework.`,
      why: `${occ.length} failures across ${new Set(occ.map((o) => o.scope).filter(Boolean)).size} scope(s) and the learn-correction record never mentions this gate.`,
    }));
  }
  return { candidates, scanned: { gatesWithFails: byGate.size } };
}

// ── the planner ─────────────────────────────────────────────────────────────

export function planEvolution(events) {
  const evs = Array.isArray(events) ? events : [];
  const exp = deriveExperience(evs);
  const prior = priorArt(evs.filter((e) => e && typeof e === 'object'));

  const d1 = detectToolCorrections(exp.steps);
  const d2 = detectGateFlaps(exp.steps);
  const d3 = detectRecurringLearnings(exp.steps);
  const d4 = detectUncorrectedGates(exp.steps, prior);

  // Prior-art dedup by content. CRITICAL: adopt writes the CONCATENATION
  // `${summary}. ${draft}` as the correction text (commands/evolve.mjs), so
  // the dedup MUST test that same concatenation — checking summary and draft
  // separately let evolve's own adopted corrections re-surface on the next
  // plan (red-team finding, demonstrated live). Summary/draft alone are also
  // checked so learn-mined prior art in either form still suppresses.
  const adoptedText = (r) => normText(`${r.summary}. ${r.draft || ''}`.trim());
  const recommendations = [...d1.candidates, ...d2.candidates, ...d3.candidates, ...d4.candidates]
    .filter((r) => !prior.has(adoptedText(r)) && !prior.has(normText(r.draft)) && !prior.has(normText(r.summary)));

  const scanned = {
    events: evs.length,
    steps: exp.steps.length,
    trajectories: exp.trajectories.length,
    priorCorrections: prior.size,
    thresholds: { minOccurrences: MIN_OCCURRENCES, minScopes: MIN_SCOPES },
    detectors: {
      'tool-correction': d1.scanned,
      'gate-flap': d2.scanned,
      'recurring-learning': d3.scanned,
      'uncorrected-gate': d4.scanned,
    },
  };

  if (recommendations.length === 0) {
    return {
      recommendations: [{
        recId: recIdFor('no-op', ['no-evidence']),
        detector: 'no-op',
        category: 'no-op',
        summary: 'no recommendation clears the evidence thresholds — the honest output is: change nothing',
        evidence: [],
        confidence: 1,
        draft: null,
        why: `Scanned ${evs.length} event(s) / ${exp.steps.length} step(s): ` +
          `${d1.scanned.refusalCompletionPairs} refusal→completion pair(s), ` +
          `${d2.scanned.failOkArcs} gate fail→ok arc(s), ` +
          `${d3.scanned.recurringLearnings} recurring learning(s), ` +
          `${d4.scanned.gatesWithFails} gate(s) with failures — none reached ` +
          `≥${MIN_OCCURRENCES} occurrences across ≥${MIN_SCOPES} scopes ` +
          `(or were already covered by ${prior.size} existing correction(s)). ` +
          'A finding manufactured from this corpus would be noise, not insight.',
      }],
      noOp: true,
      scanned,
    };
  }
  return { recommendations, noOp: false, scanned };
}
