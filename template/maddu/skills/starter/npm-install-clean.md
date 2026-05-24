---
id: npm-install-clean
tags: npm, install, dependencies, rule-4
triggers: npm install, dependency, add package
provenance: framework-starter-pack-v1.2.0
---

# npm install — clean form

Use `maddu install <package>` (v1.1.0 Phase 1) — the audited wrapper resolves npm/pnpm/yarn from lockfiles and refuses empty package lists (rule #4 — no broad new deps without explicit operator intent).

Before adding a dependency:
1. Confirm rule #4 — the framework forbids broad new deps. This wrapper is for *project* deps, not Máddu's own.
2. Check the lane allowlist (`.maddu/config/triggers.json` `tools.<lane>.deny`) — `install` may be denied for sensitive lanes.
3. Pass the exact package name; the wrapper does NOT pick for you.

If the wrapper refuses with `dangerous-form: install refused: at least one package name required`, ask the operator which package they meant.
