# 56. Acceptance proofs — RED → GREEN against a frozen oracle

A green test suite tells you the suite passes *now*. It does not tell you the
suite ever failed — and a test that has never failed has never demonstrated
that it can. The oldest way to weaken verification without touching a line of
production code is to write (or quietly relax) a check that passes no matter
what, then report "green".

An **acceptance proof** is Máddu's narrow answer to exactly that. It is
derived, never stored, and it says one thing:

> One declared command **exited nonzero** and later **exited zero**, while the
> declared **oracle** bytes stayed identical and the declared **implementation**
> bytes moved.

Read that literally. It is a statement about a *process exit code*, not about
an assertion. Every Máddu surface that renders proof state says "exited
nonzero" and never "failed a test", because a missing module, a bad config, an
unresolvable interpreter or an inner signal death surfacing as `128+n` all exit
nonzero too.

Nothing here is tamper-proof, and this document never uses that word. See
[Honest limits](#honest-limits) — the list is exported from the code as
`ACCEPTANCE_HONEST_LIMITS` precisely so no readout can quietly narrow it.

## The three declarations

An acceptance is declared on the **goal**, alongside the success conditions it
already carries:

```bash
maddu goal set "ship the retry backoff" \
  --success "npm test -- retry::retry backs off exponentially" \
  --oracle  "test/retry.test.js" \
  --impl    "src/retry.js"
```

| declaration | flag | what it binds |
|---|---|---|
| the **command** | `--success "<cmd>::<text>"` | the exact command string that must flip nonzero → zero |
| the **oracle** | `--oracle "<glob>"` | the files that must stay **frozen** across the flip — your test, the thing that judges |
| the **implementation** | `--impl "<glob>"` | the files that must **move** across the flip — the thing being judged |

Both set flags are repeatable. They are declared as raw pattern strings and
validated only for *shape* at declaration time (non-blank strings, at most 256
patterns, at most 1024 characters each). Whether a pattern actually matches
anything, escapes the repository, or crosses a symlink is decided at
**observation** time and reported as a typed refusal on the receipt — a refusal
is visible, a silent omission would not be.

`maddu goal show` renders both sets. A goal that declares neither is a **legacy
goal**: it still runs its verify commands and still reports met/pending, it
simply records no acceptance receipts and can hold no proof.

## How a proof forms

A proof needs two observations of the same declaration: one that exited
nonzero, then one that exited zero. Two commands record them.

**`maddu orient`** observes every verifiable condition of an acceptance-active
goal each time it runs with verification enabled. Run it before the fix and it
records the RED; run it after and it records the GREEN, at which point the
proof derives:

```
✓ met  retry backs off exponentially  — npm test -- retry
    proof: RED→GREEN · oracle 1 file frozen
```

**`maddu loop ralph`** records the same pair around an autonomous iteration.
Two grammars, and the loop refuses rather than iterating toward something it
could never prove:

```bash
# adopt the active goal's conditions and sets
maddu loop ralph --from-goal --iterate "<agent turn>"

# or declare one ad-hoc acceptance for this loop only
maddu loop ralph --goal "fix the retry test" \
  --verify "npm test -- retry" --oracle "test/retry.test.js" --impl "src/retry.js"
```

| invocation | outcome |
|---|---|
| `--from-goal` **and** `--verify` | exit 2 — two answers to one question |
| neither flag | exit 2 — the loop has nothing to verify |
| `--verify` without both `--oracle` and `--impl` | exit 2 — an acceptance with no declared sets can never form a proof |
| `--from-goal` with no goal / a closed goal / no verifiable condition / no declared sets | exit 3 |

Before iteration 1 the loop records an explicit **baseline** observation — the
RED that must exist before any later GREEN can pair with it. If the baseline is
already green the loop still runs (you asked for it), and that GREEN can close
a qualifying earlier RED that `orient` recorded.

Every observation appends a `VERIFICATION_STARTED` / `VERIFICATION_RAN` pair
carrying the acceptance identity. There is **no proof event and no re-baseline
verb**: the verdict is re-derived from those receipts every time somebody looks.
Changing your test destroys the proof, and the only route back is to observe
the new test exit nonzero and then exit zero.

## Reading proof state

`maddu orient` renders a clause per condition and `maddu orient --json` carries
a `proofs` array aligned by index with `success`. The state vocabulary is closed
— **`live` is the only positive verdict**:

| state | meaning |
|---|---|
| `live` | a qualifying pair anchors the latest observation and every liveness condition holds |
| `historically-proven` | proven once, but a liveness condition now fails — **not green** |
| `regressed` | proven once; the latest observation exits nonzero |
| `indeterminate` | the latest observation did not complete (timeout, signal, spawn error, void receipt) |
| `unproven` | no qualifying pair anchors the latest observation |

When a proof is not live, the reason comes from a closed vocabulary too, in the
order the conditions are tested: `policy-invalid`, `no-ts`, `future-ts`,
`redeclared`, `undeclared`, `oracle-unavailable`, `oracle-changed`,
`impl-unavailable`, `impl-moved`, `expired`.

## The `acceptance-proven` gate

The same view is rendered wherever gates run (`maddu doctor`, `maddu audit`,
`maddu ci`):

```bash
maddu doctor --gate acceptance-proven
```

It is **green only when every verifiable condition of the active goal is
`live`**, and its message names the count (`2/2 live`), the tier the declaration
bound (`worktree`), and — for each condition that is not live — its state and
reason. Three distinct refusals stay visibly separate, because "nothing
declared" must never render like "declared and clean": no active goal, an
active goal whose conditions carry no verify command, and an active goal with no
`--oracle`/`--impl` set.

The gate **executes nothing**. Observation belongs to `orient` and `loop ralph`,
the two commands an operator invokes on purpose; a gate that ran declared
commands would turn `maddu doctor` into an arbitrary-command runner that any
goal declaration could aim.

It ships at severity `warn` and that is **permanent, not a gap**. `maddu ci pin`
structurally refuses warn-severity gates, so this gate can never become a
required, fail-capable check in shared CI. That ceiling is honest: the actor who
can green a proof can re-declare the goal underneath it, so a `critical`
severity would lend the signal trust-boundary weight it does not have. An
operator-authored shadow gate under `.maddu/gates/` is **not** a promotion path
— `.maddu/*` is gitignored, so a shadow never reaches a PR diff or a CI
checkout.

## Freshness policy — `acceptance.maxProofAge`

A proof does not expire by default. Declare a ceiling in `maddu.json` when you
want one:

```json
{ "acceptance": { "maxProofAge": "30d" } }
```

The value is a `"<n>d"` string and nothing else — a bare number is refused
rather than guessed at, because days-versus-milliseconds is precisely the
ambiguity that silently expires every proof or none. A malformed policy is
**fail-closed**: nothing derives live and the reason reads `policy-invalid`. An
absent `maddu.json` is the only thing that means "no policy declared"; an
unreadable or malformed one is invalid, not absent. The offending value is never
echoed back — it is caller-typed config text, and a secret pasted into the wrong
field must not land on stderr.

## Team-sync mode is refused, not degraded

A proof rests on one totally-ordered history in which a RED provably precedes a
GREEN. A partitioned (replica-synced) spine has no such single order, so
derivation **refuses** rather than guessing:

```
acceptance proofs: unsupported in team-sync mode
```

Observations recorded on a partitioned checkout are persisted as **void**
receipts with `refusal_reason: unsupported-team-sync` — the command still ran
and the record still says so, but nothing derives from it. The gate reports the
same refusal. Neither surface ever renders team-sync as green.

**Fresh-clone note.** A checkout that carries partition segments but no active
replica configuration reads as an empty flat history: no goal projects, so
`orient` renders "no goal" and nothing is observed. That is the platform-wide
fresh-clone semantic (`status`, `brief` and `goal show` project empty there
too), not an acceptance-specific failure. Run `maddu spine sync init` to attach
the checkout.

## Honest limits

Reproduced verbatim from `ACCEPTANCE_HONEST_LIMITS`
(`template/maddu/runtime/lib/acceptance.mjs`), which every surface that renders
a proof points at. Nothing below may be narrowed in a readout:

- **PROCESS-LEVEL, NOT ASSERTION-LEVEL.** A RED means the declared command
  EXITED NONZERO against the frozen oracle — never that a test assertion
  failed. A missing module, a bad config, an unresolvable interpreter or an
  inner signal death surfacing as 128+n all qualify. Say "exited nonzero",
  never "failed a test".
- **A WEAK ORACLE PROVEN RED→GREEN IS STILL A WEAK ORACLE.** An assertion
  checking almost nothing yields an entirely honest proof.
- **NO CAUSATION.** A moved implementation digest proves co-occurrence only:
  some declared byte changed between the two observations. Remove a dependency,
  record the RED, restore it, touch whitespace, record the GREEN — a proof
  forms without the implementation change having caused the flip.
- **THE COMMAND TEXT IS FROZEN, NOT THE PROGRAM IT NAMES.** The same string
  under a different interpreter, PATH, NODE_OPTIONS or platform shell is a
  different program.
- **ENDPOINT EQUALITY, NOT CONTINUOUS IMMUTABILITY.** A run that mutates the
  oracle or the implementation and restores it before the post-hash is NOT
  detected, and leaves no recorded difference at all.
- **ONLY THE DECLARED SETS ARE BOUND.** Digests bind the raw bytes, path,
  permission bits and entry type of what the declaration named — not the
  environment, not the repository revision, not files nobody declared.
  Whitespace-only edits satisfy the implementation-moved clause.
- **MUTATION FROM OUTSIDE MÁDDU IS UNBOUNDED.** Only Máddu's own sanctioned
  concurrency is serialized.
- **SYMLINKS, NESTED REPOSITORIES AND NON-FILE ENTRIES ARE REFUSED, NOT
  COVERED.** The expander stops rather than guessing; a refusal is visible, an
  omission would not be.
- **A RECEIPT IS A COOPERATIVE ACTOR'S ASSERTION THAT IT RAN SOMETHING.** The
  spine chain is an unkeyed SHA-256 with no HMAC and no signature: fabricated
  receipts carrying a correctly computed prev_hash verify. Deriving a proof
  rather than storing it removes the minting verb, not the forgery. Anchoring
  proves bytes existed at a time — existence and continuity, never truth. The
  only structurally independent execution witness is CI re-observation from a
  protected base branch, which is not solved here.
- **NO COMMIT BINDING.** Any recorded subject sha is human context, not
  evidence; nothing here ties a proof to a reviewable commit.

## See also

- [34-threat-model.md](34-threat-model.md) §12 — what acceptance proofs close
  in the "an agent weakens its own verification" scenario, and what they leave
  open.
- [33-loops-and-coordinator.md](33-loops-and-coordinator.md) — the ralph
  baseline observation and the stuck-detection fingerprint.
- [20-governance.md](20-governance.md) — gate authoring and the built-in set.
- [55-verify-replay.md](55-verify-replay.md) — the complementary
  clean-checkout re-verification receipt.
