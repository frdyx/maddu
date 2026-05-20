# Lanes

A **lane** is the unit of mutually-exclusive work in Máddu. Before an agent edits files, it claims a lane. While the lane is claimed, no other agent may edit the same area. Coordination across lanes happens through the mailbox bus, never through shared mutation.

## Default lanes

Installed on `maddu init`. Listed in `.maddu/lanes/catalog.json`. Each lane has an id, a one-line scope description, and a default set of file globs it owns.

| Lane id | Scope |
|---|---|
| `architecture` | High-level design, planning, architecture briefs. Reads everything, writes briefs and roadmaps. |
| `cockpit-shell` | The Máddu cockpit HTML, tokens, routes. Visual surface only — no business logic. |
| `bridge-server` | `maddu/runtime/server.js` and harness wiring around it. |
| `auth-providers` | OAuth flows, token paths, provider authentication. |
| `harness` | The Node-only scripts under `.maddu/harness/`. |
| `wiki` | The framework-default wiki pages under `.maddu/wiki/`. |
| `briefs` | Framework-default briefs under `.maddu/briefs/`. |
| `verification` | Verification reports, focused gates, doctor checks. |
| `guardrails` | The approval ledger and policies (lands in Phase A). |
| `observability` | The live event panel and search index (lands in Phase A/B). |
| `learning-patterns` | Hindsight extraction, the skill gallery, the pattern library (lands in Phase A/B). |
| `coordination` | The mailbox bus, the dependency-aware task board (lands in Phase B). |
| `search-retrieval` | The file-backed spine search index (lands in Phase B). |
| `runtime-integration` | The pluggable runtime-adapter contract (lands in Phase C). |
| `tools` | The MCP visual registry (lands in Phase C). |
| `ops-automation` | The NL→cron scheduler (lands in Phase C). |
| `git-integration` | The checkpoint timeline via git worktrees (lands in Phase C). |
| `shell` | The `/workbench` multi-pane shell (lands in Phase D). |
| `portability` | The export/import surface (lands in Phase D). |

## Claiming a lane

```bash
# Conceptual — actual CLI lands in Slice 3.
maddu lane claim <lane-id> --session <session-id> --focus "<one-line>"
```

A claim writes to `.maddu/lanes/claims.json`:

```json
{
  "schemaVersion": 1,
  "claims": [
    {
      "lane": "cockpit-shell",
      "session": "ses_2026...01",
      "focus": "Implement /approvals route",
      "claimedAt": "2026-05-14T12:34:56Z"
    }
  ]
}
```

`maddu doctor` and the bridge both refuse to start a new session on an already-claimed lane unless the prior claim is closed.

## Releasing a lane

A lane is released when the holding session closes or runs `maddu slice-stop`. Slice-stop appends a `LANE_RELEASED` event to the spine and removes the claim entry.

## Cross-lane coordination

If lane A needs lane B to do work, lane A appends a message to `.maddu/lanes/B/mailbox.ndjson`:

```json
{ "schemaVersion": 1, "from": "A", "to": "B", "type": "request", "subject": "...", "body": "...", "at": "2026-05-14T12:35:00Z" }
```

When the lane B owner picks up the message, it acknowledges by appending a `mailbox_read` event. There is no shared-file workaround — that would violate Rule #8.

## Adding a project-specific lane

Projects may add their own lanes under `.maddu/lanes/project/<lane-id>.json`. `maddu upgrade` will never overwrite or remove these. The framework-default lanes are owned by Máddu; project lanes are owned by the project.
