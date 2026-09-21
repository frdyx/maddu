# 58 · Embedding Máddu in an AI-powered product — `maddu/runtime`

> **Scope of this page.** It describes what the opt-in runtime does, the
> modes that are tested, and the limits that are stated rather than
> assumed. Every claim below maps to a test under `scripts/test/runtime-*`
> or is marked as a limitation. The design and its decisions are in
> [57-product-runtime-rfc.md](57-product-runtime-rfc.md); this page is the
> adoption surface that RFC's P8 called for.

## What it is, what it is not

`maddu/runtime` is an **embedded evidence runtime**: a small, dependency-free
module your product calls to record what an AI agent did, run registered
checks against exactly what the model produced, turn those checks into a
bound decision, and hold the protected side effect or release behind a
handle nobody but your policy service can forge. It leaves behind a
per-run, hash-chained event stream and a portable receipt an independent
verifier can re-check offline.

It is **not** a model client, a sandbox, an authentication system, a
compliance certificate, or a hosted service. Your application keeps the
model calls, the credentials, the database, the business policy and the
final authorization. The runtime holds no key of its own and spawns nothing.
The same charter that governs the CLI applies: *the host calls Máddu; Máddu
never sits in the request path and never touches your keys* (ADR-001).

The development harness (the `maddu` CLI, the bridge, the cockpit) is a
separate tree. Nothing under `runtime/` imports it, and it does not import
the runtime; `.maddu/config/architecture.json` pins that boundary and the
`architecture-contract` gate enforces it.

## Install and import

The runtime ships inside the existing `maddu` package as one subpath export
(ADR-002). No separate package name is claimed.

```bash
npm install maddu        # or: npm pack in a checkout → npm install ./maddu-<version>.tgz
```

```js
import { createRuntime, GateRegistry, MemoryStore, FileStore, freezePolicy, hmacSigner,
         decide, recordApproval, execute, release, reconcile,
         referenceContext, observeModelCall, exportReceipt, verifyReceipt, measureRun } from 'maddu/runtime';
```

Types are declared in `runtime/index.d.ts` and resolved through the
`exports` map (`"types"` condition). `maddu/runtime` is the **only**
supported import path. Deep paths below it resolve today only because the
package keeps a `./*` fallback for the CLI's own legacy imports; they are
not part of the contract and may move without notice.

**No startup side effects.** Importing the runtime reads no git repository,
no global configuration, no environment variable, and creates no files
(V01: `runtime-core-import-boundary`; V25: `runtime-external-consumer`
installs the packed tarball into a fresh consumer and runs it with no
`.maddu/` directory appearing).

## The lifecycle in one page

The synthetic pilot (`scripts/test/runtime-pilot-synthetic.mjs`, host side in
`scripts/test/__fixtures__/runtime-pilot-host.mjs`) is the reference
integration. Its shape, with the host's own pieces marked:

```js
// 1. Trusted host context first. The model never picks its tenant or policy.
const context = { tenant, product, principal, agentVersion, field };        // host
const store   = new FileStore('/var/lib/app/evidence');                     // or MemoryStore, or your own BaseStore
const gates   = new GateRegistry();                                          // trusted deployment config
gates.register({ id: 'schema', version: '1.0', evidenceClass: 'deterministic', check: (draft) => /* … */ 'pass' });
gates.freeze();
const policy  = freezePolicy({ version: 'pol-7', boundaries: {
  draft:   { enforced: false },                                              // shadow: measured, never blocks
  release: { enforced: true, requireApproval: true, ttlMs: 300_000 },        // the one enforced boundary
}});
const signer  = hmacSigner({ id: 'policy-svc', key: process.env.POLICY_KEY });   // host-owned key; or your KMS
const runtime = createRuntime({ store, gates, newId: () => crypto.randomUUID(), now: () => new Date().toISOString() });

// 2. Open the run against the frozen gate set. Same key → same run, never a second RUN_STARTED.
const run = await runtime.startRun({ run, context, idempotencyKey, requiredGates: ['schema'], policyVersion: 'pol-7' });

// 3. Observe context selection and the model call. References and digests only — no bodies.
await referenceContext(run, { references: [{ kind: 'document', ref: docId, digest, bytes }] });
const call = await observeModelCall(run, { metadata: { provider, model }, invoke: () => yourModelClient.draft(doc) });

// 4. Run the gates against exactly that draft. error / timeout / unknown / missing are never `pass`.
const evaluation = await run.evaluate({ subject: call.output });

// 5. Decide. Coverage is read from the run's evidence, not from `evaluation`.
let d = await decide(run, { signer, policy, boundary: 'release', operation, parameters, resourceVersion, subjectDigest: evaluation.subjectDigest, now });
if (d.decision === 'escalate') { /* a human decides through recordApproval(); then decide() again */ }

// 6. The protected boundary re-binds the handle to what is presented NOW, lets your authorize() deny, consumes it once.
if (d.decision === 'allow') await release(run, { handle: d.handle, signer, boundary: 'release', subject: call.output, now, authorize, deliver });

// 7. Terminal, receipt, measurement.
await run.complete();
const receipt = exportReceipt({ events: (await run.read()).events, manifest: evaluation.manifest, policy, exportedAt: now(), exporter: 'app' });
```

