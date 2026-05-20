---
name: maddu-advise
description: Non-claiming advisor query — ask another runtime for a second opinion.
maddu-version-min: 0.18.0
---

The operator wants a second opinion: **$ARGUMENTS**.

Parse `$ARGUMENTS` as `<runtime> <prompt>` — first token is the
runtime (`claude`, `codex`, `gemini`, ...), the rest is the prompt
text.

Procedure:

1. Run `./maddu/run advise <runtime> "<prompt>"`. Capture the
   returned `advisorId` and `artifactPath`.
2. Read the prompt as-is and produce the response inline (you, the
   current agent, are the advisor when `<runtime>` matches your
   provider). For other runtimes: tell the operator the call must
   happen out-of-band — Máddu doesn't import provider SDKs (rule #5);
   the artifact stub is ready for them to paste a transcript into.
3. Append your response to the artifact file under the `## Response`
   header. Do not touch the header lines above it.
4. Surface the verdict in 3–5 lines max. End with a question or a
   recommendation, not just a summary.

Discipline:
- Advisors NEVER claim lanes (rule #8 companion enforced by the
  advisor-non-claiming gate). If you find yourself wanting to edit a
  file, stop — escalate to `/maddu-autopilot` instead.
- Tell the operator you picked `/maddu-advise`, which runtime you're
  consulting, and that the response is artifact-only.
