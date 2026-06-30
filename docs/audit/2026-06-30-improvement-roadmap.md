# Improvement roadmap — 2026-06-30

Output of a **Ralph-loop ideation workflow** (32 agents: 7 diverse-lens
generators → 3 critic→refiner rounds → adversarial feasibility judges under the
8+1 rules → synthesis). Grounded in [`2026-06-30-cross-project-audit.md`](./2026-06-30-cross-project-audit.md);
findings tracked in [`LEDGER.md`](./LEDGER.md). 34 ideas generated → 18 judged →
ranked below. Effort tiers S/M/L. Every item names the faulty process it
structurally prevents from recurring.

> **Delivery status** (tracked in [`FIXED-IN.json`](./FIXED-IN.json)). **Shipped:**
> #6 staleness FLOOR + #4 release-parity + #3 DD1 (v1.75.0) · #1 fleet-spine + #2
> audit-circuit (v1.76.0) · #11 outcome ledger (v1.77.0) · **#7 governance-budget
> (v1.78.0)**. **Open:** #5 skill funnel, #8 lesson federation, #9 discipline
> loop, #10 `maddu fleet upgrade`, #12 reposition charter, #13 compat spine, #14
> cost ledger.

> **Top pick — `fleet-spine`.** The one clean SHIP (impact 5 / effort 3 /
> leverage 5), fully offline + files-only, and the substrate nearly every other
> high-value idea reads. It turns the *manual* act that produced this audit into
> a standing instrument, with an ACTIVE-only denominator so dead repos can't
> inflate or hide the numbers. Build first.

## Themes

- **A — Fleet substrate & the missing delivery leg (F1):** make every repo's
  currency both *deliverable* and *detectable* on one disk, offline.
- **B — Self-proving audit & surface hygiene (F3 + the meta-loop):** the audit
  that found these findings becomes recurring and self-verifying; the dead
  surface can shrink; the governance machinery is itself budgeted.
- **C — Close the learning loops the system goal demands (F2 + compounding):**
  suggest→apply and cross-repo lessons actually converge; start measuring whether
  Máddu prevents *real* faults.
- **D — Sharpen the discipline layer as the real product (F4):** invest where
  value is extracted in 13/13 repos; fix positioning so the audit stops
  false-alarming "orchestration dead."
- **E — Cost visibility (F5):** de-risk the rule-5 capture path as the
  deliverable before any UI.

## Ranked roadmap

