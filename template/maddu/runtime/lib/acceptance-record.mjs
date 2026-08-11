// acceptance-record — phase 2b of the acceptance proof: `observeAcceptance`,
// the one function that RECORDS an acceptance observation. It is a CALLER of
// `./acceptance.mjs` (the single public entry — never its siblings), per that
// file's header, and it owns no primitive of its own: the lock and the
// execution come from phase 2a, identity and digests from phase 1a, and the
// spine append from the shared recorder in `verification-recency.mjs`.
//
// EXECUTION AND RECEIPT-ELIGIBILITY ARE SEPARATE DECISIONS, and that separation
// is the load-bearing rule of this module. The declared command runs EXACTLY
// ONCE on every path that reaches the lock — team-sync, an unsupported tier, a
// pre-hash refusal and an overlapping declared set all RUN it and record a VOID
// receipt — and the process result is returned to the caller regardless of what
// the receipt says. Suppressing execution because a receipt cannot be earned
// would silently stop `orient` evaluating success conditions the moment a
// repository upgraded into a state this phase does not support: a governance
// feature quietly disabling an unrelated one. The ONLY paths that do not run
// the command are the four that cannot honestly run it:
//   - a caller-bug THROW (bad roots/decl/rctx/ctx) — nothing is recorded;
//   - a blank command (`refuseBlankCommand`) — nothing is recorded;
//   - a `decl.cwd` that is not `roots.workRoot` — nothing is recorded;
//   - lock-busy — a VOID pair IS recorded, because running unlocked is the
//     exact race the lock exists to close.
//
// A RECEIPT PAIR EXISTS FOR EVERY INVOCATION THAT REACHES LOCK ACQUISITION.
// That is the one rule; everything else decides which reason the pair carries.
// The three pre-lock refusals above are the complete list of invocations that
// record nothing at all.
//
// RECEIPTS APPEND TO THE STATE ROOT; digests are taken against the WORK root.
// An attached lane worktree has its own work root and shares ONE state root
// with the primary checkout, so a receipt appended to `workRoot` would land in
// a spine nobody reads while the observation lock (also state-root anchored)
// serialized against a different file entirely.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: it never READS the spine. It
// appends two events and returns; the verdict over them is `deriveProofs`'s
// job, from a VERIFIED read, and an observer that also derived would be the
// actor grading its own receipt. It also does not capture a subject — the tier
// on the receipt is the DECLARED policy, labelled as such (see below), and
// `captureSubject` (a later phase) replaces it with observed evidence.
//
// Node stdlib plus four local imports: the acceptance entry, the standalone
// command digest, the shared recorder and the canonical redactor.

import { resolve } from 'node:path';

import {
  acceptanceIdFor,
  implDigest,
  oracleDigest,
  refuseBlankCommand,
  runAcceptanceCommand,
  withAcceptanceLock,
} from './acceptance.mjs';
// NOT a split sibling of the acceptance family: acceptance-digest.mjs is the
// standalone receipt-identity module that acceptance-core.mjs itself imports.
// The "import from the entry, never a sibling" law is about the three phase
// modules, not about this one.
import { commandDigest } from './acceptance-digest.mjs';
import { redactText } from './secret-scan.mjs';
import { recordVerification } from './verification-recency.mjs';

// The receipt `kind`. `deriveProofs` selects acceptance observations by exactly
// this string, so it is not a label — changing it orphans every prior receipt.
const RECEIPT_KIND = 'acceptance';

// The only tier policy this phase can honour. A declaration naming any other
// one still RUNS (eligibility is a separate axis) but records a void receipt:
// a proof pairing observations from two different tiers would compare evidence
// gathered under different isolation guarantees.
const SUPPORTED_TIER_POLICY = 'worktree';

