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
