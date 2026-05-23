---
name: maddu-governance
description: Switch workspace governance tier (strict / standard / relaxed) or show current mode + effective gates. Hard rules immutable regardless of mode.
maddu-version-min: 1.1.0
---

The operator wants to inspect or change workspace governance.

**Output discipline:**

1. If `$ARGUMENTS` is empty or starts with `show`, run `./maddu/run governance show` via Bash.
2. Otherwise forward `./maddu/run governance $ARGUMENTS`.
3. Re-print the wrapper's complete output inside a fenced markdown code block.

Mode summary:

- `strict` — every operational gate active, approvals required, tighter loop caps + cooldowns.
- `standard` — default; most gates active, lighter approvals.
- `relaxed` — operational gates lifted (tool allowlist warn-only, no slice-stop required, fastest loop cooldowns). The 8+1 structural hard rules stay enforced.

Refusal handling:

- Switching to `relaxed` requires `--reason "<why>"`. Pass the operator's stated reason verbatim.
- Setting an override key not in the valid set is refused; surface the valid keys list from the error output and ask the operator which they meant.

Reminder: the 8+1 hard rules (files-only state, append-only spine, no hosted backend, no broad deps, no provider SDKs, device-bound tokens, three-layer brand boundary, lane ownership, auto-trigger gauntlet) are NEVER affected by mode. Only operational gates tune.