// `runAcceptanceCommand` THROWS on an absent `timeoutMs` — deliberately, since
// an observation with no execution deadline hangs forever holding the lock. So
// the default is named here and resolved BEFORE the lock is taken: resolving it
// inside would turn a defaulting decision into a throw with a STARTED already
// on the spine.
export const DEFAULT_OBSERVE_TIMEOUT_MS = 600000; // 10 minutes

// Stored in place of the command when the canonical redactor is unusable. The
// raw text is NEVER the fallback: the persisted field is operator-authored and
// may carry a secret, so a redactor failure yields no command on the receipt
// rather than an unscrubbed one. Identity is unaffected — `commandSha256`
// hashes the RAW command, so display and identity cannot drift apart.
const COMMAND_UNREDACTABLE = '[REDACTION-UNAVAILABLE]';

function isPlainRecord(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// The same seven-key refusal shape `acceptance-core.mjs` uses, duplicated
// rather than imported because that helper is internal to the family. A caller
// must never have to test which fields exist, so the refusals minted here and
// the ones handed back from `refuseBlankCommand` are indistinguishable in
// shape.
function refusal(reason, refusalClass, detail) {
  return { ok: false, reason, refusalClass, detail, pattern: null, patternIndex: null, path: null };
}

// Both roots are required. `workRoot` is where the command runs and what the
// digests describe; `stateRoot` is where the receipts and the lock live. A bare
// string is the exact bug the pair exists to prevent and is refused loudly.
function requireRootsPair(roots) {
  if (typeof roots === 'string') {
    throw new TypeError('observeAcceptance takes roots = { workRoot, stateRoot } — a bare root string would run the command in one checkout and record the receipt in another');
  }
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
    throw new TypeError('observeAcceptance takes roots = { workRoot, stateRoot }');
  }
  const { workRoot, stateRoot } = roots;
  if (typeof workRoot !== 'string' || !workRoot.trim()) {
    throw new TypeError('roots.workRoot must be a non-blank path — expansion, hashing and execution all run against the WORK root');
  }
  if (typeof stateRoot !== 'string' || !stateRoot.trim()) {
    throw new TypeError('roots.stateRoot must be a non-blank path — receipts append to the STATE root spine, which attached lane worktrees share, so a workRoot receipt would land in a spine no reader consults');
  }
  return { workRoot, stateRoot };
}

