# Replay — clean-checkout re-verification (`maddu spine verify --replay`)

An anchor ([54-spine-anchor.md](54-spine-anchor.md)) proves a receipt
*existed*; it says nothing about whether the verification it records would
actually reproduce. **Replay** closes that half: it clones this repository at
an exact commit into a throwaway directory and re-runs the verification
commands the repository itself declares — then appends the outcome to the
spine as its own receipt (`VERIFICATION_RAN` with `profile: "replayed"`),
derived strictly from the in-process result.

```bash
maddu spine verify --replay $(git rev-parse HEAD)   # replay this exact commit
maddu spine verify --replay <full-sha> --json       # machine-readable
```

## What replay honestly is (and is not)

- **Clean-checkout reproducibility + dirty-worktree contamination detection.**
  The clone (`git clone --no-local`) contains only *committed* state: an
  uncommitted edit that makes your worktree pass (or fail) does not reach the
  replay. That is the whole claim.
- **`--no-local` isolates git object copying only.** Host environment,
  credentials, caches, services, and absolute-path writes are **not**
  isolated. Every replay output ends with exactly that sentence.
- **The declared commands are trusted operator config.** They run through the
  host shell as-is; the clone provides no safety boundary. Declare commands
  you would run by hand.

## Declared commands only — no inference

Replay runs **only** what `maddu.json` declares:

```json
{ "replay": { "install": "npm ci", "verify": "npm test" } }
```

- `install` is optional; `verify` is required. Both must be non-blank
  strings; the v1 shape is exactly `{install?, verify}` — unknown keys are
  refused (`config-invalid`).
- **Config is read from the clone at the subject SHA, never from your
  worktree** — dirty or newer config can never choose the commands for an
  older commit, and a commit that predates the declaration is honestly
  `unsupported`.
- There is deliberately **no lockfile or ecosystem inference** and no
  fallback command. An undeclared project reports `unsupported` (exit 2, no
  events) and can never gain `replayed`.

## Subject discipline

The subject must be the **full commit id in the repository's own object
format** (40 hex in sha1 repos, 64 in sha256 repos — an abbreviation or ref
is refused), and the object itself must **be a commit**: an annotated-tag id
would peel to a different object than the receipt records, so it is refused
by type, not peeled.

## Execution + receipt semantics

Flow: clone `--no-local --no-checkout` → `checkout --detach <sha>` → read +
validate config from the clone → append `VERIFICATION_STARTED` → declared
install (if any) → declared verify → **delete the clone** → append the
`VERIFICATION_RAN` receipt from the in-process result.

- Setup refusals (bad sha, clone failure, `unsupported`, `config-invalid`)
  exit 2 and emit **no spine events** — a failed setup can never manufacture
  a receipt or a dangling `STARTED`.
- Receipt appends are **strict**, unlike the best-effort test-recency path: a
  `STARTED` append failure refuses pre-run (`spine-unavailable` — replay will
  not run unrecorded); a receipt append failure after the run exits nonzero
  and never claims `replayed`.
- Each command has a fixed **10-minute timeout**; on expiry the whole process
  tree is killed (Windows `taskkill /T /F`, POSIX process-group SIGKILL) with
  a bounded settlement deadline — a stalled kill can never hang the replay.
- Receipt: verify exit 0 with full protocol → `result: "pass"`. Verify
  nonzero → `fail` with `complete: true` (the protocol completed; the
  commands failed). Install failure / timeout / spawn error → `fail`,
  `complete: false` (verify never ran or was killed). A **cleanup failure
  fails closed**: even a passing verify becomes `result: "fail",
  complete: false` with `clone_deleted: false` and a nonzero exit —
  `verify_exit` stays visible so the truth is auditable, but an incompletely
  executed replay protocol never reads as a successful `replayed` run.
- `kind: "replay"` receipts never satisfy project-test/self-test recency
  (pairing is kind-scoped) — replay is its own signal on the assurance
  ladder, assessed only at the operator ceremony
  ([54-spine-anchor.md](54-spine-anchor.md)).

`MADDU_REPLAY_TIMEOUT_MS` is an env **test seam** (like `MADDU_OTS_BIN`) so
the kill path is testable — it is not configuration; the maddu.json shape
does not grow a timeout.
