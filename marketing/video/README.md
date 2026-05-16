# Máddu marketing video

A [Remotion](https://www.remotion.dev/) project that renders the **22-second
cockpit demo video** referenced in the root `README.md`.

The video tells one story: an empty cockpit accepting its first session,
claiming a lane, receiving a BOSS proposal, hitting a slice-stop, and
watching Hindsight memory populate live. It uses the exact tokens,
typography, and motion principles documented in
[`../../docs/DESIGN-SYSTEM.md`](../../docs/DESIGN-SYSTEM.md).

## Why this lives in `marketing/video/`

The framework's hard rule #4 forbids **broad dependencies in app code**.
Remotion + React + a build chain are decidedly broad — they belong nowhere
near the cockpit runtime. So this project is **fully isolated**: its
`package.json`, `node_modules/`, and TypeScript config live here and only
here. `maddu doctor` does not scan it. Nothing it produces gets imported
back into `template/`.

The render output (an MP4 / GIF) lands in `../../brand/screenshots/` so
the root README can reference it via a relative path that survives
`npm publish` (the root `package.json`'s `files:` block already includes
`brand/` indirectly via the project layout).

## Prerequisites

- **Node ≥ 18** (Remotion 4.x requires this).
- **FFmpeg** on `PATH`. Remotion bundles its own as a fallback, but a
  system FFmpeg is faster.
- **Chromium / Chrome** — Remotion downloads Headless Shell automatically
  on first install, no extra step needed.
- ~500 MB of disk for `node_modules/` and the headless browser.

## Install

Run **one command per line** (PowerShell treats `#` as part of the command,
not as a comment marker, so don't paste inline `#`-style notes from elsewhere
in this doc):

```powershell
cd marketing/video
npm install
```

Bash / zsh works the same way:

```bash
cd marketing/video
npm install
```

First install takes ~1–2 minutes — Remotion downloads its bundled Chromium
headless build (~150 MB) and resolves React + the TypeScript toolchain.
Subsequent installs reuse the cache.

If the install ever errors with `ETARGET / No matching version found`, the
package.json may have pinned a published version that's since been removed.
Bump the affected line to `"^4.0.0"` (or whatever the current major is) and
retry.

## Live-edit in the studio

```bash
npm start
```

Opens the Remotion Studio at `http://localhost:3000`. You can scrub the
timeline, hot-reload component changes, and preview at full quality
without rendering. Best mode while you're polishing.

## Render to MP4 (for the README)

```bash
npm run render
```

Output: `../../brand/screenshots/cockpit-demo.mp4`
Resolution: 1920×1080, 30 fps, H.264 + AAC, yuv420p, BT.709.
Render time: ~30–90 seconds on a modern laptop, single-core.

For a faster preview pass, add `--concurrency=4` (uses more RAM).

## Render to GIF (fallback for inline rendering)

GitHub README supports `<video>` tags but loops + autoplay work best with
GIFs. If you want a loop-friendly preview, render the GIF variant:

```bash
npm run render:gif
```

Output: `../../brand/screenshots/cockpit-demo.gif`
Half resolution (960×540) so the GIF stays under ~10 MB. Adjust
`--scale=` in `package.json` if you want a different size.

## Render a poster frame (static fallback)

If you want a single still — useful as the `<video poster=…>` attribute
or for social previews — render frame 240 (the BOSS-proposal moment):

```bash
npm run render:still
```

Output: `../../brand/screenshots/cockpit-poster.png`, 1920×1080 PNG.

## Project layout

```
marketing/video/
├─ package.json          Remotion + React deps (isolated)
├─ tsconfig.json
├─ remotion.config.ts    pixel format / codec / color space
└─ src/
   ├─ Root.tsx           composition registry
   ├─ Composition.tsx    the 6-scene story
   ├─ tokens.ts          mirror of cockpit.css brand tokens
   └─ components/
      ├─ CockpitFrame.tsx   navy canvas + rail + stage + composer
      └─ Pieces.tsx         Panel · KpiStrip · NextCommand · ProposalCard
                            · LearningFact · PaletteOverlay · Pill · Caption
```

Every visual element is built as a React component that mirrors the
cockpit's `cockpit.css` selectors — same colors, same typography, same
radii, same border-line treatment. **There are no images in the video**;
everything is rendered live from React/CSS so it stays in sync with the
design system.

## Scene breakdown

22 s × 30 fps = 660 frames, six scenes:

| Frames | Time | Scene |
|---|---|---|
| 0–89   | 0–3 s   | **Cold cockpit.** Empty Conductor with the first-run banner. |
| 90–209 | 3–7 s   | **Command palette.** `Ctrl+K`, cursor types "claim", result row highlights. |
| 210–359| 7–12 s  | **Lane claimed.** KPI count-up from 0 → 1; the Next Command strip appears. |
| 360–449| 12–15 s | **BOSS proposal.** Card slides up; Enforcer cites `claim_ok`; APPROVED stamps in. |
| 450–569| 15–19 s | **Slice-stop.** 900 ms lime line traces across; a Hindsight `rule` fact pops in. |
| 570–659| 19–22 s | **Closing card.** Brand mark, tagline, install command, the three identity pills. |

To change the timing, edit the `SCENES` map in `src/Composition.tsx`.

## Updating the video when the cockpit changes

1. Update the relevant token / component in
   `../../template/maddu/cockpit/cockpit.css` first.
2. Mirror the change in `src/tokens.ts` (colors) or
   `src/components/Pieces.tsx` (component anatomy).
3. Verify in `npm start` (Remotion Studio).
4. Re-render: `npm run render`.
5. Commit the new `brand/screenshots/cockpit-demo.mp4` alongside the
   cockpit + tokens change.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not find Chrome` | `npx remotion browser ensure` |
| Render is dark / wrong colors | Check `pixelFormat` in `remotion.config.ts` is `yuv420p` and `colorSpace` is `bt709`. Some players ignore other combinations. |
| Font fallback looks wrong | Plex fonts aren't loaded — render uses system fallbacks (Inter / Helvetica / JetBrains Mono / Consolas). To embed Plex, add `@font-face` rules at the top of `src/Composition.tsx` pointing to the WOFF2 files in `../../brand/`. |
| `cockpit-demo.mp4` too large for GitHub README | GitHub renders MP4 inline up to ~10 MB. Use `npm run render:gif` or drop the bitrate via `--codec=h264 --crf=28`. |

## License

Apache-2.0, same as the rest of Máddu.
