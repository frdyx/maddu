// acceptance-view — the ONE read-time view of a goal's acceptance proofs,
// shared by `maddu orient` (which observes, then renders) and the
// `acceptance-proven` gate (which only reads).
//
// WHY THIS FILE EXISTS. Two surfaces that each build their own declaration
// record for the same success condition will eventually build DIFFERENT ones —
// a renamed field, a `cwd` taken from the wrong root, a tier policy typed twice
// — and then the same condition carries two acceptanceIds, orient renders a
// live proof and the gate renders none, and the operator has no way to tell
// which surface is lying. That is the exact two-surfaces-disagree failure the
// acceptance track exists to close, so the decl mapping and the proof
// derivation live here ONCE and every surface calls in.
//
// NOTHING HERE OBSERVES. No command is executed, no lock is taken, no event is
// appended: observation belongs to `observeAcceptance` (orient and `loop ralph`
// are its only callers). This module reads the working tree (digests), reads
// `maddu.json` (the age policy) and folds the caller's already-verified spine
// read. A gate that could execute a declared command would turn `maddu doctor`
// into an arbitrary-command runner.
//
// ROOTS ARE ALWAYS A PAIR — the law inherited from acceptance-core.mjs.
// `workRoot` is the checkout whose bytes are hashed and whose path binds every
// declaration; `stateRoot` is where the spine lives. Inside an attached lane
// worktree they differ, and hashing the state root would digest a tree the
// operator is not editing.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  acceptanceIdFor,
  oracleDigest,
  implDigest,
  deriveProofs,
} from './acceptance.mjs';

// The tier policy every GOAL-DECLARED acceptance is declared under. It is an
// identity term, so it is named once here rather than typed at each surface:
// two surfaces disagreeing about this string produce two acceptanceIds for one
// condition, which is precisely the drift this module prevents.
export const GOAL_TIER_POLICY = 'worktree';

// The declaration schema version carried in the identity preimage (the shipped
// 2b convention, `scripts/test/acceptance-record.mjs`).
export const GOAL_DECL_SCHEMA_VERSION = '1';

// A map MISS in the derivation means "no acceptance observation exists for this
// id at all". `deriveProofs` deliberately does not synthesize an entry for it
// (its evidence is the spine, and inventing a row would be inventing evidence),
// so the NORMALIZATION happens here, in the view every surface renders from —
// otherwise one surface prints a null state and the next prints "unproven" for
// the same condition. The sentence is the derivation's own map-miss vocabulary
// (acceptance-derive.mjs header), not a second wording invented here.
export const NEVER_OBSERVED_REASON = 'this command has never been observed to exit nonzero';

// Rendered beside EVERY proof readout. `ACCEPTANCE_HONEST_LIMITS` is exported
// from the acceptance library so no surface can quietly narrow the limits; a
// one-line message cannot carry the whole block, so it carries the pointer to
// it. Never say "tamper-proof"; never say "a test failed".
export const ACCEPTANCE_LIMITS_POINTER =
  'a proof says the command EXITED NONZERO then ZERO with the oracle frozen — process-level, never "a test failed". Limits: ACCEPTANCE_HONEST_LIMITS in the acceptance library.';

