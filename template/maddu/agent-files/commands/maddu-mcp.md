---
name: maddu-mcp
description: List, install, or inspect MCP server templates (v1.1.0 tool gateway). Default-allowed catalog ships 5 templates.
maddu-version-min: 1.1.0
---

The operator wants to interact with the MCP tool gateway.

**Output discipline:**

1. If `$ARGUMENTS` starts with a verb (list, install, show, uninstall, templates, etc.), forward as `./maddu/run mcp $ARGUMENTS`. Otherwise default to `./maddu/run mcp templates list`.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

Common patterns:

- `templates list` — show the 5 curated templates (local-fs, local-search, calculator, git-advanced, time-and-date).
- `templates show <name>` — surface required binaries + hard-rule notes for a template.
- `install <template>` — checks required binaries (via `which`/`where`), **verifies the template's SHA256 provenance hash (v1.2.0)**, scaffolds companion files into `.maddu/mcp/<template>/`, registers the descriptor as `provenance: framework-shipped` + approved. Refuses with `MCP_PROVENANCE_MISMATCH` if the template was tampered with.
- `register --name <n> …` — operator-registered MCP. Tags `provenance: operator-trusted` and is **disabled until `maddu mcp approve <name>`** (v1.2.0). Pass `--approve` to skip the explicit approval step.
- `approve <name>` — flips an operator-trusted MCP to approved + enabled. Lands an `MCP_APPROVAL_GRANTED` spine event.
- `uninstall <name>` — removes the registration. Companion files under `.maddu/mcp/<name>/` are left alone for the operator to inspect.

Hard-rule reminder: templates are JSON descriptors only — none of them adds an entry to `package.json`. If a template requires an external binary (npx, curl, git), it lists that in `requires` and the install refuses cleanly when missing. Tampered or mis-hashed templates refuse install with `MCP_PROVENANCE_MISMATCH`.
