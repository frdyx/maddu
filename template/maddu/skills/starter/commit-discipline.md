---
id: commit-discipline
tags: git, commit, audit
triggers: commit, message, git commit
provenance: framework-starter-pack-v1.2.0
---

# Commit discipline

Use `maddu git commit -m "<message>"` (v1.1.0 Phase 1) — never plain `git commit -m ""`.

The audited wrapper refuses empty messages and emits `TOOL_INVOKED` / `TOOL_COMPLETED` / `TOOL_REFUSED` on the spine, so every commit is replayable in `maddu log`.

When framing the message:
- Subject line ≤ 70 chars.
- Body explains the *why*, not the *what*.
- Trailer: `Co-Authored-By: ...` when an agent contributed.

If the wrapper refuses with `dangerous-form: empty commit message`, surface the actual error to the operator; do not retry with a placeholder.
