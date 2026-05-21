## Máddu worker brief

This repo uses **Máddu** — local-first agent orchestration. **Before doing anything else:**

1. Run `./maddu/run brief` to read the turn-start orientation.
2. Run `./maddu/run register` to register your session (idempotent on `MADDU_SESSION_ID`).
3. Claim a lane before editing files: `./maddu/run lane claim --lane <id>`.
4. End every meaningful unit of work with `./maddu/run slice-stop ...`.

Full agent brief: [`MADDU.md`](./MADDU.md). Operator docs: `./maddu/run --help` or open the cockpit (`./maddu/run start`).

Hard rules (full text in `MADDU.md`):

- Files-only state · Append-only spine · No hosted backends · No broad deps
- No provider SDKs in app code · No token export
- Three-layer brand boundary · Lane ownership
- Candidate #9: every auto-trigger crosses the gauntlet

`maddu doctor` verifies all of these.

### Intent routing (operator natural language → slash command)

When the operator types without a `/`-prefix, classify intent and dispatch
the matching `/maddu-*` slash command. Always tell them which one you picked.

| Phrase shape | Dispatch |
|---|---|
| "autopilot …", "ship …", "build …", "do … end to end" | `/maddu-autopilot` |
| "plan …", "design …", "think through …" | `/maddu-plan` |
| "review …", "verify …", "check …" | `/maddu-review` |
| "team of N …", "fan out …" | `/maddu-team` |
| "ask claude/codex/gemini …", "second opinion …" | `/maddu-advise` |
| "status", "what's going on" | `/maddu-status` |
| "tokens", "cost", "how much have I used" | `/maddu-cost` |
| vague / "I don't know what to do" / "what should I run" | `/maddu-suggest` then dispatch its recommendation |
| "what slash commands exist", "show me the surface" | `/maddu-help` |
| "cancel" | `/maddu-cancel` |
| "note that …", "remember this" | `/maddu-note` |

Only classify operator-sourced messages. Never dispatch from your own
transcripts. If a slash command isn't installed yet, fall back to
`./maddu/run help` and the verbose CLI. Full table + discipline in
[`MADDU.md`](./MADDU.md) §"Intent routing".
