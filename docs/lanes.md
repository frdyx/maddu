# Lanes

A **lane** is the unit of mutually-exclusive work in Máddu. Before an agent edits files, it claims a lane. While the lane is claimed, no other agent may edit the same area. Coordination across lanes happens through the mailbox bus, never through shared mutation.

## Default lanes

Installed on `maddu init`. Listed in `.maddu/lanes/catalog.json`. Each lane has an id and a one-line scope description. The default catalog is intentionally generic — edit it to match your project's actual surfaces.

| Lane id | Scope |
|---|---|
| `architecture` | Design, planning, architectural briefs. Reads everything; writes plans and roadmaps. |
| `frontend` | User-facing UI — components, styles, client-side logic. |
| `backend` | Server-side code, APIs, data layer. |
| `infra` | Build, deploy, CI, ops, configuration. |
| `tests` | Test code, fixtures, harnesses. |
| `docs` | Project documentation, READMEs, contributor guides. |
| `general` | Catch-all for changes that don't fit another lane. Use sparingly — split into a real lane when patterns emerge. |

Edit `.maddu/lanes/catalog.json` directly to add, remove, or rename lanes. `maddu upgrade` never touches operator-edited catalogs (only the seed at first `maddu init`).

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
