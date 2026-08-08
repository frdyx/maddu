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

// Locale-INDEPENDENT UTF-16 code-unit comparator. Never `localeCompare`, whose
// ordering differs across runtimes and locales for non-ASCII and case — a
// golden digest computed under one collation would not reproduce under another.
function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTuple(a, b) {
  return compareCodeUnits(a[0], b[0])
    || compareCodeUnits(a[1] ?? '', b[1] ?? '')
    || compareCodeUnits(a[2] ?? '', b[2] ?? '');
}

// Fingerprint of a SELECTED task plan.
//
// `descriptors` is [{ id, command, cwd }] for every selected task — including
// tasks that never executed (a `--bail` run stops early, and digesting only the
// executed results would make two plans sharing a first failing task
// fingerprint identically, which is exactly the guarantee this defeats).
//
// MULTIPLICITY IS PRESERVED and duplicates are NOT rejected: ids are trimmed in
// one place and keyed untrimmed in another, so "x" and " x " can both legitimately
// execute today. Sorting a COPY by the full (id, commandDigest, cwd) tuple gives
// a total order without requiring ids to be unique, and never touches execution
// order — which is deliberately not part of the fingerprint.
export function planFingerprint(descriptors) {
  const rows = (Array.isArray(descriptors) ? descriptors : []).map((d) => [
    typeof d?.id === 'string' ? d.id : '',
    commandDigest(d?.command) ?? '',
    typeof d?.cwd === 'string' ? d.cwd : '',
  ]);
  rows.sort(compareTuple);
  return sha256Json([TASK_PLAN_TAG, rows]);
}

// One condition's verifier term, kept TOTAL over what the contract permits.
// `GOAL_DECLARED.success` constrains only the outer array, so `{verify: 42}` is
// representable; `evalCondition` already tolerates it (spawn throws, condition
// reports `pending`). A string-only helper would throw here, be swallowed by
// `recordSuccessEvalFinish`'s outer catch, leave a dangling STARTED and change
// the rendered verdict — a behaviour change in a recording-only path.
//
// Non-strings are encoded BY TYPE rather than collapsed to one value, so
// `{verify:42}` and `{verify:null}` stay distinguishable. Two different numbers
// do NOT: the term records `[object Number]`, not the number. That equivalence
// class is deliberate and documented, not an oversight.
export function verifierTerm(cond) {
  const v = cond?.verify;
  return typeof v === 'string'
    ? ['s', commandDigest(v)]
    : ['x', Object.prototype.toString.call(v)];
}

// Fingerprint of a goal's DECLARED condition plan.
//
// Source is `goal.success` in DECLARATION ORDER — not `result.evaluated`, and
// not sorted: the operator's ordering is part of the declaration. `text` is
// paired with its own verifier in one tuple, so swapping two conditions'
// verifiers changes the digest.
export function conditionPlanFingerprint(success) {
  const rows = (Array.isArray(success) ? success : []).map((c) => [
    typeof c?.text === 'string' ? c.text : null,
    verifierTerm(c),
  ]);
  return sha256Json([CONDITION_PLAN_TAG, rows]);
}
