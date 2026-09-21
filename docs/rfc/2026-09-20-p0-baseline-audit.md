# P0 baseline audit — Máddu runtime and agent economy plan

**Date:** 2026-09-20
**Baseline:** `frdyx/maddu` at `227c69d3b0606ebfe9a4f441483dfa46512f655f` (v1.139.0, `main`).
**Branch under review:** `claude/cool-clarke-a5r9ks` (adds the RFC, this report, and the P1 characterization tests; changes no runtime behaviour).
**Plan:** [`2026-09-18-runtime-economy-handoff-plan.md`](2026-09-18-runtime-economy-handoff-plan.md) §9 (P0), §10 (audit execution), §10.4 (finding format).
**Decision record:** [`docs/57-product-runtime-rfc.md`](../57-product-runtime-rfc.md).

This is the P0 deliverable: pinned commit, code-path map, findings with
coordinator labels, ADR pointers, synthetic pilot scope, unknowns, and the
first implementation slice. It records what was inspected and how. It does
not certify anything beyond what the named commands and tests showed.

## 1. Environment and commands executed

The session ran in a Linux remote container, not on the operator's PC
workstation or MacBook. Platform-specific behaviour (file durability on
macOS/Windows, the heavy suites' timing) was therefore **not** observed.

| Item | Value |
|---|---|
| Platform | Linux 6.18.44 x86_64, 4 CPUs, Node v22.22.2, npm 10.9.7 |
| Checkout | fresh clone; `git status` clean at `227c69d`; branch created from `origin/main` |
| Máddu discipline | session `ses_20260920221713_3a9187`; goal + 9-phase plan declared; lane `runtime-economy` claimed before any write; slice-stops recorded at each boundary |

| Command | Result |
|---|---|
| `npm ci` | ok (dev deps `happy-dom`, `playwright` installed so cockpit gates run instead of skip) |
| `node bin/maddu.mjs ci --json` | exit 0, mode `pinned`, 51 required gates, 0 failing |
| `node scripts/generate.mjs --check` | 72 generated artifacts current (73 after `docs/57` was added and regenerated) |
| `node bin/maddu.mjs doctor` | 76 pass · 3 warn · 0 fail · 1 info — warns: `acceptance-proven` (goal declares no oracle/impl), `self-test-recent` (no receipt yet on this fresh spine), `tracked-source-drift` (94 files declared, nothing pinned on this checkout) |
| `node bin/maddu.mjs self-test --profile smoke` | 3/3 pass (`audit generated`, `audit`, `spine verify`) |
| `node scripts/test/doc-phantoms.mjs` | 36/36 after the RFC was added |
| `node scripts/test/legacy-evidence-vectors.mjs` (new, P1) | 54/54 at commit `61ca780`; 57/57 after the critic's extra cases |
| `node scripts/test/runtime-core-import-boundary.mjs` (new, P1) | 43/43 at `61ca780`; 44/44 with the `globalThis` check |
| `node scripts/test/legacy-boundary-characterization.mjs` (new, P1 follow-up) | 11/11 (swallowed `GATE_RAN` receipt; unguarded bridge respond) |
| `node bin/maddu.mjs self-test --profile quick --fail-on-skip` | 244 run · 242 pass · 2 fail · 0 skip (509 s). The two failures are environment artifacts, **reproduced identically on a detached worktree at the pinned `227c69d`**: `session-mint` ("unwritable map (read-only dir)" — the container runs as uid 0, and root ignores permission bits, so the write the test expects to fail succeeds) and `verify-replay` ("timeout: BOTH processes dead (tree kill)" — PID 1 here is `process_api`, not an init that reaps, so killed descendants linger as zombies that `kill(pid, 0)` still reports alive). Neither test touches a file this branch changes; both new P1 tests passed inside the run. |
| `stress-harness`, `upgrade-matrix`, `cockpit-playwright` | not run (heavy/browser suites; `maddu-heavy.yml` runs the first two weekly) |

## 2. How the audit was run

One coordinator (this session) orchestrated a deterministic workflow:

- **Audit stage.** Eight scoped read-only auditors A1–A8 (plan §10.2) plus one
  code-path cartographer for M1–M11, each given the immutable commit, an
  explicit 4–9 file scope, the related tests to read (not run), the plan
  sections holding the invariants, a mandatory negative case, an escalation
  rule, and the §10.4 structured finding format. Model: Claude Sonnet (alias
  `sonnet`). Rules of engagement: no file changes, no `maddu` verb, no test
  suite execution, no installs, no secrets; pure `node` import probes allowed
  from a scratch directory and recorded under `testsExecuted`.
- **Verify stage.** Every critical/high finding (cap 3 per audit) went to an
  adversarial refuter on the session's default model (configured
  `claude-opus-4-8`; the serving model may differ) at high effort, told to
  refute by default and to label `confirmed`, `needs-reproduction`,
  `design-decision`, or `not-supported`; critical findings got two independent
  refuters.
