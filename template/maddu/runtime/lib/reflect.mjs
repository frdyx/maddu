// reflect.mjs — read-only completion-claim-without-proof heuristic (`learn scan` v1).
//
// Deterministic, no LLM, no writes, no new event type. Given the append-only
// event spine, it finds SLICE_STOP events whose `summary` HEDGES a completion
// claim while the slice shows NO OBSERVED proof of verification.
//
// The signal is the JOIN, not the hedge text alone: a hedge that co-occurs with
// real green proof is honest confidence, not a defect (that JOIN is what keeps
// this from becoming the inverted "penalise honest agents" sensor). Proof is
// read ONLY from observed events — a real GATE_RAN(ok) that ran during the
// slice, or a verified deliverable recorded ON the SLICE_STOP itself
// (deliverables.verified > 0, i.e. declared files that actually exist on
// disk/git). The self-reported `data.gates` / `data.targets` CSV strings — which
// are just whatever the worker typed on the flag — are NEVER treated as proof.
//
// This is the shadow-measurement stage: it reports, it writes nothing. The
// write/approval/gate path is a deferred v2, earned only if this converts.

export const BEHAVIOR = 'unverified-completion-claim';
export const DEFAULT_THRESHOLD = 3;
export const DEFAULT_RECENT_DAYS = 30;

// A FIXED, maddu-authored template — v1 never renders untrusted summary bytes as
// a durable instruction. In v1 this is only DISPLAYED, never written.
export const PROPOSED_NOTE =
  'Recent slice summaries claimed completion in hedged terms (e.g. "should work") ' +
  'on slices that recorded no observed gate pass and no verified deliverable — ' +
  'consider verifying outcomes before stating done.';

// Hedged completion-claim phrasings: an uncertain assertion that the work is done.
const HEDGE_PATTERNS = [
  /\bshould\s+(work|pass|be\s+fine|be\s+good|be\s+ok(?:ay)?|be\s+enough|cover\s+it|handle\s+it|do\s+it|be\s+done)\b/i,
  /\bshould\s+be\s+(fine|good|ok(?:ay)?|working|correct|enough|done)\b/i,
  /\b(probably|likely|hopefully|presumably)\s+(works?|fine|good|correct|passes|done|fixed)\b/i,
  /\b(seems|appears)\s+to\s+(work|pass|be\s+(fine|good|correct|done|fixed))\b/i,
  /\b(i\s+think|pretty\s+sure|fairly\s+sure|i\s+believe|i\s+guess)\b[^.!?]*\b(works?|done|fixed|fine|correct|passes)\b/i,
];

// Prescriptive / forward-looking uses of "should" that are NOT a hedged claim
// about THIS slice's completion (rules, planned follow-ups, references to
// machinery). Their presence suppresses the whole summary — v1 biases to
// silence: a false negative is cheaper than nagging an accurate meta-use.
const BENIGN_PATTERNS = [
  /\bshould\s+(never|not|always|only)\b/i, // prescriptive rule, not a self-claim
  /\bnext\s+slice\s+should\b/i, // forward-looking plan
  /\bshould\s+be\s+covered\s+by\b/i, // reference to a gate / existing machinery
  /\bshould\s+extract\b/i, // planning a follow-up extraction
];

