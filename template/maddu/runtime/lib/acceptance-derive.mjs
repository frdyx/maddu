// acceptance-derive — phase 1b of the acceptance proof: `deriveProofs`, the
// read-time verdict. Pure: its only inputs are the events/goal the caller
// hands it — nothing here touches the filesystem or the spine. Split out of
// acceptance.mjs (the single public entry; its header carries the full
// contract, which binds this module).

import { pairVerifications } from './verification-recency.mjs';
import { isStaleTs } from './success-eval.mjs';

import { isPlainRecord, short } from './acceptance-core.mjs';

// ── deriveProofs — the read-time verdict ───────────────────────────────────
//
// There is no proof EVENT and no re-baseline verb. A proof is derived from two
// observation receipts every time somebody looks, the way `recencyFromSpine`
// and `resolveSuccessView` already derive their verdicts. Changing a test
// DESTROYS its proof; the only route back is to observe the new test exit
// nonzero and then exit zero.
//
// PURE, AND THAT IS LOAD-BEARING. This function reads no filesystem, takes no
// lock and calls no clock — `nowMs` and the CURRENT digests all arrive as
// arguments. A derivation that re-expanded the tree itself would be a SECOND
// expander running beside the observer's, and two expanders disagreeing about
// one declaration is exactly the two-surfaces-disagreeing failure this feature
// exists to prevent. One expander runs at OBSERVATION time; derivation only
// ever compares strings it was handed.
//
// THE RETURN IS A DISCRIMINATED UNION, NEVER A BARE MAP:
//
//   { ok:true,  proofs, suppressed, integrity, mode, unattributed }
//   { ok:false, unsupported:'team-sync' }
//
// "this mode cannot support proofs", "the chain is broken" and "nothing has
// been observed" must never render alike, and a caller must never have to guess
// whether to call `.get`, print "none", or print "unsupported". `suppressed`
// carries the third of those on the ok:true arm rather than adding an arm, so
// the discriminant stays exactly `ok`.
//
// A MAP MISS MEANS "no acceptance observation exists for this id" — render it
// as *"this command has never been observed to exit nonzero"*, never as a
// failure. Declared-but-never-observed acceptances are deliberately NOT
// synthesized here: this function's evidence is the spine, and inventing an
// entry for an id it has seen no receipt for would be inventing evidence.
//
// WHAT IS DELIBERATELY NOT HERE: `observeAcceptance`, `captureSubject` and the
// gate. Every one of them is a CALLER of this. (The observation lock and the
// command runner DO live in this file since phase 2a, at the bottom — but
// `deriveProofs` neither takes the lock nor runs anything: derivation is a read.)
const DAY_MS = 86400000;

// Bounds the pair search per acceptanceId. The scan is O(greens × reds), so an
// id with thousands of observations would otherwise turn a read into a stall.
// Truncation can only LOSE a qualifying older pair — the safe direction — and
// it is reported on the view as `scanTruncated` rather than silently narrowing
// coverage while the readout still says "no proof".
const MAX_PAIR_SCAN = 512;

// The closed state vocabulary, exported so no gate or readout can invent a
// fourth positive-sounding word. `live` is the ONLY positive verdict:
//   live                 a qualifying O1–O8 pair anchors the LATEST observation
//                        and every liveness condition holds.
//   historically-proven  a qualifying pair anchors the latest observation but
//                        at least one liveness condition fails. NOT green.
//   regressed            proven at some earlier point; the latest observation
//                        is an eligible process-fail. NOT green.
//   indeterminate        the latest observation is infra-fail, void, a dangling
//                        STARTED, or a corrupt receipt. NOT green. First-class,
//                        never a silent fallthrough.
//   unproven             no qualifying pair anchors the latest observation.
//                        `previouslyProven` says whether one ever existed.
export const ACCEPTANCE_PROOF_STATES = Object.freeze([
  'live', 'historically-proven', 'regressed', 'indeterminate', 'unproven',
]);

// The closed liveness-failure vocabulary, in the order they are TESTED. The
// order is normative: without it two implementations would report different
// reasons for the same proof, and an operator comparing two surfaces would see
// a disagreement where none exists.
export const ACCEPTANCE_STALE_REASONS = Object.freeze([
  'policy-invalid',      // maddu.json acceptance.maxProofAge is malformed — fail closed
  'no-ts',               // the GREEN carries no parseable timestamp
  'future-ts',           // the GREEN is materially future-dated
  'redeclared',          // a GOAL_DECLARED superseded the declaration behind the GREEN
  'undeclared',          // this acceptanceId is no longer declared
  'oracle-unavailable',  // declared, but the current oracle digest could not be computed
  'oracle-changed',      // the test moved — the proof died with it
  'impl-unavailable',    // the current implementation digest could not be computed
  'impl-moved',          // boundToCurrent:false — the GREEN never ran these bytes
  'expired',             // older than the operator's configured maxProofAge
]);

