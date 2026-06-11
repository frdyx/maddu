# Proposal — spine tamper-evidence (`prev_hash` chain)

> **Status:** ACCEPTED — **Option A implemented in v1.14.0** (operator ruling,
> 2026-06-09). Forward-only `prev_hash` chain in `spine.append()` + a report-only
> `chain_broken`/`chain_gap` check in `verify.mjs`; no migration (legacy events
> unchained). The design below is the as-shipped record. Written during the v1.13.0
> hardening pass as an OPEN charter-level decision; resolved at v1.14.0.

## The question

Should Máddu's spine be **tamper-evident** — each event hash-chained to its
predecessor so a consistent rewrite of history is detectable — or is the current
*legible-and-git-backed* posture enough?

## Current state (verified in code, v1.12.0)

- `spine.append()` writes `JSON.stringify(ev) + '\n'`. There is no hash, no link
  to the prior event.
- Total ordering comes from *segment file index + line number* (the module's own
  comment), not from any cryptographic chain.
- `verify.mjs` checks: NDJSON parseability, envelope shape, event-id uniqueness,
  segment continuity, timestamp monotonicity, the torn-trailing-line distinction
  (added in this pass), and referential integrity across types.
- **What nothing checks:** a consistent edit of an *interior* event that leaves
  valid JSON and a unique id. Rewrite `APPROVAL_DECIDED.data.decision` from `deny`
  to `allow` on line 200, and `spine verify` stays green. For a spine whose entire
  pitch is "the one authoritative thing; every trust decision recorded," that is
  the gap a safeguard layer against the agents working *through* it would want
  closed.

## The git nuance (why this is bounded, not urgent)

If the spine is committed to git, git's own object hashing already makes a history
rewrite visible (`git diff`, `git fsck`, signed commits). So tamper-evidence's
*marginal* gain is real but bounded to:

1. the **uncommitted window** — events appended since the last commit, and
2. **non-git use** — a spine carried by `cp`/`export` outside a git repo.

A team that commits the spine frequently already has most of this. A team that
treats `.maddu/` as ephemeral or ships bundles around git does not.

## Proposed design (if accepted)

- **Envelope:** add one field, `prev_hash` — the SHA-256 of the *canonical*
  serialization of the immediately-preceding event in the same segment (and the
  last event of the prior segment at a roll boundary). The genesis event carries
  `prev_hash: null`.
- **Append:** `spine.append()` computes the hash over a canonical form (stable key
  order) so a fresh replay on another machine recomputes identical hashes.
  Pure stdlib — `crypto.createHash('sha256')`. No new dependency (rule #4 safe).
- **Verify:** a new `chain-integrity` check walks each segment, recomputes the
  chain, and reports the first event whose `prev_hash` doesn't match the actual
  predecessor's hash — i.e. the exact line where history was altered or an event
  was inserted/removed. **Report-only. Never auto-repaired** (rule #2). The
  operator decides (rollback to a checkpoint, accept, investigate).
- **Files-only preserved:** every line stays independently `cat`-able JSON; the
  hash is just another field. No binary index, no sidecar.
- **Migration:** existing events (the current 360-event spine, and every consumer
  install) predate the field. Options: (a) treat a missing `prev_hash` as
  "unchained, legacy" and only verify the chain from the first event that has one
  (forward-only adoption — zero migration, honest about what's covered); or
  (b) a one-time `maddu spine seal` that backfills the chain over existing events
  and records a `SPINE_SEALED` anchor. (a) is simpler and recommended.

## Trade-offs to weigh

- **For:** upgrades the core claim from *legible* to *tamper-evident*; catches the
  one class `spine verify` is blind to today; cheap (stdlib, one field); keeps
  every invariant (files-only, no deps, no auto-repair).
- **Against:** it is an **event-envelope change** — every new event grows by ~75
  bytes and gains a field other tooling must tolerate; it adds a determinism
  obligation (canonical serialization must be stable across Node versions and
  machines, or honest spines flag false positives); and for git-committed spines
  the marginal benefit is modest. The charter currently lists "no write-ahead log
  (the spine is the WAL)" among *deliberately absent* machinery — a hash chain is
  adjacent to that minimalist stance and deserves an explicit yes.

## Options

| Option | Meaning |
|---|---|
| **A. Implement optional `prev_hash`** | Forward-only chain (migration option *a*), report-only `chain-integrity` verify check. Lands as its own slice once the charter says yes. |
| **B. Keep legible + git** | Decide the spine stays legible-and-git-backed; record the decision in the threat model so it's a *choice*, not an oversight. |
| **C. Defer** | Revisit after more operators run non-git/exported spines and the real exposure is known. |

## Recommendation

Decide **B or A deliberately**, don't drift. If most real use commits the spine to
git, **B** (record the choice) is defensible and cheapest. If Máddu is meant to be
trustworthy *independent* of git — the stronger reading of "outlives every agent
that touches it" — then **A**, forward-only, is the right charter addition: small,
stdlib, invariant-preserving, and it closes the one integrity gap verification
can't see today.

What's needed to decide: a one-line charter ruling on *"is the spine tamper-evident
or legible-and-git-backed?"* Everything else (the design above) follows from it.