// audit P3 — CONFIDENT verification-outcome claims. Unlike a hedge, this is a
// factually checkable assertion that a suite/gate PASSED. The ritual template
// makes ~every slice-stop say "COMPLETE"/"done", so bare "done" is NOT enough:
// the claim must name a verification SUBJECT (test/gate/suite/check/ci/build) AND
// assert a positive OUTCOME (green/pass/verified/clean) [F12]. The JOIN with
// zero matching-family proof is the signal — we do not assert the claim's SCOPE
// is false, only that it is UNWITNESSED.
// The subject and outcome must be ADJACENT (subject then outcome within a couple
// of connecting words, or outcome then subject) — NOT merely both present
// somewhere in a long summary. This is what separates a real claim ("all gates
// green", "tests pass", "CI is green", "verified clean") from the slice-stop
// TEMPLATE, which carries a "Gates: <id> N/N" line and "pass"/"green" in its
// learnings without ever claiming this slice verified anything.
const SUBJECT = '(?:all\\s+)?(?:tests?|gates?|suites?|checks?|ci|build|self-?tests?|audit)';
const OUTCOME = '(?:green|pass(?:ing|ed|es)?|verified|clean)';
const VERIFICATION_ADJACENT_RE = new RegExp(
  `\\b${SUBJECT}\\s+(?:are\\s+|were\\s+|is\\s+|was\\s+|all\\s+|now\\s+|still\\s+)*${OUTCOME}\\b` +
  `|\\b${OUTCOME}\\s+(?:${SUBJECT})\\b`,
  'i',
);