- **Critic stage.** One completeness critic over all packets: missing
  coverage, contradictions, unowned cross-boundary risks, ADRs required,
  first slice.
- **Coordinator.** Read every packet, re-opened the anchors of every
  medium/low finding and of the escalations that pointed at files outside an
  auditor's scope (`commands/ci.mjs`, `runtime/server.js`), and assigned the
  final label in §4. Agent agreement is provenance, not proof.

Outcome: 23 agents (9 audit/inventory, 13 refuters over 11 critical/high
findings, 1 critic), 0 errors, 55 minutes wall-clock, 2.9 M subagent tokens
(unpriced). Medium/low findings were deliberately not sent to refuters (cost
cap); the coordinator labelled them from re-opened anchors instead, which the
critic correctly notes as a weaker verification tier.

Concurrency was two agents at a time on this 4-CPU box. Token usage and cost
were **not measured** (unpriced, per plan §10.5). One auditor (A4) noticed
`HEAD` had moved one docs-only commit past the pinned commit during the run
and read its files via `git show 227c69d3:<path>`; all other packets read the
working tree, which was byte-identical to the pinned commit for every runtime
file (A5 checked with `git diff --stat`).

## 3. Code-path inventory (M1–M11)

Cartographer packet (Sonnet), read against the pinned commit (`git diff
--stat 227c69d3..HEAD` showed every module below byte-identical); import
probes from a fresh empty directory confirmed **zero import-time filesystem
writes** for all nine code modules. Verdicts follow ADR-010's vocabulary.

