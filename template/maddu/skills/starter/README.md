# Starter skill pack

Eight SKILL.md-pattern work-discipline recipes seeded into `.maddu/skills/`
by `maddu init` **and backfilled by `maddu upgrade`** (write-if-missing —
a skill you edited or deleted while it still exists on disk is never
overwritten, only a missing one is restored; delete + upgrade restores it).

The `skills-starter-pack-installed` gate (warn-tier) reports which of the
eight are absent from `.maddu/skills/`. Skills are injected into agent
briefings on trigger/tag match — see `docs/10-skills-and-hindsight.md` and
`docs/24-skills-auto-inject.md`.

This README is directory documentation, not a skill: the seeder skips it
(`commands/_config-seed.mjs:seedStarterSkills`).
