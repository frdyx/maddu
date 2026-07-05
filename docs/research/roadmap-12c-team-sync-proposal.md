# Proposal — git-native team-sync (roadmap #12c)

> **Status:** DESIGN PROPOSAL — **not yet built** (roadmap #12c, competitive-response
> arc). #12a (worktree-isolated lanes) and #12b (published event contract +
> `maddu export --otel`) shipped; #12c was filed BLOCKED pending this merge/import
> protocol, because plain git-sync of the spine does not work (proven below).
> This document is the design to unblock it. It proposes a **files-only, no-Máddu-server,
> no-Máddu-accounts** way for several machines/agents sharing one git repo to converge on
> a single spine. Written 2026-07-05 against `main` (post-#220). Design-only: no code
> in this PR. **Red-teamed by Codex over two rounds (FLAWED → corrected); §A–§E, the
> import protocol, migration, and the risk register were revised against those
> findings** — the surviving claims are deliberately narrower: partitioning fixes the
> *cross-replica* conflict + convergence, not the intra-replica chain; reconciliation is
> pure-projection, not an emitted event; import dedups on exact partition-position, not
> the (only probabilistically-unique) event id; the legacy segment is *migrated* into a
> replica partition, not left local; the secret surface is the full `data` payload, not
> just argv. Chain-verify on import is report-only (matching today's `spine verify`).

## The question

A team wants several teammates — each on their own machine, each running their own
Máddu against the **same git repo** — to end up with **one shared, convergent,
tamper-evident record** of who did what, with the cockpit/projections identical for
everyone after a `git pull`. Can Máddu deliver that with **no sync server, no
accounts, no SSO, no CRDT dependency** — using git itself as the only transport —
or does multi-writer state force a hosted backend (which every hard rule forbids)?

The honest answer today is: **you cannot just commit `.maddu/events/` and `git
merge` it.** That breaks three separate ways. This proposal makes it work by
changing the *storage layout* (author-partitioned segments) so git never has to
merge anything, and by folding foreign events in with an *explicit, deterministic
import step* rather than a textual 3-way merge.

## Current state (verified in code, `main` post-#220)

- The spine is **segmented append-only NDJSON** at `.maddu/events/NNNNNNNNNNNN.ndjson`,
  rolled when a segment exceeds `ROLL_BYTES` (`spine.mjs:372-395`). Every replica
  appends to the **same** current segment.
- **Total ordering "comes from segment file index + line number"** — the module's
  own contract (`spine.mjs:10`), not from any clock or logical counter. Read order =
  file order + line order (`readAll`, `spine.mjs:492-505`).
- Each event is hash-chained: `prev_hash` = SHA-256 of the **exact stored line** of
  the immediately-preceding event (`spine.mjs:404-418, 446-458`). The chain is
  **single-parent linear** — genesis is `null`, and `maddu spine verify` walks it to
  flag the first altered/inserted/removed line.
- Single-machine concurrency is handled by the **OS, not a mutex**: `appendFile`
  with `O_APPEND` makes each whole-line write atomic; "Máddu deliberately has no
  mutex (lane claims coordinate AGENTS, not spine bytes)" (`spine.mjs:461-473`).
- Event ids are `evt_<14-char-timestamp>_<random-hex>` — but the timestamp is
  **second-precision** (the ISO string's sub-second digits are sliced off,
  `spine.mjs:334`) and the suffix is **only 24 random bits** (`bytes = 3`,
  `spine.mjs:333`). So ids are **probabilistically** unique, **not** collision-proof:
  two events in the same second (same replica, or across replicas) can in principle
  collide. This matters for §C — **import must not dedup on event id alone.**
- The event envelope is a **published contract**, `EVENT_CONTRACT_VERSION = 1.0.0`
  (`event-schema.mjs`): `{v, id, ts, type, actor, lane, prev_hash, triggered_by,
  data}`. There is **no author/origin/replica field** and no logical clock.
- **The spine is deliberately git-ignored today.** `.gitignore` excludes `.maddu/*`
  except `.maddu/config/` — "The framework repo never commits dev state." So the
  current posture is **device-local spine**; team-sync is a net-new, opt-in mode,
  not a tweak to the default.
- `maddu spine` exposes only `verify` and `show` (`commands/spine.mjs`); `maddu
  import` today is transcript-import, not spine-import. Both are extension points.

## Why plain git-sync of the spine breaks (three independent failures)

Suppose two teammates A and B both commit `.maddu/events/000000000001.ndjson` and
try to `git merge`.

1. **Textual conflict on essentially every sync.** Both append to the *end of the
   same file*. Git's line-merge sees two different insertions at the same trailing
   region → a conflict hunk on nearly every pull. The one file every writer touches
   is the worst possible shape for git's 3-way merge.

2. **The hash chain forks — and concatenation fails `spine verify`.** The chain is
   single-parent (`spine.mjs:458`). A's events hash A's local predecessor; B's hash
   B's. There is no single line that is "the predecessor" of both. Any textual
   resolution that interleaves or concatenates them produces at least one event
   whose `prev_hash` no longer matches the line now above it → `spine verify` reports
   `chain_broken` at the seam. Tamper-evidence and multi-writer git-merge are
   directly at odds.

3. **No cross-machine total order.** Read order is *file position* (`spine.mjs:10`),
   which is meaningless once two machines' lines are merged. `ts` is a wall clock and
   can skew between machines, so even ordering by `ts` is not deterministic across
   replicas — two replicas resolving the same merge differently would compute
   *different projections* from the *same events*. Convergence is lost.

Conclusion: the fix cannot be "merge better." It must be to **never make git merge
overlapping content**, and to **derive a deterministic order at read time** instead
of trusting file position.

## Non-goals — what this explicitly DECLINES (charter-anchored)

Per the positioning north-star (cooperative, files-only, no hosted backend) and the
8+1 rules, team-sync must **add coordination without adding a control plane**:

- **No *Máddu-run* identity system.** Máddu stands up no accounts, no SSO, no user
  directory, no login of its own. It **delegates** authZ to the git host (SSH keys,
  repo ACLs) and authorship to git/PGP — which are, themselves, account/key systems
  owned by the team, not by Máddu. The precise claim is "**Máddu adds no identity
  plane**," not "no identity exists anywhere." "Who may contribute" = who can push;
  "who wrote this" = git author + optional PGP signature + the existing `actor`/session
  id inside events. (Rules #3/#6 — Máddu ships no auth service, stores no tokens.)
- **No sync server / no daemon.** Sync is **operator-triggered and pull-based** (a
  `git pull` + an explicit import), never a background service holding a socket.
- **No CRDT / new dependency.** We apply the *principle* (grow-only log + deterministic
  reduction) with plain stdlib code; no library. (Rule #4.)
- **No history rewrite — and no reconciliation writes at all on the default path.**
  Semantic conflicts are resolved by **re-deriving the projection** from the ordered
  event set (§D), not by editing or appending anything; past lines are never touched.
  (Rule #2 — the spine wins, append-only; the projector reduces it.)
- **No auto-commit of secrets or of the whole `.maddu/`.** Only the events (and
  chosen shared state) are synced, under an explicit opt-in policy.

## Proposed design

Five parts. (A) is the load-bearing change; the rest follow from it.

### A. Author-partitioned segments (make git-merge conflict-free)

Give every replica its **own segment namespace** so no two replicas ever write the
same file. Instead of one shared `000000000001.ndjson`, writes go to a
**replica-scoped path**:

```
.maddu/events/
  by-replica/
    <replicaId>/000000000001.ndjson   ← replica A appends ONLY here
    <replicaId>/000000000002.ndjson
    <otherReplicaId>/000000000001.ndjson  ← replica B appends ONLY here
  000000000001.ndjson                 ← legacy/local pre-sync segment (unchanged)
```

- `replicaId` = a per-checkout random id (`makeId('rep')`, reusing `spine.mjs:333`),
  minted on first sync-enabled write and stored in `.maddu/config/replica.json`. It
  is a **partition key, not an identity claim** — two checkouts by the same human get
  different ids, and that's fine. **Uniqueness is load-bearing** (a duplicated
  `replicaId` on two machines resurrects the multi-writer conflict on one partition
  path), so: `replica.json` is **never committed** (git-ignored even in sync mode), is
  minted lazily per checkout, and `spine sync init` **detects collision** — if an
  incoming partition already carries this replica's id with events this replica never
  wrote, import refuses and prompts a re-mint.
- **Cross-replica writes never collide, so git never has to merge event content.**
  A only ever changes files under its own `replicaId/`, B under its own; `git merge`
  of two disjoint file sets is a clean union. This is the core trick: partition the
  write surface so git's merge degenerates to "both added different files." Note the
  scope precisely — this eliminates the **cross-replica** conflict (failure 1 above),
  which is the one that fired on every sync. It does **not** by itself make the
  per-partition `prev_hash` chain valid; that is a separate, pre-existing concern:
- **Intra-replica chain forks are a PRE-EXISTING limitation this does not fix.**
  `append()` reads the predecessor line *before* the `O_APPEND` write
  (`spine.mjs:457-458`); the `O_APPEND` guarantee protects **byte framing** (no
  interleaved lines), **not** the read-then-write. Two local processes on one replica
  (the long-lived bridge + a CLI invocation — the exact concurrency
  `spine.mjs:461-473` describes) can read the same predecessor and write two events
  with the same `prev_hash`, which `verify` already flags as `chain_broken`. This is
  true of the single-shared-segment spine **today**; partitioning neither causes nor
  cures it. Two honest options, to decide before building: **(a)** accept the chain as
  today's best-effort, verify-*reported* evidence (cross-replica is now clean; the
  signed git commit is the stronger second layer); or **(b)** add a per-replica append
  funnel (an advisory lockfile / single append queue) so each partition truly has one
  writer and its chain is strictly valid. (b) is the honest way to actually *claim* a
  valid per-partition chain; (a) ships sooner and regresses nothing. **The doc no
  longer claims partitioning alone yields a valid per-partition chain.**

### B. Deterministic total order at read time — *without a contract change*

`readAll` becomes a **k-way merge of the per-partition streams** — NOT a flat sort on a
composite key. Each partition is already an ordered stream (its append/chain order =
line sequence `seq`); the merge interleaves those streams:

```
merge(streams):  each partition contributes its events in seq order (never reordered);
                 at each step, emit the partition-head with the smallest (ts, replicaId).
```

- **Intra-partition order is `seq`, absolutely** — a partition's events are emitted in
  their chain/append order no matter what their `ts` values are. This is required:
  if the system clock steps backward between two appends, a flat sort on a
  `ts`-primary key would put a later-`seq` event *before* an earlier one, contradicting
  the partition's own `prev_hash` chain. The k-way merge cannot do that, because it
  only ever consumes a partition's heads in `seq` order.
- **`ts` (tie-break `replicaId`) decides only the CROSS-partition interleave** — which
  stream's head goes next — never the order *within* a stream. So `ts` is a heuristic
  for "roughly when, across machines," and `seq` is the ground truth for "in what order
  on this machine."
- `replicaId` is read from the **segment path**, and the sequence from line position —
  **neither requires a new event field**, so `EVENT_CONTRACT_VERSION` stays **1.0.0**.
  This is a deliberate, valuable constraint: team-sync ships **without breaking the
  contract we just published in #12b**.
- **Convergent, not stable — the distinction matters.** For the *same complete
  partition set*, every replica computes the *same* merged order → the *same*
  projections (**convergent**: a pure function of the G-set of events). But the order
  is **not stable** under new arrivals: a late-synced event with an *earlier* `ts`
  inserts into the *middle* of the sequence, shifting everything after it. That is
  fine for append-only *views* (the event stream just re-sorts) but it is exactly why
  reconciliation decisions (§D) must be **re-derived from the full set each time**,
  never frozen from a partial view.
- **Under-specified inputs must be pinned or the "same set → same order" claim
  fails.** The cross-partition interleave key `(ts, replicaId)` must define,
  deterministically: **missing/invalid `ts`** → a fixed sentinel (e.g. epoch-0), never
  a parse-locale-dependent value (intra-partition `seq` still orders such events
  correctly regardless); **legacy root `000…001.ndjson`** → migrated into
  `by-replica/<replicaId>/` at `sync init` (see Migration), so it carries the replica's
  own id and needs no special rank; **torn trailing line** (a partition synced
  mid-write) → the incomplete final line is **skipped on import** exactly as `verify`
  treats `torn_trailing_line`, and picked up on the next sync when complete — it never
  participates half-parsed. Two partition-heads with an identical `(ts, replicaId)`
  cannot occur (one replica has one head at a time; `replicaId` differs across
  partitions), so the merge is a deterministic total order once the `ts` sentinel is
  fixed.

**Honest limitation:** physical-`ts` ordering can misorder two *causally related*
events authored on different replicas under clock skew. But lanes exist precisely to
keep replicas on **disjoint work** (rule #8: no two agents hold the same lane), so
cross-replica causal dependencies are rare by design. For the common case
(disjoint-lane parallel work) the k-way merge — `seq` within each partition,
`(ts, replicaId)` to interleave across them — is sufficient and fully deterministic.
If cross-replica causality ever matters, the **contract-minor**
extension is a hybrid-logical-clock field `hlc` (a `1.1.0` additive change via the
existing `versionDiscipline`) — noted as future work, not built now.

### C. Git as a dumb transport + explicit import/verify

Sync is three explicit, operator-visible steps (optionally wrapped in one convenience
verb), never a hidden merge:

```
  maddu spine sync   ≡   git pull  →  maddu spine import  →  git add/commit/push
```

- **`git pull`** brings other replicas' partitions in as **new files** (disjoint
  paths → no conflict).
- **`maddu spine import`** (new) folds them into the local view **deterministically**:
  1. **Parse-validate** each foreign partition: reject a partition that is
     unparseable/malformed NDJSON or whose envelope fails the contract (`quarantine +
     report`, never a partial merge). A **torn trailing line** is skipped, not
     quarantined (picked up next sync).
  2. **Chain-verify is REPORT-ONLY** — reuse the `verify.mjs` walker to flag a
     `chain_broken` seam, but (consistent with today's `spine verify`, which never
     auto-repairs or blocks — `spine-tamper-evidence-proposal.md`) a chain fork does
     **not** block ingestion; it is surfaced. A team that wants chain-fork to be
     *fatal* must adopt §A option (b) (the per-replica append funnel) so forks cannot
     occur in the first place — then, and only then, chain-fail can gate import.
  3. **Dedup by PARTITION-POSITION identity** — `(replicaId, segment, line-seq)`, which
     is exact and collision-free by construction (each line has one position in one
     partition). **Not** the event id, which is only probabilistically unique
     (Current-state note). Re-importing is a no-op → **idempotent**.
  4. **Rebuild projections** under the (B) total order, applying §D **pure-projection**
     reconciliation. **No reconciliation event is written to the spine** (rule #2 +
     the §D correction); contentions are exposed as a read-time view.
- Git operations stay **operator-driven**; Máddu never opens a socket or auto-pushes.
  `maddu spine sync` is sugar over the three commands, printing exactly what it ran.

### D. Semantic-conflict reconciliation (the genuinely hard part)

Author-partitioning removes *event-level* conflicts (nothing is lost; the union is
complete). But it surfaces **logical** conflicts the single-writer spine never had:
two replicas can each validly `lane claim X` while offline. After union, the
projection sees two live claims on one lane — a real contradiction rule #8 forbids.

Resolution must be **deterministic, history-preserving, and monotonic under late
arrivals** — the red-team showed the naive "emit a reconciliation event" approach
fails the last two. The corrected design:

- **Reconciliation is a PURE PROJECTION function, not a written event.** The projector,
  given the full event set, re-derives the winner every rebuild: the claim earliest in
  the (B) total order holds lane X; all later concurrent claims are *computed* as
  superseded. Nothing is written to the spine to record this. Because it is
  re-derived from the whole set each time, a **late-arriving earlier claim simply wins
  on the next rebuild** — the decision self-corrects instead of being frozen wrong.
  This kills two red-team defects at once: **non-monotonicity** (no immutable
  "B won" record to contradict) and **double-emit** (no per-replica reconciliation
  events to pile up). Convergence is the CRDT insight applied in plain code: same
  event set → same reduction → same state, on every replica, in any arrival order.
- **The loser's claim line is never edited** (rule #2 intact) — it stays on the spine
  as evidence that a contention happened; the projection just doesn't honor it.
- **Default (recommended): NO spine write at all.** The contention is exposed purely as
  a **read-time cockpit view** ("lane X was contested; A holds, B superseded"),
  computed by the projector. This is simpler, monotonic, and impossible to
  double-count — it is the mainline design.
- *(Rejected alternative, documented for completeness — NOT the default.)* A durable
  audit marker was considered; it would have to be **content-addressed** (keyed on
  `sorted(idA,idB)`) and deduped so replicas can't each emit their own. It is **not
  adopted** — the read-time view supersedes it. Listed only so the trade-off is on
  record; the default writes nothing.
- The same pure-reduction pattern covers other non-commutative projections (approvals,
  phase-tier escalations): deterministic reduce over the ordered set, no written
  reconciliation. Commutative projections (counters, event streams) need no tie-break —
  union suffices.
- **Honest bound — side effects already taken don't roll back.** Convergence fixes the
  *record and the projection*, but if replica B already *acted* on its (later-losing)
  claim before syncing (edited files in lane X), that work happened. Team-sync makes
  the contention **visible and consistently resolved**, it does not prevent the
  double-work — lanes + worktree isolation (#12a) are the *prevention* layer; sync is
  the *detection/convergence* layer. The doc does not claim otherwise.

### E. Identity & git-tracking policy (opt-in)

- **Contribution control = git ACL.** Whoever can push to the remote can contribute a
  partition; Máddu adds no authz layer. A protected branch + signed commits is the
  team's call, enforced by the git host.
- **Authorship = git author + optional PGP signature** over the commit that carries a
  partition, layered on top of the per-partition `prev_hash` chain. Two independent
  evidence layers (chain + signed commit) with **zero Máddu-run identity**.
- **Git-tracking policy is opt-in and scoped.** Team-sync flips a project (not the
  framework repo) into committing **only** `.maddu/events/by-replica/**` — distinct
  from the framework's own "never commit dev state" `.gitignore`. `maddu spine sync
  init` writes the scoped `.gitignore`/`.gitattributes` (LF-pinned, like #12b's
  generated artifacts), git-ignores `replica.json`, and mints the `replicaId`.
  **Projections/state/inbox/sessions stay uncommitted and rebuildable** — committing
  them would both reintroduce merge conflicts (they *are* shared-mutable files) and
  widen the secret surface below. Only events are the synced source of truth.
- **Committing the spine widens the secret surface far beyond what #219/#220 scrub —
  this is a first-class requirement, not a footnote.** Those PRs redact **argv/command**
  channels; they do **not** touch arbitrary event `data` — approval payloads, handoff
  prose, slice-stop summaries, inbox text, plans, imported vendor memory. A committed
  spine exposes *all* of it to everyone with repo read. Therefore `sync init` and every
  `spine sync` **must** run a secret-scan gate (`redactText`/`scanArgv` patterns, reused
  from secret-scan.mjs) over the **whole** partition set being committed and **refuse on
  a hit**, and the design should treat **payload-level redaction as its own tracked
  problem** (larger than argv scrubbing). Teams that cannot accept committing rich `data`
  should sync a **projection-only or field-filtered** export instead of raw events — an
  explicit future variant, flagged here as an open decision.

### Data-flow (partitioned union → convergent projection)

```
 Replica A                         git remote                      Replica B
 ─────────                         ──────────                      ─────────
 append → by-replica/A/*.ndjson    ┌───────────────┐   append → by-replica/B/*.ndjson
        │  (A's linear chain)      │  union of      │          │  (B's linear chain)
        └──push──────────────────► │  all replica   │ ◄──push──┘
        ◄──pull──────────────────  │  partitions    │  ──pull─►
                                   └───────────────┘
 spine import:  parse-validate + chain-verify (report-only) → dedup by
                (replicaId,segment,seq) → k-way merge (seq within partition, ts across) →
                rebuild projections w/ pure-projection reconciliation (NO spine write)
        │                                                            │
        ▼                                                            ▼
   identical projection / cockpit  ═══ converges ═══   identical projection / cockpit
```

## Migration / back-compat

- **Zero contract break.** Core design needs no envelope change (`replicaId` in the
  path, order derived at read, reconciliation writes nothing) → `EVENT_CONTRACT_VERSION`
  stays `1.0.0`. The **only** possible additive `1.x` change is the optional `hlc`
  field (for cross-replica causal ordering), gated by the existing `versionDiscipline`
  and taken only if/when that need is proven — not part of the core path.
- **Legacy segment must be MIGRATED into the replica's partition at `sync init`, not
  left as a local "origin" (red-team round-2).** If the pre-sync `000…001.ndjson`
  stayed committed-nowhere but still read locally, an upgraded checkout's projection
  would include events no teammate has → **divergence**. So `sync init` **moves** the
  legacy segment(s) into `by-replica/<replicaId>/` (byte-for-byte — the
  `prev_hash` chain hashes stored lines, so a pure move preserves it, no reseal), where
  they get committed and synced like everything else. Result: **no local-only origin;
  every event a replica reads is one it also shares.** The move is a git rename (content
  identical) → no merge risk. A fresh (no-legacy) checkout simply starts writing under
  `by-replica/<id>/`.
- **Sync is opt-in.** Repos that never run `spine sync init` behave exactly as today
  (single shared segment, git-ignored). Nothing changes for solo users.

## Phased implementation plan (when unblocked)

1. **Partitioned write path** — `replicaId` mint + `spine.append` targets
   `by-replica/<id>/`; `readAll` k-way merge (seq within partition, `(ts,replicaId)`
   across). Gate: a new self-test proving N partitions replay to one deterministic
   order, byte-for-byte projection equality regardless of partition arrival order, **and
   that a clock-step-backward within a partition does NOT reorder its events** (seq
   wins).
2. **`spine verify` per-partition** — extend the chain walker to verify each partition
   independently. **Parse/envelope failure quarantines** that partition; a **chain
   fork is reported, not fatal** (report-only, matching today's `spine verify` and §C).
   Gate: a malformed partition is quarantined + reported; a chain-forked-but-parseable
   partition is ingested with a surfaced `chain_broken` warning (fatal only under the
   §A(b) append-funnel opt-in).
3. **`maddu spine import`** — verify + dedup + rebuild + idempotency. Gate: import same
   union twice → identical state, no dupes.
4. **Reconciliation (pure projection)** — deterministic lane-claim (then approval/phase)
   tie-break computed in the projector, **no per-replica reconciliation event**; expose
   contentions as a read-time view. Gate: two concurrent claims on one lane converge to
   the same winner on both replicas, **and a late earlier-`ts` claim flips the winner on
   the next rebuild** (monotonicity), with no accumulating reconciliation records.
5. **`spine sync` sugar + `sync init` policy** — the git wrapper + opt-in
   `.gitignore`/`.gitattributes` + `replicaId`. Gate: two real checkouts, disjoint
   lanes, `sync` round-trip → identical cockpit; **zero git conflicts**.
6. **Docs + charter** — `maddu spine sync` capability row, a `20-team-sync.md`
   deep-dive, and a cockpit surfacing of foreign replicas / reconciliations.

Each phase closes with a **Codex post-seal review chained to CLEAN**, per the #12
standing rhythm.

## Trade-offs, risks, open questions

- **For:** delivers the headline "several agents/teammates, one convergent record, no
  Máddu server" that vendors structurally can't match; keeps every hard rule; **no
  contract break required** (core path); eliminates the **cross-replica** git conflict
  that fired on every sync (disjoint write surface); convergent projections by pure
  reduction.
- **Risk — intra-replica chain fork (red-team #3/#6).** Partitioning does **not** make
  the per-partition `prev_hash` chain valid; bridge+CLI concurrency on one replica can
  still fork it, exactly as today. *Mitigation:* either accept verify-reported
  best-effort (regresses nothing) or add a per-replica append funnel (§A option b) to
  actually claim a valid chain. Do **not** ship the doc's original "valid per-partition
  chain" wording — corrected above.
- **Risk — ordering is convergent, not stable (red-team #2).** Late earlier-`ts` events
  reshuffle the sequence. *Mitigation:* reconciliation re-derives from the full set
  (§D); sentinels pin missing-ts/legacy/torn-line so "same set → same order" holds.
- **Risk — clock-skew misordering** of cross-replica *causal* events. *Mitigation:*
  lanes keep replicas disjoint; document the bound; HLC as a contract-minor escape hatch.
- **Risk — reconciliation double-count / non-monotonic (red-team #4).** *Mitigation:*
  the corrected §D keeps the decision in the projector (pure, re-derived, monotonic) and
  writes **nothing** to the spine (a durable marker was considered and rejected).
  Semantic-conflict surface is still unbounded in principle (every non-commutative
  projection needs a rule): ship lane-claim first, then approvals/phases; enumerate
  covered vs. uncovered in the gate.
- **Risk — committing the spine leaks rich `data`, not just argv (red-team #5).** The
  #219/#220 scrubs do **not** cover payloads (approvals, handoff, plans, memory).
  *Mitigation:* mandatory secret-scan gate over the committed set (§E); payload-level
  redaction and a projection-only/field-filtered sync variant are tracked as their own
  problems.
- **Risk — residual git conflicts outside event data (red-team #1):** duplicated
  `replicaId`, accidentally-committed projections/state, concurrent `.gitattributes`
  edits, git modify/delete/rename. *Mitigation:* never commit `replica.json` + collision
  detection (§A); commit events-only (§E); write `.gitattributes` once at `sync init`.
- **Open — partition GC / compaction.** Long-lived teams accumulate partitions; a
  `spine compact` that seals old partitions into a signed archive is future work.
- **Resolved — reconciliation is a pure cockpit view, no spine write** (the marker
  alternative was considered and rejected in §D).

## Recommendation

Adopt **author-partitioned segments + read-time deterministic order + explicit
verify/import, with git as a dumb transport and identity delegated to git/PGP.** After
the red-team, the claim is deliberately bounded but still strong: it satisfies all four
moat properties (external, cooperative, files-only, deterministic), unblocks #12c, ships
the **core path without a contract change**, and eliminates the cross-replica conflict
that made naive git-sync impossible. It is explicitly a **detection/convergence** layer
(who-did-what, resolved consistently), riding on lanes + worktree isolation (#12a) as the
**prevention** layer — not a distributed mutex. Recommend building phases 1–3 (the
convergent substrate) with the §A(b) append-funnel decision made up front, then 4
(pure-projection reconciliation), then 5–6 to productize — each with the mandatory
secret-scan gate before any spine is committed. Re-review the corrected design before
writing code.

See also `spine-tamper-evidence-proposal.md` (the per-event chain this builds on),
`competitive-response-proposal.md` (the #12 arc), and `roadmap-12-RESUME.md`.
