---
name: maddu-cancel
description: Stop the current slice cleanly — heartbeat-close + slice-stop.
maddu-version-min: 0.18.0
---

The operator wants to stop the current slice: **$ARGUMENTS**.

Procedure:

1. Identify the active session. Prefer `$MADDU_SESSION_ID` (env). If
   absent: `./maddu/run session list` and pick the one matching this
   shell/cwd; confirm with the operator if ambiguous.
2. Compose a slice-stop summary. Treat `$ARGUMENTS` as the reason. If
   empty, ask one question: *"Why are we stopping — done, blocked, or
   pivoting?"*
3. Run `./maddu/run slice-stop "SLICE STOP: <slice-id> cancelled —
   $ARGUMENTS. Action: stopped mid-slice. Targets: <files touched so
   far>. Gates: -. Learnings: - <what we learned, even from the
   cancellation>. Next actions: - <handoff or pickup note>. Reason:
   operator-cancel."`
4. Release the lane (if claimed): `./maddu/run lane release --lane
   <lane>`.
5. Close the session: `./maddu/run session close --session-id <id>
   --focus "cancelled: $ARGUMENTS"`.

Discipline:
- Cancellation is a clean close, not abandonment. Always emit
  slice-stop — hindsight needs the trail.
- If the operator wanted to bail entirely (not just stop the current
  slice), suggest `./maddu/run session close` for every active
  session, but don't run them without confirmation.
- Tell the operator you picked `/maddu-cancel` and surface the
  slice-stop summary you wrote.