| Module | Plan ref | Ambient couplings (anchors) | Reuse verdict |
|---|---|---|---|
| `package.json` | M1 | no `exports`/`main`/`types`; `files` ships the whole `template/` tree, so runtime lib code reaches npm consumers only as undocumented deep paths | reference-only — an SDK starts from zero contract |
| `runtime/lib/paths.mjs` | M2 | `process.cwd()`/`process.env` only as overridable defaults (`:30`, `:56`); reads `MADDU_STATE_ROOT` (`:77-82`); probe: `resolveRoots(freshdir, {})` → null, no writes | reusable-as-is |
| `runtime/lib/spine.mjs` | M2 | `globalThis` witness on import (A1-002); `append()` (`:620-945`) interleaves the multi-replica workspace-identity ceremony with the write | extract-with-characterization — reuse `EVENT_TYPES`, `makeId`, the read side; extract a minimal single-writer `append` behind the P1 vectors |
| `runtime/lib/spine-append-core.mjs` | core | none of its own; imports `append-lock` (hostname/env at load, A1-001); ~35 of ~39 exports are sync-partition/identity machinery; 1577 lines on the monolith ratchet | extract-with-characterization — `hashLine` reusable-as-is; extract `{hashLine, minimal chained append}` only |
| `runtime/lib/append-lock.mjs` | core | `os.hostname()` `:48`, `MADDU_LOCK_BODYLESS_GRACE_MS` `:66-71` at module load; same-host advisory lock, dead-pid reclaim, bodyless grace | extract-with-characterization — or assign to `runtime/execution` |
| `docs/34-threat-model.md` | M3 | scenarios 11 (unkeyed chain residuals), 13 (assurance ladder), 14 (mutation witness) | reference-only — the residuals the runtime must re-derive, not inherit |
| `runtime/lib/gates.mjs` | M4 | `resolveGateRoots()` calls `paths.resolveRoots(process.cwd())` with no override (`:217`), falling back to `repoRoot` on mismatch; dynamic `import()` of operator files (`:34-44`); best-effort `GATE_RAN` (`:194`) | extract-with-characterization — discovery/status loop reusable; receipt durability and registry trust need decisions (RFC §7.3) |
| `runtime/lib/approvals.mjs` + `global.mjs` | M5 | global-policy branch (`approvals.mjs:84-100`) reads `<configDir()>/global/policies.json` under `os.homedir()` via `workspaces.mjs:20,24` → `config-dir.mjs:18-25`; **no test exercises `maybeAutoDecide`'s global branch or `matchGlobalPolicy`** | extract-with-characterization — `matchRepoPolicy` reusable; the global channel must be removed or re-scoped before any tenant boundary (see INV-001) |
| `runtime/lib/autonomy.mjs` | M6 | none — pure over an events array with an injected clock | reusable-as-is (as the recommend-only precedent, never as the economy's identity or value record) |
| `docs/47-earned-autonomy.md` | M6 | matches the code on every section read | reference-only |
| `runtime/lib/reflect.mjs` | M7 | imports `pairVerifications` from `verification-recency.mjs` (not re-verified) | reusable-as-is |
| `runtime/lib/experience.mjs` | M8 | imports `scanCompletionClaims` with a null clock; zero writes; no scalar reward anywhere | reusable-as-is |
| `docs/50-experience-evolve.md` | M8 | headings only | reference-only |
| `runtime/lib/verify-replay.mjs` | M9 | `child_process.spawn` with `shell:true` and full `process.env` passthrough (`:256-259`); shells out to `git`; `MADDU_REPLAY_TIMEOUT_MS` (`:64`) — all self-documented as trusted-operator scope | extract-with-characterization — the receipt discipline (STARTED first; setup refusal emits nothing; failed RAN never claims replayed) is the shape to keep; the execution model is not for less-trusted callers |
| `docs/55`, `docs/56` | M9 | headings only | reference-only |
| `docs/charter.md` | M10 | rule 2's v1.14.0/v1.98.0 language matches `FLAT_LOCK_VERSION` | reference-only — a runtime spec must state which of the 8+1 it inherits |
| `scripts/generate.mjs` | M11 | `invokedDirectly` guard since v1.139.0; probe: no writes on import | reusable-as-is |
| `runtime/lib/generate.mjs` | M11 | `runGenerators(repoRoot)` explicit-root; the `GENERATORS` manifest is hard-coded beside the engine (`:181-258`) | extract-with-characterization — engine and manifest are one file |

Inventory findings folded into §4: **INV-001** (medium) the machine-global
approval policy channel; **INV-002** = A7-001 (best-effort `GATE_RAN`);
**INV-003** (low, by design) `verify-replay`'s unsandboxed shell execution.

What the coordinator established directly while building P1, and pinned in
`scripts/test/__fixtures__/legacy-evidence-vectors.json`:

- **Stored line.** `JSON.stringify` of the envelope in insertion order
  `v, id, ts, type, actor, lane, data[, triggered_by][, ws], prev_hash`; one
  line per event, `\n`-terminated, no reformatting. The genesis line is
  ws-less by protocol; every later line carries `ws` (`^ws_[a-f0-9]{16}$`)
  after `data`/`triggered_by` and before `prev_hash`.
- **Chain.** `prev_hash = sha256(previous stored line as UTF-8, trailing CR
  stripped)` — the literal bytes, not a canonical re-serialization
  (`spine-append-core.mjs` `hashLine`); genesis `prev_hash: null`. Computed
  inside the per-directory append lock. Strict (FAIL-on-tamper) once a
  `FRAMEWORK_INSTALLED`/`FRAMEWORK_UPGRADED` ≥ `FLAT_LOCK_VERSION` (1.98.0)
  or a `SPINE_CUTOVER` anchor is seen.
- **Ids.** `evt_<14 digits from the ISO ts>_<6 hex>` via `makeId`; session ids
  `ses_…` gated by `isSid`; references by `isRefId`.
- **Redaction.** Every `data` passes `redactDataPayload` before the line is
  built and hashed; a clean payload passes by reference; hits become
  `[REDACTED:<pattern-type>]` and the redacted bytes are what the chain
  commits to.
- **Contract shape.** `EVENT_CONTRACT_VERSION` 1.21.0, fingerprint
  `ba204ab3`, pinned by the existing `event-schema` test; it covers field
  names/types only, never bytes or hashes (A7-002 — now covered by P1).

## 4. Findings register

Severity is the auditor's; **label** is the coordinator's after verification.
`design-decision` means the behaviour is real, documented or clearly
intentional for the development tool, and becomes a *requirement* on the
runtime rather than a defect to patch. `confirmed` means real and
undocumented at the anchors. Where the refuters corrected a severity the cell
reads `auditor → corrected`; the coordinator owns the final value (plan §10.4).

| ID | Sev | Finding (anchors) | Label | Consequence |
|---|---|---|---|---|
| A1-001 | medium | `append-lock.mjs:48,66-71` reads `os.hostname()` and `MADDU_LOCK_BODYLESS_GRACE_MS` at module load; imported by `spine-append-core.mjs:18` | confirmed | Pinned shrink-only by `runtime-core-import-boundary`. Fix candidate: evaluate lazily at lock-acquire, or assign locking to `runtime/execution` (RFC §6). |
| A1-002 | low | importing `spine.mjs`/`verify.mjs` installs a guarded `globalThis.__MADDU_MUTATION_WITNESS__` (`mutation-witness.mjs:63-74`, `verify.mjs:71`) | confirmed | Inert; not on the candidate-core path. A `verify` extraction must import `EVENT_TYPES`/`hashLine` from the core, not the façade. |
| A2-001 | high → medium | cross-partition order is the self-reported `ts` k-way merge; merged-order issues capped at WARN (`spine-append-core.mjs:1335-1354`, `verify.mjs:140-160`) | design-decision (verified) | Documented in `verify.mjs` ("a timestamp merge across independent replicas is not a causal order"). Runtime requirement: per-run sequence and explicit causal refs (RFC §7.1). Default flat mode unaffected. |
| A2-002 | high → low | suffix truncation, tail-only edit, and a well-linked forged tail verify clean (`spine-tamper-guard.mjs` tests 11-13 pin them as conceded residuals) | design-decision (verified) | Documented in `docs/34`, `docs/54`, `hard-rules.md` rule 2. Runtime requirement: retained checkpoint / external witness (RFC §7.4); P1 pins the limit. |
| A2-003 | high → medium | `actor` is a self-declared string; verify checks registration existence, not authenticity (`event-schema.mjs:264-281`, `verify-referential.mjs:71-132`) | design-decision (verified) | Cooperative single-operator tool by charter. Runtime requirement: host-issued identity tuple (ADR-007). |
| A2-004 | medium | no `fsync`/`fdatasync` anywhere in the append path (`spine-append-core.mjs:1519-1524,1567-1572`) | confirmed | Same fact as A5-003. Acknowledgement level is undocumented; ADR-003 makes it explicit. Fix candidate: state the level in the module header. |
| A2-005 | low | bodyless-grace reclaim window (`append-lock.mjs:159-203`) | design-decision — folds into the A5-001 operation-id gap | Documented trade-off in code; not to be re-fixed blindly. |
| A3-001 | critical → high | `POST /bridge/approvals/respond` appends `APPROVAL_DECIDED` for any `approvalId` with no open/already-decided check (`bridge-routes-approvals.mjs:61-79`); the CLI path refuses (`approval.mjs:57-78`); projection keeps every row (`projections.mjs:288-300`) | confirmed (2 votes) | Coordinator read `server.js`: loopback-only, writes require the bridge token — so a same-machine token holder, not an anonymous caller. Still a real CLI/bridge inconsistency. **Fix candidate (separate PR):** mirror the CLI check atomically before the append. Runtime: single-use bound handles (ADR-005). |
| A3-002 | critical → high | a required gate with no file yields no run; `_gates-before-done.mjs:69-70` filters present runs only → `goal done`/`plan complete` proceed under strict | confirmed (2 votes) | Coordinator read `commands/ci.mjs:204-222`: `maddu ci` **already fails closed** ("required but no runnable gate resolves"). The gap is only in the completion check. **Fix candidate (separate PR):** port `ci.mjs`'s required-integrity check into `_gates-before-done.mjs`. |
| A3-003 | high → medium | an operator file under `.maddu/gates/` may shadow any builtin gate id; "later-loaded wins" (`gates.mjs:78-90`) | design-decision (verified) | Documented operator override for the repo-local tool. Runtime requirement: trusted registry with implementation digests (RFC §7.3). |
| A3-004 | high | an import-time throw is keyed by file path, so a required id never matches it (`gates.mjs:34-44`) | confirmed (coordinator; beyond the per-audit refuter cap) | Same blind spot as A3-002 for the completion path; `maddu ci` catches it via count = 0. Fix together with A3-002. |
| A3-005 | medium | (a) `GATE_RAN` append failure swallowed (`gates.mjs:194`); (b) `APPROVAL_DECIDED` binds only tool/lane, not action bytes, resource version, or expiry | confirmed | (a) = A7-001. (b) Runtime requirement: exact action binding (ADR-005, RFC §7.2). |
| A4-001 | high → medium | redaction is secret-shaped only; a foreign path survives event data, error text, and OTLP export (`secret-scan.mjs:21-84,217-271`, `otel.mjs:74-134`, `paths.mjs:69-75`; probe-confirmed) | design-decision (verified) | `hard-rules.md` rule 6 already says best-effort pattern redaction is not a privacy boundary. Runtime requirement: references-only evidence, keyed commitments (ADR-008). |
| A4-002 | medium | `maddu export --otel` echoes the raw `--endpoint` (possibly with userinfo) to stderr (`commands/export.mjs:96,101`) | confirmed | Low blast radius; **fix candidate (separate PR):** mask userinfo before printing. |
| A4-003 | medium | device-local workspace registry stores paths/labels in one 0600 JSON with no redaction (`workspaces.mjs:30-32,82-90`) | design-decision | Device-local single-operator state by its own header. Not a tenant primitive; the runtime must not reuse it (ADR-007). |
| A5-001 | high → medium | `spine.append()` has no operation-id/idempotency parameter; a crash-then-retry duplicates the logical event under two ids (`spine.mjs:620,774-775,876-891`) | confirmed (verified) | Runtime requirement: unique operation ids + reconciliation (RFC §8, ADR-003). Not a dev-tool defect on its own. |
| A5-002 | medium | `createCheckpoint()` writes `checkpoints/index.ndjson` before the `CHECKPOINT_CREATED` event with no reconciliation (`checkpoints.mjs:93-113`) | confirmed | Violates "derived ≠ projected" in spirit. **Fix candidate (separate PR):** append first, or derive the index from the spine as `receipts.mjs` does. |
| A5-003 | medium | append acknowledged on `appendFile` resolve, before any OS flush | confirmed | Same as A2-004. |
| A5-004 | low | tolerant `readAll` silently drops a torn tail; only strict readers and the next append surface it (`spine.mjs:905-947`, `spine-append-core.mjs:1185-1222`; probe-confirmed) | confirmed | Bytes are preserved (good). Surface a torn-tail signal on ordinary reads — candidate, not urgent. |
| A6-001 | high → medium | autonomy scoring is keyed by the bare `lane` string joined from self-reported registration/claim events; a new lane name starts at n=0 (`autonomy.mjs:105-130,183-217`) | design-decision (verified) | Lanes are ad-hoc by design (`docs/lanes.md`). Economy requirement: host-issued principal lineage, never lane ids (ADR-007). |
| A6-002 | medium | "clean" proof is deliverable existence or one ok gate; 22 trivial clean slices reach the top rung (`autonomy.mjs:43-46,148-155`; `autonomy-score.mjs` fixture) | design-decision | Documented in the module docstring. Economy requirement: value and reliability are separate records (ADR-006). |
| A7-001 | high | no test forces the `GATE_RAN` append to throw, so the empty catch at `gates.mjs:194` has zero coverage | confirmed (verified) | Runtime requirement: explicit evidence-durability result (RFC §7.3, P3). A characterization test that pins the current swallow is a P3 precondition. |
| A7-002 | medium | no fixed byte or hash-preimage vectors existed at the baseline; chain tests recompute hashes self-referentially | confirmed → **resolved on this branch** | Closed by commit `61ca780` (`legacy-evidence-vectors`). |
| A8-001 | high → medium | **process finding, not code:** auditors read the live checkout while the coordinator committed the RFC (`25f9cea`) and P1 (`61ca780`) on it; `git cat-file -e 227c69d:docs/57-…` fails though the file is on disk | confirmed (verified; orchestration) | Mitigated in this round: A4, A5, A8 and the cartographer each ran `git diff --stat 227c69d..HEAD` (or read via `git show 227c69d:<path>`) and found every runtime/gate/test file byte-identical; only `docs/57`, `docs/00-index`, `docs/rfc/*` and the two new tests differ. **Next round:** give every read-only auditor a detached worktree at the pinned SHA (`git worktree add --detach`), never the coordinator's working checkout. |
| A8-002 | medium | at `227c69d` no doc answers plan §3.2 (does a host-owned storage adapter fit the charter?); `charter.md:30-36` and `hard-rules.md:9-34` frame only "Máddu's own code" vs "the product" | confirmed at baseline → **resolved on this branch** | ADR-001 in `docs/57` records the answer (a separately scoped contract; adapters host-owned). The one-sentence charter addition is deliberately sequenced after P2 (ADR-001 follow-up). A8 also noted `docs/57:15` cited this report before it existed and that neither `docs-indexed` nor `generated-artifacts-current` checks external URLs — the citation resolves once this file is committed in the same PR. |
| A8 (observed) | — | README, `package.json`, `charter.md`, `hard-rules.md`, `45-category.md`, `installation.md` make no installable-SDK, durability, or isolation claim at the baseline; the only "SDK" mentions say Máddu's own code imports none; probe: importing `/index.js` → `ERR_MODULE_NOT_FOUND` | no finding | V27 holds at the baseline. P8's two-entry-path README work starts from a clean slate. |
| INV-001 | medium | a global approval policy set in one repo auto-decides `APPROVAL_REQUESTED` in every other repo the same OS user opens (`approvals.mjs:84-100` → `global.mjs:22-24` → `config-dir.mjs:18-25`), matched by tool/lane wildcard only; zero tests cover the global branch | design-decision | Intentional single-operator convenience (`docs/19-multi-workspace.md`). Runtime requirement: no inherited machine-global policies (RFC §2, ADR-005). A test for the global branch is a reasonable dev-tool follow-up. |
| INV-003 | low | `verify-replay` executes declared commands with `shell:true` and full env passthrough, unsandboxed | design-decision | Self-documented (`docs/55`). Never reuse for a less-trusted caller's commands (RFC §7.4: re-execution is a separate operation). |

Duplicates merged: A2-004/A5-003 (fsync), A3-005a/A7-001/INV-002 (swallowed receipt).

### 4.1 Refuter verdicts

Thirteen refuters (session model, high effort, told to refute by default)
over the eleven critical/high findings; two independent votes for each
critical one. No finding was marked `not-supported`; none was removed.

| Finding | Votes | Verdict | Priority | The refuter's decisive point |
|---|---|---|---|---|
| A2-001 | 1 | design-decision | medium | Documented at `verify.mjs:140-143`, CHANGELOG v1.124.0, `docs/49:70-82`, `docs/34:560-567`; pinned by `spine-partition-verify`/`spine-kway-merge`. A P2 requirement (per-run sequence), not a cleared finding. Residual: heavy-suites/self-test/project-test-recent gates consume ts-sorted sync-mode events without a team-sync refusal. |
| A2-002 | 1 | design-decision | low | `docs/34` scenario 11 lists truncation, last-event edit and well-linked forged append verbatim as unkeyed limits; `spine-anchor` is the partial mitigation; a requirement on the P2 verifier's head commitment. |
| A2-003 | 1 | design-decision | medium | Real and not refuted, but documented (`docs/34` §11: "a plain hash, not an HMAC/signature"; "writable by anyone with repo access"). Load-bearing for reuse: `actor` is a self-declared label. |
| A3-001 | 2 | confirmed, confirmed | high | Two overstatements corrected: not "forgeable" (`server.js:138-216` requires the per-boot capability token on every POST; loopback-only) and not "undetected" (`verify-referential.mjs:36-52` FAILs `orphan_approval_decided`, WARNs `duplicate_approval_decided`). Preventive single-use/existence enforcement is genuinely absent on the write and consume path → fails V09 if reused. |
| A3-002 | 2 | confirmed, confirmed | high | Traced `goal.mjs:125-128` / `plan.mjs:297-299` → `proceed:true`; probe `runGates({onlyId:'nonexistent-gate-id'})` → 0 runs, 0 blocking. `ci.mjs:208-228` fails closed, so the completion check's "mirrors ci EXACTLY" comment is wrong for this case; `GOAL_COMPLETED` records `gatesFailed:0` with no witness. Needs strict tier + a pinned profile. |
| A3-003 | 1 | design-decision | medium | `docs/34` §12 names operator shadowing "local-only… unwatched"; SECURITY.md, README, `docs/02`/`03` repeat it; `audit-traceability` asserts an override runs under the builtin identity with `source:'operator'`; `.gitignore` keeps `.maddu/gates` out of CI. A warn-severity stub on a required id is RED at `ci.mjs:221`. Residual for reuse: `GATE_RAN` omits source/digest. |
| A4-001 | 1 | design-decision | medium | `hard-rules.md:87-101` scopes redaction to secret-shaped values; `docs/48` documents the export promise as "no secrets leave"; no tenant boundary exists at the pin. The `paths.mjs:69-75` trigger is a hypothesis (`gates.mjs:215-227` swallows that throw). |
| A5-001 | 1 | confirmed | medium | Mechanism real; impact overstated: per-type in-lock preconditions exist at the caller layer (`session-lifecycle.mjs:104-129`, `janitor.mjs`, `enforcer.mjs`, `approval.mjs:146`) and verify WARNs duplicates. The bridge respond retry does duplicate. P2/P4 schedule operation ids. |
| A6-001 | 1 | design-decision | medium | `docs/47:25-27,50` documents per-(lane×repo) scoring with "no binding enforcement, no crypto identity"; `lane.mjs:262-291` accepts ad-hoc ids by design; plan §7.2 already forbids lane ids as principal keys. Combined with A2-003 (a forged `SESSION_REGISTERED` plus a fresh lane) the dev-tool exposure is larger than either row alone — both are ADR-007 requirements. |
| A7-001 | 1 | confirmed | high | Production callers with `emitEvents:true` are `doctor.mjs:311-317` and `slice-stop.mjs:127-156`; `spine.append` throws on `WS_IDENTITY_CONFLICT`/`UNRESOLVABLE`, `REPLICA_UNATTACHED`, a migration stall. Over-crediting path: `gate-ledger.mjs:41-88` is last-wins per gateId, so a swallowed newest FAIL leaves an older ok as "latest" (stale green in orient/cockpit). No test injects a throwing spine. |
| A8-001 | 1 | confirmed | medium | Every factual claim reproduces; an audit-process defect, not code. A8's conclusions from the six unchanged files remain valid for the baseline. |

### 4.2 Escalations resolved by the coordinator

- **Does `maddu ci` share A3-002/A3-004?** No. `commands/ci.mjs:204-222`
  resolves every pinned required id against the post-override runs and reds
  on "required but no runnable gate resolves" or on a duplicate resolution.
  The blind spot is confined to `commands/_gates-before-done.mjs`, whose
  comment claims to mirror `ci` exactly — it does not, for this case.
- **Bridge reachability for A3-001.** `runtime/server.js` binds
  `127.0.0.1` by default, rejects non-loopback Host/Origin, and requires the
  bridge token for every write (kept honest by `scripts/test/bridge-auth-guard.mjs`).
  A forged or replayed decision therefore needs same-machine token access.

## 5. Unknowns and open escalations

Consolidated from the packets; each names the file or decision that would
resolve it.

- Whether `append-lock.mjs` belongs to `runtime/core` or `runtime/execution`
  (A1-001) — a P2 boundary decision; the RFC's table places locking in
  `execution` by implication, and this report recommends stating it.
- Whether any `commands/` caller of `spine.append()` layers its own
  idempotency (A5-001) — not read; irrelevant to the runtime, which gets
  operation ids by contract.
- Whether the OpenTimestamps anchor (`docs/54`) is run often enough to bound
  the tail gap (A2-002) for any event class — operator practice, not code.
- Whether `.maddu/gates/` operator override (A3-003) should emit a visible
  event when it shadows a builtin id — a small dev-tool improvement, not a
  runtime blocker.
- `commands/_args.mjs` masking of `--endpoint` (A4-002) — not read.
- `verify.mjs`'s body was read by A2 for chain semantics but its referential
  rules were only grep-inspected; a dedicated pass is due before any
  `verify` extraction (P2).
- Platform durability (macOS/Windows buffered writes, A2-004/A5-003) needs
  the fault-injection harness the plan calls for; nothing here observed it.

## 6. Cross-boundary risks no single audit owns

From the completeness critic, with the coordinator's owner assignment:

| Risk | What no packet owns | Owner |
|---|---|---|
| Actor / decision authentication end to end | `bridge-auth.mjs` (token mint, capability file) unread; how CLI verbs obtain authority to append `SESSION_REGISTERED`/`LANE_CLAIMED`/`GATE_RAN`; the respond route trusts `body.actor || 'operator'` | P3/P4 (ADR-005, ADR-007); dev tool: documented residual (`docs/34` §11) |
| Signing / cryptographic attribution | none of the read files sign events; no packet owns whether signing exists elsewhere | ADR-011 states it: the legacy spine is unsigned; runtime v1 uses a host-attested actor from trusted context; signatures are verifier dimension 4, deferred |
| Idempotency / operation identity | A3-001, A5-001, A3-005(b) are one gap | P2 store contract (operation ids) + P4 (single-use handles) |
| Durability protocol | no fsync (A2-004/A5-003); `checkpoints` index before its event (A5-002); git-tag durability and the OTS anchor producer unexamined | P2 (ADR-003 acknowledgement levels); dev tool: header-comment fix candidate |
| Tenant / workspace isolation | provenance of the `ws` stamp (`spine-sync.mjs`) and the unscoped workspace registry unowned; `server.js` cross-workspace check unaudited | P2/P4 (ADR-007/008); follow-up read of `spine-sync.mjs` before any `verify` extraction |
| Grader weakening | A3-003, A3-002/A3-004, and same-PR refresh of `event-contract-baseline.json` / `ci.json` — no owner for the path "author edits gate/baseline/profile → CI green" | Runtime: review-owned, content-addressed manifests (RFC §7.3). Dev repo: the solo-maintainer residual `docs/34` §12 and `tracked-sources.json` already record |
| Privacy retention | what is retained where (event data, hindsight, mailbox, briefings, exports) and for how long | P5 fixture + ADR-008; out of scope for the dev tool |
| Settlement atomicity | no economy code exists at the pin, and no packet said so | Stated in ADR-011: P6 starts from a new settlement store, never from `autonomy.mjs` |
| Incompatible contract change | whether the P1 vectors are literal constants rather than self-computed | Checked by the coordinator: the fixture holds literal sha256 hex strings and literal stored lines, and the tests compare the live functions to those constants (a change is a visible diff) |

## 7. ADRs recorded and ADRs still required

Recorded in `docs/57` §4: ADR-001 charter fit, ADR-002 packaging, ADR-003
persistence/deployment, ADR-004 event namespace, ADR-005 enforcement posture,
ADR-006 economy defaults, ADR-007 identity, ADR-008 privacy, ADR-009
authority, ADR-010 reuse policy.

The critic proposed eight ADRs. Disposition:

| Critic's ADR | Disposition |
|---|---|
| Charter fit of host storage adapters | exists — ADR-001 |
| Package boundary / core candidate set (append-lock to execution; spine.mjs and verify.mjs excluded until the import-time `globalThis` witness goes; extraction is copy-behind-compat-tests) | **accepted** — added as ADR-011 in `docs/57` |
| Audit pinning and evidence rule (detached worktree at the pin; revision recorded per file; the shared checkout is not evidence) | **accepted** — added as ADR-012 in `docs/57`; applied from the next round |
| Legacy assurance residuals declared, not inherited (chain-local hashes; undetected suffix truncation and tail edits; WARN-only cross-producer ordering; unauthenticated actor; buffered acknowledgement; no operation-id idempotency; best-effort `GATE_RAN`) | **accepted** — the list is part of ADR-011; a `design-decision` verdict never clears P2–P4 |
| Single-use bound decision handle; the legacy bridge route is not the model | exists — ADR-005; the "not the model" sentence added to ADR-011 |
| Gate identity and grader ownership; second-reviewer rule for gate/baseline/profile changes | runtime part exists (RFC §7.3, ADR-005); the second-reviewer rule is accepted for runtime manifests and recorded as a solo-maintainer residual for the dev repo |
| Identity / autonomy / economy separation; economy code does not exist at the pin | exists — ADR-006/007; the "does not exist at the pin" statement added to ADR-011 |
| Privacy scope and synthetic pilot definition | exists — ADR-008 and RFC §11; the critic is right that the pilot scope is a statement, not audited evidence |

## 8. Synthetic pilot scope (P5)

As in RFC §11: one AI-draft workflow (summary of a supplied synthetic
document for human review) against the public runtime API, synthetic tenants,
controlled model/tool responses, no network; scenarios: success, rejected
output, missing evidence, timeout, crash/retry; boundaries: trusted host
context before init, release boundary re-validation, simulated side effects
with idempotency and reconciliation, minimization rules, no keys or admin
operations in browser code, economy toggle cannot bypass authorization.

## 9. First implementation slice — done on this branch, and what is next

**Done (P1, commit `61ca780`).** `scripts/test/legacy-evidence-vectors.mjs`
pins the stored-line bytes, the `prev_hash` preimage, the ws stamp, the
redaction sweep, the id grammar, the strict-chain tamper/strip outcomes, and
the documented truncation limit against a frozen fixture and against the live
writer. `scripts/test/runtime-core-import-boundary.mjs` pins the candidate
core set's import graph and ambient reads (shrink-only) and proves import
from a fresh non-git directory with a scrubbed environment writes nothing.
Both are auto-discovered by the quick profile and therefore run in CI.

**Critic's review of that slice, and what the follow-up commit adds.** The
critic asked for six things. (1) Literal constants rather than
self-computed hashes — already true: the fixture stores sha256 hex strings
and literal stored lines, and the tests compare the live functions to them.
(2) A fuller verifier characterization — the follow-up adds a tail-only edit
(clean, the documented residual), a torn trailing line
(`torn_trailing_line` FAIL, committed lines still counted) and a well-linked
duplicate id (`duplicate_id` FAIL); interior delete, forged insert, key strip
and the concurrent fork were already pinned by `spine-tamper-guard.mjs`.
(3) A `globalThis` check — added to the import probe (the candidate set adds
no global; `spine.mjs`/`verify.mjs` are excluded for exactly that, ADR-011).
(4) The swallowed `GATE_RAN` receipt — `scripts/test/legacy-boundary-characterization.mjs`
pins it with a throwing spine (verdict returned, no receipt, nothing on the
result says so) next to a control run that lands one receipt. (5) The
unguarded bridge respond route — the same script pins two `200`s for a
never-requested id and the post-hoc `orphan_approval_decided` FAILs (the
duplicate rule does not fire for an orphan). (6) Running on the MacBook —
still to be confirmed by the operator; the scripts need Node only. Not
adopted: one literal event per `EVENT_TYPES` member (the hash is
type-agnostic; per-type `data` shape is the existing contract baseline's
job). When a fix PR lands for A7-001 or A3-001, its assertion in that script
flips in the same change, which is the point.

**Next, requiring the operator's authorization because they change legacy
behaviour (each a small PR with a failing test first):**

1. `_gates-before-done.mjs`: port `ci.mjs`'s required-gate resolution check
   so a missing or import-broken required gate blocks `goal done` /
   `plan complete` under strict (A3-002, A3-004).
2. `bridge-routes-approvals.mjs`: refuse a decision for an unknown or
   already-decided `approvalId`, atomically, matching the CLI (A3-001).
3. `checkpoints.mjs`: append `CHECKPOINT_CREATED` before writing the index,
   or derive the index from the spine (A5-002).
4. `commands/export.mjs`: mask userinfo in the printed endpoint (A4-002).
5. `append-lock.mjs`: read hostname and the grace env lazily (A1-001), then
   tighten `PINNED_AMBIENT` in the boundary test.
6. Header comments in `spine-append-core.mjs` / `append-lock.mjs`: state the
   acknowledgement level (process-crash safety, not power-loss durability)
   (A2-004/A5-003); fix the stale "flat path is lock-free" header in
   `append-lock.mjs` (A5 observed).

**Next on the runtime track (no legacy change): P2** — runtime schemas,
canonical encoder with fixed vectors, append-store contract with an explicit
acknowledgement level, reducer, offline verifier, in-memory store and the
experimental file adapter, each with the V04/V05/V12 negative fixtures.

## 10. Completion report

- **Changed files / commits.** `25f9cea` docs (RFC, plan, index, generated
  mirror); `61ca780` tests (two scripts, one fixture); this report and the
  release notes follow on the same branch.
- **Executed tests.** See §1. Nothing in §4 was fixed on this branch; no
  provider call, deployment, or production access occurred.
- **Negative-path evidence.** P1 asserts tamper → `chain_broken` FAIL, strip
  → `chain_stripped` FAIL, truncation → clean (documented limit), redaction
  bytes, and zero writes on import.
- **Migration / rollback.** None needed: docs and tests only. Reverting the
  branch removes the RFC and the two tests.
- **Remaining risks.** The six fix candidates in §9 are open on `main`; the
  runtime does not exist yet, so every RFC guarantee is unimplemented; the
  quick profile's two environment failures (§1) should be re-run on the
  operator's workstation and in GitHub CI (non-root runner with an init) to
  confirm they are green there, as `main`'s release history implies.
- **Next authorized step.** The operator decides (a) whether to authorize
  the six legacy fix PRs, and (b) whether P2 starts now. This report does
  not authorize either.
