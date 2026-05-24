---
name: maddu-trust
description: Run the v1.2.0 supply-chain audit (freshness + pins + CVEs) and surface findings clearly.
maddu-version-min: 1.2.0
---

The operator wants a Máddu supply-chain audit (TeamPCP-style fresh-install attack window + pin drift + known CVEs).

**Output discipline (read carefully):**

1. Run `./maddu/run trust audit` via Bash. If `$ARGUMENTS` is non-empty, forward it (common: `--cve` for CVE inclusion, `--fresh` to bypass the 6h cache, `--json` for machine-readable output).
2. **After the bash call returns, re-print the audit's complete output inside a fenced markdown code block (` ``` `).** The operator's bash-output view collapses long output behind a `… +N lines (ctrl+o to expand)` affordance — the only way they actually see the per-dep verdicts is if you echo them back inside a code fence. Do not summarize, paraphrase, or omit rows.

Then add a short post-print synthesis (one paragraph max):

1. If the table shows no `BLOCK` / `DRIFT` rows, say so explicitly — e.g. *"Supply chain clean: N deps, no freshness blocks, no pin drift"*. Quote any `WARN` row verbatim.
2. If there are violations, list each with the package name and the actionable hint (pin drift → `maddu trust pin <pkg> --version <v>`; freshness block → review the package's npm page before re-installing).
3. For a Markdown report sharable with a security team, suggest `./maddu/run trust report`.

Discipline:

- Never claim a dep is safe that the audit reported `BLOCK` / `DRIFT` on.
- Don't attempt to pin or unpin inside this command — surface the finding and ask the operator first.
- If `.maddu/state/trust-cache.json` is missing, the first run populates it (slow); subsequent runs hit the cache (fast).
