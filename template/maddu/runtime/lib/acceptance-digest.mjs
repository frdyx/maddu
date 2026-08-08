// acceptance-digest — stable fingerprints for verification-receipt identity.
//
// WHY THIS EXISTS
// A `VERIFICATION_RAN` receipt records THAT something was verified, not WHAT
// was run: two `profile:'quick'` receipts are indistinguishable on the spine
// even if they selected entirely different test sets. These helpers produce the
// digests that tell them apart.
//
// WHAT A FINGERPRINT BINDS — and what it does not
// The DECLARED plan only: task ids, command strings, working directories (and,
// for goals, condition text + verifier). It does NOT bind the resolved
// executable, PATH, environment, repo revision, package.json script bodies,
// runner configuration, or which tests a command discovers at runtime. Two
// `npm test` receipts can share a fingerprint while running different tests
// after a config change. Call this a task-plan fingerprint, never "identity of
// what ran".
//
// TWO LAWS, both learned the hard way:
//
//   1. NEVER REUSE `sha256Normalized` FROM content-pins.mjs HERE. It collapses
//      CRLF→LF, its `buf.includes(0)` binary probe searches for the CHARACTER
//      "0" when handed a string, and its latin1 round-trip is lossy for
//      non-ASCII. All three merge inputs that must stay distinct.
//
//   2. A FALSE DIFFERENCE IS SAFE; A FALSE MATCH IS NOT. Every encoding here is
//      injective by construction. `Buffer.from(str,'utf8')` is NOT: an unpaired
//      surrogate and U+FFFD both encode to `ef bf bd`. So every digest is taken
//      over `JSON.stringify` of a domain-tagged structure — JSON escapes
//      unpaired surrogates to distinct sequences, restoring injectivity, and the
//      domain tag stops a digest from one purpose being mistaken for another.
//      Distinctness holds up to SHA-256 collision resistance, nothing stronger.
//
// Node stdlib only (hard rule 4). Pure — no I/O, no spine, no process state.

import { createHash } from 'node:crypto';
import { sep } from 'node:path';

const COMMAND_TAG = 'maddu.command.v1';
const TASK_PLAN_TAG = 'maddu.task-plan.v1';
const CONDITION_PLAN_TAG = 'maddu.condition-plan.v1';

function sha256Json(value) {
  return createHash('sha256').update(Buffer.from(JSON.stringify(value), 'utf8')).digest('hex');
}

// Digest of a single command string. Raw — deliberately NOT normalized, so
// `npm test` and `npm  test` differ: they are different strings to the shell,
// and a false difference ("you must re-check") is the safe direction.
// Non-string input yields null rather than throwing (see totality note below).
export function commandDigest(str) {
  if (typeof str !== 'string') return null;
  return sha256Json([COMMAND_TAG, str]);
}

// Canonicalize the platform's OWN separator only.
//
// The runner emits native separators, so on Windows `test\sub` and `test/sub`
// name the same directory and must fingerprint alike. On POSIX a backslash is a
// LEGAL FILENAME CHARACTER: `a\b` is a directory literally called "a\b", which
// is NOT `a/b`. An earlier revision replaced every backslash unconditionally,
// which fixed a false difference on Windows by creating a FALSE MATCH on POSIX —
// the trade this module exists to refuse. So the substitution is gated on the
// host separator.
const BACKSLASH = String.fromCharCode(92);
const NATIVE_SEP_IS_BACKSLASH = sep === BACKSLASH;
function canonPath(p) {
  if (typeof p !== 'string') return '';
  return NATIVE_SEP_IS_BACKSLASH ? p.split(BACKSLASH).join('/') : p;
}

// Lossless encoding of a JSON-compatible value, for identity terms.
//
// THROWS on anything it cannot encode losslessly. That is deliberate and the
// callers rely on it: conditionPlanFields wraps the call in try/catch and omits
// identity entirely on error (success-eval.mjs), so an unencodable value yields
// NO identity rather than a shared one. An earlier revision collapsed such
// values to a type tag and justified it by claiming a throw would leave a
// dangling STARTED — which was simply false about that call site.
//
// -0 is distinguished from 0: JSON.stringify maps both to "0", so without this
// two distinct declared values would share a term.
// `undefined` is an ABSENCE, not an encoding failure, and it is the common case:
// a condition declared with only a verifier has no `text`. Throwing on it would
// omit identity for ordinary goals. It gets its own term so it stays
// distinguishable from `null` (which encodes as the string "null").
function valueTerm(v) {
  if (v === undefined) return ['u'];
  if (Object.is(v, -0)) return ['n', '-0'];
  if (typeof v === 'bigint') throw new TypeError('bigint is not JSON-encodable');
  const json = JSON.stringify(v);              // throws on circular
  // Functions and symbols also stringify to undefined — genuinely unencodable.
  if (typeof json !== 'string') throw new TypeError('value is not JSON-encodable');
  return ['j', json];
}

// Fingerprint of a SELECTED task plan.
//
// `descriptors` is [{ id, command, cwd }] for every selected task — including
// tasks that never executed (a `--bail` run stops early, and digesting only the
// executed results would make two plans sharing a first failing task
// fingerprint identically, which is exactly the guarantee this defeats).
//
// ORDER IS PART OF THE FINGERPRINT, and that is a correction, not a preference.
// An earlier revision sorted a copy and declared execution order irrelevant
// "because only the selected set matters". It does matter: runProjectTest walks
// plan.tasks IN ORDER and breaks at the first failure under --bail
// (_project-test-runner.mjs:549-555), so [pass, fail] runs two tasks while
// [fail, pass] runs one. Sorting made those two genuinely different plans share
// a digest — a FALSE MATCH, the exact direction this module exists to prevent.
//
// Multiplicity is preserved and duplicate ids are NOT rejected: ids are trimmed
// in one place and keyed untrimmed in another, so "x" and " x " can both
// legitimately execute today, and refusing them would be a behaviour change.
export function planFingerprint(descriptors) {
  const rows = (Array.isArray(descriptors) ? descriptors : []).map((d) => [
    typeof d?.id === 'string' ? d.id : '',
    commandDigest(d?.command) ?? '',
    canonPath(d?.cwd),
  ]);
  return sha256Json([TASK_PLAN_TAG, rows]);
}

// One condition's verifier term. Strings hash through commandDigest; every
// other JSON-encodable value is encoded losslessly; anything else THROWS, which
// makes the whole condition-plan identity absent rather than shared.
export function verifierTerm(cond) {
  const v = cond?.verify;
  return typeof v === 'string' ? ['s', commandDigest(v)] : ['x', valueTerm(v)];
}

// Fingerprint of a goal's DECLARED condition plan.
//
// Source is `goal.success` in DECLARATION ORDER — not `result.evaluated`, and
// not sorted: the operator's ordering is part of the declaration. `text` is
// paired with its own verifier in one tuple, so swapping two conditions'
// verifiers changes the digest.
export function conditionPlanFingerprint(success) {
  // `text` gets the SAME lossless treatment as the verifier. Mapping every
  // non-string text to null made [{text:1,…}] and [{text:2,…}] share a digest —
  // both are contract-valid, since GOAL_DECLARED.success constrains only the
  // outer array. Fixing `verify` and leaving `text` collapsed would have been
  // the same defect one field over.
  const rows = (Array.isArray(success) ? success : []).map((c) => [
    typeof c?.text === 'string' ? ['s', c.text] : ['x', valueTerm(c?.text)],
    verifierTerm(c),
  ]);
  return sha256Json([CONDITION_PLAN_TAG, rows]);
}