## Supported modes

| Mode | Status | What is tested |
|---|---|---|
| `MemoryStore` | supported | ack `buffered`; the full contract (`runtime-execution-store`) |
| `FileStore` (one NDJSON file per run) | **experimental** | ack `durable` after `fdatasync` and a one-time directory sync, `written` where the platform cannot sync the directory; torn tail and corrupt line reported, never repaired; appends refused on damage; cross-instance reload |
| your own `BaseStore` subclass | supported contract | `append(draft, { expectedHead })` compare-and-swap, one operation key per run, terminal closes the run, explicit ack level |
| shadow boundary (`enforced: false`) | supported | `decision: allow` with `wouldDecide` and `reasons` recorded; `measureRun().decisions.wouldBlock` |
| enforced boundary | supported | `fail` / `error` / `timeout` / `unknown` / missing all withhold; an approval never overrides a failing required gate |
| approval binding | supported | one `APPROVAL_REQUESTED` per operation, single use, expiring, bound to the action digest and resource version |
| single-use handle | supported | HMAC by a host signer; re-bound at the boundary to run, tenant, principal, boundary, policy, gate set, parameters, resource version, artifact, expiry |
| receipts | supported, **unsigned** | portable bundle with known omissions; `authority: 'unsigned'` on every verification |
| producer keys, external witness, signatures | **not supplied** | the verifier reports `not_supplied`; a receipt is never "from a trusted issuer" in this version |
| economy / settlement | **not present** | no code under `runtime/economy`; ADR-006 |

Storage is one single-writer stream per run. A distributed store must
provide compare-and-swap or an equivalent, unique operation ids and crash
recovery; that adapter is the host's (RFC §8).

## Guarantees that are tested, and their limits

| Property | Tested by | Limit |
|---|---|---|
| Same events → byte-identical state and head (V03) | `runtime-core-envelope-reduce`, pilot A18 | none |
| Tamper, reorder, splice, gap, replay → named failure, never repair (V04) | `runtime-core-envelope-reduce`, `runtime-core-receipt` | detection is by the chain; producer authenticity is `not_supplied` |
| Dropped terminal / replaced bundle → incomplete or invalid, limits explicit (V05) | `runtime-core-receipt` | an unsigned bundle can be wholesale replaced by whoever holds the store; the verifier says `unsigned` |
| Missing gate, changed implementation under the same id, malformed policy → withheld (V06) | `runtime-lifecycle-run`, `runtime-decision-policy` | the implementation digest covers the check's source text or a host-supplied digest; it does not sandbox the check |
| Gate throws / times out / evidence append refused → explicit non-pass, no side effect (V07) | `runtime-lifecycle-checks`, `runtime-lifecycle-run`, `runtime-boundary-execute` | a check that spawns its own side effects is outside the runtime's view |
| Modified output or arguments after a gate or approval → binding mismatch (V08) | `runtime-decision-policy`, `runtime-boundary-execute`, pilot A9 | the digest binds what the host presents to the boundary; an in-process host can present anything (§6.1) |
| Forged / reused / re-scoped handle → refused; legitimate retry reconciles (V09) | `runtime-decision-policy`, `runtime-boundary-execute` | HMAC strength is the host key's; key custody is the host's |
| Host authorization stays authoritative (V10) | `runtime-boundary-execute` | `authorize()` is a hook; the runtime cannot enforce a route it is not on |
| Crash before / after effect → known or unknown, reconciled, never blindly retried (V11) | `runtime-boundary-execute`, pilot A10–A12 | reconciliation needs the host's durable idempotency state |
| Concurrent appends, stale writer, duplicate op, torn write (V12) | `runtime-execution-store` | single process; multi-process fencing is the store adapter's |
| Streaming before final checks is refused at a boundary promising pre-release checks (V13) | pilot A7 | the boundary is the host's outbox; the runtime only makes the decided artifact the one with a handle |
| Injected tenant / policy text is data (V14) | `runtime-execution-observe`, pilot B3 | identity comes from the host context; nothing parses model output for identity |
| Secrets / PII in errors, exports (V15) | `runtime-core-minimize-measure`, `runtime-core-receipt`, pilot C1 | **shape-based**; `MINIMIZE_LIMITS` states it is never a complete privacy boundary |
| No cross-run / cross-tenant handle or approval reuse (V16) | `runtime-boundary-execute` | store-level tenant isolation is the adapter's |
| Packed tarball installs into a fresh consumer and runs (V25) | `runtime-external-consumer` | Node ≥ 20; no upgrade across major contracts has existed yet |
| This page matches the tested scope (V27) | `runtime-external-consumer` (claims audit block) | prose is audited for the listed phrases only |

