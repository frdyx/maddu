# Proposal — earned autonomy (`maddu autonomy`): trust-graded governance recommendations

> **Status:** DESIGN FINAL — phase 1 of plan `pln_20260703191614_8da5` (market
> roadmap #11, operator-directed 2026-07-03). Inspired by
> MMVFIRM/Universal-Earned-Autonomy-Layer (UEAL); adapted to Máddu's cooperative
> files-only identity. Codex consult completed 2026-07-03; all findings
> incorporated below (marked ⊕).

## The question

Máddu's governance tiers (strict/standard/relaxed, per-workspace + per-phase)
are entirely **operator-set**. Should relaxation also be **earnable** — a
deterministic score over the verified record that tells the operator "this
lane's track record supports relaxed governance" (or "does not")? And if so,
what exactly counts as the record, and what is the schema?

## What we take from UEAL — and what we refuse

| UEAL concept | Máddu translation |
|---|---|
| Autonomy earned per (workflow, authority-class) from vetted decisions | Trust score per **(lane × repo)** from verified slice outcomes |
| Wilson lower bound so small samples don't over-score | Same statistic, verbatim |
| Clean approvals isolated from edited ones | Clean outcomes isolated from *unwitnessed* ones (Máddu has no approved-with-edits signal — verified in code, see below) |
| Hard risk ceilings no trust level removes | Sterile phases / escalation-only overrides stay the absolute floor; recommendations are suppressed while a phase tier is active |
| **Binding PEP + capability tokens + Ed25519 identity** | **REFUSED** — cooperative means recommend-only; no code path auto-relaxes a tier |

## Current state (verified in code, v1.91.2)

Full inventory: 10 evidence sources audited 2026-07-03. The load-bearing facts:

- **`SLICE_STOP.lane` is null in 59/59 events** on this repo's spine
  (`commands/slice-stop.mjs:186` sets `flags.lane || null`; agents don't pass
  `--lane`). But `SLICE_STOP.actor` is always the sessionId, and the session's
  lane is recoverable from `SESSION_REGISTERED.lane` / `LANE_CLAIMED{actor,lane}`.
  **Lane attribution = a session join, not a field read.**
- **`GATE_RAN` carries `actor:null, lane:null` in 31/31** (`gates.mjs:116-124`
  appends without context). Attribution today can only be *temporal*: gates run
  between two slice-stops of the same session (`reflect.mjs:106-110` already
  implements exactly this window for the completion-claim scan).
- **Per-slice verdict fields that exist today:**
  - `SLICE_STOP.data.deliverables {declared, verified, missing[]}` (v1.17.0) —
    `missing.length > 0` is the cleanest deterministic "hollow claim" flag;
    `verified > 0` is positive proof.
  - `SLICE_STOP.data.risk {level, signals, files, sensitive}` — stake weighting.
  - `GATE_RAN.data.status ok|warn|fail` + `outcome.mjs`'s `isCatch`/`isHardCatch`
    (v1.86.0) — the codebase's canonical clean/dirty gate classifier; reuse
    verbatim so definitions never diverge.
  - `reflect.mjs scanCompletionClaims` — hedged-claim-without-proof membership
    per sliceId (read-only sensor, persists nothing; results also ride
    `GATE_RAN gateId:completion-claim` evidence).
  - Approvals ledger records allow/deny only — **there is no approved-as-is vs
    approved-with-edits distinction**, so UEAL's clean-vs-edited axis maps to
    witnessed-vs-unwitnessed instead.
- **No per-lane/per-session aggregate scorer exists.** The idioms to copy:
  `fleet.mjs` (pure per-unit digest + `aggregate()` reducer — the closest
  precedent), `outcome.mjs` (pure reducer over events, shared predicates),
  `insights.mjs` (classification buckets + `--json`).
- `readEffectiveGovernance(repoRoot)` (v1.91.0) exposes mode + active phase
  tier; the recommender must read it (suppress relax-recommendations during an
  escalated phase; don't penalize lanes for skipping rituals a `relaxed` mode
  made optional).
- **Naming:** `maddu trust` is taken (supply-chain, docs/36). Verb: `maddu autonomy`.

## Proposed design

### 1. Outcome extraction (pure reducer over `spine.readAll`)

An **outcome** = one `SLICE_STOP`, attributed to a lane via the session join
(⊕ the join reads `SESSION_REGISTERED` **and** `SESSION_AUTO_REGISTERED` —
CLI auto-registration emits the latter). Each outcome is classified:

- **witnessed-clean** — has proof and no fault. Proof is *either* axis (⊕
  Codex: requiring declared deliverables systematically under-credited
  gate-only slices; this now matches `reflect.mjs`'s proof semantics):
  `deliverables.declared > 0 && missing.length === 0`, **or** ≥1 `GATE_RAN`
  with `status:'ok'` in the slice window. AND: no `isHardCatch` in the window,
  AND not a hedged-claim-without-proof match.
- **witnessed-dirty** — any of: `deliverables.missing.length > 0`; an
  `isHardCatch` in the window; hedged-without-proof membership.
- **unwitnessed** — no declared deliverables and no gate runs in the window.
  **Excluded from n** (the UEAL isolation move: unvetted work never inflates the
  score) but counted, because coverage itself gates recommendations.
  ⊕ Legacy `SLICE_STOP`s with absent/null `deliverables` (pre-v1.17.0) classify
  as unwitnessed unless gate runs in their window provide proof or fault.
  ⊕ A warn-status `GATE_RAN` makes a slice witnessed (it is evidence the work
  was checked) but is neither proof nor fault — `isHardCatch` stays the only
  dirty gate axis, warn-severity catches don't damn a slice. Implementation
  refinement (phase 2): these slices form an explicit fourth bucket,
  **neutral** — witnessed for coverage, excluded from n — so the trichotomy
  stays exhaustive. `witnessed = clean + dirty + neutral`;
  `coverage = witnessed / total`; `n = cleanCapped + dirty`.

Windowing (which `GATE_RAN`s belong to a slice) reuses the `reflect.mjs`
between-slice-stops idiom for historical events. ⊕ Report/meta events
(`AUTONOMY_SCORED`, `DOCTOR_REPORT`, `AUTONOMY_RECOMMENDATION`) are ignored by
the reducer so scoring never feeds on itself.

⊕ **Clean-credit throttle (gaming resistance, Codex #5):** clean outcomes are
capped per (lane × UTC day) — default 5 — while dirty outcomes always count.
Deterministic from `ts` + attribution; farming trivial verified deliverables
buys at most the daily cap, and one hard catch still lands in full. Raw
uncapped counts stay visible in the output so volume remains legible.

### 2. Forward-only signal enrichment

The temporal gate window mis-attributes under concurrent sessions. Rather than
tolerate that forever: when `runGates` is invoked from slice-stop (which knows
the session), **start stamping `actor`/`lane` onto `GATE_RAN`** — a
forward-only envelope enrichment, same adoption pattern as `prev_hash`
(v1.14.0). Historical events stay window-attributed; new events are exact.
⊕ Also pass `sliceId` into the gate context when available (`data.sliceId`),
so a gate run binds to one specific outcome, not just a lane — actor/lane
alone narrows but doesn't fully bind.

### 3. Score + ladder

Per (lane × repo): **Wilson lower bound** (z = 1.96) over
`clean / (clean + dirty)`, with `n = clean + dirty` and
`coverage = n / (n + unwitnessed)`.

| Rung | Meaning | Default criteria |
|---|---|---|
| 0 `observe` | Record too thin to say anything | `n < 5` or `coverage < 0.5` |
| 1 `established` | Consistent verified record | wilson ≥ 0.60 |
| 2 `relaxation-candidate` | Record supports recommending `relaxed` | wilson ≥ 0.85, `n ≥ 20`, no witnessed-dirty in the trailing 14 days |

Thresholds live in `.maddu/config/autonomy.json` (defaults above); `nowMs` is a
parameter (the `reflect.mjs` pattern) so the reducer stays deterministic and
testable. ⊕ Codex verdicts adopted: **unweighted v1** (risk-weighted Wilson
makes the denominator unexplainable; `risk.level` stays a reporting dimension,
candidate veto material for v2), and a documentation note that wilson ≥ 0.85
all-clean is first reachable at **n ≈ 22**, so the `n ≥ 20` criterion is
effectively n ≥ 22 — intentional, stricter than it reads.
⊕ Historical coverage is **never judged against the current governance mode**
(a lane graded lax under today's `relaxed` may have worked under `strict`);
effective mode is used only for present-tense recommendation suppression.

### 4. Surface + events

- `maddu autonomy` — table per lane: score, n, coverage, rung, recommendation;
  `--json`; `--lane <id>`.
- `AUTONOMY_SCORED` — emitted on explicit runs (like `DOCTOR_REPORT`).
- `AUTONOMY_RECOMMENDATION` — emitted **only on rung change**, deduped against
  the last such event on the spine (no state file; the spine is the dedup
  record). ⊕ `spine.append` is atomic-append, not compare-and-swap, so two
  concurrent runs can double-emit the same change — readers (cockpit, orient)
  MUST collapse by `(lane, rung)`, and the event carries full context so a
  duplicate is self-explanatory, never corrupting.
- One-line surfacing in `maddu orient` + `maddu governance show` when a
  recommendation is live.
- ⊕ While `readEffectiveGovernance` reports **any active phase** (`__phase`
  present, escalated or not — the phase floor is absolute, Codex fix): relax
  recommendations are suppressed, shown as `muted (active phase)`.

⊕ **Frozen event `data` shapes (schemaVersion 1 — spine fields are forever):**

```json
AUTONOMY_SCORED.data = {
  "schemaVersion": 1, "asOf": "<ISO ts>", "attribution": "session-join+window|stamped",
  "configHash": "<sha256 of effective thresholds>",
  "lanes": [{ "lane": "...", "clean": 0, "cleanCapped": 0, "dirty": 0,
              "neutral": 0, "unwitnessed": 0, "total": 0, "n": 0,
              "coverage": 0.0, "wilson": 0.0,
              "rung": "observe|established|relaxation-candidate" }]
}

AUTONOMY_RECOMMENDATION.data = {
  "schemaVersion": 1, "asOf": "<ISO ts>", "lane": "...",
  "fromRung": "...", "toRung": "...", "wilson": 0.0, "n": 0, "coverage": 0.0,
  "recommendation": "consider-relaxed|maintain|revert-to-standard",
  "muted": false, "mutedReason": null,
  "configHash": "<sha256 of effective thresholds>"
}
```

Both types registered in `spine.mjs EVENT_TYPES` (append rejects unknowns).

### 5. Files

```
template/maddu/runtime/lib/autonomy.mjs    pure reducer: attribution join + classify + wilson + rungs
commands/autonomy.mjs                      CLI verb (table/--json/--lane)
.maddu/config/autonomy.json                thresholds (optional; defaults compiled in)
scripts/test/autonomy-score.mjs            fixture: golden cases incl. small-vs-large sample ordering
```

No state file. The score is a pure derivation, recomputable from the spine —
same posture as `outcome.mjs`.

### Invariants (restated as code obligations)

1. No write to `governance.json` anywhere in the feature.
2. Same events + same config + same `nowMs` ⇒ byte-identical `--json` output.
3. Reads spine + state only; writes only its two event types.
4. Recommendation ≠ application: applying remains the operator running the
   existing `governance set` / tier commands.

## Trade-offs

- **For:** turns the durable record into the thing vendors structurally can't
  offer — *earned* governance graded by a deterministic verifier; all raw data
  already exists; pure-reducer implementation is cheap and idiomatic; the
  self-incriminating-receipts positioning gets a constructive twin (the record
  can also *vouch* for you).
- **Against:** historical gate attribution is heuristic until the enrichment
  accumulates; lane attribution depends on sessions registering lanes (they do
  via hooks, but `--lane`-less slice-stops in foreign repos degrade to
  unwitnessed); a score invites gaming (an agent could declare trivial verified
  deliverables to farm clean outcomes — mitigated by coverage + hard-catch
  veto, but worth a retro after real data); and it's a new always-on capability
  in a codebase that just drained its roadmap — scope discipline matters.

## Options

| Option | Meaning |
|---|---|
| **A. Full design above** | Reducer + enrichment + verb + events + surfacing, recommend-only. |
| **B. Score-only** | Ship the reducer + `maddu autonomy --json` with no recommendations/events; add rungs after a quarter of data. |
| **C. Defer** | Wait for more approvals/gate volume on real fleets first. |

## Recommendation

**A**, as amended by the consult: unweighted Wilson, gate-only proof counts,
clean-credit daily cap, both event shapes frozen at schemaVersion 1, GATE_RAN
enrichment (actor/lane/sliceId) shipped in the same release so the
exact-attribution clock starts immediately. Codex endorsed the trichotomy,
the statistic, the thresholds (with the n≈22 documentation note), and the
forward-only enrichment; every defect it raised is folded in above. Phase 2
(scoring engine) can start from this document as the contract.
