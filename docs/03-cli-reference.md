# CLI reference

Every `maddu` subcommand. Flags shown are read from the actual command sources under `commands/`.

The CLI is invoked via the `maddu` binary (installed by `maddu init` or via `npx github:frdyx/maddu <cmd>`).

## Conventions

- Flags use `--name value` or `--name=value`.
- Bare positional arguments come after the subcommand.
- Comma-separated lists are accepted where flags expect arrays.
- For `slice-stop --learnings` and `--next`, separators are **semicolons** (because entries often contain commas).
- Most write subcommands accept an optional `--by <id>` for the actor field.

## `maddu init`

Scaffold `.maddu/` and `maddu/` into the current directory.

```bash
$ maddu init [--force]
```

Refuses to run if `.maddu/` or `maddu/` already exists, unless `--force`. Writes `maddu.json` with the framework version and a SHA-256 manifest of every managed file, then appends a `FRAMEWORK_INSTALLED` event to the spine.

## `maddu upgrade`

Pull newer framework files in place. Never touches project state.

```bash
$ maddu upgrade [--force] [--dry-run]
```

- `--dry-run` — print the plan and stop.
- `--force` — overwrite locally-modified framework files (warns either way).

See [upgrade-policy.md](upgrade-policy.md).

## `maddu doctor`

Verify install integrity, hard rules, and port availability.

```bash
$ maddu doctor [--verbose] [--all] [--gate <id>] [--severity <critical|safety|warn>]
```

Reports PASS / WARN / FAIL per check. Appends a `DOCTOR_REPORT` event. Exits 1 on any FAIL.

If a workspace registry exists at `~/.config/maddu/workspaces.json`, doctor validates its shape unconditionally. By default per-rule checks run for the cwd repo. Pass `--all` to run every check for every registered workspace; check rows are prefixed with `[<workspace-id>]`.

