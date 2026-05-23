---
name: maddu-install
description: Audited dependency installer (npm/pnpm/yarn). Refuses empty package lists. Emits tool events on the spine.
maddu-version-min: 1.1.0
---

The operator wants to add a dependency via Máddu's audited installer.

**Output discipline:**

1. Run `./maddu/run install $ARGUMENTS` via Bash. `$ARGUMENTS` must contain at least one package name.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

Refusal handling:

- `dangerous-form: install refused: at least one package name required` → ask the operator which package they want; do NOT pick one.
- `allowlist-deny` / `allowlist-not-allowed` → the current lane's allowlist blocks `install`. Surface the lane id and the reason. DO NOT edit `.maddu/config/triggers.json` to bypass the deny — that's an operator decision.

Hard rule reminder: rule #4 forbids broad new framework deps. This wrapper is for *project* deps (the host repo's package.json), not Máddu's own.
