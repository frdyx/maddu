# Agent-file merge skill

> **Copy this file to `.maddu/skills/agent-file-merge-skill.md` in any repo where you want agents to understand how `MADDU.md`, `CLAUDE.md`, and `AGENTS.md` at the repo root are maintained.**

## When to use

Use this skill when:

- You see `agent-file-current` failing in `maddu doctor` and need to understand the fix.
- You want to add operator content to `CLAUDE.md` or `AGENTS.md` without it getting overwritten by `maddu upgrade`.
- You're contributing to Máddu and need to extend the agent-file set (e.g. adding `GEMINI.md` or Cursor's `.cursorrules`).

## What it does

The v0.17 agent-native bootstrap (plan §7) ships three files at every consumer's repo root and refreshes them on `maddu upgrade`. The merge discipline preserves operator content via versioned HTML-comment markers.

| File | Ownership | Discipline |
|---|---|---|
| `MADDU.md` | Máddu (whole file) | `maddu upgrade` overwrites. Rename if you fork. |
| `CLAUDE.md` | Project (operator) + Máddu section between markers | `<!-- BEGIN MADDU v1 -->` / `<!-- END MADDU v1 -->` is Máddu-owned; everything else is yours. |
| `AGENTS.md` | Same as CLAUDE.md | Same marker pair. |

The three-rule discipline:

1. File missing → create with just the Máddu content.
2. File exists, markers present → replace BETWEEN markers only.
3. File exists, no markers → prepend the Máddu section + blank line; original content stays byte-identical below.

## Recipe

```bash
# 1. Check that the three files are in sync (`maddu doctor` runs this gate).
./maddu/run doctor | grep "agent files"

# 2. If drifted, refresh:
./maddu/run upgrade --force

# 3. Add project content to CLAUDE.md without losing it on upgrade:
#    Place it ABOVE the BEGIN marker or BELOW the END marker. Anything
#    between markers will be replaced on the next upgrade.

# 4. View what's emitted on the spine for each sync:
grep AGENT_FILE_SYNCED .maddu/events/*.ndjson
```

## Anatomy of the sync

`commands/_agent-files.mjs` exposes:

- `syncMaddu(repoRoot, canonical)` — whole-file owned `MADDU.md`.
- `syncMarkerFile(repoRoot, filename, sectionBody)` — marker-delimited.
- `syncAllAgentFiles(repoRoot, templates)` — drives all three.

Templates live at `template/maddu/agent-files/{MADDU.md,CLAUDE.section.md,AGENTS.section.md}` in the framework source and ride along into `<consumer>/maddu/agent-files/` via the framework-owned manifest. The `agent-file-current` gate hashes both ends and fails doctor on drift.

## Extending the pattern

To add a new agent file (e.g. `GEMINI.md`):

1. Author the canonical content at `template/maddu/agent-files/GEMINI.section.md`.
2. Add a call to `syncMarkerFile(repoRoot, 'GEMINI.md', templates.geminiSection)` in `syncAllAgentFiles`.
3. Extend `loadAgentFileTemplates` to read the new template.
4. Extend `agent-file-current.mjs` to hash-check the new file.
5. Bump the marker version (`v1` → `v2`) if the format changes incompatibly.

## Hard-rule check

- **Rule #4** (no broad deps): the helper is pure Node stdlib — no regex library, no markdown parser, no AST.
- **Rule #1** (files-only state): no DB, no projection writeback. The single side-effect is the three files at repo root + one `AGENT_FILE_SYNCED` event on the spine.
- **Marker discipline**: never writes outside `<!-- BEGIN MADDU v1 -->` / `<!-- END MADDU v1 -->`. Tested in scenarios A-D of the Phase 4 acceptance suite.
