// acceptance — the core of the acceptance proof (RED → GREEN against a FROZEN
// oracle). Phase 1a is identity, refusals, expansion and digests; phase 1b is
// `deriveProofs`, the read-time verdict; phase 2a adds the two OBSERVATION
// PRIMITIVES at the bottom — `withAcceptanceLock` (mutual exclusion between two
// observations sharing one state root) and `runAcceptanceCommand` (settle-once
// execution with a bounded output fingerprint). `observeAcceptance` itself,
// `captureSubject`, the receipt append and the gate are deliberately NOT here —
// they are later phases and every one of them is a CALLER of this file.
//
// WHAT AN ACCEPTANCE PROOF CLAIMS
// That one declared command exited NONZERO and later exited ZERO while the
// declared ORACLE bytes stayed identical and the declared IMPLEMENTATION bytes
// moved. That is a process-level statement, never an assertion-level one: a
// missing module, a bad config or an unresolvable interpreter all exit nonzero
// too. Every readout says "exited nonzero", never "failed a test". The full
// list lives in ACCEPTANCE_HONEST_LIMITS at the bottom of this file — it is
// exported so no surface can render a proof without the limits beside it.
//
// THE TWO LAWS INHERITED FROM acceptance-digest.mjs, both learned the hard way:
//
//   1. NEVER REUSE content-pins.mjs HERE — not `sha256Normalized`, not
//      `expandPins`. `sha256Normalized` collapses CRLF→LF, so a CRLF shell
//      script whose shebang carries a `\r` (and therefore FAILS) has the same
//      digest as the passing LF script: the oracle looks frozen across a
//      genuine behaviour change. Its `buf.includes(0)` binary probe searches
//      for the CHARACTER "0" when handed a string, and its latin1 round-trip
//      is lossy for non-ASCII. `expandPins` is a drift-reporting walker: it
//      yields only `e.isFile()` (symlinks vanish silently), elides SKIP_DIRS
//      (`vendor/`, `target/`, `.venv/`), and never checks containment.
//
//   2. A FALSE DIFFERENCE IS SAFE; A FALSE MATCH IS NOT. Every choice below
//      that could go either way goes toward "these two are different, re-prove
//      it". Nothing here normalizes, and every ambiguity is a REFUSAL rather
//      than a best guess. A silent omission is the one outcome this module
//      exists to make impossible: a set that quietly skipped a file would read
//      as frozen while the skipped bytes moved underneath it.
//
// ROOTS ARE ALWAYS A PAIR. `resolveRepoRoot()` returns the STATE root, which
// inside an attached lane worktree is redirected to the PRIMARY repo. A
// single-root API would hash the primary checkout while the operator edits a
// worktree, then record digests describing the wrong tree. So every API here
// takes `roots = { workRoot, stateRoot }` from `resolveWorkAndStateRoots()`,
// and everything in this file hashes and expands against `workRoot` only.
// Passing a bare root string is a hard TypeError, not a coercion.
//
// ERRORS VS REFUSALS — the split is deliberate and load-bearing:
//   - A violated API contract (bad `roots`, a non-record declaration, an
//     unencodable identity term) THROWS. Caller bugs must be loud, and the
//     acceptance-digest precedent is that an unencodable input yields NO
//     identity rather than a shared one.
//   - Anything derivable from OPERATOR INPUT (a pattern that escapes the repo,
//     a symlinked test directory, a glob matching nothing) returns a typed
//     refusal `{ok:false, reason, refusalClass, …}`. Those must be recordable
//     on a receipt as `refusal_reason`, not thrown into a crash.
// The digest functions return the SAME union. That is not stylistic: if a
// refusal returned a bare object with `digest` undefined, two unrelated
// refusals would compare `undefined === undefined` and satisfy "the oracle did
// not move" — a false match manufactured out of an error path.
//
// REFUSAL DETAIL IS RAW, UNREDACTED, CALLER-AUTHORED TEXT. Declared patterns
// can carry anything an operator typed. This module deliberately does NOT
// redact: redaction belongs at the receipt/stdout boundary (`redactText` from
// secret-scan.mjs), where the consumer knows whether the value is being
// persisted, and where nobody has to treat a redacted string as proof the
// plaintext was safe to store.
//
// Node stdlib only (hard rule 4). NO SPINE ANYWHERE IN THIS FILE — nothing here
// appends an event or reads a projection, which is what keeps its suite
// hermetic. Everything through `deriveProofs` is additionally pure: its only
// I/O is reading the working tree. The two phase-2a primitives at the bottom
// are the deliberate exception and the exact width of it is: ONE advisory
// lockfile under `<stateRoot>/.maddu/state/`, and ONE child process.

