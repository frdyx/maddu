# Upgrading

See [`upgrade-policy.md`](upgrade-policy.md).

## Notes for host projects

What a release changes for a project built on Máddu, when it changes anything
beyond Máddu's own files.

### v1.158.0

- **Worktree sessions record to the worktree's own spine.** A Claude Code
  session working in a git worktree that has its own `.maddu/` now registers,
  binds and counts discipline there, the same root its `maddu slice-stop`,
  `register` and `lane claim` use, even when the app fires hooks from the
  primary checkout. A slice-stop in the worktree clears the discipline block.
  Sessions that earlier sessions of this kind left in the primary spine close
  through the stale sweep as usual. A host tool that reads a worktree
  session's role or binding should read the worktree's
  `.maddu/state/` (`session.active.json`, `discipline/sessions.json`).
  The fix is in the hook runtime, which the desktop app runs from the primary
  checkout, so `maddu upgrade` there covers worktrees branched before it.
  The root follows the Claude session's binding, so changing directory
  mid-session does not move it; a new SessionStart leaves the Claude id bound
  in one root only.
- **`session close` prints what it closed** on every stdout. A script that
  relied on its silence when piped will now see one `closed <id> (<root>)`
  line.

### v1.157.0

- **Host gates can be tracked.** `maddu-state-untracked` counts `.maddu/gates/`
  as durable. To commit your gates there, add `!.maddu/gates/` to the Máddu
  block in `.gitignore`. A host that copied gates in from elsewhere so they
  wouldn't be tracked under `.maddu/` can track them in place instead.
  [20-governance.md](20-governance.md#tracking-host-gates-v11570)
- **A gate can refuse `plan new`.** Declare `phase: 'pre-plan'`; `plan new` runs
  it first, with `ctx.mode === 'plan'` and the plan about to be created in
  `ctx.plan`. A refusal exits 1, or 2 for `verdict: 'hold'`. Gates without a
  phase are unaffected, and a repo that declares none behaves as before, with
  one exception: a gate file that fails to import now also refuses `plan new`
  (it may have been a pre-plan gate). Upgrade the installed runtime too
  (`maddu upgrade`): a newer CLI over an older runtime refuses `plan new` while
  a phased gate exists. A wrapper around `plan new` that existed only to run
  such a check can go.
  [20-governance.md](20-governance.md#gates-that-refuse-a-command-phase-v11570)
- **`OPERATOR_FEEDBACK` is a spine event type** (contract 1.23.0):
  `{ kind, target?, verdict?, digest, tags? }`. Name the text by digest; don't
  put it in the event, since the spine doesn't stop you and can't forget it.
  A host that recorded feedback as `INBOX_MESSAGE` with its own `kind`
  can append this type instead. Earlier events stay as they are; a reader that
  wants both has to read both. [event-schema.md](event-schema.md)
- A gate file that fails to import now reports
  `could not load gate file <path>: <error>` instead of
  `gate threw: g.run is not a function`. Same `fail` status.
