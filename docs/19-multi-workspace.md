# Multi-workspace cockpit

*(v0.13.0)*

One bridge, every repo. Lifts Máddu from one-bridge-per-repo to a
machine-wide service that mounts N repos via a device-bound registry.
Each repo's `.maddu/` remains the sole source of truth for that repo —
the registry is just a pointer file on your machine.

## Mental model

- **Per-repo spine is still authoritative.** Every `.maddu/events/*.ndjson`
  is independent. No cross-repo spine. No shared database.
- **The registry is device-local pointers.**
  `~/.config/maddu/workspaces.json` (Linux/macOS) or
  `%APPDATA%\maddu\workspaces.json` (Windows). Never committed, never
  exported. Each entry may carry a reporting-only `role`: `project`
  (default), `fixture` (canary/test repo), or `archive` (reference repo).
- **One HTTP port, N repos.** `maddu start` reads the registry and
  mounts every entry. Each `/bridge/*` request carries an
  `X-Maddu-Workspace: <id>` header naming the target repo. Missing
  header falls back to the registry's `active` field.
- **`_all` is a special header value** for fan-out reads under
  `/bridge/_all/*`. Writes never use `_all` — every write has to land on
  exactly one spine.

## Workspace registry

### CLI

```bash
$ maddu workspace add <path> [--id <slug>] [--label "<label>"] [--role project|fixture|archive]
$ maddu workspace list
$ maddu workspace remove <id>
$ maddu workspace activate <id>
$ maddu workspace role <id> <project|fixture|archive>
$ maddu workspace show
```

`<path>` must contain a `.maddu/` directory — i.e. `maddu init` was run
there first. Ids must match `[a-z][a-z0-9-]{0,40}` and are unique per
machine. If `--id` is omitted, it is derived from the directory name.
Roles do not change routing or gate behavior; they make fleet reports
clearer.

### Example

```bash
$ maddu init                       # in ~/code/repo-a
$ cd ~/code/repo-b && maddu init   # in repo-b
$ maddu workspace add ~/code/repo-a
$ maddu workspace add ~/code/repo-b
$ maddu workspace list
WORKSPACES  (2)  registry: ~/.config/maddu/workspaces.json
  ● repo-a                 project  repo-a              ~/code/repo-a
    repo-b                 project  repo-b              ~/code/repo-b
$ maddu start
Máddu bridge v0.13.0 listening on http://127.0.0.1:4177
  workspaces: 2 mounted (registry: ~/.config/maddu/workspaces.json)
    ● repo-a   ~/code/repo-a
      repo-b   ~/code/repo-b
```

## Cockpit affordances

- **Rail switcher.** Dropdown above the nav. Persists in `localStorage`.
  Shown whenever ≥ 2 workspaces are registered; hidden in legacy
  single-repo mode.
- **`Ctrl+K`.** Every registered workspace surfaces as a "Switch to
  workspace: \<label\>" action.
- **"All workspaces" scope pill.** On Conductor, Dashboard, Approvals,
  Agents, and Queue Board. Toggles the view between the active
  workspace and an aggregate across every mounted workspace. In "All"
  mode, rows carry a small workspace badge.
- **Cross-workspace approval decisions.** In "All" mode the decision
  POST sets `X-Maddu-Workspace` to the row's origin workspace id, so
  the resulting `APPROVAL_DECIDED` event lands on the *origin* spine,
  not the active one.

## Global crons and policies

Machine-scope orchestration state — define once, fan out across N
workspaces. Files live next to the workspace registry:

```
~/.config/maddu/global/schedules.ndjson    (or %APPDATA%\maddu\global\schedules.ndjson)
~/.config/maddu/global/policies.json
```

### `maddu global cron`

```bash
$ maddu global cron add --natural "every morning at 8am" \
    --title "morning ping" \
    --action inbox --value "good morning" \
    --targets r1,r2          # comma-separated; omit = all mounted
$ maddu global cron list
$ maddu global cron show <id>
$ maddu global cron enable | disable <id>
$ maddu global cron remove <id>
```

`schedules.ndjson` is append-only with `{kind:"put", schedule:{…}}` and
`{kind:"remove", id}` records — same projection shape as the per-repo
`.maddu/schedule.ndjson`, with one added field, `targets: [workspaceId,
…]`. Omitted or empty `targets` means every mounted workspace at fire
time. Cron evaluation, natural-language parsing, and the
minute-deduplication gate are the same code path as per-repo schedules.

The bridge's existing 30 s scheduler interval calls `tickGlobal` after
the per-repo tick. Each fired schedule appends one action event per
target spine with a top-level `triggered_by` field (see below).

### `maddu global policy`

```bash
$ maddu global policy add --tool bash --decision deny           # any lane
$ maddu global policy add --tool * --decision allow-always --lane review
$ maddu global policy list
$ maddu global policy remove bash@*
```

`policies.json` is a flat JSON array of
`{id, tool, lane, decision, setAt, setBy}` rows. `decision ∈
{allow-always, deny}`. Wildcards in the composite id `tool@lane` work
as `*@*`, `tool@*`, `*@lane`, or exact.

