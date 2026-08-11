# 33. Loops and coordinator

Two related but distinct autonomy primitives:

- **Loops** (`maddu loop ralph`, `maddu loop plan`) — single-lane
  persistent iteration on one task.
- **Coordinator** (`maddu coordinator <plan-id>`) — multi-phase plan
  walking, one lane per phase.

Both are stdlib + `child_process.spawn` — no provider SDKs, no
Claude-Code-specific affordances.

## Loops (Phase 6)

Every iteration is a real slice with audit trail:

```
LOOP_STARTED             { loopId, kind, goal, maxIter, cooldownMs }
LOOP_ITERATION_STARTED   { loopId, kind, iter }
LOOP_ITERATION_COMPLETED { loopId, kind, iter, ok, signature, summary }
LOOP_HALTED              { loopId, kind, iter, reason, signature? }
LOOP_COMPLETED           { loopId, kind, iter, summary }
```

Stuck-detection: two consecutive failures with identical signatures →
`LOOP_HALTED reason: stuck-detection`. Max iter + cooldown come from
the governance tier ([governance tiers](30-governance-tiers.md)):

| Mode      | maxIter | cooldownMs |
|---|---|---|
| strict    | 3       | 10000      |
| standard  | 5       | 5000       |
| relaxed   | 10      | 1000       |

### Ralph

```bash
maddu loop ralph --goal "fix tsc errors" \
  --iterate "npm run codegen" \
  --verify  "npm test"
```

`verify` exit=0 ⇒ ok; non-zero ⇒ fail (and gets its tail captured into
the signature for stuck-detection).

**Verify-contract guarantees** *(locked in v1.1.1)*:

| verify outcome                               | loop result                                    |
| -------------------------------------------- | ---------------------------------------------- |
| exit=0                                       | `LOOP_COMPLETED` at iter=1                     |
| non-zero, identical signature twice in a row | `LOOP_HALTED reason: stuck-detection`           |
| non-zero, distinct signature each iteration  | `LOOP_HALTED reason: max-iter-reached`          |

A synthetic stress-harness scenario (`ralph-always-fail-halts`) exercises runLoop directly with in-process verify callbacks to lock the contract against regression. If the operator-supplied `--verify "<cmd>"` looks like it "always passes" when it shouldn't, double-check that the shell expansion preserves the exit code — single-quoted JS scripts inside `cmd.exe /c` on Windows can be interpreted very differently than under POSIX shells.

For agent-written project code, prefer the adaptive project-test verifier when
the repo has more than one test shape:

```bash
maddu loop ralph --goal "fix tests until green" \
  --verify "maddu test --profile quick --bail"
```

That keeps Ralph's loop bounded to the project's discovered test contract,
prints stable failing test ids, and leaves test creation suggest-only.

#### Ralph is acceptance-declared *(v1.120.0)*

Ralph's verification is now a declared **acceptance** — a command plus the
oracle that must stay frozen and the implementation that must move
([56-acceptance-proof.md](56-acceptance-proof.md)). Two grammars, and nothing is
inferred:

```bash
maddu loop ralph --from-goal --iterate "<agent turn>"          # adopt the active goal
maddu loop ralph --goal "..." --verify "<cmd>" \
                 --oracle "test/**" --impl "src/**"            # one ad-hoc acceptance
```

| invocation | outcome |
|---|---|
| `--from-goal` **and** `--verify` | exit 2 — two answers to one question |
| neither flag | exit 2 — nothing to verify |
| `--verify` without both `--oracle` and `--impl` | exit 2 |
| `--from-goal` with no goal / a closed goal / no verifiable condition / no declared sets | exit 3 |

A loop that cannot succeed refuses at the door instead of at the cap: an
acceptance with no declared sets can never satisfy the frozen-oracle clause, and
before v1.120.0 a bare `--verify` burned every iteration to `max-iter` on
`no-verify-supplied`. That change is **breaking** for existing
`ralph --verify`-only invocations — loudly, with a typed exit code.

`--from-goal` adopts the goal's own conditions, so the RED an earlier
`maddu orient` recorded pairs with the GREEN this loop produces; an ad-hoc
`--verify` acceptance is scoped to the loop id and pairs only within it. When
both an ad-hoc `--verify` and an acceptance-active goal exist, the loop warns
naming both and records `verifyOverride: true`.

#### Baseline observation

Ralph records an explicit **iteration-0 baseline** observation of every
acceptance after `LOOP_STARTED` and before the first iterate — the RED that must
exist before any later GREEN can pair with it. If the baseline comes back green
the loop still runs (the operator asked for it), and that GREEN can close a
qualifying earlier RED. A baseline that throws is caught and summarized, never
fatal: proof plumbing must not break the primitive it observes.