// maddu.json → acceptance.maxProofAge, normalized. Accepts the `readMaxAnchorAge`
// RESULT shape ({set,invalid,days}) or the raw "<n>d" config string, and nothing
// else — a bare number is REFUSED rather than guessed at, because days-vs-
// milliseconds is precisely the ambiguity that silently expires every proof or
// none. Malformed is fail-closed (`policy-invalid`, so nothing reads live), never
// "no policy": a consume gate must never guess its own policy.
function normalizeMaxProofAge(policy) {
  if (policy === null || policy === undefined) return { set: false, invalid: false, ttlMs: null };
  if (typeof policy === 'string') {
    // Bounded by construction (≤ 5 digits ≈ 273 years): an unbounded digit run
    // parses to Infinity and makes every age comparison false — a policy that
    // can never fire is worse than none.
    if (!/^\d{1,5}d$/.test(policy) || parseInt(policy, 10) < 1) return { set: true, invalid: true, ttlMs: null };
    return { set: true, invalid: false, ttlMs: parseInt(policy, 10) * DAY_MS };
  }
  if (isPlainRecord(policy)) {
    if (policy.set === false) return { set: false, invalid: false, ttlMs: null };
    if (policy.invalid === true) return { set: true, invalid: true, ttlMs: null };
    const d = policy.days;
    if (!Number.isSafeInteger(d) || d < 1 || d > 99999) return { set: true, invalid: true, ttlMs: null };
    return { set: true, invalid: false, ttlMs: d * DAY_MS };
  }
  return { set: true, invalid: true, ttlMs: null };
}

// A current-digest lookup: `null` (nothing available at all), a Map, a plain
// object, or a function of acceptanceId.
//
// THE KEY SET IS THE CURRENT DECLARATION. A MISS means "this acceptanceId is
// not declared any more" (`undeclared`), which is how the liveness clause
// "acceptanceId unchanged" is enforced without this file recomputing an id it
// has no cwd/tierPolicy/schemaVersion for: a redeclaration that changes the
// identity simply produces an id the caller's lookup does not carry. A present
// key whose value is `null` means "declared, but the digest could not be
// computed" — a REFUSED expansion, which must not read the same as a match.
// Both are non-live; they are distinguished because the remedies differ.
const LOOKUP_MISS = { known: false, unavailable: false, digest: null };

function coerceDigest(v, label) {
  if (v === undefined) return LOOKUP_MISS;
  if (v === null) return { known: true, unavailable: true, digest: null };
  if (typeof v === 'string' && v.trim()) return { known: true, unavailable: false, digest: v };
  // A caller contract violation, not operator input: a lookup returning a
  // number or a record would compare unequal to every recorded digest and
  // silently mark every proof stale for the wrong reason.
  throw new TypeError(`${label} must yield a non-blank digest string, null (unavailable) or undefined (not declared)`);
}

function makeDigestLookup(src, label) {
  if (src === null || src === undefined) {
    return () => ({ known: true, unavailable: true, digest: null });
  }
  if (src instanceof Map) return (id) => (src.has(id) ? coerceDigest(src.get(id), label) : LOOKUP_MISS);
  if (typeof src === 'function') return (id) => coerceDigest(src(id), label);
  if (isPlainRecord(src)) return (id) => (Object.hasOwn(src, id) ? coerceDigest(src[id], label) : LOOKUP_MISS);
  throw new TypeError(`${label} must be null, a Map, a plain object or a function of acceptanceId`);
}

