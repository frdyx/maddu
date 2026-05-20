# Review-lane skill

> **Copy this file to `.maddu/skills/review-lane-skill.md` to give agents a stable recipe for wiring a post-stop reviewer.**

## When to use

When the repo cares about catching the **semantic** regressions structural gates miss — refactors that ship but break edge cases, fixes that re-introduce known anti-patterns, surface drift that humans see but `git diff` doesn't flag. A reviewer runtime examines each slice after `SLICE_STOP` and emits a verdict.

## Architecture (one-line)

```
SLICE_STOP → reviewer runtime (kind:'reviewer') → stdout (JSON or YAML/MD)
           → SLICE_REVIEWED event → optional FOLLOWUP_OPENED → orientation digest
```

## Setup recipe

```bash
# 1. Author or install a reviewer (a small program / wrapper)
mkdir -p tools
cat > tools/review.mjs <<'EOF'
const sliceEventId = process.argv.includes('--event') ? process.argv[process.argv.indexOf('--event') + 1] : null;
// ... read .maddu/events to find the slice ...
// ... emit JSON to stdout:
process.stdout.write(JSON.stringify({
  verdict: 'CLEAN',     // or P1 / P2 / P3 / INFO
  findings: [],          // [{ severity, location, message }, …]
  body: '# free-form markdown',
}));
EOF

# 2. Register the runtime
maddu runtime register --name local-reviewer --binary node \
  --args 'tools/review.mjs,--event,${SLICE_EVENT_ID}'

# 3. Mark its kind as 'reviewer'
#    (edit .maddu/runtimes/local-reviewer.json: "kind": "reviewer")

# 4. Set the routing policy
mkdir -p .maddu/config
cat > .maddu/config/review-policy.json <<'EOF'
{ "schemaVersion": 1,
  "defaultReviewer": "local-reviewer",
  "lanesRequiringReview": ["*"],
  "severityToFollowupMap": {
    "CLEAN": null, "P1": "P1", "P2": "P2", "P3": "P3", "INFO": null
  } }
EOF

# 5. Run it
maddu review run --slice <slice-event-id>
maddu review status
```

## Reviewer output formats

JSON:

```json
{ "verdict": "P2",
  "findings": [
    { "severity": "P2", "location": "src/x.ts:42",
      "message": "cookie path drops domain — same regression as evt_abc" }
  ],
  "body": "# Optional markdown body" }
```

YAML-frontmatter markdown:

```markdown
---
verdict: P2
findings: 3
---

# Body of the review …
```

The parser normalizes both to `{ verdict, findings, body }`. Verdicts outside `CLEAN | P1 | P2 | P3 | INFO` are coerced to `INFO`.

## What a good reviewer looks like

- **Reads, never writes.** A reviewer that mutates state breaks the audit trail.
- **Findings are actionable.** Each finding has a location (path:line) and a message that explains the *why*.
- **Verdict reflects severity, not effort.** P1 means "this ships now and breaks things"; INFO means "noted for future me."
- **Deterministic given the slice.** Same slice → same verdict. Random sampling, race conditions, network calls all violate this.
- **Bounded.** 10-minute timeout is enforced by the framework. Reviewers should target <60s.

## Acting on verdicts

| Verdict | What the framework does | What the agent should do |
|---|---|---|
| CLEAN | No follow-up emitted | Move on |
| INFO | No follow-up emitted | Read the body; surface to operator if relevant |
| P3 | `FOLLOWUP_OPENED severity=P3` | Address before next slice, or escalate |
| P2 | `FOLLOWUP_OPENED severity=P2` | Address in next slice |
| P1 | `FOLLOWUP_OPENED severity=P1` | Stop. Address immediately. |

Follow-ups surface in `maddu brief` and on the cockpit's `/orientation` and `/reviews` routes.

## Anti-patterns

- A reviewer that talks to a hosted API (hard rule #3 says provider calls happen in spawned runtime subprocesses — the reviewer IS a subprocess, so it may, but be intentional about which provider, which model, which auth).
- A reviewer that always returns CLEAN. Worse than no reviewer.
- A reviewer that triggers on every slice but never raises a finding. Either calibrate severity or narrow the routing policy.
- Editing `.maddu/reviews/*.md` by hand. The bridge re-writes them.
