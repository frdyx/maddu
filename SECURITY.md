# Security Policy

## Supported versions

Máddu is distributed from this repository and installed directly from `main`
(`npx github:frdyx/maddu init`, then `maddu upgrade`). **The supported version
is always the latest `main`** (currently v1.96.0). There is no separate
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
  redacted at the write boundary (as are tool argv, worker-spawn args, and the
  local mailbox / briefing / skill / wrapper-log stores). `maddu export` and
  `maddu spine sync` add a refuse-on-hit secret gate with **no skip flag** — a
  secret-shaped value blocks the operation rather than shipping.
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