## Compatibility policy

- The **contract strings** are the surface: `maddu.runtime.v1` (envelope),
  `maddu.canonical.v1` (encoding and digests, pinned by
  `scripts/test/__fixtures__/runtime-canonical-vectors.json`),
  `maddu.runtime.receipt.v1`, `maddu.runtime.decision.v1`,
  `maddu.runtime.minimize.v1`, `maddu.runtime.measure.v1`.
- Within a contract version, changes are **additive**: new event types only
  in the `app.*` namespace or with a contract bump, new optional fields,
  new digest domains, new exports. Existing digests, vectors and verifier
  verdicts do not change; the P2 verifier reads P3–P5 runs unchanged and
  the suites assert it.
- A **breaking** change bumps the contract string, adds a new fixture
  vector file, and keeps the old verifier able to read old runs.
- The package version (`version.json`, `package.json`) is Máddu's release
  number, not the contract version; the CHANGELOG names the contract when it
  moves.
- Supported runtime: Node ≥ 20, ESM only, stdlib only (`node:crypto`,
  `node:fs`, `node:path`). No runtime dependencies are added.
- `maddu/runtime` is the only supported specifier. `runtime/index.d.ts` is
  the typed surface; an export absent from it is internal.

## Threat-model delta

RFC §10 lists the threats the runtime adds to [34-threat-model.md](34-threat-model.md).
Their status after P5:

| Threat | Package | Rows | Status |
|---|---|---|---|
| Model or tool payload injects tenant ids, paths, policy instructions | P3 | V14 | tested (`runtime-execution-observe`, pilot B) |
| Decision handle forged, reused, replayed with changed scope | P4 | V08, V09 | tested (`runtime-decision-policy`, `runtime-boundary-execute`) |
| Action executes after a missing gate, a throwing gate, a swallowed append | P3, P4 | V06, V07 | tested |
| Whole-bundle replacement or tail drop on an unkeyed export | P2 | V05 | tested; **residual**: unsigned receipts are non-authoritative and say so |
| Cross-tenant reuse through cache, idempotency key, evidence lookup | P2, P4 | V16 | handle and approval binding tested; **residual**: store-level isolation is the adapter's |
| Crash between intent, effect and receipt duplicates the effect | P4 | V11 | tested with a simulated crash after the effect |
| Same-process concurrent appends, stale writer, torn write | P2 | V12 | tested in one process; multi-process fencing is the adapter's |
| Streaming leaks unverified content past a pre-release boundary | P5 | V13 | tested at the pilot's outbox |
| Public claims exceed tested deployment scope | P8 | V25, V27 | this page + `runtime-external-consumer` |
| A host administrator who controls process, credentials and store | none | — | documented residual: an in-process integration is a cooperation boundary, not an isolation boundary (§6.1) |

## Baseline measurements from the synthetic pilot

These are the numbers `measureRun()` produces for the pilot's three
scenarios, pinned by the suite. They are **counts of what the synthetic
evidence states**. No latency, accuracy, cost or savings figure is claimed;
none has been measured (RFC §14).

| Scenario | checks pass/fail/error | decisions allow / withhold / would-block / blocked / escalated | approvals | actions started / unknown / reconciled / unresolved | outputs delivered |
|---|---|---|---|---|---|
| A · happy path | 3 / 0 / 0 | 3 / 0 / 0 / 0 / 1 | 1 allowed | 1 / 1 / 1 / 0 | 1 |
| B · would-block | 1 / 2 / 0 | 1 / 1 / 1 / 1 / 1 | 1 allowed, decision still withheld | 0 / 0 / 0 / 0 | 0 |
| C · provider outage | 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 | — | 0 / 0 / 0 / 0 | 0 |

## What the README says, and why it says only that

The README's second entry path ("embed Máddu in an AI-powered product")
advertises: an opt-in subpath export, evidence with a tamper-detecting
chain, gates whose non-pass results can never read as pass, decisions
bound to the exact artifact, a portable unsigned receipt, and a synthetic
pilot. It does not advertise production storage guarantees beyond the
experimental file store, signed receipts, an economy, or any performance
figure. `runtime-external-consumer` reads this page and the README and
fails if either claims a mode the table above marks absent (V27).