`LOOP_STARTED.data` carries the intent fields for acceptance-bearing ralph runs
only — `baselineRequested`, `verifySource: 'flag' | 'goal'`, `verifyOverride`.
`loop plan` and ralph-without-acceptance keep their exact legacy five-field
shape.

#### The stuck signature comes from an output fingerprint

For an acceptance-bearing ralph, an iteration's stuck-detection signature is
built per acceptance as `${acceptanceId}:${exit}:${fingerprint}`, joined in a
stable order — where `fingerprint` is a bounded digest of the run's output with
timing noise canonicalized away.

**A null fingerprint disables stuck detection for that iteration.** If any
acceptance's fingerprint is null — the output was truncated, or the observation
did not run at all (lock contention, a refusal) — the whole signature is `null`
and the loop cannot halt on it. That is the deliberately safe direction: two
genuinely different failures that happen to share a truncation prefix must never
read as "stuck", and a missed halt is bounded by `--max-iter` while a false halt
stops real work.

Timing is collapsed only in positions where it is unambiguously a *duration*:
an end-of-line suffix (parenthesized, `in`/`took`, or bare) and whole-line
fields (TAP `duration_ms`, jest `Time:`, vitest `Duration`). A test name that
itself ends its line with a duration collides with its own variants — a known,
accepted residue; every form that is *missed* merely false-differs, which costs
iterations, not correctness.

### Plan-loop

```bash
maddu loop plan --plan pln_2026... --max-iter 8
```

Same iteration discipline, but the loop's goal is derived from the
named plan; the iteration carries `triggered_by.planId` lineage so
the slice-stop ritual feeds the plan auto-revision pathway.

## Coordinator (Phase 7)

The coordinator is the missing portability piece. Before v1.1.0,
multi-phase autonomous coordinators were invoked through Claude Code's
`Agent` tool — Claude-Code-specific. The Máddu-native coordinator
works with any runtime.

```bash
maddu coordinator <plan-id>                     # via configured runtime
maddu coordinator <plan-id> --dry-run           # each phase succeeds (smoke test)
maddu coordinator <plan-id> --synthetic-cmd "<bash>"  # shell mode
maddu coordinator <plan-id> --runtime claude-code     # named runtime
```

### Mechanics

For each open phase:

1. Spawn a subprocess via `child_process.spawn` (no shell). Pass env
   vars: `MADDU_COORDINATOR_PLAN_ID`, `MADDU_COORDINATOR_PHASE`,
   `MADDU_COORDINATOR_ID`, `MADDU_COORDINATOR_ITER`, plus the operator's
   `MADDU_SESSION_ID`.
2. The initial prompt is the phase's `intent` from `state.json`.
3. 5-iter cap per phase. Stuck-detection (2x identical fail signature)
   halts cleanly with `reason: phase-iteration-cap`.
4. Phase complete → emits `PLAN_PHASE_COMPLETED` (Phase 5 auto-refreshes
   plan artifacts).
5. Cooldown between iterations reads from governance tier.

### Events

```
COORDINATOR_STARTED         { coordinatorId, planId, runtime, dryRun }
COORDINATOR_PHASE_STARTED   { coordinatorId, planId, phase, intent }
COORDINATOR_PHASE_COMPLETED { coordinatorId, planId, phase }
COORDINATOR_HALTED          { coordinatorId, planId, phase, reason, signature?, exitCode? }
COORDINATOR_COMPLETED       { coordinatorId, planId, phaseCount }
```

### Slash command

```
/maddu-coordinate <plan-id> [--dry-run | --synthetic-cmd "..."]
```

## When to use which

| Scenario | Use |
|---|---|
| "fix tsc errors until clean" | `maddu loop ralph` |
| "walk plan X through all phases" | `maddu coordinator X` |
| "implement TODO list across audit→build→verify" | plan + coordinator |
| "retry project tests until pass" | `maddu loop ralph --verify "maddu test --profile quick --bail"` |
| "manual phase progression" | `maddu plan complete-phase` |

## Gates

- **`loop-iteration-audit`** (safety) — every `LOOP_STARTED` has a
  matching `LOOP_COMPLETED` or `LOOP_HALTED`.
- **`loop-cooldown-respected`** (warn) — failing-iteration gaps honor
  the tier-default cooldown (200ms tolerance).
- **`coordinator-phase-coherent`** (safety) — every
  `COORDINATOR_PHASE_STARTED` has a matching `_PHASE_COMPLETED` or
  `_HALTED`.

## What's intentionally NOT here

- **Coordinator-to-coordinator chaining** — deferred to v1.3.0+ if a
  real need surfaces.
- **Auto-write skill curation from loop runs** — operator chose
  suggest-only ([Skills auto-inject](24-skills-auto-inject.md)).
- **Cloud terminal backends** — violates rule #3. Won't ship.
