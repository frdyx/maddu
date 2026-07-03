# 47. Earned autonomy (`maddu autonomy`)

`maddu autonomy` grades each lane's **earned trust** from the verified record —
a deterministic **Wilson lower bound** over witnessed-clean vs witnessed-dirty
slice outcomes, mapped to a three-rung ladder — and **recommends, never
applies,** governance-tier changes.

It is the constructive twin of Máddu's self-incriminating receipts: the same
durable record that can prove an agent claimed "done" without proof can also
*vouch* for a lane that has consistently delivered verified work. Governance
tiers stop being pure operator intuition; the tier decision meets its evidence.

**Recommend-only is a contract, not a default.** No code path in the feature
writes governance config — applying a recommendation is always the operator
running `maddu governance set …`. This is fixture-asserted, not just
documented.

## Why it exists

`strict / standard / relaxed` (see [30-governance-tiers.md](30-governance-tiers.md))
are operator-set. Nothing computed whether a lane's actual track record —
clean slice-stops, green gates, no hedged claims — *supported* relaxing, or
demanded reverting. Vendors can't build this either: it requires a neutral,
cross-session, repo-owned record of agent work, which is exactly what the
spine is. (Inspired by the "earned autonomy" concept in UEAL; Máddu takes the
*idea* — autonomy earned from a vetted track record — and refuses the
mechanism: no binding enforcement, no crypto identity, no proxy.)

## How a slice becomes an outcome

Every `SLICE_STOP` is classified by a pure reducer over the spine
(`lib/autonomy.mjs` — same events + same thresholds ⇒ identical output):

| Outcome | Meaning |
|---|---|
| **witnessed-clean** | Proof on either axis — declared deliverables all verified on disk/git (`declared > 0`, none missing), or ≥1 ok-status gate ran during the slice — AND no hard gate catch, AND not a hedged completion claim without proof. |
| **witnessed-dirty** | A declared deliverable that doesn't exist, a hard gate catch (`isHardCatch`, the outcome-ledger predicate) in the slice's window, or a hedged claim with no observed proof (the `learn scan` join). |
| **neutral** | Witnessed (a gate ran — e.g. warn-status) but neither proof nor fault. Counts toward coverage, excluded from n. |
| **unwitnessed** | No deliverables declared, no gates ran. Excluded from n — unvetted work never inflates the score — and drags coverage down. |

**Lane attribution is a session join,** because `SLICE_STOP.lane` is null in
practice: the slice's lane is whatever its session registered
(`SESSION_REGISTERED` / `SESSION_AUTO_REGISTERED`) or claimed (`LANE_CLAIMED`)
as of that point in the spine. Historical `GATE_RAN`s attach by the
between-slice-stops window; **from v1.92.0 slice-stop stamps its session onto
the gate events it runs**, so exact attribution accumulates forward.

## The score and the ladder

Per (lane × repo): Wilson lower bound (z = 1.96) over `clean / (clean + dirty)`.
The statistic is the point — 3-for-3 clean scores 0.44, 30-for-30 scores 0.89,
so a thin record can never masquerade as a proven one.

| Rung | Default criteria |
|---|---|
| `observe` | n < 5, or coverage < 50% — the record is too thin to say anything |
| `established` | wilson ≥ 0.60 |
| `relaxation-candidate` | wilson ≥ 0.85, n ≥ 20, no witnessed-dirty in the trailing 14 days. (All-clean first crosses 0.85 at **n = 22** — the n ≥ 20 line is intentionally stricter than it reads.) |

**Anti-farming:** clean credit is capped per lane per UTC day (default 5) while
dirty always lands in full — declaring trivial verified deliverables buys at
most the cap, and one hard catch outweighs a day of farming. Raw counts stay
visible (`clean` capped/raw in the table) so volume remains legible.

Thresholds are overridable in `.maddu/config/autonomy.json`; the effective set
is hashed onto every emitted event (`configHash`) so a score stays
interpretable against the config that produced it.

## The command surface

```bash
maddu autonomy                # per-lane table: rung · wilson · n · clean · dirty · neutral · unwit. · coverage
maddu autonomy --lane backend # one lane
maddu autonomy --json         # machine-readable (byte-identical for identical inputs)
maddu autonomy --no-emit      # read-only inspection: append nothing
```

Every explicit run appends `AUTONOMY_SCORED` (the `DOCTOR_REPORT` pattern).
`AUTONOMY_RECOMMENDATION` is appended **only when a lane's rung changes**,
deduped against the last such event on the spine — the spine is the dedup
record; there is no state file. Recommendation verdicts: `consider-relaxed`
(rose into candidate), `revert-to-standard` (fell out of candidate),
`maintain` (any other move).

## The phase floor is absolute

While **any** phase is active (`maddu phase set`, sterile or not), relax
recommendations are **muted** — shown with the phase named as the reason, and
the emitted event carries `muted: true`. A declared phase is an operator
statement about the current working posture; no earned score overrides it.
Escalation-only phase tiers ([30-governance-tiers.md](30-governance-tiers.md))
always win.

## Where it surfaces

- `maddu autonomy` — the full table.
- `maddu orient` — one `∴ autonomy:` line when a live (unmuted, non-maintain)
  recommendation exists.
- `maddu governance show` — the latest recommendation rendered next to the
  tier decision it informs.
- **Cockpit** — both event types in the stream (trust/amber family, human
  summaries with rung-change arrows), and the orientation brief card shows the
  latest recommendation as its own `Autonomy` row.

## Events & invariants

- `AUTONOMY_SCORED` / `AUTONOMY_RECOMMENDATION` — schemaVersion-1 `data`
  shapes frozen before first emission (spine fields are forever); both are
  report events the scorer itself ignores, so scoring never feeds on itself.
- Deterministic: no LLM, no network, no clock inside the reducer (`nowMs`
  injected). Files-only: reads the spine, writes only its two event types.
- Rule #9: the verb is `mutating` + auto-trigger `forbidden` — it runs when
  the operator (or an agent, explicitly) invokes it, never on a timer.
- Design record: `docs/research/earned-autonomy-proposal.md` (the full
  contract, evidence inventory, and the consult that shaped it).

## Related

- [30-governance-tiers.md](30-governance-tiers.md) — the tiers a
  recommendation points at, and the sterile phases that mute it.
- [37-failure-learning.md](37-failure-learning.md) — `learn scan`, whose
  hedged-claim join is one of the dirty signals.
- [39-rule-gate-traceability.md](39-rule-gate-traceability.md) — the gate
  machinery whose runs are the proof/fault signals.
