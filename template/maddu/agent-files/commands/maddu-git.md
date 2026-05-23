---
name: maddu-git
description: Audited git wrapper. Refuses empty commit messages and `git push -f`. Emits TOOL_INVOKED/COMPLETED/REFUSED on the spine.
maddu-version-min: 1.1.0
---

The operator wants to run an audited git command through Máddu.

**Output discipline:**

1. Run `./maddu/run git $ARGUMENTS` via Bash. Forward `$ARGUMENTS` verbatim (do NOT reinterpret).
2. After the bash call returns, re-print the wrapper's complete output inside a fenced markdown code block. The operator's bash-output view collapses long output; the only way they see exit codes and refusal reasons is if you echo them back.

Refusal handling:

- If the output starts with `refused` (red), DO NOT retry with shell `git` directly. The wrapper refuses for a structural reason (e.g. empty commit message, `git push -f`). Explain the refusal to the operator and ask how they want to proceed.
- Acceptable resolutions for common refusals:
  - `dangerous-form: git commit refused: empty commit message` → ask the operator for the actual commit message, then re-run.
  - `dangerous-form: git push refused: use --force literally, not -f` → re-run with `--force` spelled out, or use `--force-with-lease` (safer; allowed).
  - `allowlist-deny` / `allowlist-not-allowed` → the current lane's allowlist blocks `git`. Ask the operator before changing `.maddu/config/triggers.json`.

Never bypass the wrapper by calling raw `git` for the same operation in the same turn.