// Negation / quotation / forward-looking contexts that flip a verification claim
// into a NON-claim (a rule, a plan, a quote, a denial) — suppress them [F12].
const VERIFICATION_NEGATION_RE = [
  /\b(no|not|never|without|isn't|aren't|wasn't|weren't|didn't|don't|doesn't|fail(?:s|ed|ing)?|red)\b/i,
  /\b(should|must|need|needs|ensure|verify|make\s+sure|before\s+(?:claiming|stating))\b/i, // prescriptive/forward
  /["'`]/, // a quotation — likely citing, not claiming
];

// True iff the summary reads as a hedged completion claim.
export function hedgesCompletion(summary) {
  const s = String(summary || '');
  if (!s) return false;
  if (BENIGN_PATTERNS.some((re) => re.test(s))) return false;
  return HEDGE_PATTERNS.some((re) => re.test(s));
}

// True iff the summary confidently asserts a verification OUTCOME with an explicit
// subject and no negation/quotation/forward-looking context.
export function claimsVerification(summary) {
  const s = String(summary || '');
  if (!s) return false;
  // Evaluate per CLAUSE, not globally: a stray negation/quote elsewhere in a long
  // summary must not suppress a real claim in another clause ("No regressions;
  // all gates green" is still a claim). A clause with the adjacency AND no
  // negation/quotation IN THAT CLAUSE is a confident verification claim.
  for (const clause of s.split(/[.!?;\n]+/)) {
    if (!VERIFICATION_ADJACENT_RE.test(clause)) continue;
    if (VERIFICATION_NEGATION_RE.some((re) => re.test(clause))) continue;
    return true;
  }
  return false;
}

// The proof FAMILY a claim needs [F10]: a claim about tests needs a passing test
// receipt; about gates needs a passing gate; a generic green/verified claim
// accepts any. We match family so a test receipt can't "prove gates green".
export function claimFamily(summary) {
  const s = String(summary || '');
  const test = /\b(tests?|suites?|self-?test|ci|build)\b/i.test(s);
  const gate = /\b(gates?|audit|checks?)\b/i.test(s);
  if (test && !gate) return 'test';
  if (gate && !test) return 'gate';
  return 'any';
}

// A verified deliverable recorded ON the event: declared --targets that actually
// exist on disk / show in git. This is observed, not self-reported.
function hasVerifiedDeliverable(ev) {
  const d = ev && ev.data ? ev.data.deliverables : null;
  return !!d && typeof d.verified === 'number' && d.verified > 0;
}

// A real gate that passed. status wins; fall back to ok for pre-status events.
function gateOk(ev) {
  if (!ev || ev.type !== 'GATE_RAN') return false;
  const st = ev.data ? ev.data.status : undefined;
  if (st != null) return st === 'ok';
  return ev.data ? ev.data.ok === true : false;
}

// audit P3 — a passing TEST verification receipt (project/self test). Heavy
// suites and success-eval are not "test proof" for a completion claim.
function testVerificationPass(ev) {
  if (!ev || ev.type !== 'VERIFICATION_RAN' || !ev.data) return false;
  const k = ev.data.kind;
  return (k === 'project-test' || k === 'self-test') && ev.data.result === 'pass' && ev.data.complete === true;
}

// Does event `ev` satisfy proof of `family` for a claim? [F10]
function isProofFor(ev, family) {
  if (family === 'gate') return gateOk(ev);
  if (family === 'test') return testVerificationPass(ev);
  return gateOk(ev) || testVerificationPass(ev); // 'any'
}

// Lane/actor attribution [R4/F11]: prevent one agent from borrowing ANOTHER
// agent's proof, without breaking the normal case where proof (gate runs) is
// untagged infra. A proof event is rejected ONLY when it is EXPLICITLY tagged to
// a DIFFERENT actor or a different lane than the claim. Untagged infra proof
// (lane-null / actor-null, e.g. an audit GATE_RAN) still counts within the
// claim's lane-bound window; same-actor / same-lane proof always counts.
function attributed(ev, claimLane, claimActor) {
  if (ev.actor != null && claimActor != null && ev.actor !== claimActor) return false;
  if (ev.lane != null && claimLane != null && ev.lane !== claimLane) return false;
  return true;
}

function tsMs(ev) {
  const t = ev && ev.ts ? Date.parse(ev.ts) : NaN;
  return Number.isFinite(t) ? t : null;
}

// Evaluate ONE slice-stop against its in-slice, lane-bound proof. `fromIdx` is the
// previous SAME-LANE slice-stop index (exclusive). `machineryReady` is true once
// the VERIFICATION_RAN receipt machinery exists on the spine — a CONFIDENT
// verification claim made BEFORE that could not have left a receipt, so policing
// it is inversion (a false "unproven"); such claims are not flagged as confident.
// Hedged detection is unaffected (its proof, GATE_RAN, always existed).
// Returns { flagged, kind } where kind ∈ 'hedged'|'verification'|null.
function evaluateSliceStop(list, i, fromIdx, claimLane, claimActor, machineryReady = true) {
  const ev = list[i];
  const summary = ev && ev.data ? ev.data.summary : '';
  const hedged = hedgesCompletion(summary);
  const confident = !hedged && machineryReady && claimsVerification(summary);
  if (!hedged && !confident) return { flagged: false, kind: null };
  const family = confident ? claimFamily(summary) : 'any';
  // A verified deliverable (a declared file exists) is proof for a HEDGED claim
  // ("should work" + the file is really there), but NOT for a confident
  // verification claim: a file existing proves neither "gates green" nor "tests
  // pass" [F10]. Confident claims need a matching-family gate/test event.
  let proof = hedged ? hasVerifiedDeliverable(ev) : false;
  if (!proof) {
    for (let j = fromIdx + 1; j < i; j++) {
      const e = list[j];
      if (!e) continue;
      if (!attributed(e, claimLane, claimActor)) continue;
      if (isProofFor(e, family)) { proof = true; break; }
    }
  }
  return { flagged: !proof, kind: hedged ? 'hedged' : 'verification' };
}

// Scan the event list for completion-claim-without-observed-proof slices —
// hedged ("should work") OR confident verification claims ("all gates green")
// with no matching-family, lane-bound proof. Pure + deterministic.
export function scanCompletionClaims(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
  const recentDays = Number.isFinite(opts.recentDays) ? opts.recentDays : DEFAULT_RECENT_DAYS;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : null;
  const windowMs = recentDays * 24 * 60 * 60 * 1000;

  // The index at which the VERIFICATION_RAN receipt machinery first appears — a
  // confident claim before this couldn't have left a receipt (don't police it).
  let machineryFromIdx = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i] && list[i].type;
    if (t === 'VERIFICATION_STARTED' || t === 'VERIFICATION_RAN') { machineryFromIdx = i; break; }
  }

  const matches = [];
  let scanned = 0;
  let hedgeMatches = 0;
  let confidentMatches = 0;
  // Per-lane (or per-actor) previous slice-stop index — the lane-bound window
  // start, so concurrent agents don't share each other's proof window [R4].
  const prevSliceIdxByKey = new Map();

  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    if (!ev || ev.type !== 'SLICE_STOP') continue;
    scanned++;
    const claimLane = ev.lane != null ? ev.lane : null;
    const claimActor = ev.actor != null ? ev.actor : null;
    const key = claimLane != null ? `lane:${claimLane}` : (claimActor != null ? `actor:${claimActor}` : '');
    const fromIdx = prevSliceIdxByKey.has(key) ? prevSliceIdxByKey.get(key) : -1;

    const { flagged, kind } = evaluateSliceStop(list, i, fromIdx, claimLane, claimActor, i >= machineryFromIdx);
    if (kind === 'hedged') hedgeMatches++;
    if (kind === 'verification') confidentMatches++;
    if (flagged) {
      const at = tsMs(ev);
      const recent = nowMs == null || at == null ? true : (nowMs - at) <= windowMs;
      matches.push({
        sliceId: ev.id || null,
        ts: ev.ts || null,
        lane: claimLane,
        kind,
        summary: String(ev.data ? ev.data.summary : '' || '').slice(0, 200),
        recent,
      });
    }
    prevSliceIdxByKey.set(key, i);
  }

  const cumulativeCount = matches.length;
  const recentCount = matches.filter((m) => m.recent).length;
  // audit P3 — trip on a RECENT cluster, not accumulated history: broadening to
  // confident claims means a mature repo carries many old (pre-machinery) claims
  // that legitimately had no receipt to leave. Requiring `recentCount >= threshold`
  // (rather than cumulative) keeps historical honest work from a false "live
  // pattern" while still catching a current run of unproven claims. When `nowMs`
  // is omitted (pure/test use), every match is "recent" so this reduces to the
  // prior cumulative behavior.
  const crossed = recentCount >= threshold;

  return {
    behavior: BEHAVIOR,
    scanned,
    hedgeMatches,
    confidentMatches,
    matches,
    cumulativeCount,
    recentCount,
    threshold,
    recentDays: nowMs == null ? null : recentDays,
    crossed,
    proposedNote: PROPOSED_NOTE,
  };
}

