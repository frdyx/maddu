# Focus Director (`maddu focus`)

The Focus Director is an **opt-in, domain-blind instrument** that scores the
*pilot's* trajectory against the declared goal and flags **sustained,
un-returned** drift with a `swap / revert / continue` choice — never a gate. It
optimizes the operator's attention, not the artifact: an "anti-ADHD" / scope-creep
watcher distilled into an agent.

It is **off by default**. Nothing fires until you opt in.

## Why it exists

Every other guardrail in Máddu points at the *work* — gates lint the code, the
drift checks compare artifacts to a contract, the reviewer reads the diff. The
Focus Director is the first instrument pointed at the **steerer**. It answers a
different question: *are we still moving toward the goal, or have you wandered?*

It is deliberately **domain-blind** — it compares the topic of your current
attention to the goal's text, never the technical merit of the work. That means
it cannot be argued out of a flag on technical grounds, and a stretch of
genuinely necessary detours still reads as drift until you return. One detour is
silence; a *run* of off-axis turns with no return earns the interrupt.

## How it works

| Stage | Mechanism |
|---|---|
| **Per-turn tag** | On every `session heartbeat` (and each `slice-stop`, as a floor), a **deterministic** tagger scores the turn `toward` / `lateral` / `away` of the goal — by counting how many of the goal's **distinctive terms** (stemmed tokens of the objective + constraints; success-condition texts excluded, their verification vocabulary matched off-goal work) appear in your current focus text. Absolute anchors, not a ratio (v1.92.2): the old share-of-attention metric punished *verbosity* as drift — detailed, honest, on-goal slice summaries read as `away` (5/5 false positives on real 2026-07-03 data) while terse texts passed. ≥2 anchors → `toward`, 1 → `lateral`, 0 → `away`. No LLM; zero cost. Appended as `FOCUS_TAGGED` (signals carry `anchors` + `anchorHits`). |
| **Goal-relative** | The score is relative to the declared goal (`maddu goal set`). With **no goal**, the director stays silent (`toward`, distance 0) — it never asserts drift without a reference. |
| **Sustained-drift flag** | When `K=4` consecutive turns are off-axis with no return, one `DRIFT_FLAGGED` is emitted (30-minute cooldown so it never nags) and surfaced to the operator mailbox with the `swap / revert / continue` menu. |
| **Cheap-worker narrative** | The flag's wording is optionally enriched by a cheap-model **worker subprocess** (`spawnWorker`). If no runtime is configured it degrades gracefully to the deterministic run-summary — so the flag always lands. (Rule #5: the subprocess owns the API call; no SDK in framework code.) |

The per-turn tag has **no cooldown** (tagging every turn is the whole point, like
the auto-handoff refresh); only the *flag* is cooldown-guarded.

## The command surface

```bash
maddu focus [status]                          # current direction + window + open flag
maddu focus enable                            # opt IN  — allowlist the two triggers
maddu focus disable                           # opt OUT — remove them
maddu focus resolve <swap|revert|continue>    # answer an open drift flag
```

`enable`/`disable` toggle the rule-#9 allowlist entries `heartbeat:focus-director`
and `slice-stop:focus-director`. `resolve` appends a cleared `DRIFT_FLAGGED`
carrying your choice, which resolves the open flag.

## The cockpit

The **Focus** route (decide cluster) renders the trajectory as an operator
dashboard: the current direction + overall score + a trend sparkline, the
trajectory of recent turns converging on the **TARGET** (the declared goal), any
open drift flag with its choice, and a timeline strip — all in the navy-noir
cockpit language. Data: `GET /bridge/focus`.

## Opt-in, by design

The director writes a `FOCUS_TAGGED` every turn, so — unlike `auto-review`, which
no-ops without a reviewer — it is **off by default** and you opt in explicitly.
Its event types (`FOCUS_TAGGED`, `DRIFT_FLAGGED`) are registered
`DORMANT_BY_DESIGN`, so an un-enabled install reads them as *dormant*, not *dead*,
in `maddu insights`. The same pattern as `SCHEDULE_*`.

## Events & invariants

- `FOCUS_TAGGED` — `{ tag, distanceScore, signals, goalSetAt }`, one per tagged turn.
- `DRIFT_FLAGGED` — `{ reason, runs, menu, deterministic|enriched }`; `{ cleared: true, choice }` resolves an open flag.
- Every emission crosses the **rule-#9 gauntlet** (allowlist + cooldown + `TRIGGER_FIRED` provenance).
- Files-only, append-only (rules #1/#2); the `focus{lastTag, window, openFlag}` projection slot is rebuilt from the spine and kept honest by the `focus-ledger-coherent` gate.

## Related

- [`maddu goal`](03-cli-reference.md) — declare the objective + success conditions the director measures against.
- [`maddu orient`](03-cli-reference.md) — the goal-anchored session-start briefing the director complements.
