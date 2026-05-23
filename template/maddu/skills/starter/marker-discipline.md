---
id: marker-discipline
tags: marker, agent-files, claude-md, agents-md
triggers: CLAUDE.md, AGENTS.md, MADDU.md, marker
---

# Marker discipline (agent files)

Three files at the repo root are partly framework-owned:
- `MADDU.md` — owned entirely by Máddu.
- `CLAUDE.md` — operator-authored outside the marker block; framework-authored between `<!-- BEGIN MADDU v1 -->` and `<!-- END MADDU v1 -->`.
- `AGENTS.md` — same marker discipline as CLAUDE.md.

Rules:
1. Never edit content between the markers — `maddu upgrade` overwrites it from the template.
2. Operator content lives OUTSIDE the markers (above or below).
3. Slash-command files under `.claude/commands/maddu-*.md` and `.codex/commands/maddu-*.md` are framework-owned in their entirety (NO markers; v0.19.1 fix). Don't edit them; edit the template instead.

If you need to override the framework section, talk to the operator first — there's usually a better path via a per-lane override file under `.maddu/`.
