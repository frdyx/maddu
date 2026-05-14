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
$ maddu doctor [--verbose]
```

Reports PASS / WARN / FAIL per check. Appends a `DOCTOR_REPORT` event. Exits 1 on any FAIL.

## `maddu start`

Boot the bridge server.

```bash
$ maddu start [--port 4177]
```

Default port: 4177. The bridge listens on `127.0.0.1` only.

## `maddu status`

Print a state snapshot — repo root, spine event count, active sessions, lane claims, recent slice-stops.

```bash
$ maddu status
```

## `maddu session`

Register / heartbeat / close / list agent sessions.

```bash
$ maddu session register --role <r> --label "<l>" --focus "<f>" [--runtime <name>]
$ maddu session heartbeat --session <id> [--focus "<f>"] [--lane <id>]
$ maddu session close --session <id> [--handoff "<h>"]
$ maddu session list
```

`register` prints the new `ses_...` id. `list` shows active sessions plus the last 10 closed.

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
```

`request` is mostly for testing — workers normally request approvals via the bridge. See [09-approvals-and-permissions.md](09-approvals-and-permissions.md).

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
