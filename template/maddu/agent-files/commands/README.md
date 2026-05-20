# Máddu slash commands — template source

This directory is the framework's source of truth for `/maddu-*` slash
commands installed into operator repos under `.claude/commands/` and
`.codex/commands/`.

- Phase 1 (v0.18): install mechanics in place; no commands ship yet.
- Phase 3 (v0.18): `/maddu-help.md` and `/maddu-doctor.md`.
- Phase 5 (v0.18): remaining 10 commands.

Each `*.md` file in this directory is copied verbatim into both
`.claude/commands/<name>.md` and `.codex/commands/<name>.md` by
`maddu init` / `maddu upgrade`, wrapped in `<!-- BEGIN MADDU v1 -->` /
`<!-- END MADDU v1 -->` markers. Operator-authored slash commands that
don't follow the `maddu-` prefix are never touched. Drift is reported by
the `slash-commands-installed` gate.

This README itself is filtered out at install time (only `maddu-*.md`
files install — see `commands/_agent-files.mjs:listSlashCommandTemplates`).
