---
name: maddu-team
description: Open a team of N child sessions with disjoint lanes. Coordinate via the mailbox.
maddu-version-min: 0.18.0
---

The operator wants to fan out work into a team: **$ARGUMENTS**.

Parse `$ARGUMENTS` as `<N> <task>` — first token is the member count
(2 or 3 is the usual sweet spot), the rest is the shared task
description.

Procedure:

1. Ask `./maddu/run lane list` and pick `N` disjoint lanes that
   collectively cover the task. If you can't propose `N` non-overlapping
   lanes, surface the candidate list and ask the operator to pick.
2. Run `./maddu/run team open --members <N> --lanes <a,b,...>
   --label "$ARGUMENTS"`. Capture the returned team id.
3. For each lane, draft the per-member focus (one line each). Surface
   them as a numbered list.
4. Choose how the team executes — two modes:
   - **Máddu-spawned (tracked):** if a runtime descriptor exists
     (`./maddu/run runtime list`), run
     `./maddu/run team spawn --runtime <name> --task "$ARGUMENTS" --lanes "<a,b,...>"`.
     Máddu spawns a tracked worker per lane **concurrently** (full lifecycle:
     `TEAM_OPENED` → `TEAM_MEMBER_JOINED` → `WORKER_SPAWNED`/`WORKER_EXITED` →
     `TEAM_MEMBER_LEFT` → `TEAM_CLOSED`) — the cockpit shows a live team. Prefer
     this for true parallel fan-out visible to Máddu. (For sequential
     phase-by-phase work, `coordinator <plan-id> --runtime <name>` instead.)
   - **OAuth sub-agents (tracked via the session tree):** when YOU are an authed
     interactive session (Claude Code / Codex) and fan out via your own
     sub-agent/Task tool, those sub-agents inherit your OAuth — so prefer this
     over `team spawn` (which spawns headless subprocesses that can't reuse your
     OAuth). Make them tracked: tell each sub-agent to
     `export MADDU_PARENT_SESSION_ID=<your session id>`, run
     `./maddu/run register --parent <your session id>` (claims its lane), do its
     work, and `./maddu/run slice-stop "…"` when done. They then show up under
     you in `./maddu/run session tree`. This is the OAuth-correct way to spawn +
     track sub-workers.
   - **Manual fan-out:** each member opens `/maddu-autopilot <their focus>` in
     its own terminal session (same `--parent` registration applies for tracking).
   Cross-lane handoffs go through `./maddu/run mailbox send --lane <lane>
   --text "..."`. Never claim each other's lanes.
5. Close the team when work converges: `./maddu/run team close
   --team-id <id>` from the parent.

Discipline:
- Lanes MUST be disjoint pre-fact. The rule-8-team-lane-disjoint gate
  refuses overlaps; the command refuses them too. Don't fight the gate.
- Members can leave early via `TEAM_MEMBER_LEFT`; the team can close
  with stragglers — they'll appear in `openMembers` on the CLOSED
  event.
- Tell the operator you picked `/maddu-team` and which lanes you split
  the work into.
