# SLM governance — `maddu model`

Teams building **domain-specific small language models** run a factory:
curate data, fine-tune (SFT / DPO / GRPO, usually LoRA/QLoRA), benchmark,
and promote checkpoints toward production. Excellent tools do every step —
TRL/PEFT/Axolotl train, vLLM/llama.cpp serve, SWE-bench/BFCL/MLflow
evaluate — but none of them is the neutral record of what happened between
the steps, and none governs the hand-offs. `maddu model` makes Máddu that
record and that gatekeeper. **Máddu governs the factory; it never trains,
serves, or evaluates** — no CUDA, no weights, no ML dependencies.

Design of record: `docs/research/slm-governance-design.md` (red-teamed
across the build). Event contract: the 11 `MODEL_*` types in
[event-schema.md](event-schema.md) (contract 1.1.0).

## The shape of it

Everything rides **manifests** — JSON files in your repo (any path;
`models/` is the convention) describing a dataset snapshot, training run,
eval run, promotion, or checkpoint registration. Each verb validates the
manifest, pins its sha256, sweeps it for secrets (refuse-on-hit, **no skip
flag**), and appends a typed event. Two kinds of claim are kept honest
everywhere: what Máddu computed first-hand (**pinned** — the manifest hash)
vs what the manifest author declared (**declared** — artifact hashes,
licenses, metrics). Máddu never fetches or verifies a multi-GB artifact;
gates and docs never present a declaration as a verified fact.

```
maddu model dataset snapshot models/tickets-v3.json   # record the dataset of record
maddu model train start models/run-42.json            # record an externally-run training start
maddu model train complete models/run-42.json         # …and its completion (checkpoint + metrics)
maddu model checkpoint register models/ckpt.json      # register the checkpoint identity (sha256)
maddu model eval record models/eval-7.json            # record a benchmark result (+ critical regressions)
maddu model regression ack ev-7 --reason "…"          # recorded operator judgment — the only recovery
maddu model promote models/promote.json               # propose a stage advance (see the ride below)
maddu model release models/promote.json               # record the release (rollback plan required)
maddu model rollback models/promote.json              # strictly downward, never a re-elevation
maddu model status · maddu model list checkpoints     # the registry, derived read-time from the spine
```

Every verb records what external tools did — `train start` starts nothing,
`eval record` runs nothing.

## The promotion ride

Checkpoints walk a fixed ladder — `experiment → candidate → canary →
released`, one step at a time — and the **current stage is always derived
from the spine** (approvals move it up, rollbacks move it down); a
manifest's declared `from_stage` is a claim that gets checked, never
trusted. Advancing requires the approvals system, in every governance mode:

1. `promote` appends an `APPROVAL_REQUESTED` **first** (tool key
   `model promote:<from>-><to>`), then the proposal carrying that request's
   id. Decide with `maddu approval respond --id <id> --decision allow-once`,
   then `maddu model promote --confirm <proposal-id>` — which binds exactly:
   that proposal's own request, an allowing decision, one approve per
   proposal, and a stale proposal (checkpoint moved meanwhile) is refused.
2. Standing policies work **only for `experiment → candidate`**. ⚠ **A
   policy on the canary or released tool keys is deliberately inert** — the
   auto-decide cascade is simply never consulted above candidate, so no
   standing policy (stage-keyed or wildcard) can advance a model toward
   production. Those transitions always wait for an explicit per-request
   decision. If you set such a policy expecting auto-promotion: that is the
   safety property working, not a bug.
3. There is no flag that skips the ride.

The spine verifier holds all of it tamper-detecting on replay: promotion
without its own allowing approval, stage skips vs the derived stage,
cross-proposal approval reuse, non-downward rollbacks, releases without a
rollback plan — all FAIL `maddu spine verify`.

## The gate starter pack

```
maddu model gates install          # copies 12 gates into .maddu/gates/ — then they are YOURS
maddu model gates install --force-list   # dry run
maddu ci pin                       # make any of them required in CI
```

