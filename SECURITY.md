# Security Policy

## Supported versions

Máddu is distributed from this repository and installed directly from `main`
(`npx github:frdyx/maddu init`, then `maddu upgrade`). **The supported version
is always the latest `main`** (currently v1.105.2). There is no separate
maintenance branch — fixes land on `main` and ship on the next tag.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue for a security report.

- **Preferred:** GitHub private vulnerability reporting — the **Report a
  vulnerability** button under this repository's **Security** tab.
- **Or email:** freddy@expstyle.se

Include the affected version or commit, reproduction steps, and the impact you
observed. You'll get an acknowledgement, and a fix or mitigation plan once the
report is triaged. Please allow a reasonable window to address the issue before
any public disclosure.

## Scope

Máddu's hard rules govern **the framework layer only** — Máddu's own code under
`.maddu/` and `maddu/` (the CLI, the bridge server, the cockpit). Reports about
that layer are in scope. Máddu does **not** govern the product you build *with*
it: your application's own dependencies, backend, and secrets are yours and out
of scope here — report those to the relevant project.

## Security posture (what the design guarantees)

Properties Máddu enforces by construction — useful context for what should and
shouldn't be possible:

- **Local-first, no cloud.** Máddu runs as a local Node process, calls no hosted
  backend, and emits no telemetry. Nothing leaves the machine unless you
  explicitly `export` or `spine sync` it.
- **Device-bound credentials.** OAuth tokens live in OS-appropriate,
  device-bound paths; `maddu export` scrubs them from portable bundles and
  `maddu import` refuses to overwrite them. There is no token-sync feature.
- **No provider SDKs in framework code.** The bridge and cockpit import no
  provider SDK; provider calls happen only inside spawned worker subprocesses,
  with credentials handed in at spawn time.
- **Secrets are not persisted to the record.** Every spine event's payload is
  redacted at the write boundary by one canonical detector (AWS, OpenAI,
  Anthropic, GitHub — classic + fine-grained + user/refresh, GitLab, Slack,
  Google, Stripe, PEM private-key blocks, and a high-entropy-adjacent fallback).
  The same detector scrubs tool argv, worker-spawn args, and the auxiliary state
  stores: the local mailbox / briefing / skill / wrapper-log stores, the
  checkpoint tag + index, the active-session pointer, schedules (repo + global),
  review archives, memory facts, MCP/runtime descriptors + health, the lane
  catalog, and the invocation-receipts telemetry corpus
  (`.maddu/state/invocation-receipts.ndjson` — additionally, the CLI never
  persists an unknown command's raw text or non-token-shaped arguments there). `maddu export` and `maddu spine sync` add a refuse-on-hit secret gate
  with **no skip flag** — a secret-shaped value blocks the operation rather than
  shipping. **Not auto-redacted (known limitation):** worker subprocess
  stdout/stderr **log files** are written by direct file descriptor (a stream), so
  a secret split across read boundaries can't be scrubbed by the record-level
  redactor — treat those logs as untrusted and rotate any credential a worker
  echoed. Redaction is best-effort at write time; a secret already in git history
  stays there.
- **Tamper-detecting record.** The event spine is append-only and hash-chained;
  `maddu spine verify` recomputes the chain and reports (never auto-repairs) any
  break. On a post-cutover (v1.98.0+, locked) chain an interior edit, deletion,
  insertion, or prev_hash-strip is a **FAIL**, not a warning. It is UNKEYED — it
  detects naive/accidental edits and partial interior tampering, not a determined
  local actor who recomputes the whole forward chain or truncates a contiguous
  tail (the OS's job). The event contract is published and versioned
  ([`docs/event-schema.json`](docs/event-schema.json)).

These protect the **record and the framework** — they do not sanitize the
*content* your agents produce, and redaction is applied at write time: a secret
committed to git history before redaction existed stays in that history. Rotate
the credential; don't rely on redaction after the fact.

## What the verification story does NOT guarantee

Máddu's gates, receipts, and drift signals are **cooperative accountability
inside the repository's existing authority boundary** — they surface
verification drift, they do not make it adversary-proof. An actor with write
access to the repository can modify the verifier, the baselines, and the local
event history under the same OS authority; Máddu's records cannot prove
themselves against that actor. No Máddu feature should be read as prevention,
independent attestation, or proof that a green result is meaningful.

The claim Máddu is entitled to is narrower and stated exactly: **Máddu can
reproduce an exact commit's declared verification in a clean checkout and
preserve the result as auditable evidence; it does not independently validate
the verifier that commit supplied.** The Claude Code permission rules this repo
ships are bypassable harness friction, not a security boundary.