// audit P3 [S3] — evaluate a CANDIDATE slice-stop that may not be on the spine
// yet (the current claim a pre-append gate would miss). `candidate` is a
// SLICE_STOP-shaped { id?, lane?, actor?, data:{summary, deliverables?} }.
// Returns { flagged, kind }. The slice-stop command calls this AFTER it appends
// the stop, so the final claim is always evaluated.
export function evaluateStop(events, candidate, opts = {}) {
  const list = Array.isArray(events) ? events.slice() : [];
  const stop = {
    id: candidate.id || 'candidate', type: 'SLICE_STOP',
    ts: candidate.ts || null, lane: candidate.lane ?? null, actor: candidate.actor ?? null,
    data: candidate.data || { summary: candidate.summary || '' },
  };
  const i = list.length;
  list.push(stop);
  const claimLane = stop.lane != null ? stop.lane : null;
  const claimActor = stop.actor != null ? stop.actor : null;
  // The lane-bound window start = the previous same-lane slice-stop.
  let fromIdx = -1;
  for (let j = i - 1; j >= 0; j--) {
    const e = list[j];
    if (e && e.type === 'SLICE_STOP' && attributed(e, claimLane, claimActor)) { fromIdx = j; break; }
  }
  const machineryReady = list.some((e) => e && (e.type === 'VERIFICATION_STARTED' || e.type === 'VERIFICATION_RAN'));
  return evaluateSliceStop(list, i, fromIdx, claimLane, claimActor, machineryReady);
}
