# Session 2026-05-14 — OMC design language port

Picks up immediately after `v0.3.2` (Phase A+B+C+D2 complete). This session
was pure cockpit/CSS evolution — no bridge, route, or schema changes. Goal:
take Máddu's cool-steel-on-black cockpit and port it onto the OMC visual
language (navy noir + dual-neon accents + status triad + Plex ladder).

## Where the framework is right now

- `https://github.com/frdyx/maddu` · main · last commit `f8fa28c`
- Spine version `v0.3.2`. Doctor 8/8 in `/tmp/maddu-fresh-v032`
- Bridge running at `http://127.0.0.1:4203` (last verified this session)

## What shipped this session (in order)

| Commit | Change | What's visible |
|---|---|---|
| `4e8fce7` | **Slice A — composer rebuild** | `<input>` → `<textarea>`; auto-resize via `composer.fit()`; Enter submits, Shift+Enter newline; expandable up to 240 px; foot row added a slim secondary meta row (italic tagline + bridge coord) |
| `618d3df` | **Slice B — token swap** | Pitch-black + rgba navy surfaces; cream ink ladder; lime + electric-blue accents; status triad (`--m-ok/-warn/-danger`); pulse keyframes recoloured green; aliases for `--m-signal`/`--m-accent-warm` |
| `eb181bd` | **Slice C — navy canvas + OMC fidelity** | `--m-bg-0` materialized as navy `#050B17` (operator feedback: stage-body shouldn't be black); brand orange `#F04E23` on rail-mark glyph + glow; panel radial blue/lime corner glows + electric-blue top accent; status surfaces (`--m-ok-bg/-border`, etc); spacing + radius scales; event-type tokens; rail-w 220→240; ledger hover halo; .approval card gets amber alert wash gradient; .btn-deny-hard → `--m-danger` |
| `db4d690` | **classifyEvent extension** | 11 event families mapped to 5 colour buckets (fixed SCHEDULE_FIRED / MAILBOX_* / WORKER_* etc which had been falling through) |
| `573fee9` | **Banner redesign** | Default tone blue (info); `.warn` + `.danger` modifiers; standing glow removed; `setBanner(text, severity)` helper with pulse-on-change animation (3 hue variants) |
| `5ef57e6` | **Floating composer** | `.stage-foot` lifted out of grid flow; absolute-positioned over body; glassy backdrop (rgba navy + blur 18 + saturate 120); body has `padding-bottom: 96px` so resting composer doesn't hide content; expanding composer overlays body instead of pushing it |
| `f8fa28c` | **Floating toast system** | `#toast-region` top-right corner; stackable max 5; severity left-borders; 220 ms slide-in animation; click-to-dismiss; auto-dismiss 3 s base + 35 ms/char up to 9 s. Replaced single-slot `.composer-toast` |

## Open design threads / decisions for next session

1. **Composer rest height.** Currently 48 px single-line. Operator asked
   whether it should be a "small strip" — confirmed it is by design, but
   if they want a 2–3 line default chat-box feel, bump `min-height` to
   ~72 px on `.composer-input`. Just say.

2. **Banner pulse trigger.** Currently pulses only when `setBanner()` is
   called with new content. Operator mused about it being a general
   "system breathing" indicator that pulses on every event from the page
   stream. To implement: subscribe to `stream.bus` in `initComposer()` or
   in `boot()`, debounce to ~once-per-second, dispatch a no-op pulse
   (could change a class on the banner without altering its content).

3. **Rail-link unread badges.** Still solid amber pills
   (`APPROVALS 1`, `MAILBOX 1`, `TASKS 1`). OMC convention is left-border-
   only chip with tone-bg. Subtler but harmonious — operator hasn't
   confirmed preference yet.

4. **Typography ladder application.** Tokens are defined
   (`--m-type-xs/sm/body/row/h3/h2/h1/metric`) but not applied uniformly.
   Specifically `.view h2` is still 22 px, should adopt `--m-type-h1` 28 px
   for primary route titles + `--m-type-h2` 18 px for panel headers.

5. **Button hover states.** Generic `--m-bg-3` hover — OMC convention is
   accent-2 (electric blue) glow halo. Easy diff in `cockpit.css` under
   `button:hover`.

6. **OMC brand red glow `--m-shadow-orange-glow`** is defined but unused
   outside the rail-mark text-shadow. Could be a CTA-button hover for the
   most prominent actions.

## Operator preferences captured (don't re-litigate)

- **No tabular-nums anywhere.** Even though the OMC source brief
  recommends them on counters/timestamps, the operator explicitly opted
  out at the start of the port.
- **Composer (a) over (b).** Single expandable footer composer, not a
  composer + terminal scrollback split.
- **Brand orange `#F04E23` reserved for the rail-mark glyph** as a ghost
  accent. Lime `#D0FF00` is the interactive accent; orange is brand only.
- **`--m-accent-warm` renamed conceptually to `--m-warn`** — both names
  resolve to the same value via alias; either can be used in new rules.

## Reference: where to read next time

- Tokens: `template/maddu/cockpit/cockpit.css` lines 1–135 (`:root` block)
- Composer: `cockpit.css` `.stage-foot` + `.composer-*` + `cockpit.js`
  `initComposer()` and `composer.fit()`
- Banner: `cockpit.css` `.stage-banner*` + `cockpit.js` `setBanner()`
- Toasts: `cockpit.css` `.toast-region` + `.toast*` + `cockpit.js`
  `showToast()`
- Event classification: `cockpit.js` `classifyEvent()`

## Visual evidence

Screenshot scripts that worked this session:

- Full route tour: `/tmp/maddu-screens/screenshot.mjs`
- Toast demo (types `test` + `/help` to fire toasts): `/tmp/maddu-screens/demo-toast.mjs`
- Output dir: `/tmp/maddu-screens/shots/`

Playwright + Chromium installed at `~/AppData/Local/ms-playwright/` in a
sibling scratch project under `/tmp/maddu-screens/`.

## Test environment state

`/tmp/maddu-fresh-v032/` — fresh empty git repo with `maddu init`
applied. Populated state from the v0.3.2 integration smoke:

- 2 anthropic auth keys + 1 openai
- 3 tasks (1 done, 2 todo/blocked)
- 2 skills (1 created, 1 from-slice distilled)
- 1 stuck worker, 1 running worker
- 1 mailbox unread on harness
- 1 schedule (5min heartbeat, fired multiple times)
- 1 checkpoint (smoke baseline)
- 1 MCP server (local-fs, untested)
- 1 runtime (node, detected v24.11.1)
- 1 accepted import + 1 rejected (secret-laden)

Bridge typically run via:
```bash
cd /tmp/maddu-fresh-v032
node "C:/users/frdy/documents/claude/projects/maddu/bin/maddu.mjs" start --port 4203
```

## Pre-compact checklist

- [x] All cockpit changes committed and pushed
- [x] This handoff doc written
- [x] Open design questions enumerated (see "Open design threads")
- [x] Operator preferences captured (see "Operator preferences")
- [x] Reference paths documented
- [x] Test env state documented
