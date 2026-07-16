# CLI reference

Every `maddu` subcommand. Flags shown are read from the actual command sources under `commands/`.

The CLI is invoked via the `maddu` binary (installed by `maddu init` or via `npx github:frdyx/maddu <cmd>`).

## Conventions

- Flags use `--name value` or `--name=value`.
- Bare positional arguments come after the subcommand.
- Comma-separated lists are accepted where flags expect arrays.
- For `slice-stop --learnings` and `--next`, separators are **semicolons** (because entries often contain commas).
- Most write subcommands accept an optional `--by <id>` for the actor field.
- *(v1.1.1)* `--help` / `-h` is detected at the dispatcher before any flag validation. `maddu <verb> --help` always returns help text — never `--<flag> required` errors. Verbs with bespoke usage (start, stop, workspace, plan, lane, install) print their own; others fall back to the global discovery surface (`maddu help`).

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

**Activation funnel *(v1.102.0)*.** After the summary, doctor prints the repo's activation stage — the lifetime furthest step reached on the ritual path `installed → healthy → session → claimed → slice → repeating` (≥3 slice-stops) — plus the ONE next action for any repo not yet repeating. Derived read-only from the spine; passive gate/doctor traffic and imported backfill never count as adoption; the funnel never decays. `maddu fleet` shows the same stage as a column across every registered workspace.

## `maddu start`

Boot the bridge server.

```bash
$ maddu start [--port 4177]
```

Default port: 4177. The bridge listens on `127.0.0.1` only.

