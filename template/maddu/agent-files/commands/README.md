# Máddu slash commands — template source

This directory is the framework's source of truth for the `/maddu-*` slash
commands installed into operator repos (40 commands as of v1.96.0).

Each `maddu-*.md` file is copied verbatim (RAW, no marker wrapping — a
marker comment above the frontmatter breaks Claude Code's parser, v0.19.1)
into both `.claude/commands/<name>.md` and `.codex/commands/<name>.md` by
`maddu init` / `maddu upgrade`. The whole file is framework-managed and
overwritten on upgrade — the `maddu-` prefix is the ownership boundary;
operator-authored slash commands without it are never touched. Drift is
reported by
the `slash-commands-installed` gate; verb reachability (every agent-facing
CLI verb has a slash or intent-routing on-ramp) is checked by
`maddu audit slash`.

Not every verb gets a 1:1 slash — that would recreate the sprawl the
no-learning-curve surface removed. Some slashes fan out to several verbs
(`/maddu-ralph`, `/maddu-plan-loop`, `/maddu-coordinate`), and some verbs
are reached by intent routing in `agent-files/MADDU.md` instead. See
`docs/22-slash-commands.md`.

This README itself is filtered out at install time (only `maddu-*.md`
files install — see `commands/_agent-files.mjs:listSlashCommandTemplates`).
