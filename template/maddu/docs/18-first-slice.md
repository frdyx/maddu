# Your first slice — the five-minute tour

You just installed Máddu. The cockpit is open at `http://127.0.0.1:4177/` and every route is showing an empty state. This is the page that takes you from that empty cockpit to a system that *remembers what you did*, in about five minutes.

You don't need to read everything else first. The mental model takes two paragraphs.

## What you're looking at

Máddu is an **append-only event spine** under `.maddu/events/*.ndjson`. Every meaningful action — registering an agent, claiming a lane, finishing a slice of work — appends one event to that file. Nothing edits in place. Nothing lives in a database. The cockpit is a window onto the spine.

Every other surface you'll see — projections, claims, memory, the wiki, scoring — is **derived** from those events at read time. That's why "files only" is the first hard rule: when the data lives in one append-only log, everything else can be regenerated. There is one source of truth and it is plain NDJSON in your repo.

The slice-stop is the ritual that closes one unit of work and writes a `SLICE_STOP` event. That's the only path into Hindsight memory and the only thing that makes the auto-wiki update. Once you've done one slice-stop, the system has something to remember. That's the whole goal of this five-minute tour.

## 1 · Find the Conductor

When the cockpit first boots, it lands on **Conductor** — the leftmost item in the **Decide** group. You'll see four panels:

- **Now · Next · Waiting · Done** — empty.
- **Queue Board** — empty.
- **Operation Score Matrix** — empty.
- **Last slice-stop** — empty.

All empty is correct. There's nothing to show yet. The panels read empty states with a quieted lime ◌ glyph and a one-line hint each.

## 2 · Register a session

Open a terminal. From your repo root:

```bash
maddu session register --role implementer --label "First session" --focus "tour"
```

The CLI prints a session id like `ses_20260101_aaaaaa`. Copy it — you'll reference it in three more commands.

Switch back to the cockpit. `Ctrl+K`, type `agents`, Enter. The **Agents** route now shows one card: your session.

That card is **searchable by name**. `Ctrl+K`, type the first three letters of your session label ("fir"), and it appears as a sub-target hit. This is the system noticing your work as it happens.

## 3 · Claim a lane

Lanes are the cockpit's write-locks — only one session can hold a lane at a time. From the terminal:

```bash
maddu lane claim --lane harness --session ses_XXXXXX --focus "first slice"
```

Back in the cockpit, `Ctrl+K` → `claims`. The **Claim Map** route shows your lane held by your session, with a heartbeat age and a focus line. The **Teams** route shows the same lane card with a green "held" pill.

Every state visible right now was derived from two events (`SESSION_REGISTERED`, `LANE_CLAIMED`) in `.maddu/events/`. Open the **Events** route to see them.

## 3.5 · Read the brief *(v0.16+)*

Before doing the work, get oriented. From the terminal:

```bash
maddu brief
```

You'll see a turn-start digest — goal, phase, active session, last slice-stop, counters, open follow-ups, plus the handoff markdown from the most recent slice-stop (empty on a fresh install). This is the agent's "where am I?" ritual. The same digest is the **Orientation** route in the cockpit (`Ctrl+K` → `orientation`).

Optionally, declare a goal so future briefs anchor to it:

```bash
maddu goal set --objective "Tour Máddu end-to-end" --constraint "no SQLite, no SDKs"
```

Re-run `maddu brief` — the goal now appears. Whatever the agent reads at turn-start lives in `.maddu/state/orientation.json` + `.maddu/state/handoff.md`, both rebuildable from the spine.

See [20-governance.md](20-governance.md) for the rest of the governance surface (gates, scope-lock, review lane).

## 4 · Make a slice-stop

This is the moment the framework starts remembering. From the terminal:

```bash
maddu slice-stop \
  --session ses_XXXXXX \
  --lane harness \
  --summary "First slice — tour complete" \
  --action "Registered session, claimed harness, made first slice-stop" \
  --learnings "rule: every slice closes with a slice-stop;discovery: the cockpit updates live without refresh" \
  --next "Read 02-concepts;Explore the BOSS route" \
  --reason "Following 18-first-slice.md"
```

**Watch the cockpit while you hit Enter.** Three things happen, in order:

1. A single 1 px **lime line traces across the top of the viewport** in about 900 ms and dissolves. That's the signature flourish — the cockpit's tell that a slice-stop just landed on the spine. It's the only motion that fires from a spine event, and it works from every route. If it didn't fire, see [13-troubleshooting.md](13-troubleshooting.md).
2. The Conductor's **Last slice-stop** panel fills in with your summary.
3. The Hindsight worker auto-runs and writes facts to `.maddu/state/memory.ndjson`. The Wiki Updater writes a stamped block to `.maddu/wiki/lane-harness.md`.

You did one slice-stop. Three projections populated. Nothing required a refresh.

## 5 · See what was remembered

`Ctrl+K` → `learning` → Enter. The **Learning** route now lists your learnings as classified facts ("rule:" → rule kind, prefix-detected) with the source event linked.

`Ctrl+K` → `wiki` → Enter. The **Wiki** route shows one page (`lane-harness.md`) with your slice-stop block.

`Ctrl+K` → `roadmap` → Enter. The **Slice index** lists your slice-stop. Click it — the Inspector opens with the full event payload.

You can now answer four questions just by looking at the cockpit:

- What was done? → Conductor's Last slice-stop, or the Slice index.
- Who did it? → Agents grid.
- What did we learn? → Learning route.
- What does the system know now? → Wiki page for that lane.

That's the loop.

## 6 · The verbs you'll actually use

Open the command palette with `Ctrl+K` (or `⌘K` on macOS). Three kinds of result appear:

- **Routes** (◇ outlined, ◆ filled for anchor routes) — every page in the cockpit.
- **Sub-targets** (▸ lime) — specific panels inside a route. Typing `tele` lands you on Settings → Telegram.
- **Actions** (▷ electric blue) — verbs the cockpit can run. Typing `wiki` surfaces "Rebuild wiki from spine" as an action; Enter runs it directly.

Try `Ctrl+K` → `memory` → arrow-down to **Re-extract hindsight memory** → Enter. The toast confirms the run.

## 7 · Where to go next

You now have a working spine with one slice-stop, a populated Learning route, a fresh wiki page, and a feel for the palette. Three reasonable next reads:

- **[02-concepts.md](02-concepts.md)** — the mental model in depth: lanes, claims, sessions, hindsight, the BOSS/Enforcer duality.
- **[08-slice-stop-ritual.md](08-slice-stop-ritual.md)** — the slice-stop payload reference.
- **[04-cockpit-tour.md](04-cockpit-tour.md)** — every route, what it shows, when to use it.
- **[20-governance.md](20-governance.md)** *(v0.16)* — orientation, gate authoring, tracked sources, slice scope-lock, trigger discipline, review lane.

If anything didn't behave as described above, [13-troubleshooting.md](13-troubleshooting.md) covers the common failures. Most issues surface via `maddu doctor --verbose`.

## Cleanup, if you want it

The session and lane claim you made above are real — they'll show up forever in the spine. That's correct: the spine is append-only and durable. To close out the tour cleanly:

```bash
maddu lane release --lane harness --session ses_XXXXXX
maddu session close --session ses_XXXXXX --handoff "Done with tour"
```

The cockpit's Agents grid will move the session card to closed. The events ledger keeps the full history.

Welcome to Máddu.