// ── maddu.json → acceptance.maxProofAge ────────────────────────────────────
//
// Read exactly the way `readMaxAnchorAge` (spine-anchor.mjs) reads the witness
// policy beside it: an ABSENT maddu.json is the only thing that means "no policy
// declared", and every other failure — unreadable file, invalid JSON, a value
// that is not "<n>d" — returns the INVALID shape, which `normalizeMaxProofAge`
// fail-closes on (`policy-invalid`, so nothing derives live). A consume gate
// must never guess its own policy.
//
// The offending value is never echoed: it is caller-typed config text, and a
// secret pasted into the wrong field must not land on stderr or in a log. The
// shape returned here is the one `deriveProofs` already accepts, so nothing
// downstream has to re-interpret it.
export async function readMaxProofAge(workRoot) {
  let raw = null;
  try { raw = await readFile(join(workRoot, 'maddu.json'), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { set: false };
    return { set: true, invalid: true };
  }
  let cfg = null;
  try { cfg = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { return { set: true, invalid: true }; }
  const v = cfg?.acceptance?.maxProofAge;
  if (v === undefined || v === null) return { set: false };
  // Bounded by construction (≤5 digits ≈ 273 years): an unbounded digit run
  // parses to Infinity and makes every age comparison false — a policy that can
  // never fire is worse than none.
  if (typeof v !== 'string' || !/^\d{1,5}d$/.test(v) || parseInt(v, 10) < 1) return { set: true, invalid: true };
  return { set: true, invalid: false, days: parseInt(v, 10) };
}

// ── the goal fold ──────────────────────────────────────────────────────────
//
// The goal a proof view reasons about is FOLDED FROM THE VERIFIED READ, never
// projected beside it. A projection built from the tolerant `spine.readAll` and
// a derivation built from `readVerifiedEvents` are two reads of two possibly
// different event sets; folding from the read the proofs are derived from makes
// "the goal" and "the evidence" the same document by construction, and lets a
// caller detect that its own projection has moved on (the `goal-changed` arm).
//
// The reducer is the GOAL half of `projections.project` transcribed, not
// re-invented: latest GOAL_DECLARED wins; GOAL_COMPLETED closes only a
// currently-active goal. THERE IS NO GOAL_ABANDONED EVENT — abandonment is a
// GOAL_COMPLETED carrying `outcome:'abandoned'`, so this fold names
// GOAL_COMPLETED only.
export function foldGoalFromEvents(events) {
  if (!Array.isArray(events)) return null;
  let goal = null;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'GOAL_DECLARED') {
      const d = (ev.data && typeof ev.data === 'object') ? ev.data : {};
      goal = {
        objective: d.objective || '',
        success: Array.isArray(d.success) ? d.success : [],
        oracle: Array.isArray(d.oracle) ? d.oracle : [],
        implementation: Array.isArray(d.implementation) ? d.implementation : [],
        declEventId: typeof ev.id === 'string' ? ev.id : null,
        status: 'active',
      };
    } else if (ev.type === 'GOAL_COMPLETED') {
      if (goal && goal.status === 'active') {
        goal.status = (ev.data && ev.data.outcome === 'abandoned') ? 'abandoned' : 'completed';
      }
    }
  }
  return goal;
}

// ── the declaration mapping ────────────────────────────────────────────────
//
// One aligned entry per success condition:
//   null                      the condition declares no command — nothing to
//                             observe, nothing to prove.
//   {cond, decl, id}          a well-formed declaration.
//   {cond, decl, id:null, error}  the declaration is structurally malformed
//                             (a non-string command, a non-string pattern, a
//                             set over budget). `acceptanceIdFor` THROWS on
//                             those by design — an unencodable identity term
//                             must not merge two declarations into one id — but
//                             a goal is operator input reaching two read
//                             surfaces, so THIS function never throws. The
//                             caller decides what an unencodable condition
//                             means for it (orient: pending with a note; the
//                             gate: a named refusal).
//
// The error text is structural (types, key names, budgets) and never echoes a
// declared pattern or command, so it is safe to render and safe to persist.
export function goalAcceptanceDecls(goal, workRoot) {
  const success = Array.isArray(goal?.success) ? goal.success : [];
  const oraclePatterns = Array.isArray(goal?.oracle) ? goal.oracle : [];
  const implPatterns = Array.isArray(goal?.implementation) ? goal.implementation : [];
  const declEventId = goal?.declEventId ?? null;
  return success.map((cond) => {
    // ABSENT and INVALID are different rows (gate funnel r1 #1): a condition
    // with no verify at all is text-only (null arm, out of the denominator),
    // but a PRESENT non-string or blank command — `verify:0`, `verify:false`
    // — is a malformed declaration and must reach the error arm, or a falsy
    // value would silently shrink the denominator and let the gate green over
    // a declaration it could not encode.
    if (!cond || cond.verify === undefined || cond.verify === null) return null;
    if (typeof cond.verify !== 'string' || !cond.verify.trim()) {
      return { cond, decl: null, id: null, error: 'condition verify must be a non-blank string when present' };
    }
    const decl = {
      command: cond.verify,
      cwd: workRoot,
      declEventId,
      scopeNonce: null,
      oraclePatterns,
      implPatterns,
      tierPolicy: GOAL_TIER_POLICY,
      schemaVersion: GOAL_DECL_SCHEMA_VERSION,
    };
    try {
      return { cond, decl, id: acceptanceIdFor(decl) };
    } catch (err) {
      return { cond, decl, id: null, error: (err && err.message) || 'invalid declaration' };
    }
  });
}