If `~/.config/maddu/workspaces.json` exists, the bridge mounts every registered repo simultaneously and routes each HTTP request to the workspace named by the `X-Maddu-Workspace` header (falls back to the registry's `active` field). With no registry, the bridge falls back to walking up from `cwd` for a single `.maddu/` — existing single-repo installs work unchanged.

**v1.1.1:** `maddu start` writes `.maddu/state/bridge.pid` on boot (so `maddu stop` can find the process) and installs SIGINT/SIGTERM handlers — Ctrl+C in the foreground terminal cleanly terminates the bridge instead of leaving a detached node process.

## `maddu stop`

Terminate the running bridge server. *(v1.1.1)*

```bash
$ maddu stop
```

Reads `.maddu/state/bridge.pid` and sends SIGTERM (then SIGKILL after a 3 s grace period). If the PID file is missing or stale, probes port 4177 — if a bridge responds but no PID file is known, prints an actionable hint for terminating it manually (`Get-NetTCPConnection` on Windows, `lsof | xargs kill` elsewhere). Exit 0 on success (or no-bridge-running), 1 if a bridge is detected but cannot be killed.

## `maddu workspace`

Manage the multi-workspace registry. Stored at `~/.config/maddu/workspaces.json` (Linux/macOS) or `%APPDATA%\maddu\workspaces.json` (Windows) — device-bound, never committed.

```bash
$ maddu workspace add <path> [--id <slug>] [--label "<label>"] [--role project|fixture|archive]
$ maddu workspace list
$ maddu workspace remove <id>
$ maddu workspace activate <id>
$ maddu workspace role <id> <project|fixture|archive>
$ maddu workspace show
```

`<path>` must contain a `.maddu/` directory (i.e. `maddu init` was run there). Ids must match `[a-z][a-z0-9-]{0,40}` and are unique per machine. If `--id` is omitted, it is derived from the directory name. `--role` defaults to `project`; use `fixture` for canary/test repos and `archive` for reference repos. Roles affect reporting only.

**v1.1.1:** `maddu workspace activate <id>` POSTs to the running bridge at `/bridge/_workspaces/activate` so its in-memory active pointer follows the registry update — no more silent mis-routing after a swap. If the requested workspace was added *after* `maddu start` (and is therefore not yet mounted), the CLI prints a loud warning with the exact `maddu stop && maddu start` restart command. No bridge running ⇒ silent.

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
$ maddu status --line     # one-line on-goal/drift + goal progress (v1.97.0) — wire into a status line via `maddu hooks --statusline`
```

`--line` emits a single glanceable segment (e.g. `maddu · on goal +1.00 · goal 4/4`) for the [Operator Plane](53-operator-plane.md) — reading the CLI-cached success-eval, never re-running it.

## `maddu register` *(v0.17)*

Zero-keystroke session bootstrap. The agent's mandatory first command of every turn.

```bash
$ maddu register [<label>] [--parent <sessionId>] [--role <role>] [--runtime <name>]
```

- Defaults: label from cwd-basename, role=`implementer`, focus=label.
- **Idempotent**: if `MADDU_SESSION_ID` is set in env AND that session is still open in the projection, returns the cached id with `(already registered)` — no duplicate event.
- Stale env (closed session) → registers a fresh session anyway.
- Emits `SESSION_AUTO_REGISTERED` with `source: 'cli'`.
- Writes the new id to `.maddu/state/session.active.json` (same cache as `session start`).
- Prints an `export MADDU_SESSION_ID=<id>` hint on first registration; agents that source the hint get free idempotency on later calls.

For deeper init flows (multi-role, explicit focus, runtime binding) use `maddu session register` below.

## `maddu session`

Register / start / heartbeat / close / list / active / tree.

```bash
$ maddu session register --role <r> --label "<l>" --focus "<f>" [--runtime <name>] [--parent <sessionId>]
$ maddu session start "<label>" [--role implementer] [--focus "<f>"] [--lane <id>] [--runtime <name>]
$ maddu session heartbeat [--session <id>] [--focus "<f>"] [--lane <id>]
$ maddu session close     [--session <id>] [--handoff "<h>"]
$ maddu session active
$ maddu session list
$ maddu session tree      [--root <sessionId>]            # v0.17: ASCII parent → children tree
```

`register` prints the new `ses_...` id. `start` is a one-line shorthand that defaults `--role` to `implementer` and `--focus` to the label. `list` shows active sessions plus the last 10 closed. `tree` *(v0.17)* renders the `sessionsTree` projection — parent sessions with their auto-registered children inline, useful for fan-out orchestration.

`--parent <sessionId>` *(v0.17)* — set the parent reference for tree provenance. Also passable via `MADDU_PARENT_SESSION_ID` env. verify-spine rejects orphan parent references.

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

Each stop also records two deterministic, WARN-only checks on the event (printed, never blocking): a **risk** level (`none`→`critical`, classified from the touched paths — auth/secret/token/schema/migration or a broad change rank highest) and a **deliverables** check (each `--targets` file that neither exists on disk nor shows in git is flagged as a hollow deliverable). A high/critical-risk slice escalates the post-stop auto-review past its cooldown. *(v1.17.0)*

## `maddu debt`

Ledger of deliberate-shortcut markers across the source tree. Read-only.

```bash
$ maddu debt [list] [--json] [--no-write] [--repo <dir>]
```

Scans for markers of the shape `maddu-debt: <what>. ceiling: <limit>. upgrade: <trigger>.` and renders them grouped by file. A marker with **no `upgrade:` trigger** is flagged `[no-trigger]` — the shortcut nobody recorded a reason to revisit. Writes a derived cache to `.maddu/state/debt-ledger.json` (suppress with `--no-write`) and appends one `DEBT_SCANNED` event. The number to drive toward zero is the no-trigger count. *(v1.17.0)*

## `maddu architecture`

Declared architecture **contract** vs the real code import graph → **drift**. See [40-architecture-drift.md](40-architecture-drift.md).

```bash
$ maddu architecture init        # scaffold .maddu/config/architecture.json from detected dirs
$ maddu architecture [scan]      # report drift (forbidden edges, cycles, undeclared areas) + write graph.json
$ maddu architecture diagram     # write the mermaid diagram (.maddu/state/architecture/diagram.mmd)
$ maddu architecture baseline    # accept current violations (the ratchet)
$ maddu architecture mass        # report monoliths (> maxLines) + duplicate code files
$ maddu architecture mass --baseline   # record today's monoliths as the shrink-only floor
  [--repo <dir>] [--fail-on none|new|any] [--json] [--force]
```

`scan` records an `ARCHITECTURE_SCANNED` event with a `driftScore`. The `architecture-drift` gate (run by `doctor`/`audit`) and the `scan` exit code honor `options.failOn`: `none` warns + ratchets (default), `new` fails only on violations not in the baseline, `any` fails on all. Adoption: `init → edit → scan → baseline → failOn:"new"`. *(v1.18.0)* — `mass` adds a structural-mass dimension (monolith + duplicate-file detection) with its own shrink-only baseline, enforced by the `architecture-mass` gate; see [40-architecture-drift.md](40-architecture-drift.md) §"Structural mass". *(v1.26.0)*

## `maddu focus`

The **Focus Director** — an opt-in, domain-blind instrument that tags each turn `toward`/`lateral`/`away` of the declared goal and flags **sustained** drift (a `swap`/`revert`/`continue` choice, never a gate). Off by default; deterministic (no LLM) per-turn tag, with an optional cheap-worker flag narrative.

```bash
$ maddu focus [status]                        # trajectory (last tag + window) + any open flag
$ maddu focus enable                          # opt IN — allowlist the heartbeat + slice-stop triggers
$ maddu focus disable                         # opt OUT
$ maddu focus resolve <swap|revert|continue>  # answer an open drift flag
```

Once enabled, every `session heartbeat` (and each `slice-stop`, as a floor) appends a deterministic `FOCUS_TAGGED`; a run of off-axis turns with no return emits one `DRIFT_FLAGGED` (cooldown-guarded) and surfaces it to the mailbox. The tag is goal-**relative** — with no declared goal it stays silent. Crosses the rule-#9 gauntlet; its event types are registered dormant-by-design so an un-enabled install reads them as dormant, not dead.

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
                         [--lanes a,b] [--notes "<n>"] [--auto-register]
$ maddu runtime detect [<name>]                     # no arg → detect-all
$ maddu runtime spawn <name> [--session <sid>] [--lane <id>] [--args a,b]
$ maddu runtime remove <name>
```

**`--auto-register`** *(v0.17)* sets `kind: 'reviewer'`-style behavior: every `spawnWorker` call against this runtime first registers a fresh child session (linked to the caller via `parentSessionId`), then injects the new id into the child's `MADDU_SESSION_ID` env. Fan-out orchestration produces N distinct sessions in the tree instead of one shared session. Editable post-register by hand-editing `.maddu/runtimes/<name>.json` and setting `autoRegister: true`.

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

Verify integrity of the append-only event spine, look up a single event by id, or (opt-in) share the spine with teammates through the repo's git remote.

```bash
$ maddu spine verify [--json]
$ maddu spine show <eventId>
$ maddu spine oversight [--json]    # non-technical readout: skills fed/withheld + why, on-goal, record-intact (v1.97.0 — see 52-oversight.md)
$ maddu spine sync init [--json]    # opt into git-native team sync (one-time per checkout)
$ maddu spine sync [--json]         # audited round-trip: commit own segments → pull → validate → push
$ maddu spine import [--json]       # validate git-synced partitions (read-only)
```

`verify` walks every segment under `.maddu/events/` and runs the checks described in the *Verifiable, not just declared* paragraph of [hard-rules.md](hard-rules.md) — parseability, envelope shape, event-id uniqueness, id-format (with exemptions for well-known fixed-suffix events like `evt_…_init00`), timestamp monotonicity within each segment, schema-version consistency, segment continuity, and referential integrity (orphan `APPROVAL_DECIDED`, never-claimed or duplicate `LANE_RELEASED`, unknown-session `SESSION_CLOSED`, etc.).

Exit code: `0` on a clean run or WARN-only run; `1` if any FAIL. `--json` emits the raw verifier result for tooling — useful in CI pipelines.

`show <eventId>` pretty-prints the matching event from the spine. Exit `0` on find, `1` on miss. Useful when `verify` flags an event id and you want to inspect it without piping NDJSON through `grep`.

`maddu doctor` calls into the verifier on every run, up to a 50k-event cap (configurable in the verifier's `maxEvents` option). Above the cap, doctor emits a `WARN` pointing at `maddu spine verify` for the full pass — keeps doctor fast on long-running repos without dropping the check entirely.

The verifier is strictly read-only. If it flags an issue, the operator decides remediation (manual edit + slice-stop, `maddu checkpoint rollback`, etc.). There is no `maddu spine repair` — and won't be, by design.

`sync init` *(#12c)* opts this checkout into git-native team sync: secret-gate scan, mint a replicaId, migrate the flat segments into `.maddu/events/by-replica/<replicaId>/`, write the (never-committed) `.maddu/config/replica.json`, template `.gitignore`/`.gitattributes` marker blocks. `sync` runs the audited round-trip — commit own partition segments (explicit pathspec) → pull → `import`-validate → push (explicit refspec, pre-push path+content audit refuses any non-sync-owned commit). `import` is the read-only validator over every partition after a pull: chain forks, structural damage, within-partition duplicate ids, and secret hits are fatal; cross-partition id collisions and quarantined torn lines are tolerated and reported. All three exit `0` on ok, `1` on refusal (`2` when the subcommand itself is malformed or the install predates team-sync); `--json` emits the machine report. See [49-team-sync.md](49-team-sync.md) for the model, the audit, and the failure vocabulary.

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
$ maddu task create "<title>" [--description "<d>"] [--lane <id>] [--owner <sid>] \
                    [--blocked-by id1,id2] [--tags a,b] [--status todo|in-progress|blocked]
#   (`--title "<t>"` is accepted as an alias for the positional title)
$ maddu task update <id> [--title …] [--status …] [--owner …] [--lane …] \
                         [--add-blocker <id>] [--remove-blocker <id>] [--tags a,b]
$ maddu task complete <id> [--by <sid>]
```

Statuses: `todo`, `in-progress`, `blocked`, `done`, `cancelled`. Completing a task auto-surfaces unblocked dependents.

## `maddu goal` *(v0.16)*

Declare the agent's current objective. Latest `GOAL_DECLARED` wins in the projection and surfaces in `maddu brief` / `#orientation`.

```bash
$ maddu goal set "<obj>" [--constraint "<c>" --constraint "<c>" …]
#   (`--objective "<obj>"` is accepted as an alias for the positional objective)
$ maddu goal show
```

## `maddu phase` *(v0.16; per-phase strictness v1.91.0)*

Declare the agent's current phase (a coarser-grained context than goal). Latest `PHASE_DECLARED` wins; `clear` emits `PHASE_CLEARED` (explicit phase exit).

```bash
$ maddu phase set --name "<name>" [--notes "<notes>"] [--tier strict|standard|relaxed]
$ maddu phase clear
$ maddu phase show
```

A `--tier` makes the phase **sterile** (v1.91.0): while it is active, the
effective governance mode is the **stricter** of the workspace mode and the
phase tier — escalation-only, so a phase can tighten a release/stabilize
window but never silently weaken the workspace baseline. Loops, coordinator
phases, strict-mode approvals, and `governance show` all resolve through the
escalated view; explicit `governance override` keys keep winning. `phase
clear` lifts the escalation.

## `maddu brief` *(v0.16, agent-context flag v0.17)*

Turn-start orientation digest. Writes deterministic projections to `.maddu/state/orientation.json` and `.maddu/state/handoff.md` (anchored to `lastEventId`, never `new Date()` — same spine → byte-identical files).

```bash
$ maddu brief                # pretty-print
$ maddu brief --json         # emit orientation JSON for machine consumption
$ maddu brief --drain        # also drain pending-actions queue (emits PENDING_ACTION_DRAINED)
$ maddu brief --for-agent    # v0.17: single text block scoped for agent consumption
$ maddu brief --for-agent --triggers a,b --tags x,y   # v0.19: auto-inject matching skills
$ maddu brief --for-agent --triggers demo --dry-run   # render skills without emitting SKILL_INJECTED
```

Prints goal, phase, active session, last slice-stop, counters, and open follow-ups. Run at the start of every agent turn.

**`--for-agent`** *(v0.17)* returns a self-contained text block agents can read on every turn: goal, phase, active session, open follow-ups, lane catalog, recent slice-stops, three first-commands. Mirrors the bridge endpoint `GET /bridge/agent-context` (JSON). `MADDU.md` tells agents to call this at turn start.

**`--triggers a,b --tags x,y`** *(v0.19)* — auto-inject matching skills into the digest. Frontmatter `triggers:` / `tags:` on `.maddu/skills/*.md` files; matcher caps at 3 skills × 8 KB each. Active lane claims auto-fold into triggers (`lane:<id>`) and tags (`<id>`). Active session focus auto-folds into tags. Emits one `SKILL_INJECTED` event per call that injects ≥1 skill. See [24-skills-auto-inject.md](24-skills-auto-inject.md).

**`--dry-run`** *(v0.19, with `--for-agent`)* — render the digest with skills attached but do NOT emit `SKILL_INJECTED`. Useful for previewing.

See [20-governance.md](20-governance.md#turn-start-orientation) and [21-agent-onboarding.md](21-agent-onboarding.md).

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

## `maddu help` *(v0.18)*

Interactive discovery guide for `/maddu-*` slash commands.

```bash
$ maddu help                            # full topic-grouped roster
$ maddu help --topic autopilot          # filter by topic
$ maddu help --format json              # machine-readable
```

Topics: `discovery`, `autopilot`, `planning`, `team`, `cost`,
`skills`, `admin`.

## `maddu suggest` *(v0.18)*

Deterministic recommender — string-match keyword + lane scope,
stopword-filtered, recency tie-break. No LLM call (rule #5).

```bash
$ maddu suggest --task "<vague task>"           # full output
$ maddu suggest --task "<vague task>" --emit-lane     # lane id only
$ maddu suggest --task "<vague task>" --emit-command  # /maddu-* only
$ maddu suggest --task "<vague task>" --json
```

Used by `/maddu-autopilot` to pick the right lane. The
`suggest-engine-deterministic` doctor gate runs the same input twice
and fails on drift.

## `maddu team` *(v0.18)*

Pre-allocate disjoint lanes for fan-out work; rule #8 enforced both
pre-fact (the command refuses overlap) and by the
`rule-8-team-lane-disjoint` gate.

```bash
$ maddu team open --members N --lanes a,b,c [--label "..."]
$ maddu team status [--team-id <id>] [--json]
$ maddu team close --team-id <id>
```

## `maddu pipeline` *(v0.18)*

Walks declarative stages from `.maddu/config/pipelines/<name>.json`.
The runner is a bookkeeper — emits `PIPELINE_*` events with a stage
trail; the actual work is the agent's responsibility (see
`/maddu-autopilot`).

```bash
$ maddu pipeline list                              # configured pipelines
$ maddu pipeline run plan-exec-verify-fix "<goal>" # walk stages
```

Built-in: `plan-exec-verify-fix` (plan → exec → verify → fix). Seeded
by `init` and `upgrade`; never overwritten.

## `maddu advise` *(v0.18 stub; v0.19 spawns subprocess)*

Non-claiming cross-runtime advisor query. Resolves the runtime
descriptor (or built-in defaults for `claude` / `codex` / `gemini`),
auth-checks via `maddu auth list`, spawns the provider binary with
the prompt, and captures the response into
`.maddu/artifacts/advisors/<id>.md`. Rule #5 preserved — Máddu
imports zero SDKs; the provider CLI is a subprocess.

```bash
$ maddu advise <runtime> "<prompt>"
$ maddu advise codex "review this design" --timeout-sec 600
$ maddu advise gemini "..." --no-auth-check          # bypass auth check (e.g. you logged in via gemini's own CLI)
$ maddu advise claude "..." --stub-only              # v0.18 behavior: write stub only, no subprocess
```

Refuses cleanly (exit 2 + actionable error) when the provider isn't
signed in. The `advisor-non-claiming` gate refuses any `LANE_CLAIMED`
event whose actor matches a recorded advisor session — rule #8
companion. Both `ADVISOR_INVOKED` and `ADVISOR_ARTIFACT_WRITTEN`
events land on every call; the artifact event carries `status`
(`ok` / `timeout` / `nonzero-exit` / `spawn-error` / `stub`) and
`exitCode`.

## `maddu cost` *(v0.18)*

Token / call rollup from `TOKEN_USAGE_REPORTED` events. Honest about
gaps — rows missing input/output counts surface as `unreported`,
never zero-filled.

```bash
$ maddu cost --by runtime               # default axis
$ maddu cost --by session               # per session
$ maddu cost --by day                   # per day
$ maddu cost --by model                 # per model
$ maddu cost --unreported-count         # just the gap count
$ maddu cost --json                     # machine-readable
```

## `maddu usage import` *(v0.19.1)*

Retroactively populate the token ledger from Claude Code session
transcripts. Walks `~/.claude/projects/<slug>/*.jsonl`, emits one
`TOKEN_USAGE_REPORTED` event per assistant turn with `source:
"claude-code-transcript"`. Idempotent via `importHash`.

```bash
$ maddu usage import --from claude-code --dry-run    # parse + report; write nothing
$ maddu usage import --from claude-code              # commit the import
$ maddu usage import --from claude-code --session 21f43c48   # filter by session UUID
$ maddu usage import --from claude-code --since 2026-04-01   # skip older lines
```

Full reference: [27-transcript-import.md](27-transcript-import.md).

## v1.1.0 commands

The Autonomy + Planning + Tool Gateway release adds nine new top-level
verbs:

```bash
# Default tools (Phase 1)
$ maddu git <argv...>          # audited git wrapper; refuses empty -m, push -f
$ maddu test [argv...]         # legacy auto-detect runner (npm/vitest/jest/mocha)
$ maddu test --profile quick   # adaptive project-test profile (opt-in)
$ maddu self-test [--profile quick|full]  # source-only Máddu framework test suite
$ maddu format [argv...]       # auto-detect prettier / `npm run format`
$ maddu lint [argv...]         # auto-detect eslint / `npm run lint`
$ maddu install <packages...>  # audited npm/pnpm/yarn install; refuses empty list

# Governance tiers (Phase 3)
$ maddu governance show
$ maddu governance set <strict|standard|relaxed> [--reason "..."]
$ maddu governance set-override <key> <value>
$ maddu governance reset

# Receipt log (Phase 4)
$ maddu log [--since iso] [--lane id] [--op T] [--rebuild] [--json]
$ maddu log --window [--json]   # invocation-receipts corpus: retention window,
#   receipt/drop counts, rotation cap (v1.101.0 — see 31-operations-log.md)

# Plans + kanban (Phase 5)
$ maddu plan new "<title>" [--phases "a,b,c"] [--goal "..."]
$ maddu plan list
$ maddu plan show <plan-id>
$ maddu plan add-phase <plan-id> "<intent>"   # auto-numbers the next phase
#   (or pin the number explicitly: --phase <n> [--intent "..."])
$ maddu plan complete-phase <plan-id>          # completes the next open phase
#   (or target one: <plan-id> <n>  /  <plan-id> --phase <n> [--summary "..."])
$ maddu plan block-phase <plan-id> --phase <n> --reason "..."
$ maddu plan revise <plan-id> --note "..."
$ maddu plan complete <plan-id> [--summary "..."]
$ maddu plan cancel <plan-id> [--reason "..."]
$ maddu plan kanban
#
# v1.1.1: plan id is the first positional argument across every verb;
# `--plan <id>` is also accepted as an alias. Phase identifier is
# `--phase <id>` (preferred); `--name <id>` is a deprecated alias that
# emits a one-time stderr warning. `maddu plan kanban` now aggregates
# phase status — completed/pending/blocked phases each surface in their
# own column.

# Loops (Phase 6)
# v1.1.1: verify exit=0 → completes; non-zero → iterates; identical fail
# signature twice → halts with reason=stuck-detection; exceeding --max-iter
# → halts with reason=max-iter-reached. Regression-tested in the synthetic
# stress harness scenario `ralph-always-fail-halts`.
$ maddu loop ralph --goal "..." --verify "<cmd>" [--iterate "<cmd>"]
$ maddu loop plan  --plan <id> [--max-iter N]
$ maddu loop status / cancel

# Ralph + adaptive project tests
$ maddu loop ralph --goal "fix tests until green" --verify "maddu test --profile quick --bail"

# Coordinator (Phase 7)
$ maddu coordinator <plan-id> [--dry-run | --synthetic-cmd "..." | --runtime <n>]

# MCP templates (Phase 2)
$ maddu mcp templates list / show <name>
$ maddu mcp install <template> / uninstall <name>

# Skill candidates (Phase 8c)
$ maddu skill candidates list
$ maddu skill from-candidate <hash> [--title "..."]
$ maddu skill candidate-reject <hash> [--reason "..."]

# Force-claim (Phase 8a)
$ maddu lane claim --lane <id> --session <sid> --force [--reason "..."]
#
# v1.1.1: `lane claim` and `lane release` also accept the positional
# shorthand: `maddu lane claim <lane-id>`. `--session` falls back to
# `$MADDU_SESSION_ID` (v0.19.1).

# Slice-stop lineage (Phase 5)
$ maddu slice-stop --triggered-by plan:<plan-id> --summary "..."
```

Full coverage: [28-default-tools.md](28-default-tools.md),
[29-mcp-templates.md](29-mcp-templates.md),
[30-governance-tiers.md](30-governance-tiers.md),
[31-operations-log.md](31-operations-log.md),
[32-kanban-and-plans.md](32-kanban-and-plans.md),
[33-loops-and-coordinator.md](33-loops-and-coordinator.md).

## v1.2.0 commands

### `maddu trust <verb>` *(v1.2.0)*

Supply-chain audit + pin surface. Backed by `.maddu/config/trust.json`.

```bash
maddu trust audit              # freshness + pin table for direct deps
maddu trust audit --cve        # also include npm audit CVE summary
maddu trust audit --fresh      # bypass the 6h npm-view cache
maddu trust audit --json       # JSON output for tooling

maddu trust pin <pkg> --version <v> [--hash <sha>]
maddu trust unpin <pkg>
maddu trust verify             # pin ↔ package.json declared spec ↔ installed
maddu trust list               # print trust.json
maddu trust report             # write .maddu/state/trust-report-<date>.md
maddu trust env-allow <VAR> [--lane <id>]
```

Doctor gates added: `dependency-freshness`, `dep-pinning-respected`,
`mcp-provenance-verified`, `worker-env-policy-coherent`,
`secret-scan-active`, `skill-provenance-required`,
`strict-mode-approval-active`.

Spine events added: `TRUST_AUDIT_RAN`, `TRUST_PIN_ADDED`,
`TRUST_PIN_REMOVED`, `TRUST_VIOLATION_DETECTED`,
`MCP_PROVENANCE_VERIFIED`, `MCP_PROVENANCE_MISMATCH`,
`MCP_APPROVAL_GRANTED`, `WORKER_ENV_FILTERED`,
`SECRET_DETECTED_IN_ARGV`, `SKILL_IMPORTED`, `SKILL_TRUSTED`,
`SKILL_INJECTION_REFUSED`.

### `maddu mcp approve <name>` *(v1.2.0)*

Operator-registered MCPs (`maddu mcp register …`) now tag as
`provenance: operator-trusted` and are **disabled until approved**.

```bash
maddu mcp register --name custom-fs --transport stdio --command ./my-server
# → registered as disabled / pending approval

maddu mcp approve custom-fs    # → enabled, MCP_APPROVAL_GRANTED on spine
```

Pass `--approve` to `mcp register` to short-circuit the explicit step.

### `maddu skill import <path>` and `maddu skill trust <id>` *(v1.2.0)*

```bash
maddu skill import ./demo-skill.md            # refuses without --trust
maddu skill import ./demo-skill.md --trust    # imported as untrusted
maddu skill trust demo-skill                  # promotes to trusted
```

The `maddu brief --for-agent` skill auto-injection path refuses
untrusted imported skills.

See also: [34-threat-model.md](34-threat-model.md),
[35-hermes-adapter.md](35-hermes-adapter.md),
[36-trust-audit.md](36-trust-audit.md).

## v1.9.0 commands

### `maddu learn <verb>` *(v1.9.0)*

Mine past Claude Code sessions for tool calls that failed and were later
resolved, and distil durable **project** corrections. The corrections describe
your product (paths, commands, quirks) — never Máddu's hard rules.

```bash
$ maddu learn run                    # mine → spawn judgment worker → write corrections
$ maddu learn run --since 2026-06-01 --slug myrepo
$ maddu learn digest                 # no-provider fallback: write a review digest only
$ maddu learn list                   # corrections written so far
$ maddu learn show <correctionId>    # one correction + provenance
$ maddu learn retrieve <briefingId>  # full original of a curated (reversible) briefing
$ maddu learn scan                   # read-only: hedged completion claims w/o observed proof
$ maddu learn sync                   # fleet lesson federation (preview; --adopt writes)
$ maddu learn sync --from-claude-memory [--adopt]  # import Claude Code auto-memory (v1.90.0)
$ maddu learn run --spine            # ALSO mine the spine: TOOL_REFUSED→COMPLETED +
$ maddu learn digest --spine         #   GATE_RAN fail→ok arcs, id-deduped into the digest (EXP)
```

`run` mines deterministically, then spawns the configured runtime **CLI** as a
subprocess to judge the candidates (hard rule #5: no provider SDK in core; the
parent is the only spine writer). Accepted corrections route to two
destinations — stable facts to a marker block in the project-root `CLAUDE.md`,
volatile patterns to `kind:'correction'` memory facts. Emits `LEARN_MINED`,
`LEARN_JUDGED`, `LEARN_CORRECTION_WRITTEN` (or `LEARN_DIGEST_WRITTEN` on the
fallback path). `sync --from-claude-memory` imports Claude Code's own
auto-memory as `kind:'vendor'` facts — **import-only** (the vendor directory
is never written), content-hash-deduped, preview by default; each adopted
fact rides a `VENDOR_MEMORY_IMPORTED` event so rebuilds replay it. See
[37-failure-learning.md](37-failure-learning.md).

### `maddu memory` — supersession *(v1.9.0)*

```bash
$ maddu memory list --kind correction      # current view (superseded facts hidden)
$ maddu memory list --all                  # full history, including retired facts
$ maddu memory supersede --prior <id> --text "<new fact>" [--reason "…"]
$ maddu memory history <factId>            # the whole chain, newest → oldest
```

Supersession is event-sourced (`MEMORY_FACT_SUPERSEDED` carries the full fact),
so chains survive `maddu memory extract --rebuild`.

### `maddu orient --curate` *(v1.9.0)*

Opt-in reversible briefing: persists the full handoff original and prints a
budget-bounded view plus a `maddu learn retrieve <id>` pointer (emits
`BRIEFING_CURATED`). Default `maddu orient` stays read-only.

### `maddu orient --digest` *(v1.97.0)*

The "while you were away" summary — what changed since you last looked (slices
landed, gates failing, goal state) — for the [Operator Plane](53-operator-plane.md).
Read-only; also rendered by the cockpit `digest` route.

## v1.72.0 commands

### `maddu agents <verb>` *(v1.72.0)*

Make **"install maddu"** a natural-language command in every repo by writing a
self-contained install stanza into your agents' **global** instruction files
(Claude Code, Codex, Gemini, generic `AGENTS.md`, or any custom path). Paths are
resolved from `os.homedir()` + per-agent convention (never hardcoded), detected by
directory existence, with a custom-path escape hatch for anything non-standard.

```bash
$ maddu agents detect                              # known agents + resolved file + install state
$ maddu agents register                            # interactive on a TTY (pick agents + custom path)
$ maddu agents register --agent claude,codex --yes
$ maddu agents register --all --yes                # every known agent
$ maddu agents register --path ~/.foo/BAR.md --yes # any other agent .md (advanced)
$ maddu agents register --dry-run --agent claude   # show targets, write nothing
$ maddu agents unregister --agent gemini --yes     # remove the stanza, keep your content
```

The stanza is marker-delimited (`<!-- BEGIN MADDU INSTALL v1 -->`), so register is
idempotent and never disturbs operator content outside the markers. Full guide:
[42-agents-global-install.md](42-agents-global-install.md).

### `maddu hooks <verb>` *(v1.74.0)*

Wire **Claude Code session hooks** into this repo so every session auto-registers
and records to the spine — *session discipline by default*. Combined with the
active-session resolver, a single auto-registered session flows into `lane claim`
and `slice-stop` with no `--session`/`$MADDU_SESSION_ID`.

```bash
$ maddu hooks install        # merge SessionStart(auto-register) + SessionEnd(close)
                             #   + PreCompact(compaction checkpoint, v1.89.0)
                             #   + PreToolUse(discipline enforcement, v1.97.0)
$ maddu hooks install --statusline   # also wire `maddu status --line` into the status line (opt-in)
$ maddu hooks status         # which Máddu hooks are installed
$ maddu hooks remove         # strip only Máddu's hook entries (keeps yours)
$ maddu hooks uninstall      # alias for `remove` — the fast off-switch for the discipline gate
```

The `PreCompact` hook writes a `COMPACTION_CHECKPOINT` to the spine before
every context compaction (manual or auto) — `maddu orient` auto-announces the
latest one, and `maddu doctor` warns when the installed stanza is partial or
stale. It **fails open** (never blocks compaction). The `PreToolUse` hook
enforces session discipline (allow / nudge / **deny** a mutating edit when a
ritual is stale), tier-scaled, fail-open, remedies never gated — full detail in
[44-session-hooks.md](44-session-hooks.md#discipline-enforcement-the-pretooluse-gate).

`install` is idempotent and surgical — it writes the **host** file
`.claude/settings.json` (outside `.maddu/`), preserves your own hooks/settings,
refuses malformed JSON, and runs only on explicit invocation (never silently at
`init`, which offers it as a next step). Full guide:
[44-session-hooks.md](44-session-hooks.md).

### `maddu autonomy` *(v1.92.0)*

**Earned autonomy** — a deterministic per-lane trust score over the verified
record: Wilson lower bound (z=1.96) over witnessed-clean vs witnessed-dirty
slice outcomes, mapped to a 3-rung ladder (`observe` / `established` /
`relaxation-candidate`), with a daily clean-credit cap against
deliverable-farming. **Recommend-only by contract** — it never writes
governance config; applying a recommendation is `maddu governance set`.

```bash
$ maddu autonomy                  # per-lane table: rung · wilson · n · clean · dirty · neutral · unwit. · coverage
$ maddu autonomy --lane backend   # one lane
$ maddu autonomy --json           # machine-readable; byte-identical for identical inputs
$ maddu autonomy --no-emit        # read-only: append no events
```

Explicit runs append `AUTONOMY_SCORED`; `AUTONOMY_RECOMMENDATION` fires only on
a rung change, deduped against the spine itself. Relax recommendations are
**muted while any phase is active** (the phase floor is absolute). The latest
live recommendation also surfaces in `maddu orient`, `maddu governance show`,
and the cockpit. Thresholds: `.maddu/config/autonomy.json` (hashed onto every
event as `configHash`). Full guide: [47-earned-autonomy.md](47-earned-autonomy.md).

## Experience & evolution *(EXP)*

### `maddu experience`

The spine as a normalized **experience ledger** — session trajectories of
typed steps with late-bound outcome signals. Pure read-time derivation: zero
writes, step ids ARE event ids, deterministic for identical spines.

```bash
$ maddu experience                 # trajectory manifest (one row per session + env)
$ maddu experience show <id>       # one trajectory's steps (--lane <id>, --limit <n>)
$ maddu experience stats           # totals, role/kind counts, signals, absent-by-design axes
$ maddu experience export --format atdp --out exp.atdp.json [--since <id>] [--until <id>]
```

`export` is the **governed sharing boundary**: refuse-on-hit secret gate over
the selected range (**no flag to skip it** — unknown flags are hard errors),
`--out` confined to the repo on the realpath basis (never `.maddu/`, `maddu/`,
`maddu.json`, never over an existing non-ATDP file), deterministic bytes with
no clock — `--until <manifest.range.lastEventId>` reproduces a past export
byte-for-byte — and `trainingEligibility: false` hard on the manifest.

### `maddu evolve`

The **recommend-only** evolution planner over the experience ledger. Four
deterministic detectors (tool-correction, gate-flap, recurring-learning,
uncorrected-gate), evidence thresholds (≥3 occurrences across ≥2 scopes),
prior-art dedup against adopted corrections, content-addressed rec ids. Thin
evidence → the honest **no-op**, stated with its full why.

```bash
$ maddu evolve plan                          # detectors → recommendations (or the no-op)
$ maddu evolve adopt <recId>                 # operator-gated; EXISTING write paths only
$ maddu evolve adopt <recId> --to memory     # correction-class → memory fact
$ maddu evolve adopt <recId> --to agent-file # correction-class → CLAUDE.md marker block
```

Nothing auto-applies — the earned-autonomy precedent governs (compute,
recommend, stop). Full guide: [50-experience-evolve.md](50-experience-evolve.md).

## SLM governance *(SLM)*

### `maddu model`

The SLM-factory governance verb — every write sub-verb validates + sha256-pins
a host-repo manifest (refuse-on-hit secret gate, **no skip flag**) and appends
contract-1.1.0 `MODEL_*` events; every verb RECORDS what external tools did
(`train start` starts nothing, `eval record` runs nothing).

```bash
$ maddu model dataset snapshot <m.json>    # → MODEL_DATASET_SNAPSHOT_RECORDED
$ maddu model train start <m.json>         # → MODEL_TRAINING_RUN_STARTED (dataset must be recorded)
$ maddu model train complete <m.json>      # → MODEL_TRAINING_RUN_COMPLETED (checkpoint + metrics required)
$ maddu model checkpoint register <m.json> # → MODEL_CHECKPOINT_REGISTERED (sha256 identity key)
$ maddu model eval record <m.json>         # → MODEL_EVAL_RAN + MODEL_REGRESSION_FOUND per critical regression
$ maddu model regression ack <eval-id> --reason "…"   # → MODEL_REGRESSION_ACKNOWLEDGED (secret-scanned)
$ maddu model promote <m.json> [--wait]    # → APPROVAL_REQUESTED first, then MODEL_PROMOTION_PROPOSED
$ maddu model promote --confirm <proposal-id>          # → MODEL_PROMOTION_APPROVED (exact binding)
$ maddu model release <m.json>             # → MODEL_RELEASED (requires derived stage released + rollback plan)
$ maddu model rollback <m.json> [--reverted-to <stage>]  # → MODEL_ROLLED_BACK (strictly downward)
$ maddu model status [--model <id>] · maddu model list <datasets|runs|checkpoints|evals|promotions>
$ maddu model gates install [--force-list] # 12-gate operator starter pack into .maddu/gates/
```

Checkpoint stages (`experiment → candidate → canary → released`) are always
DERIVED from the spine — a manifest's `from_stage` is checked, never
trusted. Promotion is an always-on approvals ride; ⚠ standing approval
policies auto-decide **only** `experiment → candidate` — a policy on the
canary/released tool keys is deliberately inert (the safety property, not a
bug). Full guide: [51-slm-governance.md](51-slm-governance.md).

## Slash commands (v0.18, expanded v0.19.1)

Inside Claude Code or Codex CLI, the operator can dispatch any of the
underlying commands via a markdown shim. The 13 framework-owned files
ship under `template/maddu/agent-files/commands/maddu-*.md` and are
installed RAW (no marker wrap) into `.claude/commands/` and
`.codex/commands/` — Claude Code's frontmatter parser requires `---`
on line 1.

| Slash command | Underlying CLI |
|---|---|
| `/maddu-help` | `maddu help` |
| `/maddu-suggest <task>` | `maddu suggest` |
| `/maddu-doctor` | `maddu doctor` |
| `/maddu-autopilot <task>` | `register` → `suggest` → `lane claim` → `pipeline run` → `slice-stop` |
| `/maddu-plan <topic>` | `goal`, `phase`, `brief` |
| `/maddu-review [slice-id]` | `review run`, `review status` |
| `/maddu-team <N> <task>` | `team open` |
| `/maddu-advise <runtime> <prompt>` | `advise` |
| `/maddu-status` | `brief`, `status` |
| `/maddu-skill <verb>` | `skill` |
| `/maddu-cost` | `cost` |
| `/maddu-cancel` | `session close`, `slice-stop` |
| `/maddu-note <text>` | `mailbox send` |
| `/maddu-git <argv>` | `git` *(v1.1.0)* |
| `/maddu-test [argv]` | `test` *(v1.1.0)* |
| `/maddu-format [argv]` | `format` *(v1.1.0)* |
| `/maddu-lint [argv]` | `lint` *(v1.1.0)* |
| `/maddu-install <pkg>` | `install` *(v1.1.0)* |
| `/maddu-mcp [verb]` | `mcp` *(v1.1.0)* |
| `/maddu-governance [verb]` | `governance` *(v1.1.0)* |
| `/maddu-log [flags]` | `log` *(v1.1.0)* |
| `/maddu-plan [verb]` | `plan` *(v1.1.0)* |
| `/maddu-ralph <goal>` | `loop ralph` *(v1.1.0)* |
| `/maddu-plan-loop <plan-id>` | `loop plan` *(v1.1.0)* |
| `/maddu-coordinate <plan-id>` | `coordinator` *(v1.1.0)* |
| `/maddu-blast <task>` | chained: register → claim → loop → slice-stop *(v1.1.0)* |
| `/maddu-skills-review` | `skill candidates list` *(v1.1.0)* |
| `/maddu-learn [run\|digest]` | `learn` *(v1.9.0)* |

See [22-slash-commands.md](22-slash-commands.md) for the full
reference, including the raw-frontmatter rationale and how to add
your own slash commands.
