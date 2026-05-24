# 35. Hermes adapter

Hermes Agent (Nous Research) is the first new runtime added under
Máddu v1.2.0's supply-chain trust discipline. It rides through every
v1.2.0 enforcement gate — worker-env allowlist, secret-scan argv,
tool allowlist, strict-mode approval — with zero special-case code in
the spawn path. That's the point of landing it here: Hermes is the
proof case that the discipline transfers cleanly to a new runtime.

## Install

Hermes ships as a separate CLI binary published by Nous Research.
Install it the standard way (Máddu does NOT bundle it, per rule #4):

```bash
# macOS / Linux (homebrew tap when available)
brew install nous-research/tap/hermes

# Or via the official installer script — review the script before running.
curl -sSL https://hermes.nousresearch.com/install.sh -o /tmp/hermes-install.sh
less /tmp/hermes-install.sh   # read it
bash /tmp/hermes-install.sh

# Verify
hermes --version
```

Máddu detects the binary via `hermes --version` returning exit 0. If
that's not what your Hermes install does, edit
`.maddu/runtimes/hermes.json` `detect.command`.

## Register with Máddu

```bash
# 1. Copy the template descriptor into your workspace.
cp maddu/runtimes/hermes.json .maddu/runtimes/hermes.json

# 2. Verify Máddu sees the binary.
maddu runtime detect hermes
# → ok=true if `hermes --version` exits 0 on PATH.

# 3. Confirm registration.
maddu runtime list
# → hermes  detect ✓
```

If `detect` reports `ok=false`, Hermes isn't on `PATH` from the shell
Máddu spawned from. Re-export `PATH` and retry. The wrapper is
deliberately strict (no version-string parsing) — exit code 0 is the
contract.

## Use

Three surfaces work out of the box, mirroring the other runtimes:

```bash
# 1. Direct spawn (rare; usually you let `team` / `pipeline` do this).
maddu runtime spawn hermes --lane backend --focus "..."

# 2. Non-claiming advisor query.
maddu advise hermes "review this design and flag risks"

# 3. Inside a team or pipeline that names hermes as its runtime.
maddu team open 3 "ship the feature" --runtime hermes
```

The advisor surface (`maddu advise`) is the typical "second opinion"
shape — Hermes runs in artifact-only mode, no lane claim, no
file writes. The artifact lands at
`.maddu/advisors/hermes-<ts>.md` and an `ADVISOR_INVOKED` /
`ADVISOR_ARTIFACT_WRITTEN` pair lands on the spine.

## Security posture (v1.2.0)

Every Hermes worker spawn passes through:

| Gate | What it does |
|---|---|
| `worker-env-allowlist` (P2) | Default-deny on `AWS_*`, `OPENAI_*`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_*`, `AZURE_*`, `GCP_*`, `STRIPE_*`. Hermes never sees those vars unless the operator opts in per-lane via `maddu trust env-allow`. |
| `secret-scan-argv` (P3) | Any prompt argv element matching a known-secret pattern → refused before spawn with `TOOL_REFUSED reason: 'secret-detected'`. |
| `tool-allowlist` (v1.1.0) | If `.maddu/config/triggers.json` restricts tools per lane, Hermes inherits the same gate. |
| `strict-mode-approval-active` (P5) | In `strict` governance mode, gated tool invocations require operator approval before proceeding. (`maddu install`, `maddu mcp install`, `maddu skill import`, `maddu lane claim --force`.) |

Hermes does NOT get a bypass for any of these. Adding a new runtime
under v1.2.0 means accepting the trust rails by construction.

## Token usage emission

`hermes-wrapper.mjs` parses Hermes's NDJSON stream output, looking for
assistant message frames with a `usage` block:

```json
{ "type": "message", "role": "assistant", "model": "hermes-3-llama-3.1-70b",
  "usage": { "prompt_tokens": 1234, "completion_tokens": 567,
             "cache_read_tokens": 0, "total_tokens": 1801 } }
```

The wrapper normalizes Hermes's `prompt_tokens` / `completion_tokens`
into the spine's `inputTokens` / `outputTokens` columns. Cockpit
`Cost` route aggregates by `runtime: 'hermes'`.

If a future Hermes version reshapes the frame, the splitter is
tolerant — non-JSON lines and missing keys degrade silently. Wrapper
errors land at
`.maddu/state/worker-logs/<workerId>.wrapper-errors.log` and never
block the operator's stdout.

## When Hermes is not installed

`maddu runtime detect hermes` returns `ok=false` with the failing
`detect.command`. The runtime stays registered but in an unhealthy
state; `maddu runtime spawn hermes` will refuse with the same error.

Install Hermes per the instructions above and re-run
`maddu runtime detect hermes`.

## Hard-rule notes

- **Rule #3 — no hosted backend.** Hermes worker runs locally as a
  subprocess. The wrapper script tees stdout, never proxies to a
  hosted service.
- **Rule #4 — no broad new deps.** `maddu mcp install hermes` does
  not modify `package.json`. The Hermes binary lives outside Máddu's
  managed file tree.
- **Rule #5 — no provider SDKs in framework code.** The wrapper runs
  inside the worker subprocess, never imported by framework code. The
  framework only sees the spawn descriptor.
- **Rule #6 — token discipline.** Workers default-deny on
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. Hermes's own auth (if
  any) is its concern — Máddu doesn't forward provider keys into it.
- **Rule #9 — trigger gauntlet.** Every Hermes spawn emits
  `WORKER_SPAWNED` + `WORKER_ENV_FILTERED` (with the denied env keys).
  In strict mode, also a paired `APPROVAL_REQUESTED` /
  `APPROVAL_DECIDED` before spawn.

See also: [`11-runtimes-and-mcp.md`](11-runtimes-and-mcp.md),
[`34-threat-model.md`](34-threat-model.md),
[`36-trust-audit.md`](36-trust-audit.md).
