# 24. Skills auto-injection

Máddu's skill gallery lives at `.maddu/skills/*.md` — one Markdown file per skill, with a small YAML-style frontmatter block at the top. v0.19 adds **automatic injection**: when an agent runs `maddu brief --for-agent`, matching skill bodies are appended to the orientation digest under a clearly-marked section. The agent reads the right context without anyone typing `/maddu-skill list`.

## Frontmatter shape

```markdown
---
id: skl_my_skill
title: How to add a new event type
when: Apply when extending the event vocabulary
triggers: ["event", "spine", "new-type"]
tags: ["spine", "backbone"]
updated: 2026-05-21T10:00:00Z
---
# Body markdown follows
```

`triggers` and `tags` are **optional arrays of strings**. Skills without either field are still listable via `maddu skill list` — they just won't be auto-injected.

- **`triggers`** describes the intent shapes that should pull this skill in. Think of them as natural-language hints: `"autopilot"`, `"new-runtime"`, `"approval-policy"`.
- **`tags`** describes the area or surface. Think of them as topic labels: `"spine"`, `"approvals"`, `"runtime"`.

The matcher ranks by trigger hits → tag hits → `updated` DESC (recency tiebreak). At most **3 skills** are injected per orientation, capped at **8 KB per skill body** (24 KB total).

## How to invoke

The default invocation, used by the v0.18 slash commands' bootstrap rituals:

```bash
maddu brief --for-agent --triggers autopilot --tags auth,login
```

`--triggers` and `--tags` accept comma-separated lists. The agent (or the slash command) fills them in based on what the operator typed. The orientation digest then includes:

```
## Skills injected for this slice (2)

### skl_signing_in — How to sign in to a provider
…body…

### skl_login_lane — Login lane checklist
…body…
```

The active session's `focus` is auto-folded into tags (split on `\W+`, words >2 chars). Active lane claims fold into both triggers (`lane:<id>`) and tags (`<id>`). So even a bare `maddu brief --for-agent` will inject relevant skills when a session + lane are active.

## --dry-run

```bash
maddu brief --for-agent --triggers demo --dry-run
```

Renders the digest with skills attached but does **not** write `SKILL_INJECTED` to the spine. Useful for previewing what a real run would inject.

## The `SKILL_INJECTED` event

Every non-dry-run call that injects ≥1 skill appends one event:

```json
{
  "v": 1,
  "id": "evt_…",
  "ts": "…",
  "type": "SKILL_INJECTED",
  "actor": "ses_…",
  "data": {
    "sessionId": "ses_…",
    "triggers": ["autopilot", "lane:login"],
    "tags": ["auth", "login"],
    "skillIds": ["skl_signing_in", "skl_login_lane"],
    "totalBytes": 4321
  }
}
```

The projection's `skillInjections` slot keeps the last 200 events for cockpit display.

## The `skill-injection-bounded` gate

Severity: **critical**. Verifies every `SKILL_INJECTED` event in the spine:

- `skillIds.length ≤ 3`
- `totalBytes ≤ 24576` (3 × 8 KB)
- every referenced skillId resolves to a real `.maddu/skills/<id>.md` file on disk

A skill renamed or deleted after it was injected fails the gate until the operator either restores the file or accepts the drift via a manual edit. The gate is the contract that keeps auto-injection trustworthy.

## Text-only by construction

Skills are read and appended verbatim. Máddu does **not** parse macros, run shell commands, or otherwise execute skill content. If a skill body contains code blocks the agent will read them like any other context — the framework treats them as inert markdown.

This is deliberate. Auto-execution would shift skills from "shared recipes" to "implicit auto-runs", which would silently mutate the workspace without an operator's signature on every change. Hard rule #2 (append-only spine) wins.

## See also

- [10. Skills and hindsight](10-skills-and-hindsight.md) — how skills are authored and how the hindsight extractor proposes them from slice-stops.
- [25. Model routing](25-model-routing.md) — sister deferred-feature ship that also reads from descriptors / lanes / pipeline stages.
