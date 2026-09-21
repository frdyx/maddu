# 57 — Product runtime and agent economy: RFC and trust boundaries

**Status:** proposed design record. **Nothing in this page is implemented** at
the pinned baseline (`227c69d3b0606ebfe9a4f441483dfa46512f655f`, v1.139.0)
unless a row is explicitly marked *existing*. Every package name, API, event
name, directory, and test named here is a proposal until the work package that
delivers it lands with its own negative tests.

This page is the decision record. The exhaustive rationale, the audit
execution plan, and the lower-cost-agent operating model live in the handoff
plan it distils, kept verbatim in the repo:
[`docs/rfc/2026-09-18-runtime-economy-handoff-plan.md`](https://github.com/frdyx/maddu/blob/main/docs/rfc/2026-09-18-runtime-economy-handoff-plan.md).
The P0 baseline audit that checked this page's "what exists" claims against
the pinned commit is
[`docs/rfc/2026-09-20-p0-baseline-audit.md`](https://github.com/frdyx/maddu/blob/main/docs/rfc/2026-09-20-p0-baseline-audit.md).

## 1. The decision

Build two independently adoptable capabilities, in this order:

1. **Embedded runtime assurance.** An AI-powered application records its
   model/tool activity, verifies declared conditions, and gates consequential
   actions through a server-side integration. The application keeps owning
   the model calls, credentials, business logic, authorization, and storage.
2. **Optional agent economy.** Verified task outcomes produce
   non-transferable *contribution credits* and field-specific reliability
   evidence. Policy may later use those records to recommend supervision or
   allocate work. Credits never override authorization or safety rules.

This is about the AI operating **inside a product**, not only the coding
agents building the product. Neither capability may require Máddu's
coordinator, pipelines, cockpit, a git checkout, or a running bridge.

**The first deliverable is a dependable runtime, not a marketplace or a
generalized trust score.**

### 1.1 Corrections carried over from the earlier concept

- An unsupported completion claim is not proof of dishonesty. Use observable
  categories (`unverified_claim`, `contradicted_claim`, `invalid_evidence`);
  never infer intent from wording.
- A hash-valid record is not proof that a model was right or that the
  recorded action happened. Producer identity, trusted observation, and
  external evidence are separate assurance dimensions.
- Difficult work is not necessarily useful work. Value, difficulty, risk, and
  cost are separate task attributes.
- A lane's development-history score is not a persistent agent's competence
  score. Existing clean/dirty slice history is never converted into
  production credits or permissions.
- A point balance does not make a model care about points. It becomes an
  operational mechanism only when an external policy uses it; behavioural
  improvement is a hypothesis to test, not a premise.

## 2. What exists at the baseline, and what does not

Inspected through repository source at the pinned commit, not by claiming
runtime behaviour. Anchors and per-module reuse verdicts are in the P0 audit.

| Area | Baseline (existing) | Consequence for the runtime |
|---|---|---|
| Distribution | `package.json` exposes one CLI binary and no `exports` map; there is no declared public library surface. | Publish an explicit, tested runtime entry point. Internal deep imports are not a supported SDK. |
| Spine | Workspace-stamped, hash-linked NDJSON records; a funnel-locked flat append; a read-only verifier. | Reuse the reviewed algorithms and fixtures; do not assume repo-centric storage is tenant-safe runtime storage. |
| Gates | Built-in and operator gate modules are discovered from disk (an operator file may shadow a builtin id); contexts carry repository/state roots; a gate-receipt append can fail while the gate result still returns. `maddu ci` fails closed when a pinned required id resolves to no runnable gate; the `goal done` / `plan complete` completion check does not (P0 audit A3-002/A3-004). | Add a runtime gate registry with implementation digests and an explicit evidence-durability result. The existing runner is not a fail-closed action boundary. |
| Approvals | Repository and machine-global policies can produce recorded decisions. | Do not inherit machine-global policies into a multi-tenant product. Runtime approvals need product identities and exact action binding. |
| Earned autonomy | Per-repository, per-lane clean/dirty scoring; capped clean credits; a conservative Wilson bound; recommendations only. | A precedent for "recommend, never apply", not the economy's identity, settlement, or permission implementation. |
| Claim signals | Text heuristics join completion claims to observed evidence. | Advisory signals only; penalties require typed, attributable evidence and review. |
| Experience | Event-derived trajectories and outcome signals; scalar rewards explicitly absent. | Add a distinct optional economy contract instead of changing experience semantics. |
| Replay | Declared verification re-run in a clean checkout. | Event-state replay, check re-execution, and a fresh LLM call are three different operations and are never conflated. |
| Charter | Identity is cooperative, local-first governance of agent *development*, with explicit invariants. | A scoped runtime contract is ratified here (ADR-001) before any authority-changing automation or new persistence assumption. |

The present autonomy classifier can treat an existing deliverable or an `ok`
gate as positive evidence. That establishes neither business value nor
semantic correctness. Its Wilson value must not be advertised as an agent's
probability of being correct across heterogeneous tasks.

## 3. Responsibilities

| Component | Owns | Must not claim to own |
|---|---|---|
| Host application | Authenticated users/tenants, model calls, business policy, credentials, side effects, authoritative storage transactions | That a model's self-report is independent evidence |
| Máddu runtime | Typed evidence, run lifecycle, gate orchestration, decision binding, portable receipts, deterministic record verification | Universal truth checking, application authentication, sandboxing, regulatory compliance |
| Economy extension | Task contracts, valuation metadata, settlement, contribution balances, field-specific outcome views | Currency, transferable wealth, global intelligence ranking, a way to buy authorization |
| Host policy adapter | Re-validating permissions at the real execution/release boundary | That calling a gate earlier prevents a later bypass |
| Existing Máddu CLI | Development governance, diagnostics, optional receipt inspection | A mandatory production service |

## 4. Decisions (ADRs)

Each decision names its default and the condition under which it may be
revisited. Revisiting one is a new ADR that supersedes the old row; rows are
never edited in place once a work package has shipped against them.

### ADR-001 — Charter fit: a separately scoped runtime contract

**Decision.** The product runtime is a **new, explicitly scoped contract**,
not an extension of the development spine and not a reinterpretation of the
charter. The 8+1 hard rules keep governing the framework layer exactly as
[`hard-rules.md`](hard-rules.md) scopes them today. The runtime's `core` and
`execution` boundaries add **no** database, provider SDK, network, or hosted
dependency. Host-owned storage adapters live in the host application, are
injected, and are the host's responsibility — the same way the hard rules
already place a product's database outside Máddu's remit.

**Why.** The charter's identity is *"the agent calls Máddu; Máddu never sits
in the request path and never touches your keys."* An embedded runtime that
the host calls, that holds no credentials, and that spawns nothing preserves
that shape. What it does change is the deployment assumption — a product
process instead of a developer's repo — so that assumption is written down
rather than inherited. Renaming a database table an "adapter" does not
resolve a charter conflict; declaring the boundary does.

**Follow-up.** The one-sentence addition to `charter.md` that names the
embedded runtime as a second, opt-in entry path lands in its own reviewed
change once P2 exists, never as a side effect of a feature PR.

### ADR-002 — Packaging: one opt-in entry point in the existing package

**Decision.** One opt-in runtime entry point with logical `core` /
`execution` / `economy` boundaries, published from the existing `maddu`
package as an explicit subpath export (the CLI remains the default
binary). Split into separately published packages only for a real
dependency or release-cycle need. The final public name is subject to an
ownership check before P8.

**Why.** Today `package.json` declares a `bin` and a `files` list but no
`exports`, so every import is a deep import into `template/maddu/runtime/lib`
— an internal layout that `maddu upgrade` rewrites. A declared export is
the only surface a consumer fixture can test.

### ADR-003 — Persistence and deployment guarantee

**Decision.** P2 ships an in-memory test store and an **experimental**
file-backed reference adapter on explicitly supported local storage. No
durability claim is made before the conformance tests (V11, V12, V26) pass.
The reference deployment mode is **one process with explicit per-run append
serialization**. Serverless ephemeral filesystems and multi-process writers
are refused at configuration time, not tolerated.

**Why.** Even one Node process has concurrent async callers. The current
spine's append funnel is a byte-level write serializer for a developer's
repo; a product run needs expected-head preconditions, bounded waits, and a
stated acknowledgement level (buffered / written / durably committed). An
in-memory store must never advertise durable protection.

### ADR-004 — Event contract: a new versioned namespace

**Decision.** Runtime events live in a separate namespace (`maddu.runtime.v1`
proposed) with their own envelope, canonicalization, and hash vectors. The
existing closed `EVENT_TYPES` map, the development envelope, and the current
`prev_hash` preimage are **frozen by characterization fixtures first** (P1)
and never modified by runtime work. Application-defined events are
namespaced, schema-registered, size-bounded, and cannot impersonate a
privileged family.

**Why.** Extracting shared primitives without pinned byte vectors would let a
refactor change historical hash preimages silently — the one regression the
tamper-detecting spine exists to make impossible.

### ADR-005 — Enforcement posture: shadow first, fail closed when enforced

**Decision.** Every runtime deployment starts in shadow mode: checks run and
would-block results are recorded while the host's existing controls stay in
force. Enforcement is enabled **per named host boundary**, explicitly, and
never by a global flag flip. At an enforced boundary `fail`, `error`,
`timeout`, `unknown`, and *missing* are all non-passing; a decision is an
opaque, single-use handle bound to tenant, principal, exact subject digest,
resource version, gate/policy manifest, operation id, boundary, and expiry;
the protected host adapter re-validates current authorization and consumes
the handle atomically into its own durable operation state. A caller-supplied
`pass: true` is never sufficient.

**Why.** A gate result returned earlier does not prevent a later bypass. Only
the boundary that performs the side effect can enforce, and only if it holds
something forgeable-by-nobody-but-the-policy-service.

### ADR-006 — Economy: disabled by default, shadow ledger, four separate records

**Decision.** The economy is off by default. When enabled it is a shadow
ledger until a reviewed calibration says otherwise. **Contribution credits**,
**reliability evidence**, **integrity incidents**, and **authority policy**
are four separate records; cost/token accounting is a fifth. Stakes and
reservations are off in the first pilot. The numeric balance is called
*contribution credits*; "assurance capital" may remain a product term only
where the documentation exposes the four dimensions behind it.

**Why.** Collapsing value, competence, honesty, and permission into one score
is how an economy starts to sell authorization. Keeping them apart is what
lets a low balance mean "recommend supervision" and nothing more.

### ADR-007 — Identity: host-issued principal lineage, product-defined fields

**Decision.** The identity tuple is host-issued:
`(tenant, product, principal, agentVersion, field)` with a principal lineage
so a renamed model or a new session cannot mint a fresh bankroll. The
spendable account is scoped to tenant + product + principal lineage + field.
Reliability is scoped to that plus agent version, task family, and
evaluator/policy cohort. Fields are product-defined competencies, never
model-created names. Authority is the host's, full stop.

### ADR-008 — Privacy: references only, no retention by default

**Decision.** Evidence stores metadata, opaque artifact references, permitted
reason codes, and keyed commitments where a commitment is necessary. No prompt
or output body is retained by default; no hidden reasoning is captured ever.
Tenant IDs, caches, idempotency keys, keys, approvals, receipts, and accounts
share one scoping rule. A deleted artifact yields `evidence_unavailable`, not
a "fully verifiable" receipt. Hashing a low-entropy value is not
anonymization; tenant-keyed HMACs with host-owned key/version are the pattern
where a commitment is needed.

### ADR-009 — Autonomy and authority: recommendation only

**Decision.** No runtime or economy component changes a permission. Any
restriction policy is a later, separately approved, explicitly enabled
adapter with reasoned audit events, recovery criteria, and an emergency
disable path. Hard permissions, tenant boundaries, and mandatory human
approvals are non-purchasable at every credit level.

### ADR-010 — Reuse of existing code: characterize, then share behind tests

**Decision.** No wholesale copy of internal modules "as an SDK". P1 records
fixed vectors for the legacy event/hash/receipt contract and a
dependency-coupling test; only then may stable code be shared behind
compatibility tests. Per-module reuse verdicts (`reusable-as-is`,
`extract-with-characterization`, `reference-only`, `do-not-reuse`) are
recorded in the P0 audit and updated there when a module is actually
extracted.

### ADR-011 — Core candidate set and declared legacy residuals

**Decision.** The modules a future `runtime/core` may share, at the pinned
baseline, are `event-schema.mjs`, the hashing/`prev_hash` functions of
`spine-append-core.mjs`, `id-grammar.mjs`, and `secret-scan.mjs` — all pure,
import-clean, and now pinned by `scripts/test/runtime-core-import-boundary.mjs`.
`append-lock.mjs` belongs to `runtime/execution` (it reads the hostname and
an environment variable at module load; the boundary test pins those reads
shrink-only). `spine.mjs` and `verify.mjs` are excluded from `core` until
importing them no longer installs the mutation-witness object on
`globalThis`, or `verify` imports `EVENT_TYPES`/`hashLine` from the core
instead of the façade. Extraction is copy-behind-compatibility-tests, never
a move.

The following are **declared legacy residuals** of the development spine,
unchanged in the CLI and never inherited by the runtime: chain-local hashes;
undetected suffix truncation, tail-only edit, and well-linked forged tail;
WARN-only timestamp ordering across producers; an unauthenticated,
self-declared `actor`; buffered (no fsync) acknowledgement; no operation-id
idempotency on `append()`; best-effort `GATE_RAN` receipts; the bridge's
approval-respond route, which appends a decision for any id behind the
loopback token and is not the model for ADR-005. Runtime v1 (P2–P4) must
satisfy the opposite of each. A `design-decision` verdict in the P0 audit
records that a residual is documented for the CLI; it never clears a runtime
acceptance row. No economy code exists at the baseline: P6 starts from a new
settlement store, never from `autonomy.mjs`.

**Why.** P0 audit findings A1-001, A1-002, A2-001…005, A3-001, A5-001,
A7-001 and the completeness critic's package-boundary and residuals ADRs.

### ADR-012 — Audit evidence rule

**Decision.** Every read-only audit packet reads files from a detached
worktree (or `git show <pin>:<path>`) at the pinned commit, records the
revision per file, and anchors only against that revision. The coordinator's
mutable checkout is not audit evidence. Commits landed after the pin are
reviewed as their own packets.

**Why.** P0 audit finding A8-001: the checkout advanced three commits during
the round while auditors read the working tree; their byte-identity checks
against the pin saved the conclusions, but only by luck of scope.

## 5. Non-goals for the first release

- A Máddu-hosted service, agent marketplace, token, payment system, or
  transferable credit.
- A replacement for a model SDK, agent framework, product database, identity
  provider, or queue.
- Reinforcement-learning training or automatic changes to weights or prompts.
- Public reputation shared across customers, or automatic cross-domain trust
  transfer.
- Automatic purchase, publication, deletion, refund, or account-security
  decisions based on points.
- Full protection against a host administrator who controls the process,
  credentials, and evidence store.
- A universal verdict that an answer is true, useful, or safe.

## 6. Runtime architecture

Four logical boundaries; folder names are proposals.

| Boundary | Responsibility | Allowed dependencies |
|---|---|---|
| `runtime/core` | Envelope validation, canonical encoding, hashing, causal checks, pure reducers, offline bundle verification | Small audited primitives only. No repo, model, network, user-home, or environment discovery |
| `runtime/execution` | Run/attempt lifecycle, gate registry, decision policy, evidence-sink interfaces, receipt creation | `core` and injected host adapters |
| `runtime/economy` | Frozen task contracts, typed outcomes, deterministic settlement, balance projections | `core` and an explicit settlement store; cannot touch host permissions |
| Host adapters | Authenticated context, model/tool observation, persistence, approval UI, output release | Host dependencies and public runtime APIs only |

### 6.1 Trust boundary

The model proposes actions. Trusted host code decides whether they execute.
Model-visible tools never include unrestricted receipt append, settlement,
policy editing, or balance editing.

An in-process SDK is an **integration** boundary, not an **isolation**
boundary. If the product executes agent-generated code with access to the
runtime's files, database role, signing keys, or tool credentials, that code
can bypass the design. Isolate such workers under separate credentials and
processes and expose only narrow host operations — or describe the
integration honestly as cooperative instrumentation. For high-impact actions
the host's downstream authorization stays authoritative even when the runtime
reports a pass (see [OWASP LLM06: Excessive
Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)).

### 6.2 Lifecycle

1. Host resolves tenant, user, product, agent identity, field, and allowed
   action scope from trusted context.
2. Host opens a run against a frozen policy/gate manifest and, if enabled, a
   frozen task contract.
3. Runtime records bounded observations of context selection and model/tool
   calls; self-reported and host-observed evidence stay distinguishable.
4. Model output is untrusted data. Registered checks validate structure and
   product-specific assertions.
5. A consequential action is bound to its exact parameters, resource version,
   and current authorization; approval is obtained if required.
6. The host's protected execution boundary re-checks the binding and policy,
   durably records intent, and performs the action with its idempotency key.
7. Outcome evidence is recorded and reconciled; unresolved side effects stay
   `unknown`, never "success" and never auto-retried.
8. The host releases, withholds, or escalates output; a terminal evidence
   manifest is finalized where possible.
9. Optional settlement consumes attributable terminal evidence. It cannot
   authorize or retroactively legitimize an action.

### 6.3 Illustrative API shape — not implemented

```ts
// Design sketch only. No package with this contract exists.
const runtime = createRuntime({
  store: hostEvidenceStore,
  policies: approvedPolicyRegistry,
  gates: approvedGateRegistry,
  mode: "shadow", // per-boundary enforcement is added after the pilot
});

const run = await runtime.startRun({
  context: authenticatedHostContext, // never accepted from model output
  agent: registeredAgentVersion,
  taskContractId: optionalFrozenContractId,
  policyVersion: approvedPolicyVersion,
  idempotencyKey: hostRunKey,
});

const draft = await run.observeModelCall({
  metadata: declaredModelMetadata,
  invoke: () => hostModelClient.generateDraft(approvedContext),
  evidencePolicy: "references-only",
});

const result = await run.evaluate({ gateSet: "content-draft-v1", subject: draft });

// The trusted application keeps control of the final response. In enforcement
// mode the registered release boundary checks the exact artifact digest, the
// required gates, and current host authorization through a trusted decision
// service. This evaluation is advisory, not permission.
return hostDraftBoundary.present({ run, draft, evaluation: result });
```

The P3 RFC must specify cancellation, typed errors, retry behaviour, and
durability acknowledgements before this becomes a public API. A public
`record("TOOL_ALLOWED")` available to the model is not an enforcement API.

## 7. Contracts

### 7.1 Event envelope (required concepts)

Contract version and hash-algorithm/canonicalization identifiers; opaque
tenant and product identifiers supplied by the host; stable agent principal
plus immutable agent-version digest; field id; run, task, attempt, and
operation ids as applicable; unique event id, per-run sequence,
previous-event commitment, explicit causal references; event type, bounded
typed payload, producer identity/evidence provenance; recorded time for
diagnostics only (sequence and preconditions, not wall-clock, control
state); policy version, gate-set digest, and exact subject digest where a
decision depends on them.

Canonicalization rejects ambiguous or unsupported input: duplicate keys on
decoded input, non-finite numbers, implicit `undefined`, oversized payloads,
invalid encodings. Unicode and number handling, and domain separation, are
defined with fixed test vectors. The legacy spine's hashing contract is
preserved separately (ADR-004).

### 7.2 Minimal runtime vocabulary (proposed)

| Family | Events | Required relationship |
|---|---|---|
| Lifecycle | `RUN_STARTED`, `RUN_COMPLETED`, `RUN_FAILED`, `RUN_CANCELLED` | One canonical terminal run state; attempt outcomes may differ |
| Context/model | `CONTEXT_REFERENCED`, `MODEL_CALL_STARTED`, `MODEL_CALL_FINISHED` | Result references its start and actual attempt |
| Checks | `CHECK_STARTED`, `CHECK_FINISHED` | Result binds gate/version, subject digest, start id |
| Action | `ACTION_PROPOSED`, `ACTION_DECIDED`, `ACTION_STARTED`, `ACTION_FINISHED` | Exact payload, authorization, policy, operation binding |
| Approval | `APPROVAL_REQUESTED`, `APPROVAL_DECIDED` | Tenant, approver, action digest, resource version, expiry, single-use scope |
| Output | `OUTPUT_DECIDED`, `OUTPUT_DELIVERY_OBSERVED` | Approval to release is distinct from delivery observed |
| Repair | `OUTCOME_RECONCILED` | Appends a resolution to an unknown operation; never rewrites the original |

Controlled reason and status enums; `unknown` and `incomplete` recorded
explicitly; no manufactured terminal pass for a crashed or partial run.
Execution completion, task acceptance, output delivery, and settlement are
four distinct facts.

### 7.3 Gate result contract

Each gate has an id, immutable implementation/version digest, input schema,
scope, declared evidence class, and a time/resource bound.

| Result | Meaning | Required-gate behaviour when enforced |
|---|---|---|
| `pass` | Declared check completed for the exact subject | Eligible input to the decision; not permission by itself |
| `fail` | Declared condition did not hold | Withhold or escalate |
| `error` / `timeout` | Check did not complete reliably | Withhold or escalate; never green |
| `not_applicable` | Policy explicitly permits omission for this scope | Only if the predeclared policy permits it |
| `unknown` / missing | No adequate evidence | Withhold or escalate |

Deterministic checks, model-judged checks, and human review are labelled
differently. An LLM judge is a signal, never sole authority for tenant
authorization or punitive settlement. Gates are registered through trusted
deployment configuration, never model-generated paths or arbitrary code. The
existing warn/ok/fail gate system is **not** mapped automatically onto this
table.

### 7.4 Receipt and offline verifier

A portable bundle holds the versioned event stream, manifest, terminal
sequence/head commitment, gate/policy digests, typed evidence references,
and known omissions — no credentials, no raw prompt/output bodies by default.
The verifier reports **six separate dimensions** and never collapses them
into "truth verified": schema/byte integrity; sequence/causal/terminal
completeness within the bundle; policy/gate coverage for the exact recorded
subject; producer authentication (only if signatures and a trusted key
registry are supplied); external witness/checkpoint verification (if
available); evidence availability and unresolved outcomes.

Unsigned imported bundles are non-authoritative by default. A signature
authenticates a signer, not a claim, and not that the bundle is the latest
complete history. Enforcement and settlement consume an authenticated
host-owned store, or validate an import against a trusted issuer and an
independently retained checkpoint.

## 8. Durability, failure rules, and data minimization

| Failure | Shadow mode | Enforced boundary |
|---|---|---|
| Required check fails or times out | Record would-block; preserve host controls | Do not execute/release; escalate if supported |
| Evidence unavailable before action | Explicit evidence failure; never "assured" | Refuse the protected action before its side effect |
| Side effect succeeds, final receipt fails | Mark/reconcile an unknown outcome via durable host state | Never blindly retry or claim rollback |
| Optional telemetry export fails | Warn/retry export; action truth unchanged | Same; telemetry is not evidence durability |
| Model/provider unavailable | Record provider failure if possible | No task-success credit; not an integrity penalty |
| Economy unavailable | Runtime evidence and gates continue if policy does not depend on it | No new exposure admitted without a reservation, if admission requires one |

Storage rules: per-run bundles are portable artifacts, not a distributed
transaction; one single-writer stream per run with expected-head
preconditions, bounded waiting, and duplicate-operation handling; a
distributed store must offer compare-and-swap or equivalent, unique operation
ids, fencing, and crash recovery; the file adapter documents its
platform-specific flush/ack/atomic-replace/torn-tail/restart protocol and
preserves damaged evidence rather than truncating it into a valid-looking
run; every lock, append, and check has a deadline and a bounded queue; the
host owns any outbox that couples business mutations to event publication;
external effects need host idempotency and reconciliation — the ledger
guarantees at-most-one settlement, not exactly-once external execution;
cross-run balances need a separately serialized per-account ledger and atomic
pool enforcement for multi-beneficiary settlements.

Data minimization rules are ADR-008. Redaction of logs, error stacks,
evaluator output, tool arguments, and exports is required and is never
described as a complete privacy boundary.

## 9. Economy summary

The full design (frozen task contract fields, settlement table, reservation
arithmetic, ledger and dispute invariants, event list, anti-gaming test
list) is plan section 7. The invariants that bind every economy work
package, shadow accounting included:

- All entries are immutable typed grants, accepted awards, debits, or linked
  corrections; **no direct balance writes**; each entry records issuer,
  reason, policy, unique id, and source contract/evidence.
- Exact bounded integer credits; every amount and aggregate is a safe
  integer (magnitude ≤ 2^53 − 1); fractional, overflowing, `NaN`, and
  non-finite input is rejected, never clamped.
- One base terminal settlement per authorized logical task reward key
  (tenant/product/task family/dedup key). Attempts, sessions, superseding
  contracts, and model upgrades cannot mint a second base award.
- Contributor allocations never exceed the frozen task pool; allocation and
  account changes commit together or not at all.
- Corrections are signed, reviewer-authorized, chain-linked, bounded by the
  unreversed source amount, and unique; a genuinely new grant is a grant.
- The acting agent cannot set its reward, lower its checks, choose its judge,
  attest its own acceptance, write settlement, or revise a contract after
  seeing the result.
- Honest failure, required refusal, provider outage, and missing evidence are
  four different outcomes; none infers deception. Audit agents are not
  rewarded per finding.
- Deadlines are tested against recorded decision time with an injected clock;
  replay uses original inputs, never today's clock or policy.

## 10. Threat-model delta

[`34-threat-model.md`](34-threat-model.md) covers the developer-machine
posture: supply chain, spine tampering, verdict machinery, assurance faking,
silent non-recording, cost fabrication. The runtime adds threats the existing
scenarios do not own; each becomes a scenario in that document when the
corresponding work package ships, and each maps to a row in section 12.

| New threat | Owner package | Acceptance rows |
|---|---|---|
| Model or tool payload injects tenant ids, paths, or policy instructions | P3 | V14 |
| Decision handle forged, reused, or replayed with changed principal/subject/version/expiry | P4 | V08, V09 |
| Action executes after a missing gate, a throwing gate, or a swallowed evidence append | P3, P4 | V06, V07 |
| Whole-bundle replacement or tail drop on an unkeyed export | P2 | V05 |
| Cross-tenant reuse through cache, idempotency key, or evidence lookup | P2, P4 | V16 |
| Crash between intent, effect, and receipt duplicates the effect | P4 | V11 |
| Same-process concurrent appends, stale fenced writer, torn write | P2 | V12 |
| Streaming leaks unverified content past a boundary promising pre-release checks | P5 | V13 |
| Settlement farming: duplicates, splits, retries, identity resets, colluding judges, stale proof | P6 | V17, V18, V20, V21 |
| Points used to bypass a forbidden action or a required human approval | P6, P7 | V22 |
| Public claims exceed tested deployment scope | P8 | V25, V27 |
| A host administrator who controls process, credentials, and store | none (non-goal) | documented residual |

## 11. Standalone synthetic pilot (P5 scope)

One AI-draft workflow — a summary of a supplied synthetic document for human
review — built against the public runtime API with synthetic tenants,
controlled model/tool responses, and no live network. It exposes the model-call
adapter, context selection, release boundary, tenant context, and evidence
store explicitly, and demonstrates: trusted host context precedes runtime
init (the model cannot pick its tenant or policy); the release boundary
re-validates authorization and the exact checked artifact; simulated side
effects exercise idempotency, retry limits, and reconciliation; evidence
references synthetic artifacts under production minimization rules; browser
code never receives keys, unrestricted append, or economy admin operations;
toggling the economy cannot bypass authorization or disable required
evidence. Simulated behaviour is labelled as simulated; a human acceptance
decision is a labelled input, not objective truth.

## 12. Work packages, PR sequence, and acceptance

| ID | Package (dependencies) | Deliverable | Exit criterion |
|---|---|---|---|
| P0 | Baseline inventory (none) | Pinned commit; code-path map; findings; this RFC; pilot scope | Current behaviour and trust boundary confirmed; owner decisions recorded |
| P1 | Compatibility fixtures (P0) | Fixed legacy event/hash/receipt vectors; consumer-import fixture; dependency-boundary test | Existing contracts unchanged; the future runtime can import without CLI boot, git discovery, provider SDK, or global-state reads |
| P2 | Evidence core (P1) | Runtime schemas, canonical encoder, append-store contract, reducer, offline verifier | Tamper/causal/concurrent-write/duplicate/crash fixtures pass; ack level, tenant scope, and limits explicit |
| P3 | Lifecycle and gate registry (P2) | Run/attempt API; bounded checks; required-gate manifest; typed failures | Missing checks and evaluator errors cannot masquerade as pass; exact subject/version binding shown |
| P4 | Protected host boundary (P3) | Single-use bound decision handle; approval binding; execution/release adapter; idempotency/reconciliation fixture | Denied actions have zero side effects; crash ambiguity reconciles instead of retrying; host auth authoritative |
| P5 | Shadow pilot (P3; P4 designed and tested) | One synthetic workflow; read-only receipts export; baseline measurements | End-to-end trace coverage; no secret/PII leakage in fixtures; explicit unverified/unknown states |
| P6 | Shadow economy (P5 evidence accepted) | Principal registry; frozen contracts; settlement reducer; dispute/correction flow | No reward without accepted evidence; replay-safe accounting; no authority or stake change |
| P7 | Calibrated opt-in policy (P6 evaluated, owner approval) | Optional reservations; supervised-state recommendations; bounded policy adapter | Adversarial reservation/identity tests pass; no hard-rule override |
| P8 | Distribution and docs (prior gates) | Public entry points/types; installable example; compatibility policy; benchmark and threat-model report | External consumer fixture works from the packed artifact; claims match tested scope |

P0–P5 are the runtime track. P6–P7 are an optional experiment; an
inconclusive economy pilot must not delay a useful runtime release.

Suggested first PRs, each a small reviewable change with its own negative
tests: (1) this RFC — no behaviour change; (2) `test:` characterization of the
reusable evidence primitives; (3) `feat:` opt-in runtime evidence package with
in-memory store and experimental file store; (4) `feat:` runtime checks and
protected-boundary fixture; (5) `example:` AI-draft shadow workflow;
(6) `feat:` shadow task settlement.

**Generated-artifact ownership.** `docs/*.md` is authored; `template/maddu/docs/`
is generated from it by `node scripts/generate.mjs` (the `docs-tree`
generator), and `npm run generate:check` fails CI on drift. New numbered docs
must be linked from `00-index.md` (the `docs-indexed` gate is pinned). Edit
the authored source and regenerate; never hand-edit both.

**Adoption surface (P8).** The README gains two separate entry paths — *use
Máddu while building software* and *embed Máddu in an AI-powered product* —
with the economy as an optional advanced capability. No installable
production SDK is advertised before the external-consumer fixture and the
relevant release gates pass.

## 13. Verification matrix

Acceptance tests to build and execute, by feature. The runtime track owns
V01–V16 and V25–V27 plus version binding in V24; the shadow economy adds V17
and V19–V24; reservation/policy activation additionally requires V18 and the
hold/deficit/admission cases of V21–V22. A disabled feature's row is marked
*not applicable, with a reason* — never *passed*.

| ID | Required test | Expected result |
|---|---|---|
| V01 | Import runtime outside git with no CLI/global config | No startup side effects or repository discovery |
| V02 | Old spine fixtures and existing CLI smoke/full suites | No byte, schema, or behavioural regression |
| V03 | Recompute a projection twice from identical inputs | Byte-identical canonical result |
| V04 | Alter, reorder, duplicate, or splice events across tenants/runs | Named failure; never automatic repair |
| V05 | Remove terminal evidence or replace a whole exported bundle | Incomplete/unavailable where detectable; unsigned import never gains authority; completeness limits explicit |
| V06 | Missing gate, same-id changed implementation, malformed policy | Enforced action withheld |
| V07 | Gate throws, times out, or evidence persistence fails | Explicit non-pass; no protected side effect |
| V08 | Modify output/tool arguments after a gate or approval | Binding mismatch; nothing reusable |
| V09 | Forge/reuse a decision handle or replay approval with changed scope | Refusal; legitimate retry reconciles the same consumed operation |
| V10 | Bypass the SDK through another exposed route | Host downstream authorization still denies |
| V11 | Crash before intent, after intent, after effect, before receipt | Known/unknown state via reconciliation; no blind duplicate effect |
| V12 | Concurrent same-process appends, stale writer, duplicate op id, torn write, crash/retry race | Ordered durable-acknowledged stream or explicit conflict/recovery; no invented success |
| V13 | Stream model output before final checks | No unverified leakage on a boundary promising pre-release verification |
| V14 | Hostile payload injects tenant ids, paths, policy text | Treated as data; context/policy unchanged |
| V15 | Secrets/PII in fields, errors, logs, exports, evaluator text | Minimized/scrubbed; no claim of universal coverage |
| V16 | Cross-tenant cache/idempotency/evidence lookup | No access or reuse outside scope |
| V17 | Duplicate task, retry, superseded contract, child split, repeated settlement, fractional amount, overflow | One base settlement per key; pools conserved; invalid arithmetic rejected |
| V18 | Two tasks reserve the same balance concurrently | At most one admission where funds cover only one |
| V19 | Provider outage, honest uncertainty, refusal, unsupported claim | Distinct classifications; no inferred deception penalty |
| V20 | Self-issued reward/gate/evidence, colluding judge, identity/field reset | No unreviewed credit or authority gain |
| V21 | Deadline, late evidence, post-settlement dispute, repeated/concurrent correction, spent-reward clawback | Base settlement terminal; holds expire explicitly; compensation bounded and unique; deficit blocks new exposure |
| V22 | Large balance plus forbidden action or required human approval | Still denied or pending |
| V23 | Disable economy, corrupt its projection, change its policy | Runtime core still usable; replay reconstructs or refuses explicitly |
| V24 | Model/config/evaluator version changes | Version-scoped evidence; no unqualified competence inheritance |
| V25 | Pack/install into a fresh external consumer and upgrade it | Supported exports/types/examples work without internal paths |
| V26 | Slow/full/unavailable sink and large payload | Bounded memory/latency; explicit backpressure or refusal |
| V27 | Public README/example audited against supported modes | No claim exceeds evidence |

Property-based/fuzz coverage is added for envelope decoding, tenant
identifiers, reduction, and integer accounting. A happy-path screenshot is
not an acceptance test.

### 13.1 Commands and environment

The existing scripts are `npm run generate:check`, `npm run test:smoke`,
`npm run test:full`, `node bin/maddu.mjs ci`, and `node bin/maddu.mjs doctor`.
New runtime/economy test scripts are added to `scripts/test/` (auto-discovered
by the self-test runner) and documented, never assumed. Adapter tests use
disposable directories and synthetic data. No live provider calls or
deployments are authorized by this RFC.

## 14. Rollout, metrics, rollback

Stages: fixture-only → shadow runtime → one enforced narrow boundary
(withholding draft output, never an irreversible action) → shadow economy →
advisory economy → optional bounded policy. Runtime mode, evidence export,
economy accounting, and policy admission are separate flags; disabling one
never silently downgrades another. An enforced workflow that cannot obtain
required evidence pauses that capability or routes to supervised handling —
no fail-open bypass.

Metrics are set per deployment in P0/P5 and stay *unmeasured* until tested:
attributable-evidence coverage per run/action; unknown outcomes and time to
reconcile; evidence bytes and append/verify latency; would-block vs actual
block, false restrictions, review burden; accepted quality by task
family/version; dispute/reversal rate, reward concentration, duplicate
suppression; real model/tool cost per accepted task and per confirmed audit
result. No latency, accuracy, or savings target is claimed here.

Rollback restores the prior application version while keeping evidence
contracts readable. Old records are never deleted or rewritten to make a
deployment look clean. A faulty settlement reducer stops new settlement,
preserves inputs, replays in a new version, and issues explicit corrections.

## 15. Definition of done

**Runtime MVP:** public entry point and types with no required git, bridge,
cockpit, or orchestration; one explicitly supported deployment/storage mode
with durable semantics and bounded failure handling; versioned schemas, fixed
hash vectors, pure projection/replay, offline verifier; trusted host context
and exact gate/approval/subject binding; demonstrated negative paths and
crash recovery; the synthetic end-to-end example; legacy Máddu contracts
unchanged with source and generated artifacts coherent.

**Economy pilot:** host-issued lineage and field/version-scoped evidence;
frozen contracts, accepted-evidence settlement, append-only corrections; the
four records kept separate; no permission effect in shadow mode; no
text-based deception adjudication; replay/idempotency/farming tests and
independent evaluation sampling; a documented go/no-go — *"do not ship the
economy yet"* is a valid result.

**Handoff completeness:** code-path inventory, decisions, test evidence,
unknowns, and owners recorded; every critical claim maps to a check or is
labelled a limitation; any confirmed critical/high finding is resolved or
explicitly blocks its release boundary; public messaging separates
implemented functionality from roadmap.

## 15.1 Implementation status

| Package | Status | Where | Notes |
|---|---|---|---|
| P0 | done | `docs/rfc/2026-09-20-p0-baseline-audit.md` | Findings register, verdicts, six legacy fix PRs (v1.141.0–v1.146.0) |
| P1 | done | `scripts/test/legacy-evidence-vectors.mjs`, `runtime-core-import-boundary.mjs`, `legacy-boundary-characterization.mjs` | Legacy contracts pinned; candidate set boundary is a ratchet |
| P2 | slice 1 landed (v1.147.0) | `runtime/core/{canonical,envelope,reduce,verify}.mjs`, `runtime/execution/store.mjs`, `runtime/index.mjs` as `maddu/runtime` | Canonical encoding + fixture vectors, envelope, reducer, six-dimension verifier, append-store contract with `MemoryStore` and experimental `FileStore`. Producer authority and external witness report `not_supplied`; no economy code. Tenant scoping is by run file and identity tuple only — cross-tenant lookup isolation (V16) is P4's adapter work |
| P3–P8 | not started | — | — |

The `runtime` module may import nothing else in the repository and is
imported only by its tests (`.maddu/config/architecture.json`). Consumers
reach it through `import … from 'maddu/runtime'`; the deep-import fallback
`./*` keeps every pre-v1.147.0 import path working.

## 16. Provenance

Plan authored 2026-09-18; baseline `227c69d3b0606ebfe9a4f441483dfa46512f655f`
(v1.139.0). P0 audit executed 2026-09-20 with narrowly scoped lower-cost
read-only auditors (A1–A8) plus a code-path inventory, adversarially verified
for critical/high findings and reviewed by a completeness critic; the
coordinator adjudicated every label. Agent agreement is provenance, not
proof: only the tests in section 13, once built and run, establish any
guarantee named on this page.