// ── the proof view ─────────────────────────────────────────────────────────
//
// A DISCRIMINATED UNION, never a bare row array:
//
//   { ok:true,  rows, oracleFileCount }
//   { ok:false, why:'team-sync' }     this checkout has no single order for a
//                                     RED to precede a GREEN in
//   { ok:false, why:'integrity' }     the chain failed verification, so no
//                                     claim derived from it is trustworthy
//   { ok:false, why:'goal-changed' }  the caller's goal is not the goal the
//                                     verified read ends on
//
// "unsupported", "suppressed" and "the goal moved" must never render alike, and
// a caller must never have to guess whether to iterate rows or print a reason.
//
// THE READ IS SUPPLIED BY THE CALLER AND READ EXACTLY ONCE. `readVerifiedEvents`
// verifies the whole chain; calling it twice for one readout doubles the cost
// and — worse — opens a window in which the two reads disagree. orient hands in
// its post-observation read so the GREEN it just appended is inside the
// evidence; the gate hands in its own.
//
// ORDER IS NORMATIVE: mode, then integrity, then goal consistency. The first
// two are decided by `deriveProofs` itself (this module never re-implements
// them — it maps its arms), which is why the goal-consistency test comes after:
// a broken chain is a fact about the record, and it outranks a disagreement
// about which goal we are looking at.
export async function deriveGoalProofView(roots, {
  read,
  declEventId = null,
  nowMs,
  maxProofAge = null,
} = {}) {
  const folded = foldGoalFromEvents(read?.events);
  // The caller's goal must BE the goal the read ends on: same declaration
  // event, still open. Anything else and a proof derived here would be
  // attributed to a declaration nobody is pursuing.
  const consistent = !!folded
    && folded.status === 'active'
    && typeof declEventId === 'string'
    && declEventId.trim() !== ''
    && folded.declEventId === declEventId;

  const decls = consistent ? goalAcceptanceDecls(folded, roots.workRoot) : [];

  // ONE expansion per SET, not one per condition: every condition of a goal
  // shares the goal's declared oracle and implementation. The lookups are keyed
  // by acceptanceId because that is how `deriveProofs` asks "is this id still
  // declared, and what does it hash to now" — a MISS means undeclared, a
  // present `null` means declared-but-unavailable, and those must not collapse.
  // A refused expansion therefore maps to `null` for every id (fail-closed:
  // `oracle-unavailable` / `impl-unavailable`), never to the refusal record.
  let oracle = null;
  let impl = null;
  if (consistent && decls.some((d) => d && d.id)) {
    oracle = await oracleDigest(roots, folded.oracle);
    impl = await implDigest(roots, folded.implementation);
  }
  const currentOracleDigest = new Map();
  const currentImplDigest = new Map();
  for (const d of decls) {
    if (!d || !d.id) continue;
    currentOracleDigest.set(d.id, oracle && oracle.ok === true ? oracle.digest : null);
    currentImplDigest.set(d.id, impl && impl.ok === true ? impl.digest : null);
  }

  // A THROW from here is a caller-contract violation (a hand-assembled read, a
  // non-finite clock) and stays loud, exactly as the acceptance family's
  // errors-vs-refusals split requires. It is deliberately NOT a fourth union
  // arm: the union describes states of the RECORD, not bugs in the caller.
  const derived = deriveProofs(read, {
    goal: consistent ? folded : null,
    nowMs,
    currentOracleDigest,
    currentImplDigest,
    maxProofAge,
  });

  if (derived.ok !== true) return { ok: false, why: derived.unsupported || 'team-sync' };
  if (derived.suppressed) return { ok: false, why: derived.suppressed };
  if (!consistent) return { ok: false, why: 'goal-changed' };

  const oracleFileCount = oracle && oracle.ok === true ? oracle.fileCount : null;

  // One row per CURRENT condition, aligned BY INDEX with the goal's success
  // list: a positional consumer zipping the two arrays must never attribute a
  // verifiable condition's proof to a text-only neighbour. Two conditions may
  // also declare the same command (and then share an acceptanceId), so nothing
  // here may key on command text.
  const rows = decls.map((d, i) => {
    const cond = folded.success[i] || {};
    const row = {
      text: cond.text ?? null,
      verify: cond.verify ?? null,
      acceptanceId: d?.id ?? null,
      state: null,
      staleReason: null,
      reason: null,
      red: null,
      green: null,
      declarationError: d?.error ?? null,
    };
    if (!d || !d.id) return row;
    const p = derived.proofs.get(d.id);
    if (!p) {
      // DECLARED BUT NEVER OBSERVED is a named state, not a hole. Leaving it
      // null makes "we have no evidence" indistinguishable from "this condition
      // cannot be proven", and a reader seeing nulls has to invent the
      // difference — which is how two surfaces start disagreeing.
      row.state = 'unproven';
      row.reason = NEVER_OBSERVED_REASON;
      return row;
    }
    row.state = p.state;
    row.staleReason = p.staleReason ?? null;
    row.reason = p.reason ?? null;
    // red/green are EVENT-ID STRINGS on the wire: the derivation's reference
    // objects are an internal shape, and a machine consumer needs the receipt
    // id it can look up, or null.
    row.red = p.red?.eventId ?? null;
    row.green = p.green?.eventId ?? null;
    return row;
  });

  return { ok: true, rows, oracleFileCount };
}