// One declared set as recorded on a receipt. Every field is validated to its
// exact type: a missing or wrong-typed field becomes `null`/`false`, never a
// truthy default. `stable` is strictly `=== true` — the string "true", 1 and a
// missing key all mean NOT stable, so a receipt that never recorded its
// endpoints can never satisfy O6 by omission.
//
// `patterns` is all-or-nothing on purpose: filtering out a non-string element
// would SHRINK the declared set while the record still digested cleanly, which
// is the silent-omission failure this whole module is built against.
function setView(raw) {
  const r = isPlainRecord(raw) ? raw : {};
  let patterns = null;
  if (Array.isArray(r.patterns) && r.patterns.length && r.patterns.every((p) => typeof p === 'string')) {
    patterns = r.patterns;
  }
  return {
    patterns,
    fileCount: Number.isSafeInteger(r.fileCount) && r.fileCount >= 0 ? r.fileCount : null,
    digest: typeof r.digest === 'string' && r.digest.trim() ? r.digest : null,
    digestAfter: typeof r.digestAfter === 'string' && r.digestAfter.trim() ? r.digestAfter : null,
    stable: r.stable === true,
    digestAlgo: typeof r.digestAlgo === 'string' && r.digestAlgo.trim() ? r.digestAlgo : null,
  };
}