**Gate runner *(v0.16+)*.** Doctor is a fan-out runner over `template/maddu/runtime/gates/builtin/*.mjs` (framework) plus `<repo>/.maddu/gates/*.mjs` (operator). Each gate emits a `GATE_RAN` event. `--gate <id>` runs only one gate (e.g. `--gate spine-integrity`). `--severity <level>` filters by severity. Operator gates with the same id as a built-in override the built-in. See [20-governance.md](20-governance.md#authoring-gates).

## `maddu start`

Boot the bridge server.

```bash
$ maddu start [--port 4177]
```

Default port: 4177. The bridge listens on `127.0.0.1` only.

If `~/.config/maddu/workspaces.json` exists, the bridge mounts every registered repo simultaneously and routes each HTTP request to the workspace named by the `X-Maddu-Workspace` header (falls back to the registry's `active` field). With no registry, the bridge falls back to walking up from `cwd` for a single `.maddu/` — existing single-repo installs work unchanged.

## `maddu workspace`

Manage the multi-workspace registry. Stored at `~/.config/maddu/workspaces.json` (Linux/macOS) or `%APPDATA%\maddu\workspaces.json` (Windows) — device-bound, never committed.

```bash
$ maddu workspace add <path> [--id <slug>] [--label "<label>"]
$ maddu workspace list
$ maddu workspace remove <id>
$ maddu workspace activate <id>
$ maddu workspace show
```

`<path>` must contain a `.maddu/` directory (i.e. `maddu init` was run there). Ids must match `[a-z][a-z0-9-]{0,40}` and are unique per machine. If `--id` is omitted, it is derived from the directory name.

The cockpit's left rail header shows a workspace switcher when more than one workspace is registered; selecting one re-renders every route against that workspace's data. `Ctrl+K` also surfaces a "Switch to workspace: …" entry per registered workspace.

## `maddu global`

Manage **machine-scope** crons and standing approval policies. Stored at `~/.config/maddu/global/{schedules.ndjson, policies.json}` (or `%APPDATA%\maddu\global\…` on Windows). The bridge picks up changes on its next 30 s scheduler tick (schedules) or the next `APPROVAL_REQUESTED` (policies) — no restart required.

```bash
$ maddu global cron add --natural "every minute" --title "tick" \
    [--cron "*/5 * * * *"] [--action inbox] [--value "…"] \
    [--targets r1,r2]         # comma-separated; omit = all mounted workspaces
    [--disabled]
$ maddu global cron list
$ maddu global cron show <id>
$ maddu global cron enable | disable <id>
$ maddu global cron remove <id>

$ maddu global policy add --tool <name|*> --decision <allow-always|deny> [--lane <id|*>]
$ maddu global policy list
$ maddu global policy remove <tool>@<lane|*>
```

Global schedules fan out across every target workspace. Each fired action appends an event into that workspace's spine with a top-level `triggered_by: { kind: 'global_schedule', id, fired_at }`. Global policies are consulted only if no per-repo policy matches; on match they write a real `APPROVAL_DECIDED` event with `reason: 'global-policy:<tool>@<lane|*>'` and a matching `triggered_by` field. Per-repo `.maddu/` remains the sole source of truth — the global files are device-local pointers.

See [19-multi-workspace.md](19-multi-workspace.md) for the full operator flow.

## `maddu status`

Print a state snapshot — repo root, spine event count, active sessions, lane claims, recent slice-stops.

```bash
$ maddu status
```

## `maddu session`

Register / start / heartbeat / close / list / active.

```bash
$ maddu session register --role <r> --label "<l>" --focus "<f>" [--runtime <name>]
$ maddu session start "<label>" [--role implementer] [--focus "<f>"] [--lane <id>] [--runtime <name>]
$ maddu session heartbeat [--session <id>] [--focus "<f>"] [--lane <id>]
$ maddu session close     [--session <id>] [--handoff "<h>"]
$ maddu session active
$ maddu session list
```

`register` prints the new `ses_...` id. `start` is a one-line shorthand that defaults `--role` to `implementer` and `--focus` to the label. `list` shows active sessions plus the last 10 closed.

**Active-session cache** *(v0.14+)*. `register` and `start` write the new id to `.maddu/state/session.active.json`. `heartbeat` and `close` consult that file when `--session` is omitted, so the typical flow is:

```bash
$ ./maddu/run session start "morning slice"
ses_...
$ ./maddu/run session heartbeat --focus "halfway"      # no --session flag
$ ./maddu/run session close --handoff "wrap"           # clears the cache
```

The cache is a *UX hint*, not source of truth — the spine is authoritative. If the cache points at a session that's already closed in the spine, the CLI clears the file and exits 3 with a helpful message. `maddu doctor` proactively WARNs on stale caches. If you run parallel shells against the same repo, pass `--session <id>` explicitly in each.

`active` prints the cached session id (or `(no active session)` + exit 1).

## `maddu lane`

Claim / release / list lanes.

```bash
$ maddu lane list
$ maddu lane claim --lane <id> --session <sid> [--focus "<f>"]
$ maddu lane release --lane <id> --session <sid>
```

`claim` exits 3 if the lane is already held by another session.

## `maddu slice-stop`

Append a structured slice-stop event. See [08-slice-stop-ritual.md](08-slice-stop-ritual.md).

```bash
$ maddu slice-stop --session <id> --summary "<s>" \
    [--lane <id>] [--action "<a>"] \
    [--targets "f1,f2"] [--paths "p1,p2"] [--gates "g1,g2"] \
    [--learnings "A;B;C"] [--next "X;Y"] \
    [--reason "<r>"]
```

Comma-separated for plain lists; semicolons for `--learnings` and `--next`. Auto-triggers hindsight extraction.

## `maddu approval`

Manage the approvals ledger.

```bash
$ maddu approval list
$ maddu approval respond --id <approvalId> --decision <allow-once|allow-always|deny|deny-always> [--reason "<r>"]
$ maddu approval policy --tool <name|*> [--lane <id>] --decision <allow-always|deny|clear>
$ maddu approval request --tool <name> [--lane <id>] --action "<a>" --summary "<s>" [--session <sid>]
$ maddu approval migrate-legacy-decisions [--dry-run]
```

`request` is mostly for testing — workers normally request approvals via the bridge. Auto-decides now write real `APPROVAL_DECIDED` events to the spine; `request` prints `auto-deny via policy` when a policy matches.

`migrate-legacy-decisions` *(v0.15+)* — append-only, idempotent. Scans for pre-v0.15 `APPROVAL_REQUESTED` events that were auto-decided by the projector (no paired spine event) and writes a real `APPROVAL_DECIDED` event for each, with `actor: 'policy-migrated'` and `triggered_by.kind: 'policy_migration'`. Refuses to run while the bridge is on port 4177. See [09-approvals-and-permissions.md](09-approvals-and-permissions.md).

## `maddu auth`

Multi-key OAuth / API-key store. Tokens never leave the device.

```bash
$ maddu auth where                                  # show storage path
$ maddu auth list                                   # providers + key counts
$ maddu auth keys <provider>                        # masked key list
$ maddu auth add <provider> [--value <v>] [--label "<l>"] [--value-file <path>]
$ maddu auth remove <provider> <keyId>
$ maddu auth rate-limit <provider> <keyId> [--minutes N]
$ maddu auth reveal <provider> <keyId> --confirm    # prints raw key (dangerous)
```

If `--value` is omitted on `add`, the value is read from stdin. See [12-auth-and-imports.md](12-auth-and-imports.md).

## `maddu checkpoint`

Git-backed checkpoints for "before risky slice" recovery. Requires git in the repo.

```bash
$ maddu checkpoint list [--lane <l>]
$ maddu checkpoint show <id>
$ maddu checkpoint create [--lane <l>] [--title "<t>"]
$ maddu checkpoint worktree <id>                    # git worktree add into .maddu/checkpoints/<id>/
$ maddu checkpoint rollback <id> [--mode softHead|hardHead|branch|inspect] [--apply]
$ maddu checkpoint remove <id>
```

`rollback` without `--apply` prints commands only.

## `maddu events`

Read the spine.

```bash
$ maddu events list [--after <evtId>] [--limit N] [--type <TYPE>]
$ maddu events tail [--bridge http://127.0.0.1:4177] [--type <TYPE>]
```

`list` reads the spine directly (offline). `tail` long-polls the bridge's `/bridge/events/wait` endpoint.

## `maddu import`

Secret-rejecting import gateway.

```bash
$ maddu import submit --kind <kind> --file <path>
$ maddu import scan --file <path>                   # dry-run; never dispatches
$ maddu import list                                 # recent accepts
$ maddu import rejections                           # recent rejects (paths only, never values)
```

Payloads containing key-shaped values are rejected whole. See [12-auth-and-imports.md](12-auth-and-imports.md).

## `maddu mailbox`

Per-lane mailbox bus.

```bash
$ maddu mailbox counts
$ maddu mailbox list <lane> [--body]
$ maddu mailbox send <lane> --subject "<s>" [--type note|info|request|handoff|question|ack] \
                            [--from <sid>] [--summary "<s>"] [--body "<b>"]
$ maddu mailbox read <lane> --id <msgId> [--session <sid>]
```

## `maddu mcp`

MCP server registry.

```bash
$ maddu mcp list
$ maddu mcp show <name>
$ maddu mcp register --name <n> --transport stdio --command <bin> [--args a,b] [--lanes a,b] \
                     [--display "<d>"] [--notes "<n>"]
$ maddu mcp register --name <n> --transport http --url <u>
$ maddu mcp register --name <n> --transport sse --url <u>
$ maddu mcp enable <name>
$ maddu mcp disable <name>
$ maddu mcp test [<name>]                           # no arg → test-all
$ maddu mcp remove <name>
$ maddu mcp visible <lane>                          # which servers a lane sees
```

## `maddu memory`

Hindsight memory facts (derived from slice-stops).

```bash
$ maddu memory list [--kind <rule|constraint|discovery|followup|touched|gate|summary>] [--limit N]
$ maddu memory search <query> [--kind <k>] [--limit N]
$ maddu memory extract [--rebuild]
```

`extract` (without `--rebuild`) catches up incremental extraction. `--rebuild` truncates and re-derives from the entire spine.

## `maddu runtime`

Pluggable subprocess runtimes.

```bash
$ maddu runtime list
$ maddu runtime show <name>
$ maddu runtime register --name <n> --binary <b> [--args a,b] [--detect "<cmd>"] \
                         [--display "<d>"] [--mcp] [--streaming] [--approval per-tool] \
                         [--lanes a,b] [--notes "<n>"]
$ maddu runtime detect [<name>]                     # no arg → detect-all
$ maddu runtime spawn <name> [--session <sid>] [--lane <id>] [--args a,b]
$ maddu runtime remove <name>
```

## `maddu schedule`

Natural-language → cron scheduler.

```bash
$ maddu schedule list
$ maddu schedule show <id>
$ maddu schedule create --natural "every evening at 6pm" --title "Daily summary" \
                        [--action-kind inbox|event] [--action-value "<v>"]
$ maddu schedule create --cron "0 18 * * *" --title "<t>"
$ maddu schedule parse "every weekday at 9am"       # preview cron
$ maddu schedule enable <id>
$ maddu schedule disable <id>
$ maddu schedule tick [--at <ISO>]                  # run one poller pass now
$ maddu schedule remove <id>
```

## `maddu spine`

Verify integrity of the append-only event spine, or look up a single event by id. Read-only — never mutates `.maddu/events/`.

```bash
$ maddu spine verify [--json]
$ maddu spine show <eventId>
```

`verify` walks every segment under `.maddu/events/` and runs the checks described in the *Verifiable, not just declared* paragraph of [hard-rules.md](hard-rules.md) — parseability, envelope shape, event-id uniqueness, id-format (with exemptions for well-known fixed-suffix events like `evt_…_init00`), timestamp monotonicity within each segment, schema-version consistency, segment continuity, and referential integrity (orphan `APPROVAL_DECIDED`, dangling `LANE_RELEASED`, unknown-session `SESSION_CLOSED`, etc.).

Exit code: `0` on a clean run or WARN-only run; `1` if any FAIL. `--json` emits the raw verifier result for tooling — useful in CI pipelines.

`show <eventId>` pretty-prints the matching event from the spine. Exit `0` on find, `1` on miss. Useful when `verify` flags an event id and you want to inspect it without piping NDJSON through `grep`.

`maddu doctor` calls into the verifier on every run, up to a 50k-event cap (configurable in the verifier's `maxEvents` option). Above the cap, doctor emits a `WARN` pointing at `maddu spine verify` for the full pass — keeps doctor fast on long-running repos without dropping the check entirely.

The verifier is strictly read-only. If it flags an issue, the operator decides remediation (manual edit + slice-stop, `maddu checkpoint rollback`, etc.). There is no `maddu spine repair` — and won't be, by design.

## `maddu search`

Cross-corpus search over the spine, slice-stops, memory, skills, mailbox, and inbox.

```bash
$ maddu search <query> [--kinds event,slice,memory,skill,mailbox,inbox] [--limit N]
```

## `maddu skill`

Reusable agent skills in SKILL.md format.

```bash
$ maddu skill list [--tag <t>]
$ maddu skill show <id>
$ maddu skill create --title "<t>" [--when "<w>"] [--tags a,b] [--body "<b>"]
$ maddu skill from-slice <eventId> [--title "<t>"] [--when "<w>"]
$ maddu skill apply <id> [--session <sid>]
$ maddu skill delete <id>
```

`from-slice` distills a SKILL.md draft from a `SLICE_STOP` event.

## `maddu task`

Dependency-aware task board.

```bash
$ maddu task list [--status <s>] [--lane <id>] [--owner <sid>]
$ maddu task show <id>
$ maddu task create --title "<t>" [--description "<d>"] [--lane <id>] [--owner <sid>] \
                    [--blocked-by id1,id2] [--tags a,b] [--status todo|in-progress|blocked]
$ maddu task update <id> [--title …] [--status …] [--owner …] [--lane …] \
                         [--add-blocker <id>] [--remove-blocker <id>] [--tags a,b]
$ maddu task complete <id> [--by <sid>]
```

Statuses: `todo`, `in-progress`, `blocked`, `done`, `cancelled`. Completing a task auto-surfaces unblocked dependents.

## `maddu goal` *(v0.16)*

Declare the agent's current objective. Latest `GOAL_DECLARED` wins in the projection and surfaces in `maddu brief` / `#orientation`.

```bash
$ maddu goal set --objective "<obj>" [--constraint "<c>" --constraint "<c>" …]
$ maddu goal show
```

## `maddu phase` *(v0.16)*

Declare the agent's current phase (a coarser-grained context than goal). Latest `PHASE_DECLARED` wins.

```bash
$ maddu phase set --name "<name>" [--notes "<notes>"]
$ maddu phase show
```

## `maddu brief` *(v0.16)*

Turn-start orientation digest. Writes deterministic projections to `.maddu/state/orientation.json` and `.maddu/state/handoff.md` (anchored to `lastEventId`, never `new Date()` — same spine → byte-identical files).

```bash
$ maddu brief                # pretty-print
$ maddu brief --json         # emit orientation JSON for machine consumption
$ maddu brief --drain        # also drain pending-actions queue (emits PENDING_ACTION_DRAINED)
```

Prints goal, phase, active session, last slice-stop, counters, and open follow-ups. Run at the start of every agent turn. See [20-governance.md](20-governance.md#turn-start-orientation).

## `maddu slice` *(v0.16)*

Optional slice scope-lock. Slices that don't declare scope behave unchanged; slices that do are enforced by the built-in `slice-scope` gate before `slice-stop` succeeds.

```bash
$ maddu slice scope-declare --paths a.js,b.js [--slice-id <id>] \
                            [--max-files N] [--max-growth-pct N]
$ maddu slice scope-expand  --paths c.js --reason "<why>" [--slice-id <id>]
$ maddu slice approve-functional [--slice-id <id>]
$ maddu slice show [--slice-id <id>]
```

Expansion bound defaults to `+5 files OR +30%`. After `approve-functional`, only doc-like paths (`docs/`, `README`, `CHANGELOG`, `.maddu/state/`, `.maddu/reviews/`) are accepted. See [20-governance.md](20-governance.md#slice-scope-lock-opt-in).

## `maddu sources` *(v0.16)*

Tracked SSOT files driven by `.maddu/config/tracked-sources.json`. `rebuild` snapshots current hashes onto the spine; the `tracked-source-drift` gate fails when any tracked file diverges from the recorded hash.

```bash
$ maddu sources rebuild      # emits SOURCE_HASH_RECOMPUTED { count, paths[] }
$ maddu sources status       # exits 1 on drift / unrecorded / missing
```

Config format:
```json
{ "schemaVersion": 1, "paths": ["docs/hard-rules.md", "CLAUDE.md"] }
```

See [20-governance.md](20-governance.md#tracked-sources).

## `maddu review` *(v0.16)*

Post-stop review lane. Runs a configured reviewer runtime (`kind: 'reviewer'`) against a sealed slice, parses output, archives a per-review markdown, emits `SLICE_REVIEWED`, and auto-opens `FOLLOWUP_OPENED` for non-clean verdicts.

```bash
$ maddu review run --slice <eventId> [--reviewer <name>]
$ maddu review status [--limit N]
$ maddu review list  [--limit N]      # alias for status
```

Reviewer arg substitution supports `${SLICE_EVENT_ID}` and `${REPO_ROOT}`; env injection: `MADDU_SLICE_EVENT_ID`, `MADDU_REPO_ROOT`. 10-minute wallclock timeout. Policy at `.maddu/config/review-policy.json` (`defaultReviewer`, `lanesRequiringReview`, `severityToFollowupMap`). Archive at `.maddu/reviews/<slice-event-id>.md` with YAML frontmatter. See [20-governance.md](20-governance.md#post-stop-review-lane).

## `maddu worker`

Subprocess worker registration.

```bash
$ maddu worker list
$ maddu worker register --session <sid> [--lane <id>] --command "<cmd>" [--pid N] [--args a,b]
$ maddu worker heartbeat <id> [--focus "<f>"] [--session <sid>]
$ maddu worker exit <id> [--code N]
$ maddu worker kill <id> [--reason "<r>"] [--by <sid>]
$ maddu worker show <id>
```

A worker silent for >15 s appears as `stuck` at read time — no event needed.
