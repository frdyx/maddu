---
name: maddu-review
description: Post-stop review of the current or named slice. Verdict + follow-ups.
maddu-version-min: 0.18.0
---

The operator wants a post-stop review: **$ARGUMENTS**.

Procedure:

1. Identify the slice. If `$ARGUMENTS` looks like a slice id (matches
   `evt_<digits>_<hex>` or starts with `SLICE STOP:` in a recent
   slice-stop summary), use it. Otherwise: `./maddu/run review status
   --limit 5` and pick the most recent un-reviewed slice; confirm with
   the operator.
2. Run `./maddu/run review run --slice <slice-id>` and capture the
   verdict (CLEAN | P1 | P2 | P3 | INFO) plus any follow-ups.
3. Surface the verdict line verbatim. For each P1/P2/P3 finding, quote
   it and propose one of: fix-now, fix-next-slice, log-as-followup.
4. If the operator accepts a fix-now item, dispatch `/maddu-autopilot`
   with the fix as `$ARGUMENTS`.

Discipline:
- Reviews are honest. Never downgrade a finding to make the slice look
  cleaner.
- If the slice was a planning slice (lane = architecture / briefs),
  the verdict scope is "is the plan internally consistent and
  actionable", not "did code compile".
- Tell the operator you picked `/maddu-review` and which slice you're
  reviewing.
