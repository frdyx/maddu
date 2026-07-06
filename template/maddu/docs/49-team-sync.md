# `maddu spine sync` — git-native team sync

Team sync shares the append-only event spine between checkouts **through the
git remote the repo already has**. No server, no daemon, no new credentials, no
CRDT database — the transport is `git commit / pull / push`, the authorization
boundary is the remote's own ACL, and the merged history every replica reads is
a deterministic pure function of the files on disk.

It is strictly **opt-in**: until you run `maddu spine sync init`, nothing in
this document exists in your repo and every code path described here is inert.

## The guarantees

- **Opt-in / inert.** Sync mode is activated by `.maddu/config/replica.json`
  (plus the `by-replica/` partition tree). No committed `replica.json` and no
  pending init marker → the default single-machine spine, untouched — even if
  a stray `by-replica/` directory is present.
- **Byte-identical default path.** A repo that never opts in reads and writes
  the spine exactly as before — same bytes, same projection, for *every*
  history. Sync-mode logic (partitioned reads, reconciliation) is scoped behind
  the replica check.
- **No contract change.** The [published event contract](event-schema.md) stays
  at its current MAJOR. The replica identity rides in the *path*
  (`by-replica/<replicaId>/`), never in the event envelope.
- **Reconciliation is pure projection.** Conflict resolution (below) is
  computed at read time from the merged order. It writes **zero** events.

## The model: author-partitioned segments

Each checkout (a *replica*) appends **only to its own partition**:

```
.maddu/events/
  by-replica/
    rep_a1b2c3/           ← this checkout writes here, and only here
      000000000001.ndjson
      000000000002.ndjson
    rep_x9y8z7/           ← a teammate's partition — read-only to you
      000000000001.ndjson
```

- **Single writer per partition.** Git never has to merge concurrent edits to
  the same file: your commits touch your partition, theirs touch theirs.
  Segments are append-only, and `.gitattributes` marks them `-text
  merge=binary` so no tool ever attempts a line merge.
- **`replica.json` is this checkout's identity — never committed.**
  `spine sync init` templates `.gitignore` so partitions are shared but
  `replica.json` is not. Two checkouts sharing a replicaId would resurrect the
  multi-writer conflict the partitioning exists to prevent. Cloning a synced
  repo does **not** make the clone a replica — reads and writes both key on the
  local replica identity, so a fresh clone must run its own `spine sync init`
  before it reads the shared partitions or writes anywhere.
- Each partition keeps its own `prev_hash` chain, so `maddu spine verify` and
  `maddu spine import` detect after-the-fact edits or forks per partition.

## The read side: deterministic k-way merge

In sync mode, reading the spine is a k-way merge across partitions — **not a
flat sort**:

- Within a partition, events are consumed in **append (seq) order, always**. A
  backward clock step inside a partition can never reorder that partition's own
  events — it would contradict its `prev_hash` chain.
- Across partitions, `(ts, replicaId)` only decides the **interleave**: which
  stream's head event goes next.

Every replica holding the same set of partition files computes the same total
order — convergence is a property of the files, not of any coordination.

## The verbs

### `maddu spine sync init` — opt in

```bash
$ maddu spine sync init [--json]
```

One-time activation for this checkout: scans the existing spine for
secret-shaped values (refuses if any — the whole payload becomes git-visible),
mints a fresh replicaId, migrates the legacy flat segments into
`by-replica/<replicaId>/`, writes `replica.json`, and templates marker blocks
into `.gitignore` / `.gitattributes` (idempotent — it touches only its own
block). Concurrent inits are serialized by an exclusive lock; a second run
reports `already`. Then commit `.maddu/events/by-replica/` to share.

Run init **while writes are quiescent**: an append racing the migration can
leave a flat segment behind (reported as a `strandedFlat` WARN). A stranded
segment is still read locally but is not shared until the operator moves it —
the WARN names the files.

### `maddu spine import` — validate what git brought in

```bash
$ maddu spine import [--json]
```

Read-only inspection of every partition after a pull. Fatal (refuses "safe to
merge"): a fork in any partition's hash chain, structural damage (segment gaps,
missing genesis), duplicate event ids **within** one partition (a real
single-writer bug), or secret-shaped values. Tolerated and reported: duplicate
ids **across** partitions (a probabilistic collision — identity is
partition-position) and quarantined line-level damage — unparseable/torn lines
(skipped at read time) and envelope-damaged rows (reported for the operator to
fix; a parseable row still enters the read). Nothing to "apply" — in a
sync-initialized checkout a valid partition tree simply *is* the merged spine
on next read (a fresh clone must run `spine sync init` first).

### `maddu spine sync` — the git round-trip

```bash
$ maddu spine sync [--json]
```

One audited round-trip: **commit → pull → validate → push.**

1. **Preflight.** Refuses when an init is mid-flight, `replica.json` is
   malformed, git is missing, or the repo is mid-merge/rebase/cherry-pick/
   revert. Then the secret gate runs again — every sync, not just init.