// Canonical key for a pattern array — the same sort/dedupe `acceptanceIdFor`
// binds, so two receipts of ONE declaration compare equal even if the caller
// handed the patterns in a different order. Comparing the literal arrays
// instead would manufacture a false difference; comparing nothing would let two
// different declarations pair.
function patternKey(list) {
  if (!Array.isArray(list)) return null;
  return [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\u0000');
}

const OUTCOME_OF = { 'process-pass': 'pass', 'process-fail': 'fail', 'infra-fail': 'infra' };

// Normalize one acceptance receipt into the shape derivation reasons over.
// UNKNOWN `outcome_class` MAPS TO `infra`: an unrecognised value must never be
// readable as a GREEN and must never be a valid RED (O4), and mapping it to the
// third class also makes it supersede as `indeterminate` — all three at once.
// `observation_status` is likewise strictly `'eligible'`; anything else, absent
// included, is `void`.
function observationFrom(ev, index, forcedVoid = null) {
  const d = isPlainRecord(ev.data) ? ev.data : {};
  const eligible = forcedVoid === null && d.observation_status === 'eligible';
  const outcome = OUTCOME_OF[d.outcome_class] || 'infra';
  return {
    index,
    eventId: typeof ev.id === 'string' ? ev.id : null,
    startedId: typeof d.startedId === 'string' ? d.startedId : null,
    ts: typeof ev.ts === 'string' ? ev.ts : null,
    actor: typeof ev.actor === 'string' ? ev.actor : null,
    acceptanceId: typeof d.acceptanceId === 'string' && d.acceptanceId.trim() ? d.acceptanceId : null,
    commandSha256: typeof d.commandSha256 === 'string' && d.commandSha256.trim() ? d.commandSha256 : null,
    scopeNonce: typeof d.scopeNonce === 'string' && d.scopeNonce.trim() ? d.scopeNonce : null,
    declEventId: typeof d.declEventId === 'string' && d.declEventId.trim() ? d.declEventId : null,
    declSource: typeof d.declSource === 'string' ? d.declSource : null,
    phase: typeof d.phase === 'string' ? d.phase : null,
    loopId: typeof d.loopId === 'string' ? d.loopId : null,
    command: typeof d.command === 'string' ? d.command : null,
    exit: Number.isInteger(d.exit) ? d.exit : null,
    signal: typeof d.signal === 'string' ? d.signal : null,
    timedOut: d.timed_out === true,
    spawnError: d.spawn_error === true,
    durationMs: Number.isSafeInteger(d.duration_ms) ? d.duration_ms : null,
    outcome,
    eligible,
    refusalReason: forcedVoid || (typeof d.refusal_reason === 'string' ? short(d.refusal_reason) : null),
    tier: isPlainRecord(d.subject) && typeof d.subject.tier === 'string' ? d.subject.tier : null,
    oracle: setView(d.oracle),
    impl: setView(d.impl),
    role: forcedVoid !== null ? 'void' : (!eligible ? 'void' : (outcome === 'pass' ? 'green' : outcome === 'fail' ? 'red' : 'infra')),
  };
}

// A dangling STARTED — a run that began and never recorded a result. It anchors
// nothing and, per the supersession table, yields `indeterminate` when it is
// the latest observation. It carries the identity fields precisely so a crashed
// run is attributable to ITS acceptance rather than invalidating all of them or
// none.
function danglingFrom(ev, index) {
  const o = observationFrom(ev, index, 'dangling-started');
  o.role = 'dangling';
  return o;
}

// O1–O8 for one candidate pair. Returns a clause record plus `all`.
//
// Three of the eight are only PARTIALLY derivable here, and saying so is the
// point — a clause reported `true` on evidence that does not exist is worse
// than one reported `null`:
//   - O5's "one replica" half is discharged globally, by refusing every mode
//     that is not exactly `flat` before any of this runs.
//   - O8's DISJOINTNESS half is checked on the *expanded* sets at observation
//     time and rides here only as `observation_status:'eligible'`; the receipt
//     records `patterns` and `fileCount`, not paths, so this file can add only
//     the one-directional pattern check (a pattern string appearing in BOTH
//     declared sets certainly overlaps; distinct patterns do NOT imply
//     disjoint).
//   - O6's endpoint equality is the observer's own `stable` flag. Where the
//     receipt also carries `digestAfter` this compares it directly, which
//     catches an observer that computed `stable` wrongly — internal
//     consistency, NOT independent evidence.
// The same caveat applies to the identity terms folded into O2
// (`commandSha256`, the pattern arrays): both sides come from the spine, so
// they catch an inconsistent producer, never a determined forger.
function evaluateClauses(red, green) {
  const algos = [red.oracle.digestAlgo, red.impl.digestAlgo, green.oracle.digestAlgo, green.impl.digestAlgo];

  const O1 = red.oracle.digest !== null && red.oracle.digest === green.oracle.digest;

  const O2 = red.acceptanceId !== null
    && red.acceptanceId === green.acceptanceId
    && red.commandSha256 !== null && red.commandSha256 === green.commandSha256
    && (red.scopeNonce ?? null) === (green.scopeNonce ?? null)
    && (red.declEventId ?? null) === (green.declEventId ?? null)
    && patternKey(red.oracle.patterns) !== null && patternKey(red.oracle.patterns) === patternKey(green.oracle.patterns)
    && patternKey(red.impl.patterns) !== null && patternKey(red.impl.patterns) === patternKey(green.impl.patterns);

  // The PRE-execution digests, never `digestAfter`. Comparing post-execution
  // digests would let a command that writes into its own declared
  // implementation set satisfy O3 by its own side effects.
  const O3 = red.impl.digest !== null && green.impl.digest !== null && red.impl.digest !== green.impl.digest;

  const O4 = red.eligible && green.eligible && red.outcome === 'fail' && green.outcome === 'pass';

  const O5 = red.index < green.index;

  const endpointsHeld = (o) => o.oracle.stable && o.impl.stable
    && (o.oracle.digestAfter === null || o.oracle.digestAfter === o.oracle.digest)
    && (o.impl.digestAfter === null || o.impl.digestAfter === o.impl.digest);
  const O6 = endpointsHeld(red) && endpointsHeld(green);

  // One algorithm across all four digests, and one tier across both
  // observations. The tier half is the same class of forward guard as the
  // algorithm half: only `worktree` ships today, so requiring equality costs
  // nothing now and forecloses a cross-tier comparison the moment a second
  // tier lands.
  const O7 = algos.every((a) => a !== null) && new Set(algos).size === 1
    && red.tier !== null && red.tier === green.tier;

  const nonEmpty = (o) => o.oracle.fileCount !== null && o.oracle.fileCount > 0
    && o.impl.fileCount !== null && o.impl.fileCount > 0;
  const sharesPattern = (o) => {
    if (!o.oracle.patterns || !o.impl.patterns) return true;   // unusable → refuse, never assume disjoint
    const oset = new Set(o.oracle.patterns);
    return o.impl.patterns.some((p) => oset.has(p));
  };
  const O8 = nonEmpty(red) && nonEmpty(green) && !sharesPattern(red) && !sharesPattern(green);

  const clauses = { O1, O2, O3, O4, O5, O6, O7, O8 };
  clauses.all = O1 && O2 && O3 && O4 && O5 && O6 && O7 && O8;
  return clauses;
}

// The nearest PRECEDING qualifying RED for one GREEN. Nearest-first, by spine
// INDEX — never by iteration order, which two concurrent loops would make
// nondeterministic. Returns the pair, or the nearest candidate it rejected so a
// readout can say WHICH clause failed instead of only "no proof".
function pairFor(green, reds) {
  let nearestRejected = null;
  let scanned = 0;
  for (let i = reds.length - 1; i >= 0; i--) {
    const r = reds[i];
    if (r.index >= green.index) continue;
    if (++scanned > MAX_PAIR_SCAN) return { red: null, clauses: nearestRejected, truncated: true };
    const clauses = evaluateClauses(r, green);
    if (clauses.all) return { red: r, clauses, truncated: false };
    if (nearestRejected === null) nearestRejected = clauses;
  }
  return { red: null, clauses: nearestRejected, truncated: false };
}

// Did a qualifying pair EVER exist at or before `beforeIndex`? Latest-first, so
// the common case (proven recently, then regressed) stops on its first green.
function everProven(greens, reds, beforeIndex) {
  let scanned = 0;
  for (let i = greens.length - 1; i >= 0; i--) {
    const g = greens[i];
    if (g.index >= beforeIndex) continue;
    if (++scanned > MAX_PAIR_SCAN) return { proven: false, truncated: true };
    const p = pairFor(g, reds);
    if (p.red) return { proven: true, truncated: false, red: p.red, green: g, clauses: p.clauses };
    if (p.truncated) return { proven: false, truncated: true };
  }
  return { proven: false, truncated: false };
}

// A compact, immutable-by-construction reference to one observation. The raw
// event is deliberately NOT handed out: a readout holding a live reference
// could mutate the caller's verified list.
function refOf(o) {
  if (!o) return null;
  return {
    // `role` disambiguates what `outcomeClass` cannot: a dangling STARTED
    // carries no outcome at all, and defaulting it to `infra-fail` for the
    // fail-closed classification must not read as "the process reported an
    // infra failure" on a receipt that never reported anything.
    role: o.role,
    eventId: o.eventId,
    startedId: o.startedId,
    index: o.index,
    ts: o.ts,
    actor: o.actor,
    phase: o.phase,
    loopId: o.loopId,
    declSource: o.declSource,
    declEventId: o.declEventId,
    command: o.command,
    outcomeClass: o.outcome === 'pass' ? 'process-pass' : o.outcome === 'fail' ? 'process-fail' : 'infra-fail',
    observationStatus: o.eligible ? 'eligible' : 'void',
    refusalReason: o.refusalReason,
    exit: o.exit,
    signal: o.signal,
    timedOut: o.timedOut,
    spawnError: o.spawnError,
    durationMs: o.durationMs,
    tier: o.tier,
    digestAlgo: o.oracle.digestAlgo,
    oracleDigest: o.oracle.digest,
    oracleFileCount: o.oracle.fileCount,
    implDigest: o.impl.digest,
    implFileCount: o.impl.fileCount,
  };
}

// Liveness — the proof is perishable by construction, and this is the COMPLETE
// list. Every condition is tested in the ACCEPTANCE_STALE_REASONS order so two
// surfaces always name the same reason for the same proof.
//
// `boundToCurrent` is a LIVENESS CONDITION, not a label (the plan's own first
// revision listed it as report-only while simultaneously calling it "visibly
// distinct from live" — an implementer following the report-only reading keeps
// the gate green for code that never produced the recorded GREEN). It is
// computed independently of which reason fires, so it is always meaningful when
// derivable: `null` means "could not be determined", which is NOT live either.
//
// Comparing digests subsumes the plan's "implementation PATH SET and digest"
// wording: paths, permission bits and entry types are all inside the digest
// preimage, so digest equality is the strictly stronger check — and the receipt
// records no path list to compare against anyway.
function livenessOf(green, ctx) {
  const cur = ctx.oracleLookup(green.acceptanceId);
  const curImpl = ctx.implLookup(green.acceptanceId);

  let boundToCurrent = null;
  if (curImpl.known && !curImpl.unavailable && green.impl.digest !== null) {
    boundToCurrent = curImpl.digest === green.impl.digest;
  }

  const redeclared = green.declEventId !== null
    && ((ctx.goalDeclEventId !== null && ctx.goalDeclEventId !== green.declEventId)
      || ctx.lastGoalDeclaredIndex > green.index);

  let staleReason = null;
  if (ctx.policy.invalid) staleReason = 'policy-invalid';
  else {
    const tsReason = isStaleTs(green.ts, ctx.nowMs, {});
    if (tsReason !== null) staleReason = tsReason;              // 'no-ts' | 'future-ts'
    else if (redeclared) staleReason = 'redeclared';
    else if (!cur.known) staleReason = 'undeclared';
    else if (cur.unavailable) staleReason = 'oracle-unavailable';
    else if (green.oracle.digest === null || cur.digest !== green.oracle.digest) staleReason = 'oracle-changed';
    else if (!curImpl.known) staleReason = 'undeclared';
    else if (curImpl.unavailable || boundToCurrent === null) staleReason = 'impl-unavailable';
    else if (boundToCurrent === false) staleReason = 'impl-moved';
    else if (ctx.policy.ttlMs !== null && isStaleTs(green.ts, ctx.nowMs, { ttlMs: ctx.policy.ttlMs }) === 'expired') staleReason = 'expired';
  }

  return {
    live: staleReason === null,
    staleReason,
    boundToCurrent,
    oracleCurrent: !cur.known ? 'undeclared'
      : cur.unavailable ? 'unavailable'
        : (green.oracle.digest !== null && cur.digest === green.oracle.digest) ? 'equal' : 'changed',
  };
}

// Derive at most one proof per acceptanceId from a VERIFIED read.
//
//   deriveProofs({ events, integrity, mode }, { goal, nowMs, currentOracleDigest,
//                                               currentImplDigest, maxProofAge })
//
// The first argument is the COMPLETE result of the verified read, forwarded
// whole and never hand-assembled. `mode` and `integrity` are therefore
// REQUIRED, and their absence throws rather than defaulting: a caller that
// passed only `events` is the exact defect the mode predicate exists to close
// (a fresh synced clone has partition segments and no active replica config, so
// an implementation that never saw `mode` would derive over a timestamp-sorted
// cross-replica list and form proofs whose RED never preceded their GREEN).
//
// FAIL-CLOSED ORDER: mode → integrity → derivation.
//   - `mode` is anything but exactly `'flat'` (including `'unknown'`, which the
//     verified read emits when it cannot tell) → { ok:false, unsupported }.
//     Refusal suppresses PROOFS, never EXECUTION; the caller still runs its
//     commands and still evaluates success conditions.
//   - `integrity` is anything but exactly `'ok'` → all proof state is
//     suppressed. Not "rendered as broken": enumerating acceptanceIds out of a
//     chain that failed verification would already be using untrusted data.
//     EVERY caller that renders proof state honours this, not only the gate —
//     `orient` reading raw events while the gate reads verified ones is two
//     surfaces disagreeing about the same receipts.
//
// ⚠ `currentImplDigest` IS REQUIRED FOR ANY PROOF TO READ `live`. The plan's
// signature line named only `currentOracleDigest`, but its own selection
// section makes `boundToCurrent` — "the GREEN's implementation digest still
// equals the current expansion" — a LIVENESS CONDITION, and there is no way to
// evaluate that from an oracle digest. So the parameter is added here, and a
// caller that omits it gets `state:'historically-proven'`,
// `staleReason:'impl-unavailable'`, `boundToCurrent:null` on EVERY proof.
// That is deliberate and fail-closed: an omitted input must not read as a
// satisfied condition, because "the gate stays green for code that never
// produced the recorded GREEN" is precisely the defect the condition exists to
// prevent. Both lookups are keyed by the CURRENT declaration's acceptanceIds.
export function deriveProofs(read, opts = {}) {
  if (!isPlainRecord(read)) {
    throw new TypeError('deriveProofs takes the verified read result { events, integrity, mode } — pass it whole, never a hand-assembled subset');
  }
  const { events, integrity, mode } = read;
  if (!Array.isArray(events)) throw new TypeError('read.events must be an array of spine events');
  if (typeof integrity !== 'string') {
    throw new TypeError('read.integrity is required — a derivation with no integrity signal would render a broken chain as proof');
  }
  if (typeof mode !== 'string') {
    throw new TypeError("read.mode is required and must be 'flat' | 'partitioned' | 'unknown' — derivation cannot know it must refuse without it");
  }
  if (!isPlainRecord(opts)) throw new TypeError('deriveProofs options must be a plain record');

  const { goal = null, nowMs, currentOracleDigest = null, currentImplDigest = null, maxProofAge = null } = opts;
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('nowMs must be a finite epoch-milliseconds number — this function never calls the clock itself, so a caller omitting it would silently disable every age check');
  }
  if (goal !== null && !isPlainRecord(goal)) throw new TypeError('goal must be a plain record or null');

  // Mode first: in a partitioned spine the ORDERING O5 rests on does not exist,
  // so nothing below is meaningful. This is checked before integrity because it
  // is the more specific and more actionable statement.
  if (mode !== 'flat') return { ok: false, unsupported: 'team-sync' };

  const oracleLookup = makeDigestLookup(currentOracleDigest, 'currentOracleDigest');
  const implLookup = makeDigestLookup(currentImplDigest, 'currentImplDigest');
  const policy = normalizeMaxProofAge(maxProofAge);

  if (integrity !== 'ok') {
    return { ok: true, proofs: new Map(), suppressed: 'integrity', integrity, mode, unattributed: 0 };
  }

  // Spine index by event IDENTITY, not by id: two events sharing an id is
  // exactly the corruption `pairVerifications` fails closed on, and looking up
  // by id would silently pick one of them.
  const indexOf = new Map();
  let lastGoalDeclaredIndex = -1;
  events.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    indexOf.set(e, i);
    if (e.type === 'GOAL_DECLARED') lastGoalDeclaredIndex = i;
  });

  const startedById = new Map();
  for (const e of events) {
    if (e && e.type === 'VERIFICATION_STARTED' && typeof e.id === 'string' && !startedById.has(e.id)) {
      startedById.set(e.id, e);
    }
  }

  const { valid, dangling } = pairVerifications(events, 'acceptance');

  const byId = new Map();          // acceptanceId -> observations (unsorted)
  let unattributed = 0;
  const add = (o) => {
    if (o.acceptanceId === null) { unattributed++; return; }
    const list = byId.get(o.acceptanceId);
    if (list) list.push(o); else byId.set(o.acceptanceId, [o]);
  };

  // Acceptance pairing needs MORE than `pairVerifications` supplies: the shared
  // recorder correlates STARTED→RAN on kind/profile alone, so with several
  // acceptances in flight a RAN could reference a STARTED belonging to a
  // different one. Identity must agree on both events.
  //
  // A disagreement poisons BOTH candidate ids as `void`, not just one: one of
  // the two events is lying about what ran, and there is no way to tell which,
  // so the safe reading is that neither acceptance has a trustworthy latest
  // observation. It supersedes; it anchors nothing.
  for (const ev of valid) {
    const index = indexOf.get(ev);
    if (index === undefined) continue;
    const o = observationFrom(ev, index);
    const s = o.startedId ? startedById.get(o.startedId) : null;
    const sd = s && isPlainRecord(s.data) ? s.data : null;
    const agrees = sd !== null
      && (sd.acceptanceId ?? null) === o.acceptanceId
      && (sd.scopeNonce ?? null) === o.scopeNonce
      && (sd.commandSha256 ?? null) === o.commandSha256;
    if (agrees) { add(o); continue; }
    const mismatched = observationFrom(ev, index, 'identity-mismatch');
    add(mismatched);
    const sid = sd && typeof sd.acceptanceId === 'string' && sd.acceptanceId.trim() ? sd.acceptanceId : null;
    if (sid !== null && sid !== o.acceptanceId) {
      add({ ...mismatched, acceptanceId: sid });
    }
  }

  // A RAN that `pairVerifications` DROPPED — orphan, duplicate-referenced, or
  // not preceded by its STARTED. `recencyFromSpine` treats those as
  // non-existent; acceptance cannot afford to. An honest crash that produces an
  // unpaired RAN would otherwise leave a stale proof rendering green while the
  // run it describes actually failed — the two-surfaces-disagreeing failure
  // again. So it anchors nothing and supersedes as `void`.
  const validSet = new Set(valid);
  events.forEach((e, i) => {
    if (!e || e.type !== 'VERIFICATION_RAN') return;
    if (!isPlainRecord(e.data) || e.data.kind !== 'acceptance') return;
    if (validSet.has(e)) return;
    add(observationFrom(e, i, 'unpaired-ran'));
  });

  for (const s of dangling) {
    if (!isPlainRecord(s.data) || s.data.kind !== 'acceptance') continue;
    const index = indexOf.get(s);
    if (index === undefined) continue;
    add(danglingFrom(s, index));
  }

  const goalDeclEventId = goal && typeof goal.declEventId === 'string' && goal.declEventId.trim() ? goal.declEventId : null;
  const ctx = { oracleLookup, implLookup, policy, nowMs, goalDeclEventId, lastGoalDeclaredIndex };

  const proofs = new Map();
  // Deterministic key order by acceptanceId (UTF-16 code unit, never
  // `localeCompare` — that is locale- and ICU-dependent, so two machines would
  // render the same spine in different orders).
  const ids = [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const acceptanceId of ids) {
    const obs = byId.get(acceptanceId).sort((a, b) => a.index - b.index);
    const greens = obs.filter((o) => o.role === 'green');
    const reds = obs.filter((o) => o.role === 'red');
    const last = obs[obs.length - 1];

    const base = {
      acceptanceId,
      state: 'unproven',
      live: false,
      reason: null,
      staleReason: null,
      tier: last.tier,
      digestAlgo: last.oracle.digestAlgo,
      red: null,
      green: null,
      boundToCurrent: null,
      oracleCurrent: 'unknown',
      previouslyProven: false,
      supersededBy: null,
      clauses: null,
      scanTruncated: false,
      observations: obs.length,
      latest: refOf(last),
      // DESCRIPTIVE ONLY — gates nothing, and must never be rendered as though
      // it did. A Máddu actor is an unauthenticated session id from
      // MADDU_SESSION_ID; "declarer ≠ greener" is content-free as a control.
      // O3+O5 (the impl digest moved, and the RED precedes the GREEN) are the
      // content-bound replacement.
      independence: null,
      // Not derivable from these inputs. Anchor state comes from the OTS
      // commitment ladder and an operator's ASSURANCE_ASSESSED record, neither
      // of which is an input here. `null` rather than a guess: rendering
      // `unanchored` for "I did not look" would be a claim this file cannot
      // support.
      anchorState: null,
    };

    if (last.role === 'green') {
      const p = pairFor(last, reds);
      base.scanTruncated = p.truncated;
      base.clauses = p.clauses;
      if (p.red) {
        const liveness = livenessOf(last, ctx);
        base.red = refOf(p.red);
        base.green = refOf(last);
        base.previouslyProven = true;
        base.boundToCurrent = liveness.boundToCurrent;
        base.oracleCurrent = liveness.oracleCurrent;
        base.staleReason = liveness.staleReason;
        base.independence = {
          redActor: p.red.actor, greenActor: last.actor,
          distinct: p.red.actor !== null && last.actor !== null ? p.red.actor !== last.actor : null,
        };
        if (liveness.live) {
          base.state = 'live';
          base.live = true;
          base.reason = 'RED→GREEN against a frozen oracle, still bound to the current bytes';
        } else {
          base.state = 'historically-proven';
          base.reason = `proven once, not live: ${liveness.staleReason}`;
        }
      } else {
        // A pass that cannot re-anchor. NOT a fallback to an older pair: an
        // implementation reverted to the RED's bytes would otherwise be
        // re-greened by a later environment-drift pass, with O3 no longer
        // holding for the observation that actually ran.
        const prior = everProven(greens, reds, last.index);
        base.previouslyProven = prior.proven;
        base.scanTruncated = base.scanTruncated || prior.truncated;
        base.supersededBy = prior.proven ? refOf(last) : null;
        base.reason = reds.length === 0
          ? 'no proof — this command has never been observed to exit nonzero'
          : prior.proven
            ? `proven once, but the latest pass re-anchors nothing (${failedClauses(p.clauses)}) — not re-affirmed`
            : `no qualifying RED for the latest pass (${failedClauses(p.clauses)})`;
      }
    } else if (last.role === 'red') {
      const prior = everProven(greens, reds, last.index);
      base.previouslyProven = prior.proven;
      base.scanTruncated = prior.truncated;
      base.supersededBy = refOf(last);
      if (prior.proven) {
        base.state = 'regressed';
        base.red = refOf(prior.red);
        base.green = refOf(prior.green);
        base.clauses = prior.clauses;
        base.reason = 'proven once, currently exiting nonzero';
      } else {
        base.supersededBy = null;
        base.reason = 'observed to exit nonzero; no passing observation has been paired with it yet';
      }
    } else {
      // infra-fail, void, dangling STARTED, or a corrupt receipt. First-class
      // `indeterminate`, never a silent fallthrough — the environment, not the
      // code, is what is unproven, and a stale proof must not keep rendering
      // green underneath it.
      const prior = everProven(greens, reds, last.index);
      base.state = 'indeterminate';
      base.previouslyProven = prior.proven;
      base.scanTruncated = prior.truncated;
      base.supersededBy = refOf(last);
      base.reason = last.role === 'dangling'
        ? 'a run started and recorded no result'
        : last.role === 'infra'
          ? 'the latest observation did not complete (timeout, signal, spawn error or null exit) — not a valid RED and not a pass'
          : `the latest observation anchors nothing (${last.refusalReason || 'void'})`;
    }

    proofs.set(acceptanceId, base);
  }

  return { ok: true, proofs, suppressed: null, integrity, mode, unattributed };
}

// Which clauses failed, for a readout that must say more than "no proof".
function failedClauses(clauses) {
  if (!clauses) return 'no preceding RED observation';
  const failed = ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8'].filter((k) => clauses[k] === false);
  return failed.length ? `nearest RED fails ${failed.join(', ')}` : 'no preceding RED observation';
}