Twelve deterministic ML-lifecycle gates, installed as **operator-owned**
files (never builtins): `dataset-license-known`, `dataset-hash-pinned`,
`dataset-manifest-no-secrets` (re-scans recorded manifest files; a missing
file is WARN, a secret hit is the only red), `dataset-synthetic-labeled`,
`train-eval-split-frozen`, `benchmark-contamination-check`
(declaration-level, and its messages say so — content-level decontamination
is the harness's job), `training-config-pinned`,
`eval-harness-version-pinned` (warn), `no-critical-regression` (recovery is
the recorded `regression ack`, never "promote to shadow it"),
`latency-cost-budget-met` (opt-in: `.maddu/config/model-budgets.json` —
`{ "<benchmark>": { "latency_ms_max": N, "cost_usd_max": N } }`, reading the
conventional manifest keys `latency.ms` / `cost.usd`),
`candidate-promotion-complete`, `rollback-plan-present`.

Reinstalling never overwrites a gate you edited (hash-ledger check;
modified gates are skipped and reported). On a repo with no model events
every gate passes with "nothing to check" — installing the pack never reds
a non-factory repo.

## Surfaces

- **Cockpit** — the [`#model` route](04-cockpit-tour.md) (Verify cluster):
  the registry read-only; the cockpit never advances a stage.
- **Bridge** — [`GET /bridge/model`](05-bridge-endpoints.md): pure
  read-time derivation, zero writes.
- **CLI** — `maddu model status` / `list`, `--json` everywhere.

## A reference pipeline (docs-only)

A real factory wiring, every step named with the tool that does the work
and the one Máddu verb that records it:

| Step | Does the work | Records it |
| --- | --- | --- |
| Repo intake → task corpus | SWE-smith (or your curation) | `model dataset snapshot` + license/secrets gates |
| Fine-tune | TRL/PEFT/Axolotl | `model train start` / `train complete` |
| Checkpoint | your artifact store | `model checkpoint register` |
| Benchmark | SWE-bench / BFCL / your harness | `model eval record` (+ `regression ack`) |
| Promote → canary | vLLM serves the canary | `model promote` (the ride) |
| Release / roll back | your serving infra | `model release` / `model rollback` |

The full sequence, with the gate that holds each hand-off:

1. **Repo intake → dataset of record.** Curate/mine your corpus (SWE-smith
   for synthetic task generation, or your own tooling); write the
   dataset-snapshot manifest — license, artifact hash, `synthetic: true` +
   generator model, frozen train/eval split. `maddu model dataset snapshot`
   records it. Held by: `dataset-license-known`, `dataset-hash-pinned`,
   `dataset-synthetic-labeled`, `dataset-manifest-no-secrets`.
2. **Synthetic task validity.** Task-level validity filtering (execution
   checks, dedup) is your generator's job — Máddu pins the manifest
   *declaring* `dedup_policy`/`pii_scan`/`secrets_scan` (any edit breaks the
   recorded hash) and holds the split freeze
   (`train-eval-split-frozen`); it never inspects task content.
3. **Train.** TRL/PEFT/Axolotl run; `train start` / `train complete` record
   the config of record (base-model hash, seed, commit, recipe pinned by the
   manifest hash). Held by: `training-config-pinned`.
4. **Benchmark + regression.** SWE-bench/BFCL/your harness runs;
   `eval record` lands the result and one `MODEL_REGRESSION_FOUND` per
   declared critical regression. Held by: `eval-harness-version-pinned`,
   `benchmark-contamination-check`, `no-critical-regression` (recovery is
   the recorded `regression ack`).
5. **Safety eval.** Run it as another benchmark (`eval record` with your
   safety harness's id, e.g. a refusal/jailbreak suite) — it rides the same
   record, the same regression machinery, and the same budgets config.
6. **Model card.** Write it next to the promotion manifest; the
   checkpoint-registration manifest's `notes` can point at it. Máddu pins
   the manifests — the card's claims stay the author's.
7. **Promotion approval → canary → released.** The ride (§above), one step
   at a time, an explicit decision per step above candidate. Held by:
   `candidate-promotion-complete`, `rollback-plan-present`, and the spine
   verifier itself.
8. **Rollback.** Strictly downward, recorded, and the re-promotion goes
   back through the full ride.

What Máddu does **not** do in this pipeline: generate tasks, launch
training, schedule GPUs, serve models, run benchmarks, or decide that a
model is good — it records who claimed what, pins the bytes of record, and
blocks the hand-offs that lack their approvals, acknowledgments, or plans.
Across the entire capability (`maddu model`, the events, the gate pack,
this doc) the framework gained **zero new dependencies** — Node stdlib
only, per hard rules 4/5.
