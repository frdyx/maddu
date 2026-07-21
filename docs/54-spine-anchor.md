# Spine anchors — the external witness (`maddu spine anchor`)

Everything else in Máddu's record is, in the end, files an agent on this
machine could rewrite. An **anchor** places evidence *outside the agent's
authority*: a canonical payload committing to a spine receipt is stamped into
**Bitcoin** via the stock [OpenTimestamps](https://opentimestamps.org) client.
Altering an event covered by a retained anchor is detectable by anyone holding
the proof — the actor is no longer the sole witness for "this receipt existed
at this time."

Be precise about what that buys you, because the limits are structural:

- **An anchor proves existence, not truth.** Anchor-a-lie is irreducible: a
  fabricated receipt can be anchored just as well as an honest one. Content
  honesty comes from replay (`verify --replay`) and the operator's own
  ceremony — the anchor makes the *record* tamper-evident, nothing more.
- **Suffix deletion is undetectable.** Continuity checks catch mid-history
  deletion and renumbering. Dropping the *newest* anchors — or deleting all of
  them — is invisible without a **retained checkpoint**: keep an operator note
  of the latest `seq` + payload digest somewhere the agent can't edit (a
  notebook, a pinned message), or use an external immutable index.
- **Local status is never assurance.** `pending`/`complete`, spine events, and
  timestamps in files are all agent-writable. Only an **operator-run,
  Bitcoin-backed `ots verify` at consume time** counts — which is exactly why
  Máddu ships no verb that "verifies for you."

## Commands

```bash
maddu spine anchor              # stamp the newest VERIFICATION_RAN receipt now
maddu spine anchor --event <id> # anchor a specific event instead
maddu spine anchor --upgrade    # collect Bitcoin attestations (hours later)
maddu spine anchor --status     # list anchors: pending / complete
maddu spine anchor --verify     # read-only continuity diagnostic (see below)
```