// Lexical resolution only — no `realpath`. A symlinked spelling of the work
// root therefore REFUSES rather than resolving through, which is the safe
// direction here: nothing runs and nothing is recorded. Case-insensitive on
// win32 only, matching `runAcceptanceCommand`'s own cwd handling — there the
// same directory is routinely spelled with a different drive-letter case, while
// on POSIX two casings are two different directories.
function sameDirectory(a, b) {
  const norm = (p) => {
    const r = resolve(p);
    const trimmed = r.replace(/[\\/]+$/, '');
    return trimmed || r;
  };
  const na = norm(a);
  const nb = norm(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function finitePositive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// The persisted `command`. Fail-closed: a redactor that throws or returns an
// unexpected shape yields the placeholder, never the raw string.
function persistedCommand(raw) {
  try {
    const r = redactText(raw);
    if (r && typeof r.text === 'string') return r.text;
  } catch { /* fall through to the placeholder */ }
  return COMMAND_UNREDACTABLE;
}

// One declared set as the receipt records it.
//
// `stable` is STRICTLY the boolean `digest === digestAfter` over two non-blank
// strings — never `true` because both endpoints are missing. A set that was
// never hashed (team-sync, a refused expansion, a run that never happened) is
// recorded with null endpoints and `stable:false`, so O6 can never be satisfied
// by omission. `patterns` is copied so a caller mutating its declaration after
// the call cannot change what was recorded.
function setRecord(patterns, pre, post) {
  const ok = pre !== null && pre.ok === true;
  const digest = ok ? pre.digest : null;
  const digestAfter = post !== null && post.ok === true ? post.digest : null;
  return {
    patterns: Array.isArray(patterns) ? [...patterns] : null,
    fileCount: ok ? pre.fileCount : null,
    digest,
    digestAfter,
    stable: typeof digest === 'string' && digest.trim() !== '' && digest === digestAfter,
    digestAlgo: ok ? pre.digestAlgo : null,
  };
}

// The first path declared by BOTH sets, or null. O8's disjointness half is
// checked HERE, on the EXPANDED relative paths, because it is the half no
// reader can reconstruct: a receipt records patterns and counts, not paths, so
// `deriveProofs` can only catch a pattern string appearing in both lists.
// Distinct patterns expanding onto the same file is exactly the case that
// reaches this function and nothing downstream.
function firstOverlap(oraclePaths, implPaths) {
  if (!Array.isArray(oraclePaths) || !Array.isArray(implPaths)) return null;
  const seen = new Set(oraclePaths);
  for (const p of implPaths) if (seen.has(p)) return p;
  return null;
}

// Resolve the spine the receipts append through, accepting either the raw spine
// module or the `{spine, actor, lane}` wrapper the existing callers pass, and
// re-wrapping it with this observation's actor/lane. A spine with no `append`
// is a CALLER BUG and throws: the recorder's best-effort discipline covers an
// append that FAILS (recorded honestly as `recorded:false`), not a caller that
// never supplied a spine at all, and silently degrading would break the one
// rule this module states — that reaching the lock always writes a pair.
function requireSpineLib(spineLib, actor, lane) {
  const spine = spineLib && spineLib.append ? spineLib : (spineLib && spineLib.spine) || null;
  if (!spine || typeof spine.append !== 'function') {
    throw new TypeError('rctx.spineLib must expose an appendable spine (the spine module, or { spine, … }) — an observation that reaches the lock always records a receipt pair, so an absent spine is a caller bug, not a degraded mode');
  }
  return { spine, actor, lane };
}

function optionalString(v, label) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new TypeError(`rctx.${label}, when present, must be a string`);
  return v;
}

// Observe one declared acceptance: run its command under the observation lock
// and record the STARTED → RAN receipt pair that `deriveProofs` later reasons
// over.
//
//   observeAcceptance(roots, decl, rctx, ctx)
//
// `decl` is EXACTLY the closed identity record `acceptanceIdFor` takes
// ({command, cwd, declEventId, scopeNonce, oraclePatterns, implPatterns,
// tierPolicy, schemaVersion}); an unknown key throws there, which is the
// identity-domain law and is kept rather than worked around. Receipt-only
// context rides in `rctx` ({declSource, phase?, loopId?, spineLib, actor?,
// lane?}) precisely so it can never leak into the identity computation, and
// execution knobs ride in `ctx` ({mode, nowMs, timeoutMs?, maxWaitMs?,
// maxOutputBytes?}).
//
// `ctx.mode` is the CALLER's verified read mode. A missing or non-string value
// becomes `'unknown'`, which is not `'flat'` and therefore voids the receipt —
// the same fail-closed default `deriveProofs` applies, so the two surfaces
// cannot disagree about whether a partitioned checkout supports proofs.
// `ctx.nowMs` is accepted for symmetry with the derivation side and
// deliberately UNUSED: every timestamp on a receipt is stamped by the spine
// append, and a caller-supplied clock in the payload would be a second, more
// malleable answer to a question the envelope already answers.
//
// Returns, when the command executed:
//   { ok:true, ran:{exit, signal, timed_out, spawn_error, outcome_class,
//     duration_ms}, receipt:{recorded, eligible, refusal_reason, acceptanceId} }
// `receipt.recorded:false` means an append failed — the run still happened and
// its result is still returned. Lock-busy returns the 2a refusal with the void
// receipt attached; the three pre-lock refusals return a typed refusal alone.
export async function observeAcceptance(roots, decl, rctx, ctx = {}) {
  const { workRoot, stateRoot } = requireRootsPair(roots);
  if (!isPlainRecord(decl)) throw new TypeError('observeAcceptance takes a plain declaration record');
  if (!isPlainRecord(rctx)) throw new TypeError('observeAcceptance takes a plain receipt-context record as its third argument');
  if (!isPlainRecord(ctx)) throw new TypeError('observeAcceptance options must be a plain record');

  const declSource = rctx.declSource;
  if (typeof declSource !== 'string' || !declSource.trim()) {
    throw new TypeError('rctx.declSource must be a non-blank string — a receipt that cannot say where its declaration came from is unattributable');
  }
  const phase = optionalString(rctx.phase, 'phase');
  const loopId = optionalString(rctx.loopId, 'loopId');
  const spineLib = requireSpineLib(rctx.spineLib, optionalString(rctx.actor, 'actor'), optionalString(rctx.lane, 'lane'));

  // Blankness is refused before anything observable happens: a blank command is
  // a shell no-op that exits 0, so running one would manufacture a process-pass
  // for a verifier that verified nothing.
  const blank = refuseBlankCommand(decl.command);
  if (blank.ok !== true) return blank;

  // Throws on every caller bug in the declaration (unknown key, wrong type, a
  // nonce on a goal-declared acceptance) BEFORE the cwd check, so the cwd
  // comparison below always runs on a validated string.
  const acceptanceId = acceptanceIdFor(decl);
  const commandSha256 = commandDigest(decl.command);

  // `decl.cwd` IS AN IDENTITY TERM, so execution must honour it or the receipt
  // describes a run that happened somewhere the identity does not name. This
  // phase runs everything in `roots.workRoot` and therefore REFUSES any other
  // cwd rather than silently running in the work root anyway (a false receipt)
  // or running outside it (unbound by the digests). It is the narrowest sound
  // choice; supporting a sub-directory cwd is a later phase's decision, because
  // it needs a rule for what the digests then describe.
  if (!sameDirectory(decl.cwd, workRoot)) {
    return refusal('cwd-not-work-root', 'set-invalid', 'the declared cwd is not the work root — this phase executes every observation in roots.workRoot, and running a command somewhere its own identity does not name would record a receipt about a different run');
  }

  // Every execution bound is resolved and validated PRE-LOCK. Each of these
  // would otherwise throw from inside `run()` — after the STARTED append — and
  // leave a dangling receipt for what is a caller bug, not a crashed run.
  const timeoutMs = ctx.timeoutMs === undefined ? DEFAULT_OBSERVE_TIMEOUT_MS : ctx.timeoutMs;
  if (!finitePositive(timeoutMs)) {
    throw new TypeError('ctx.timeoutMs must be a finite positive number of milliseconds when present — an absent or infinite execution deadline is how an observation hangs forever holding the observation lock');
  }
  const { maxWaitMs, maxOutputBytes } = ctx;
  if (maxWaitMs !== undefined && !finitePositive(maxWaitMs)) {
    throw new TypeError('ctx.maxWaitMs must be a finite positive number of milliseconds when present');
  }
  if (maxOutputBytes !== undefined && !(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0)) {
    throw new TypeError('ctx.maxOutputBytes must be a positive safe integer when present');
  }

  const mode = typeof ctx.mode === 'string' ? ctx.mode : 'unknown';

  // The fields BOTH events carry. `deriveProofs` checks identity agreement on
  // {acceptanceId, scopeNonce, commandSha256} across the pair, so one object
  // feeds both appends — two hand-written copies is how they drift into a
  // void/'identity-mismatch' receipt.
  const identity = {
    acceptanceId,
    scopeNonce: decl.scopeNonce ?? null,
    commandSha256,
    declEventId: decl.declEventId ?? null,
    declSource,
    phase,
    loopId,
  };

  // O7 requires a non-null EQUAL tier on both observations of a pair, so a
  // receipt without one makes every proof impossible. In this phase the tier is
  // the DECLARED policy rather than captured evidence, and the receipt says so:
  // `source:'declared-policy'` is what stops a later reader mistaking it for an
  // observed subject. Written ONLY for the supported policy — labelling an
  // unsupported tier would let two receipts agree on a tier neither honoured.
  const subject = decl.tierPolicy === SUPPORTED_TIER_POLICY
    ? { tier: decl.tierPolicy, source: 'declared-policy' }
    : null;

  const command = persistedCommand(decl.command);

  // Build the RAN payload. It is merged OVER the recorder's shared defaults
  // ({kind, startedId, profile, complete, result, counts}), so `complete` and
  // `result` are overridden here honestly rather than inheriting the recorder's
  // optimistic `true`/`'pass'`: `complete` means the run settled without a
  // spawn error, and `result` is `'pass'` only for a genuine `process-pass`.
  const ranPayload = ({ voidReason, ran, oracle, impl }) => {
    const data = {
      ...identity,
      observation_status: voidReason === null ? 'eligible' : 'void',
      refusal_reason: voidReason,
      command,
      exit: ran === null ? null : ran.exit,
      signal: ran === null ? null : ran.signal,
      timed_out: ran !== null && ran.timed_out === true,
      spawn_error: ran !== null && ran.spawn_error === true,
      duration_ms: ran === null ? null : ran.duration_ms,
      // NO RUN ⇒ NO OUTCOME. `outcome_class` is null rather than 'infra-fail'
      // when the command never executed: the consumer already fail-closes an
      // unrecognised value to `infra`, so nothing is lost, while asserting an
      // infra failure the process never reported would be a claim about a run
      // that did not happen. The KEY is present on every path, so the payload
      // shape never depends on which branch produced it.
      outcome_class: ran === null ? null : ran.outcome_class,
      complete: ran !== null && ran.settled === true && ran.spawn_error !== true,
      result: ran !== null && ran.outcome_class === 'process-pass' ? 'pass' : 'fail',
      counts: null,
      oracle,
      impl,
    };
    if (subject !== null) data.subject = subject;
    return data;
  };

  const receiptOf = (rec, voidReason) => ({
    // BOTH appends must have landed. A STARTED with no RAN is a dangling
    // receipt, which the consumer reads as `indeterminate` — reporting that as
    // "recorded" would tell a caller its observation is on the record when what
    // is on the record invalidates the previous proof and establishes nothing.
    recorded: rec.startedId !== null && rec.ranId !== null,
    eligible: voidReason === null && rec.startedId !== null && rec.ranId !== null,
    refusal_reason: voidReason,
    acceptanceId,
  });

  // A receipt pair for an observation that did NOT run: the command is not
  // executed, both declared sets are recorded as declared-but-unhashed, and the
  // pair supersedes as void.
  const recordVoidPair = async (voidReason) => {
    const rec = await recordVerification(stateRoot, spineLib, {
      kind: RECEIPT_KIND,
      profile: null,
      startedData: { ...identity },
      run: async () => null,
      derive: () => ranPayload({
        voidReason,
        ran: null,
        oracle: setRecord(decl.oraclePatterns, null, null),
        impl: setRecord(decl.implPatterns, null, null),
      }),
    });
    return receiptOf(rec, voidReason);
  };

  // THE LOCK COMES FIRST — before the team-sync decision, before any hashing.
  // Running an observed command outside it lets that command mutate files
  // inside another observer's pre/post-hash window, which is the one thing an
  // endpoint comparison structurally cannot see.
  const attempt = await withAcceptanceLock(roots, async () => {
    // The FIRST void reason wins, so two surfaces reporting the same
    // observation always name the same cause.
    let voidReason = null;
    const note = (reason) => { if (voidReason === null) voidReason = reason; };

    // TEAM-SYNC: hashing is SKIPPED, not merely voided. Digests of a
    // partitioned checkout would describe the wrong tree, and a recorded digest
    // that describes the wrong tree is worse than an absent one — the receipt
    // would carry evidence-shaped values nothing may compare.
    const hashable = mode === 'flat';
    if (!hashable) note('unsupported-team-sync');
    if (decl.tierPolicy !== SUPPORTED_TIER_POLICY) note('unsupported-tier-policy');

    // PRE-HASH BEFORE THE STARTED APPEND. A refusal here precedes the receipt
    // pair entirely, so an expansion that could not be computed never leaves a
    // dangling STARTED for a run that had not begun. Both sets are hashed even
    // when the first refuses: a half-recorded receipt would read as "the impl
    // set was unavailable" for a reason that never applied to it.
    let preOracle = null;
    let preImpl = null;
    if (hashable) {
      preOracle = await oracleDigest(roots, decl.oraclePatterns);
      preImpl = await implDigest(roots, decl.implPatterns);
      if (preOracle.ok !== true) note(preOracle.reason);
      if (preImpl.ok !== true) note(preImpl.reason);
      if (preOracle.ok === true && preImpl.ok === true && firstOverlap(preOracle.paths, preImpl.paths) !== null) {
        note('sets-overlap');
      }
    }

    let ran = null;
    let postOracle = null;
    let postImpl = null;

    const rec = await recordVerification(stateRoot, spineLib, {
      kind: RECEIPT_KIND,
      profile: null,
      startedData: { ...identity },
      run: async () => {
        // Runs on EVERY path that got here — a void reason above changes what
        // is claimed, never whether the command executed.
        ran = await runAcceptanceCommand({ command: decl.command, cwd: workRoot, timeoutMs, maxOutputBytes });

        // POST-HASH only where a pre-hash succeeded: an endpoint pair needs
        // both ends, and a `digestAfter` with no `digest` compares against
        // nothing. A refusal OR a throw here is recoverable — recorded as
        // `digestAfter:null` + `stable:false` on the affected set and voiding
        // the receipt, never abandoning the RAN and leaving a dangling STARTED.
        let postFailed = false;
        if (preOracle !== null && preOracle.ok === true) {
          try { postOracle = await oracleDigest(roots, decl.oraclePatterns); } catch { postOracle = null; }
          if (postOracle === null || postOracle.ok !== true) { postOracle = null; postFailed = true; }
        }
        if (preImpl !== null && preImpl.ok === true) {
          try { postImpl = await implDigest(roots, decl.implPatterns); } catch { postImpl = null; }
          if (postImpl === null || postImpl.ok !== true) { postImpl = null; postFailed = true; }
        }
        if (postFailed) note('posthash-failed');
        return ran;
      },
      // Synchronous, over results captured above — the recorder calls it after
      // `run()` settles, so every field it reads is already final.
      derive: () => ranPayload({
        voidReason,
        ran,
        oracle: setRecord(decl.oraclePatterns, preOracle, postOracle),
        impl: setRecord(decl.implPatterns, preImpl, postImpl),
      }),
    });

    return { ran, receipt: receiptOf(rec, voidReason) };
  }, { maxWaitMs });

  if (attempt.ok !== true) {
    // LOCK-BUSY — the only path that records a pair without running anything.
    // The void supersedes, which is deliberate: a lock-busy observation must
    // not leave a previous proof rendering green while another observer's run
    // is mid-flight. If that holder's own RAN lands afterwards it is simply
    // newer evidence and supersedes the void in turn; neither ordering leaves a
    // stale proof live.
    return { ...attempt, receipt: await recordVoidPair('lock-busy') };
  }

  const { ran, receipt } = attempt.value;
  return {
    ok: true,
    ran: {
      exit: ran.exit,
      signal: ran.signal,
      timed_out: ran.timed_out,
      spawn_error: ran.spawn_error,
      outcome_class: ran.outcome_class,
      duration_ms: ran.duration_ms,
    },
    receipt,
  };
}
