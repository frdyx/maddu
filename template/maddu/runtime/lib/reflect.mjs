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

// True iff the summary reads as a hedged completion claim (and is not a benign
// prescriptive/forward-looking use of "should").
export function hedgesCompletion(summary) {
  const s = String(summary || '');
  if (!s) return false;
  if (BENIGN_PATTERNS.some((re) => re.test(s))) return false;
  return HEDGE_PATTERNS.some((re) => re.test(s));
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

function tsMs(ev) {
  const t = ev && ev.ts ? Date.parse(ev.ts) : NaN;
  return Number.isFinite(t) ? t : null;
}

// Scan the event list for hedged-completion-without-observed-proof slices.
// Pure + deterministic: pass `nowMs` to make recency deterministic (tests +
// the command inject it); when omitted, recency is not applied (all matches
// count as live) so the core stays a pure function.
export function scanCompletionClaims(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
  const recentDays = Number.isFinite(opts.recentDays) ? opts.recentDays : DEFAULT_RECENT_DAYS;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : null;
  const windowMs = recentDays * 24 * 60 * 60 * 1000;

  const matches = [];
  let scanned = 0;
  let hedgeMatches = 0;
  let prevSliceIdx = -1;

  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    if (!ev || ev.type !== 'SLICE_STOP') continue;
    scanned++;
    const summary = ev.data ? ev.data.summary : '';
    const hedged = hedgesCompletion(summary);
    if (hedged) hedgeMatches++;

    // Observed proof: own verified deliverable, OR a real ok gate that ran in
    // the window since the previous slice-stop (i.e. during this slice's work).
    let proof = hasVerifiedDeliverable(ev);
    if (!proof) {
      for (let j = prevSliceIdx + 1; j < i; j++) {
        if (gateOk(list[j])) { proof = true; break; }
      }
    }

    if (hedged && !proof) {
      const at = tsMs(ev);
      const recent = nowMs == null || at == null ? true : (nowMs - at) <= windowMs;
      matches.push({
        sliceId: ev.id || null,
        ts: ev.ts || null,
        lane: ev.lane || null,
        summary: String(summary || '').slice(0, 200),
        recent,
      });
    }
    prevSliceIdx = i;
  }

  const cumulativeCount = matches.length;
  const recentCount = matches.filter((m) => m.recent).length;
  // "Live" pattern: enough cumulative evidence AND at least one recent hit, so a
  // mature repo's long-fixed slices don't get diagnosed as a current problem.
  const crossed = cumulativeCount >= threshold && recentCount >= 1;

  return {
    behavior: BEHAVIOR,
    scanned,
    hedgeMatches,
    matches,
    cumulativeCount,
    recentCount,
    threshold,
    recentDays: nowMs == null ? null : recentDays,
    crossed,
    proposedNote: PROPOSED_NOTE,
  };
}