`anchor` requires network: there is **no offline queue** — offline, the
command says so and exits nonzero, and nothing is recorded. Re-running is
idempotent (a receipt already covered by the latest anchor returns "already
anchored"), a crash between payload write and stamp is recovered on the next
run at the same sequence number, and concurrent invocations serialize under a
funnel lock so the sequence can never fork.

**Team-sync mode is refused, fail-closed.** One anchor chain covers one
replica's spine; a singular chain head cannot cover a merged multi-replica
spine.

## What a payload commits to

`.maddu/anchors/<seq>/payload.json` is canonical JSON (sorted keys, no
whitespace); its sha256 is the stamped digest:

| field | meaning |
| --- | --- |
| `repo_identity` | `{ project, origin }` — maddu.json name + normalized origin URL (no credentials, no `.git`) |
| `receipt_digest` | sha256 of the receipt event's exact stored line |
| `subject_sha` | `git rev-parse HEAD` at stamp time (null outside git) |
| `event_id`, `position` | the receipt's id + `{replica, segment, line}` on the spine |
| `chain_head` | sha256 of the newest stored line at stamp time — the broader-history commitment |
| `prev_anchor_sha256` | sha256 of the previous anchor's payload file **bytes as stored** |
| `seq` | 1-based, gap-free sequence |

`ANCHOR_STAMPED` / `ANCHOR_UPGRADED` events record each stamp and each proof
change on the spine (contract 1.10.0). `.maddu/anchors/` is **tracked** — a
durable exception to the ignored `.maddu/*` (the stamp path adds
`!.maddu/anchors/` inside Máddu's own `.gitignore` block if it is missing).
Anchors travel with the repo; the receipt-bearing spine is device-local, so a
fresh clone can verify anchor continuity and payload self-consistency but can
check payloads against a spine only where that spine exists.

## `--verify` — what it checks, and what it can't

Read-only, emits no event, and is **never assurance evidence** — it proves the
local files are mutually consistent, not that Bitcoin confirms them. It flags:
sequence gaps and renumbering (mid-history deletion), payloads whose stored
bytes are not their own canonical serialization, `prev_anchor_sha256` breaks,
spine positions that no longer hash to `receipt_digest` (the spine was
rewritten after stamping — or the anchor lies), and `ANCHOR_*` spine events
that disk doesn't back (forged events). Its output restates the
suffix-deletion residual every time.

## Operator verification (the part that actually carries weight)

```bash
ots verify .maddu/anchors/<seq>/payload.json.ots
```

Bitcoin-backed verification needs a **local Bitcoin Core node** (pruned is
fine) — the stock Python client has **no explorer fallback**; without a node
it refuses. The explorer-backed alternative is the **JS client's lite mode**
(`npm install opentimestamps`, then `ots-cli.js verify <file>.ots`), which
prints "Lite-client verification, assuming block … is valid" — it trusts the
block explorers, not proof-of-work directly. Know which one you ran; say so
in any consume ceremony note. This step is the `anchored` assurance level's
spine: local anchor state never is.

## The stock client is an ambient tool

Like git and gh, `ots` is a *declared ambient tool* — Máddu ships no
OpenTimestamps dependency and shells out to the client on PATH
(`pip install opentimestamps-client`). On **Windows**, python-bitcoinlib needs
an OpenSSL DLL findable as `ssl`: copy your Python's `DLLs\libcrypto-3.dll`
into a PATH directory as `ssl.dll` (the `EC_*` symbols it loads live in
libcrypto, not libssl, in OpenSSL 3). A missing client refuses with this hint;
nothing is guessed. Calendar servers default to the client's stock set;
`maddu.json → witness.calendars[]` (https URLs, validated hard) overrides
them. Multiple calendars improve *availability* only — assurance changes only
with a Bitcoin-verified proof.

## Consume ritual — `--assess <sha>` (v1.110.0)

```bash
maddu spine anchor --assess <full-commit-sha> [--seq <n>]
```

An **interactive operator ceremony** that records the `anchored` rung of the
assurance ladder (*actor-reported → replayed → anchored → presence-attested
(deferred)*) as an `ASSURANCE_ASSESSED` event. Read the labels carefully: the
event is a **non-authoritative ledger note** — a record that YOU ran the
ceremony — never a verification result. Every consumer prints it that way
(`--status`, `spine show`, `events list`, search), nothing gates on it, and
anyone consuming the record must re-run the ceremony themselves.

The tool's own checks can only **refuse** — they never grant the level:

1. **Binding**: the anchor's payload must be canonical bytes whose recorded
   spine position hashes to `receipt_digest` and names the right
   `VERIFICATION_RAN` event; positions are containment-checked (canonical
   segment basename inside a symlink-free `.maddu/events` — path-shaped or
   symlinked references are refused, not followed). The whole anchor chain
   must verify: mid-history deletion/renumbering, forged `ANCHOR_*` events
   (absent/non-string/mismatched payload digest on ANY event; a newest proof
   digest disk doesn't back), and missing proofs all refuse.
2. **External evidence**: the ceremony prints the exact `ots verify` command,
   YOU run it in another terminal, and paste the output (redacted, capped at
   8 KiB, stored verbatim in the note). It asks whether YOUR verifier
   attested success — default No.
3. **Age policy**: `maddu.json → witness.maxAnchorAge` (`"<n>d"`, optional).
   When set, you enter the attestation date from the verifier output
   (strict `YYYY-MM-DD`, UTC); blank, unparseable, future, or stale-beyond-
   policy dates refuse. An invalid policy value refuses outright. When
   unset, the ceremony says so and skips the check.
4. **No stale writes**: the binding checks and the age policy are re-run
   AFTER the final confirm, immediately before the append — anything that
   moved during your verification window (anchor bytes, spine, policy)
   refuses with nothing recorded. Refused or declined ceremonies never
   append anything.

The event's `assessed_by` is the literal `operator-ceremony`; your handle
(optional) and the pasted verifier output live in the note. Recorded
evidence is the triple `{anchor_seq, anchor_payload_digest, proof_digest}` —
`--status` shows "assessed anchored" only while ALL of it still matches the
anchor's current state; after an upgrade changes the proof, the old
assessment shows as superseded, never as current.

**Residual, stated exactly:** upgrades replace the proof file, so only the
NEWEST anchor event's proof digest is disk-checkable — a forged claim about
a *superseded* proof digest asserts something about bytes nobody (including
Bitcoin) can re-examine. Payload digests, which never legitimately change,
are checked on every event. Full residual list: `docs/34-threat-model.md`
§13.

### Optional Tier 2 — GitHub as an external immutable index

The framework never requires GitHub, but a repo that lives there can layer
an independent index on top of Tier 1: publish each release with the anchor
payloads + proofs + the receipt as **release assets**, and enable GitHub's
**immutable releases** where available (once immutable, a release's assets
cannot be replaced and a deleted tag leaves a tombstone — a burned tag
cannot be silently reused). `gh attestation verify` can be part of your
consume ceremony for artifacts built by GitHub Actions. This is an operator
action — `frdyx/maddu` doing it is dogfooding, not a framework dependency.