// ── the split (v1.120.0) ───────────────────────────────────────────────────
//
// The three phases live in sibling modules, split along the seams the phases
// themselves drew — this file is the SINGLE PUBLIC ENTRY and re-exports the
// whole API, so every caller and every law above keeps addressing one place:
//   acceptance-core.mjs     phase 1a — identity, refusals, expansion, digests
//   acceptance-derive.mjs   phase 1b — deriveProofs, the read-time verdict
//   acceptance-observe.mjs  phase 2a — the two observation primitives
// Import from THIS file. The helper exports inside acceptance-core.mjs are
// internal to the family, not public API.

export {
  refuseBlankCommand,
  acceptanceIdFor,
  expandAcceptance,
  oracleDigest,
  implDigest,
} from './acceptance-core.mjs';

export {
  ACCEPTANCE_PROOF_STATES,
  ACCEPTANCE_STALE_REASONS,
  deriveProofs,
} from './acceptance-derive.mjs';

export {
  withAcceptanceLock,
  runAcceptanceCommand,
} from './acceptance-observe.mjs';

// ── honest limits ──────────────────────────────────────────────────────────

// REPLAY_SCOPE_LINE precedent: exported so every surface that renders a proof
// renders its limits from the SAME text, and no readout can quietly narrow
// them. Never say "tamper-proof". Never say "failed a test".
export const ACCEPTANCE_HONEST_LIMITS = `acceptance proof — honest limits:
- PROCESS-LEVEL, NOT ASSERTION-LEVEL. A RED means the declared command EXITED NONZERO against the frozen oracle — never that a test assertion failed. A missing module, a bad config, an unresolvable interpreter or an inner signal death surfacing as 128+n all qualify. Say "exited nonzero", never "failed a test".
- A WEAK ORACLE PROVEN RED→GREEN IS STILL A WEAK ORACLE. An assertion checking almost nothing yields an entirely honest proof.
- NO CAUSATION. A moved implementation digest proves co-occurrence only: some declared byte changed between the two observations. Remove a dependency, record the RED, restore it, touch whitespace, record the GREEN — a proof forms without the implementation change having caused the flip.
- THE COMMAND TEXT IS FROZEN, NOT THE PROGRAM IT NAMES. The same string under a different interpreter, PATH, NODE_OPTIONS or platform shell is a different program.
- ENDPOINT EQUALITY, NOT CONTINUOUS IMMUTABILITY. A run that mutates the oracle or the implementation and restores it before the post-hash is NOT detected, and leaves no recorded difference at all.
- ONLY THE DECLARED SETS ARE BOUND. Digests bind the raw bytes, path, permission bits and entry type of what the declaration named — not the environment, not the repository revision, not files nobody declared. Whitespace-only edits satisfy the implementation-moved clause.
- MUTATION FROM OUTSIDE MÁDDU IS UNBOUNDED. Only Máddu's own sanctioned concurrency is serialized.
- SYMLINKS, NESTED REPOSITORIES AND NON-FILE ENTRIES ARE REFUSED, NOT COVERED. The expander stops rather than guessing; a refusal is visible, an omission would not be.
- A RECEIPT IS A COOPERATIVE ACTOR'S ASSERTION THAT IT RAN SOMETHING. The spine chain is an unkeyed SHA-256 with no HMAC and no signature: fabricated receipts carrying a correctly computed prev_hash verify. Deriving a proof rather than storing it removes the minting verb, not the forgery. Anchoring proves bytes existed at a time — existence and continuity, never truth. The only structurally independent execution witness is CI re-observation from a protected base branch, which is not solved here.
- NO COMMIT BINDING. Any recorded subject sha is human context, not evidence; nothing here ties a proof to a reviewable commit.`;