| # | item | tier | prevents (recurrence) |
|---|---|---|---|
| 1 | **Fleet Spine** — read-only single-machine aggregator with ACTIVE/DORMANT/ABANDONED liveness tiers; reads each repo's projection + version + spine-tail digest WITHOUT running it; cockpit `fleet` route | M | the audit's single-repo blind spot becoming a quarterly manual rediscovery |
| 2 | **Self-verifying audit circuit** — LEDGER.md → checked LEDGER.json; `audit-circuit` gate: (a) every finding dispositioned + `accepted`⇄DORMANT_BY_DESIGN, (b) every "fixed-via-guardrail" carries a live `gate:` backref, (d) audit/insights filter output through the ledger | M | settled findings re-surfacing; a guardrail silently neutered while the ledger claims the class is handled; the audit decaying to a one-off |
| 3 | **DD1 — definition-site disposition registry** — every EVENT_TYPES key carries an inline `// @disp` tag; a gate generates DORMANT_BY_DESIGN from it and reconciles label vs source-reachability (self-catches the BLUEPRINT_DISTILLED lie); `maddu audit --retire <TYPE>` | M | adding an event type with no disposition; a label drifting from ground truth; the dead surface only ever inflating |
| 4 | **Release-delivery circuit** — `release-parity` gate: any consumer-impacting `template/maddu/**` change ⇒ version bump + a `FIXED-IN.json` row; measured local-fleet coverage receipt (via #1) | M | landing an impacting change without a release that carries it; the "dogfood the fix, ship consumers the un-fixed path" class (the whole v1.73–74 arc) |
| 5 | **Close the skill funnel** — *precondition spike first* (skills vs learn consolidation / detector precision); then surface top pending candidate at slice-stop with a one-line approve command; `funnel-integrity` gate (fired≥K, terminals 0 ⇒ WARN) | M | "detector runs, nobody acts, nobody notices"; manufacturing reject-spam from a bad detector |
| 6 | **Offline staleness FLOOR + delivery signal** — doctor/orient compute age from `version.json.released` (INFO>30d / WARN>90d), works even off-fleet & cold-cloned; `delivery-currency` gate WARNs the exact version delta (via #1) | **S** | F1 re-surfacing every audit; a 55-versions-behind install passing green forever |
| 7 | **Governance-budget** — a self-applying cap inside `maddu audit`: a NEW gate over the per-category cap must retire/merge another or log a waiver; relative self-test latency growth WARNs | **S** | the cure for F3/F4 becoming the next F3/F4 — adding gates/verbs faster than dead ones retire |
| 8 | **Lesson federation** — `maddu lessons sync` reads sibling repos' correction events (local disk); portable via recurrence-hash OR explicit `@portable`; adoption is approval-only, redacted, between learn markers | L | per-repo learning staying siloed; a portable lesson learned once never propagating |
| 9 | **Sharpen the discipline loop** — one-glance `orient` card (goal + ✓/○/? slice ledger + last gate verdict + next action); legible gate failure (event id + repro, not a stack trace) | M | friction in the core loop quietly pushing operators to skip slices/gates |
| 10 | **`maddu fleet upgrade`** — staged offline delivery; quiescence interlock (lane OR dirty-tree OR recent-mtime blocks); snapshot managed bytes but NEVER `.maddu/events/`; per-repo doctor halt-on-red; `--plan` ships first | L | "fixed in-tree, never received" structurally; a naive fleet upgrade breaking 12 repos; rolling back the live spine |
| 11 | **Outcome ledger** — `outcome` projection: every gate-FAIL that blocked a land = a recorded PREVENTED_FAULT (ships now); recurrence-misses half waits on #8's normalizer | M | a guardrail that never prevents anything staying invisible as dead weight — recurrence-prevention becomes *counted*, not asserted |
| 12 | **Reposition the charter** — tag capabilities `tier:core` (discipline) vs `tier:orchestration`; audit replaces "orchestration=0=dead" with an honest opt-in-rate KPI; README leads with the discipline loop | **S** | future audits re-raising "orchestration unused" as a false-alarm finding |
| 13 | **Compatibility spine** — stamp `schema_version` into projections; versioned reader that default-fills absent keys; `can-read-old-state` gate over real captured old fixtures from the 13 installs | M | "new code silently can't read an old install" staying a field-by-field surprise |
| 14 | **Fleet cost ledger** — *lead with the rule-5 capture spike as the deliverable*: confirm a worker-subprocess reads Claude Code's on-disk usage → USAGE event; only then `cost` projection + `cost-budget` WARN | **S** | F5 staying an un-investigated blind spot every audit; a runaway session staying invisible |

## Cut (with rationale — do not revisit without new evidence)

- **global-runtime (invert the install model — stop vendoring the runtime per
  repo).** Sharpest F1 diagnosis (vendoring *is* the skew factory) but highest
  risk/effort; relocates skew into one pinned ref rather than eliminating it,
  trades away offline self-containment, and leaves a multi-workspace ref-conflict
  for a bridge serving repos on different refs. Revisit only as opt-in
  `init --resolved`, proven on the canonical checkout, AFTER #6 + #10 exist.
- **counterfactual-replay (mandate every new gate prove a historical
  spine-catch).** Unsatisfiable — ~70% of gates assert on source/config
  structure, not the event stream. The narrow real piece (`replay --at`
  deterministic fold) is a future spike, not a commitment.
- **F4-1 (orchestration-coverage projection + PIPELINE_ADOPTED).** Payoff is
  mostly relabel not capability; its one durable win is absorbed by #3 + #12.
- **Sub-scopes cut from survivors:** `maddu land`/SLICE_LANDED (reinvents
  slice-stop); the skill-funnel "wiring bug" framing (false — `from-candidate`
  already materializes); compat-spine's full migration ladder; the
  release-circuit hard tag-block (degrade to a measured-debt WARN for the solo
  fast-shipper).

## Suggested first sprint (zero-to-low fleet dependency)

The cheap, high-leverage, **no-fleet-dependency** wins that can land immediately
and de-risk everything after them:

1. **#6 staleness FLOOR** (S) — pure offline arithmetic on `version.json.released`.
2. **#4 release-parity RECORD leg** (git + stdlib) — closes the F1 root cause.
3. **#3 DD1 DEFINE + source-reconcile** — collapses the dead-type problem to one
   audited registry; also unlocks the `--retire` path #7/#12 need.
4. **#2 audit-circuit legs a/b/d** + **#1 fleet-spine** as the keystone.