`/bridge/approvals/request` consults global policies **only if no
per-repo policy matches** — per-repo wins. On a global match, the
bridge writes a real `APPROVAL_DECIDED` event into the target
workspace's spine with `actor: "global-policy"`,
`reason: "global-policy:<tool>@<lane|*>"`, and a `triggered_by`
field.

## `triggered_by` ancestry

`spine.append()` accepts an optional top-level `triggered_by` parameter
and serializes it straight into the NDJSON line. No new event type,
no projector change.

Every event written *because of* a global trigger carries:

```json
{
  "v": 1,
  "id": "evt_…",
  "ts": "2026-05-17T08:00:00.012Z",
  "type": "INBOX_MESSAGE",
  "actor": "global-scheduler",
  "lane": null,
  "data": { "message": "[global] good morning", "scheduleId": "gsch_…", "scope": "global" },
  "triggered_by": { "kind": "global_schedule", "id": "gsch_…", "fired_at": "2026-05-17T08:00:00.000Z" }
}
```

Why on the per-repo spine and not in a separate file? Because the
per-repo spine has to survive a projector rebuild on a different
machine that doesn't have your `~/.config/maddu/global/` files. The
event records its own cause and stays interpretable forever.

Events without `triggered_by` are byte-identical to v0.12.0.

## Hard rules

All nine invariants are preserved per workspace:

- **Files-only.** Per-repo `.maddu/` plus device-local
  `~/.config/maddu/{workspaces.json, global/}`. No SQLite anywhere.
- **Append-only spine.** Each workspace's spine is independent and
  append-only. The global `schedules.ndjson` uses the same put/remove
  projection — no destructive rewrites.
- **No hosted backend.** Everything is local.
- **No broad deps.** Node stdlib only.
- **No provider SDKs in app code.** Workers still own their APIs.
- **No token export.** Auth dir is untouched by this slice.
- **Three-layer brand boundary.** The cockpit chrome is unchanged.
- **Lane ownership.** Each workspace's lane catalog is independent;
  no cross-workspace lane claims.

## Day-2 operator flow

A typical morning across two workspaces:

```bash
$ maddu start &                  # bridge mounts both repo-a and repo-b
$ open http://127.0.0.1:4177     # cockpit
# In the rail, click the "repo-b" workspace.
# Approvals route shows repo-b's open approvals only.
# Click the "All workspaces" pill — see open approvals across both
# repos with workspace badges. Decide one — APPROVAL_DECIDED lands
# in that repo's spine.
$ maddu global cron add --natural "every morning at 8am" \
    --title "morning ping" --value "good morning"
# Next 8 a.m. tick: every mounted repo gets an INBOX_MESSAGE with
# triggered_by.kind = 'global_schedule' pointing at this cron.
$ maddu global policy add --tool bash --decision deny
# From now on, any APPROVAL_REQUESTED for tool=bash in any workspace
# (with no per-repo override) is auto-denied; the event lands on the
# origin spine with triggered_by.kind = 'global_policy'.
```

## Legacy compatibility

With no registry (or an empty one), the bridge falls back to walking
up from `cwd` for a single `.maddu/`. The rail switcher hides, the
scope pill hides, and behavior is identical to v0.12.0. All
`_global` endpoints still respond (with empty arrays) and the global
scheduler tick is a no-op.

## Verification

```bash
# Register two workspaces with real data in each.
$ maddu workspace add ~/code/repo-a
$ maddu workspace add ~/code/repo-b
$ maddu start &

# Curl each fan-out endpoint with the _all header:
$ curl -s -H 'X-Maddu-Workspace: _all' \
    http://127.0.0.1:4177/bridge/_all/projection \
    | jq '.activeSessions[] | {id, workspace_id}'

# Issue a global cron and watch ancestry:
$ maddu global cron add --natural "every minute" --title tick \
    --action inbox --value "global tick" --targets repo-a,repo-b
# wait 90 s
$ grep triggered_by ~/code/repo-a/.maddu/events/*.ndjson | tail -3
$ grep triggered_by ~/code/repo-b/.maddu/events/*.ndjson | tail -3

# Issue a global policy and confirm cascade:
$ maddu global policy add --tool bash --decision deny
$ curl -s -X POST -H 'content-type: application/json' \
    -H 'X-Maddu-Workspace: repo-a' \
    -d '{"tool":"bash","action":"rm -rf /tmp/foo"}' \
    http://127.0.0.1:4177/bridge/approvals/request
# → status:"decided", decision:"deny", autoDecided:true
$ grep APPROVAL_DECIDED ~/code/repo-a/.maddu/events/*.ndjson | tail -1
# → carries reason:"global-policy:bash@*" + triggered_by
```

## See also

- [03-cli-reference.md](03-cli-reference.md) — `maddu workspace`, `maddu global`.
- [05-bridge-endpoints.md](05-bridge-endpoints.md) — the `_workspaces`,
  `_all`, and `_global` route namespaces.
- [09-approvals-and-permissions.md](09-approvals-and-permissions.md) —
  per-repo approvals + standing policies (the per-repo half of the
  cascade).
- [06-hard-rules.md](06-hard-rules.md) — the nine invariants this
  slice was designed against.
