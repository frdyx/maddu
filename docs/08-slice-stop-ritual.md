# The slice-stop ritual

A **slice-stop** is the structured record an agent emits at the end of a working slice. It is the only path into hindsight memory and the only mechanism by which the system learns from agent activity.

## When to run a slice-stop

Run a slice-stop when:

- A focused chunk of agent work has produced a concrete outcome (shipped feature, fixed bug, captured discovery).
- You are about to switch contexts or close the session.
- You hit a stopping condition (gate failed, blocker found, decision needed from the operator).

Do **not** run a slice-stop for:

- Pure conversational answers with no repo change.
- When the operator has explicitly said "do not write files."

## The payload

Run with the CLI:

```bash
$ maddu slice-stop \
    --session ses_2026... \
    --lane cockpit-shell \
    --summary "Approvals route renders open + ledger" \
    --action "Wrote renderApprovals(), wired badge counter, added allow-always policy CTA" \
    --targets "cockpit.js,cockpit.css" \
    --paths "maddu/cockpit/" \
    --gates "doctor,events-replay" \
    --learnings "Approvals must auto-decide via policy before surfacing in UI;Badge counter belongs in chrome, not the route" \
    --next "Wire deny-always in CLI;Add per-tool policy presets" \
    --reason "ship the approvals route"
```

Field meanings:

| Flag | Required | Meaning |
|---|---|---|
| `--session` | yes | The acting session id. |
| `--summary` | yes | One sentence: what happened. |
| `--lane` | recommended | Which lane the work belonged to. |
| `--action` | recommended | One paragraph: what specifically changed. |
| `--targets` | recommended | Files modified (comma-separated). |
| `--paths` | recommended | Directories touched (comma-separated). |
| `--gates` | recommended | Focused gates / checks that ran (comma-separated). |
| `--learnings` | recommended | Discoveries and rules that emerged. **Semicolon-separated** because entries often contain commas. |
| `--next` | recommended | Follow-ups for the next slice. **Semicolon-separated**. |
| `--reason` | optional | Why this slice was requested. |

HTTP equivalent:

```bash
$ curl -X POST http://127.0.0.1:4177/bridge/slice-stop \
    -H "content-type: application/json" \
    -d '{
          "sessionId": "ses_...",
          "lane": "cockpit-shell",
          "summary": "Approvals route renders open + ledger",
          "action": "...",
          "targets": ["cockpit.js","cockpit.css"],
          "paths": ["maddu/cockpit/"],
          "gates": ["doctor"],
          "learnings": ["Approvals must auto-decide via policy"],
          "next": ["Wire deny-always in CLI"],
          "reason": "ship the approvals route"
        }'
```

## What slice-stop produces

1. **A `SLICE_STOP` event on the spine.** Permanent, append-only, deterministic id.
2. **Hindsight extraction.** The same process that wrote the event then parses the payload and emits typed facts to `.maddu/state/memory.ndjson`:
   - Every `learnings` entry → a `rule` or `discovery` fact (heuristic).
   - Every `next` entry → a `followup` fact.
   - Every `targets` entry → a `touched` fact.
   - Every `gates` entry → a `gate` fact.
   - The `summary` → a `summary` fact.
   Each fact carries provenance back to the originating `SLICE_STOP` event id. See [10-skills-and-hindsight.md](10-skills-and-hindsight.md).
3. **Surfaces.** The slice-stop shows in `maddu status`, in the cockpit Operations route, and (later) in any skill distilled from it.

## How slice-stop is different from a commit

- A commit is git's record of file content. A slice-stop is Máddu's record of agent intent and outcome.
- One slice-stop may span many commits, or none. One commit may belong to many slices, or none.
- Slice-stops live in the spine; commits live in git. They are independent and complementary.

## Recommended patterns

- **Tight slices.** One summary sentence. If you can't summarize in one sentence, the slice was probably two slices in a trench coat.
- **Honest learnings.** "X did not work because Y" is a more useful fact than "shipped X."
- **Concrete next.** "Wire deny-always in CLI" beats "polish CLI."
- **Targets and paths.** These feed search and memory indexing — fill them in.
- **Gates.** If you ran focused gates or doctor, list them. Memory uses them as quality signals.

## Distilling a skill from a slice-stop

If the slice produced a reusable pattern, distill it into a SKILL.md:

```bash
$ maddu skill from-slice evt_2026... --title "How we wire cockpit routes"
distilled  skl_...  How we wire cockpit routes
  from evt_2026...
```

The skill body is drafted from the slice-stop's `summary`, `action`, and `learnings`. Edit `.maddu/skills/<id>.md` by hand to finalize.

## See also

- [10-skills-and-hindsight.md](10-skills-and-hindsight.md) — memory extraction and skills.
- [02-concepts.md](02-concepts.md) — concept overview.
- [03-cli-reference.md](03-cli-reference.md) — full `maddu slice-stop` reference.