2. **Commit own segments only.** Stages exactly this replica's numeric
   partition segments (explicit pathspec — never `git add -A`), plus
   `.gitignore`/`.gitattributes` **only when untracked and content-equal to
   the fresh managed block** (equal after line-ending/trailing-whitespace
   normalization — a first share can't publish your pre-existing local rules;
   if you've edited them it warns `uncommittedMeta` and leaves them to you).
   Commits under the canonical subject `maddu spine sync (<replicaId>)`.
   Hooks are **not** bypassed.
3. **Pull peers.** `git pull --no-rebase`; a failing pull — a genuine merge
   conflict, or the remote/auth/network failing — reports `pull-conflict`
   (any in-progress merge is aborted first). A *genuine* conflict should not
   happen under author-partitioning; it indicates something outside the sync
   model touched partition files.
4. **Validate.** Runs `spine import` on the merged tree; a failing report stops
   before anything is published (`import-failed`).
5. **Audited push.** Before pushing, every unpushed commit (`@{u}..HEAD`) is
   audited **by path and content**: own-partition segments must be added or
   byte-appended (an old blob must be a prefix of the new — no rewrites, no
   deletes, no renames), dotfiles must match the fresh managed block (the
   normalized comparison above), and pull-merge commits must contribute
   nothing of their own. Any other commit —
   your unpushed feature work, a foreign partition write — refuses the
   push (`unrelated-commits`, listing the offenders) rather than publishing
   things you didn't ask it to. The push itself is an explicit refspec
   (`HEAD:refs/heads/<tracked-branch>`, `--no-follow-tags` so local tags are
   never carried along), never a bare `git push`.

No upstream configured → commit and validate still run; pull/push are skipped
(`hasUpstream: false`). Set an upstream to complete the loop.

### Failure vocabulary

`maddu spine sync`:

| `reason` | Meaning |
| --- | --- |
| `not-sync-mode` | No `replica.json` — run `maddu spine sync init` first. |
| `sync-init-in-progress` | An init's pending marker exists — let it finish (or clean up a crashed one). |
| `config-invalid` | `replica.json` present but malformed — fix or remove it (remove = default mode). |
| `no-git` / `git-busy` | Git missing, or the repo is mid-merge/rebase/cherry-pick/revert. |
| `secret` | Secret-shaped values in the spine — redact before anything is shared. |
| `git-add-failed` / `git-commit-failed` / `git-status-failed` / `git-range-failed` | A plumbing git call failed — the `detail` field carries git's stderr. |
| `pull-conflict` | The pull failed — a genuine merge conflict (aborted; indicates a partition edited outside the model) or the remote/auth/network failing. |
| `import-failed` | The merged tree failed validation — the report says which partition and why. |
| `unrelated-commits` | Unpushed commits that aren't sync-owned — push them yourself, then re-run. |
| `push-failed` | Detached HEAD, the tracked upstream isn't a branch ref, or the remote refused. |

`maddu spine sync init` additionally: `mint-collision` (could not mint a fresh
replicaId) and `migrate-conflict` (a segment name already exists in the target
partition — inconsistent state, resolve manually). No upstream configured is
**not** a failure (see above).

## Reconciliation: lane claims and `contentions`

Lanes are advisory coordination, not a lock service — two replicas can claim
the same lane before either has pulled. In sync mode the projector resolves
this **deterministically at read time**:

- **Earliest wins.** The claim that comes first in the k-way-merged total order
  holds the lane. Later concurrent claims are *computed-superseded* into a
  read-time `contentions` projection field (`{ lane, holder, superseded[] }`) —
  carried in the projection, written nowhere.
- **Monotonic and convergent.** Pulling an earlier-timestamped claim can flip
  the computed winner, and every replica that holds the same partitions
  computes the same holder. Zero spine writes — history is never rewritten to
  match the outcome.
- **Default path untouched.** Without a replica identity (no committed
  `replica.json`, no pending init) the projector runs the literal pre-sync
  reducer, byte-identical for every history.

A surfaced contention is a signal to the *team* — the superseded session should
re-claim a different lane or coordinate; Máddu records, it does not arbitrate.

## Secrets

The write boundary is the primary defense: payloads are redacted before they
ever reach the spine. Team sync adds a **mandatory second gate** — `sync init`
and every `spine sync` scan the whole spine and refuse to share while any
secret-shaped value is present. Remember that git history is permanent: a value
that was committed and later redacted is still in the remote's history —
rotation, not redaction, is the fix at that point.

## Identity and trust

Máddu deliberately adds **no identity layer of its own**:

- **Authorization is the git remote's ACL.** Who may push partitions is exactly
  who may push to the repo.
- **Authenticity is git's.** Sign commits (PGP/SSH signing + branch protection)
  if you need cryptographic authorship — sync commits are ordinary commits and
  sign like any other.
- A replicaId is **identity-by-position**, not authentication: it names a
  partition, and the pre-push audit stops a replica from writing outside its
  own. A hostile collaborator with push rights can still do what git lets them
  do — the per-partition hash chains and `spine import` make tampering
  *evident*, and the remote's history makes it attributable.

## What team sync is not

- **Not a lock service.** Lanes stay advisory; contentions surface races, they
  don't prevent them.
- **Not an auto-merger of work.** It merges the *record*; conflicting code
  changes are still yours to reconcile.
- **Not a server or a daemon.** Nothing runs; state is files plus the remote
  you already trust.
- **Not a contract change.** A consumer of the [event contract](event-schema.md)
  cannot tell whether events were recorded solo or by a team.

See also: [07-lanes-and-sessions.md](07-lanes-and-sessions.md) (what lanes
mean), [19-multi-workspace.md](19-multi-workspace.md) (many repos, one
machine — team sync is the converse: one repo, many machines),
[34-threat-model.md](34-threat-model.md), and the *Verifiable, not just
declared* section of [hard-rules.md](hard-rules.md).
