# Experience ledger & evolve planner — `maddu experience` / `maddu evolve`

A **verification and governance** feature: the spine, re-read as normalized
*experience* — session trajectories of typed steps with late-bound outcome
signals — plus a **recommend-only** evolution planner that turns that record
into evidence-gated suggestions the operator may adopt. Everything here is a
**pure read-time derivation**: zero spine writes, no new event types, no
model in the loop, deterministic for identical inputs.

> **What this is not.** Máddu does not intercept model requests, store
> prompts, score "agent intelligence", or self-modify. The planner computes
> and recommends; **adoption is an explicit operator verb** that routes
> through the same write paths you already audit (`learn` corrections,
> memory facts, skills). The honest output of a planner with thin evidence
> is *no-op* — rendered as a first-class result, not padded into noise.

## The experience ledger — `maddu experience`

```bash
$ maddu experience                 # trajectory manifest (one row per session + env)
$ maddu experience show <id>       # one trajectory's steps (env = ambient repo events)
$ maddu experience stats           # totals, role/kind counts, signals, absent axes
$ maddu experience --json          # machine-readable everywhere
```

Every spine event becomes one **step**: `stepId` *is* the source event id
(nothing minted — inertness is provable by hashing the spine before and
after), grouped into **trajectories** by session linkage only — explicit
`actor` / `data.sessionId`; anything unlinkable lands in the honest `env`
trajectory, never guessed into a session. Each step carries typed axes
(`role`: action / outcome / observation / state / signal; `kind`; plus
action / outcome / observation / state payload views) derived from the
published contract's own fields.

**Absent by design** (stated on every stats view and export, never
inferred): model output, prompt text, token-level observations, environment
snapshots, scalar rewards. Máddu's record is the *coordination* record.

### Late-bound signals

Outcome evidence attaches to steps at **read time**, by deterministic
linkage only:

| attachment | source |
| --- | --- |
| `explicit-ref` | `SLICE_REVIEWED.sliceEventId`, trigger `sourceEventId`, `FOCUS_TAGGED.sourceEventId` |
| `gate-window` | `GATE_RAN` binds **forward** to the next `SLICE_STOP` (the exact window rule `maddu autonomy` uses) |
| `derived` | the `learn scan` completion-claim detector, replayed deterministically (`nowMs: null`) |
| `trajectory-scope` | signals that describe a whole session, surfaced on the trajectory manifest |

Gates that accumulate after the last slice-stop are reported as
*unattached trailing gates* — counted, never silently dropped.

## The evolve planner — `maddu evolve`

```bash
$ maddu evolve plan                # detectors over the ledger → recommendations (or the no-op)
$ maddu evolve plan --json
$ maddu evolve adopt <recId>       # operator-gated; routes through EXISTING write paths
$ maddu evolve adopt <recId> --to memory       # correction-class: memory fact
$ maddu evolve adopt <recId> --to agent-file   # correction-class: CLAUDE.md marker block
```

Four deterministic detectors mine the ledger: **tool-correction**
(refusal→completion pairs), **gate-flap** (fail→ok arcs), **recurring
learning** (repeated slice-stop learnings), **uncorrected gate** (gates that
keep failing with no adopted correction). A finding must clear the evidence
thresholds (≥3 independent occurrences across ≥2 scopes) and survive
prior-art dedup against corrections you already adopted. Recommendation ids
are content-addressed (detector + sorted evidence), so identical evidence
always produces the identical `recId`.

`adopt` never invents a write path: memory-class recommendations land as
`LEARN_CORRECTION_WRITTEN` events (destination `memory` or the `CLAUDE.md`
marker block — your choice via `--to`), skill-class through the skills
store, gate-class as a stdout draft for you to review into config. Nothing
auto-applies, ever — the earned-autonomy precedent (`maddu autonomy`)
governs: *compute, recommend, stop*.

## Spine mining for learn — `maddu learn digest --spine`

The same pair-extraction the planner uses feeds `maddu learn` as an extra
candidate source: `TOOL_REFUSED → TOOL_COMPLETED` and `GATE_RAN fail → ok`
arcs mined from the spine merge (id-deduped) with the transcript-mined
candidates. Same digest, same judgment path, same `LEARN_MINED` shape.

## The governed export — `maddu experience export`

```bash
$ maddu experience export --format atdp --out exp.atdp.json
$ maddu experience export --format atdp --out exp.atdp.json --since <eventId> --until <eventId>
```

An export is a **sharing boundary**, so the posture is the `spine sync` one,
not the local-view one:

- **Refuse-on-hit secret gate** — a secret-shaped value anywhere in the
  selected range refuses the whole export, naming offending event ids +
  pattern types. **There is no flag to skip it** (unknown flags like
  `--force` are hard usage errors). Redact at the source, then re-run.
- **Defense-in-depth** — on a clean scan, every outgoing string leaf is
  still passed through the canonical redactor.
- **Confinement** — `--out` must resolve (realpath, symlinks included)
  inside the repo, never into `.maddu/`, `maddu/`, or `maddu.json`; an
  existing non-ATDP file is never overwritten.
- **Deterministic** — no clock in the artifact; re-running over the same
  range reproduces the bytes. After the spine grows,
  `--until <manifest.range.lastEventId>` reproduces a past export
  byte-for-byte. That reproducibility *is* the audit trail — deliberately,
  no `EXPERIENCE_EXPORTED` event is minted.
- **`trainingEligibility: false`** — hard default with no flag to flip. The
  manifest names the redaction profile and the absent-by-design axes; the
  judgment regex cannot make (free prose can carry secrets that match no
  pattern) stays with the operator.

## Cockpit route

`#experience` (Verify cluster): the trajectory manifest with
**trajectory-level signals surfaced inline**, signal rollups by kind and
attachment, recent signal-bearing steps (click → Inspector, linked to their
source events), and the evolve plan — including the honest no-op with its
full "why". Reads `GET /bridge/experience`; renders nothing it cannot
shape-validate.

## Contract discipline

Zero new event types across the entire feature. Signals, trajectories,
recommendations, and exports are all read-time derivations of the published
contract; the contract version rides on every export manifest. (The one
candidate that arose — an explicit signal event — was evaluated against the
read-time evidence and **skipped**; the derivations above cover every design
need.)
