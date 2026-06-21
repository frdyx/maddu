# Máddu design system

This document is the canonical reference for how Máddu looks, moves, and reads.

The cockpit's working stylesheet is `template/maddu/cockpit/cockpit.css`. Every
token, scale, and class documented here exists in that file. When a token
changes, change it there first; this doc names every one of them by name.

---

## Brand essence

| Axis | Choice |
|---|---|
| Aesthetic | **Scandinavian sci-fi dark noir.** Restrained density, generous letter-spacing, no maximalism. |
| Mood | Calm command-control. The operator is in charge; the cockpit reports, suggests, refuses — never demands attention. |
| Reference | Black-monitor terminals from late-stage cyberpunk · Plex Mono's IBM serif lineage · the muted lime of an oscilloscope · the deep navy of a watch dial at 3 a.m. |
| Forbidden | Purple gradients on white. Skeuomorphic shadows. Glassmorphism. Confetti. Toast spam. Emoji-as-UI. |

**One-sentence test:** if a UI element would feel at home on the chrome of a
1990s mission console with a fresh coat of paint, it's on-brand. If it would
feel at home in a 2020s consumer mobile app, it's off-brand.

---

## Color tokens

All colors live as CSS custom properties under `:root` in `cockpit.css`. Use
them by name; never hex-code a brand value inline.

### Canvas + shell (the void everything floats over)

| Token | Value | Where |
|---|---|---|
| `--m-bg-0` | `#050B17` | Page canvas — the visible stage. The single non-transparent dark. |
| `--m-bg-1` | `rgba(0,8,18,0.54)` | Rail · stage chrome — lifted one notch over canvas. |
| `--m-bg-2` | `rgba(3,14,30,0.28)` | Section / panel bodies. |
| `--m-bg-3` | `rgba(4,18,38,0.34)` | Nested cards · focused rows · panel borders. |
| `--m-bg-4` | `rgba(86,184,255,0.055)` | Hover halo — cool-blue glow tint. |
| `--m-bg-true-black` | `#000000` | Escape hatch when something must read as the absolute terminal. |

### Foreground (the text scale)

| Token | Value | Where |
|---|---|---|
| `--m-fg-0` | `#E8E6E3` | Primary text — labels, headings, active route. |
| `--m-fg-1` | `#B8B2AA` | Secondary body text — paragraphs, descriptions. |
| `--m-fg-2` | `#8A8A8A` | Inline meta — labels, captions on row chrome. |
| `--m-fg-3` | `#6a7079` | Hints, placeholders, hover-only labels. |
| `--m-fg-4` | `#3a3e45` | Decorative dimming — glyphs at rest, deep meta. |

### Lines (subtle separations)

| Token | Value | Where |
|---|---|---|
| `--m-line`      | `rgba(80,113,149,0.36)` | Strong border for panels, tab strips. |
| `--m-line-soft` | `rgba(80,113,149,0.18)` | Soft separator between row groups. |

### Brand accents (used sparingly)

| Token | Value | Hex | Where |
|---|---|---|---|
| `--m-accent`     | lime         | `#D0FF00` | **Interactive · primary CTA · active state.** Reserved. |
| `--m-accent-2`   | electric blue| `#56B8FF` | **Info · BOSS voice · secondary action.** |
| `--m-accent-dim` | dim lime     | `rgba(208,255,0,0.45)` | Hover halo on buttons. |
| `--m-brand`      | orange       | `#F04E23` | **Brand mark only.** Never used as an interactive color. |

### State colors

| Token | Value | Hex | Where |
|---|---|---|---|
| `--m-ok`     | sea-green | `#6FA8A2` | Approved, healthy, progressing. |
| `--m-warn`   | amber     | `#F2BD5C` | Parked, awaiting, drift. |
| `--m-danger` | rose      | `#FF5E7A` | Refused, broken, stuck. |
| `--m-signal` | alias of `--m-ok` | — | Live indicator dot. |

### Tinted backgrounds (state-aware container fills)

| Token | Value | Pairs with |
|---|---|---|
| `--m-warn-bg`           | `rgba(242,189,92,0.10)` | `--m-warn-border` |
| `--m-warn-border`       | `rgba(242,189,92,0.38)` | for parked / warning panels |
| `--m-danger-bg`         | `rgba(255,94,122,0.10)` | `--m-danger-border` |
| `--m-danger-border`     | `rgba(255,94,122,0.40)` | for refused proposals |
| `--m-accent-glow-bg`    | `rgba(208,255,0,0.05)`  | for primary panels at rest |
| `--m-accent-2-glow-bg`  | `rgba(86,184,255,0.06)` | for BOSS / info panels |

**Lime discipline.** Lime is rare on purpose. The eye locks onto it. Use for:
the one expected action per panel · the active group tick on the rail · the
slice-stop motion · the focus ring on inputs and buttons · highlight bars on
score-matrix rows that are "healthy." That's it.

---

## Typography

Three fonts. All IBM Plex.

| Family | CSS var | Where |
|---|---|---|
| **IBM Plex Sans Condensed** | `--m-font-cond` | Headings, labels, group titles, panel titles. The cockpit's voice. |
| **IBM Plex Sans** | `--m-font-sans` | Body prose, fact text, slice-stop bodies. Readability mode. |
| **IBM Plex Mono** | `--m-font-mono` | All IDs, timestamps, chrome, meta, code, status. Terminal mode. |

**Fallback stack** (when Plex isn't loaded — GitHub README, no-network installs):
- Sans Condensed → `'Inter', 'Helvetica Neue', sans-serif`
- Sans → `'Inter', sans-serif`
- Mono → `'JetBrains Mono', 'Consolas', monospace`

### Scale

| Token | Px | Where |
|---|---|---|
| `--m-type-xs`     | 11 | Chrome captions, panel asides |
| `--m-type-sm`     | 12 | Body, ledger rows, inputs |
| `--m-type-body`   | 13 | Card titles, route descriptions |
| `--m-type-row`    | 15 | Composer, palette input |
| `--m-type-h3`     | 15 | Panel titles |
| `--m-type-h2`     | 18 | Route titles |
| `--m-type-h1`     | 28 | Page-hero `<h2>` in views |
| `--m-type-metric` | 30 | KPI numbers, donut centers |

### Tracking + weight

- Condensed labels: `letter-spacing: 0.04em` (body) / `0.06em` (route titles) / `0.10em` (group heads, chrome chips) / `0.14em` (uppercase tags inside panels).
- Mono never gets extra letter-spacing.
- Plex Sans body: `letter-spacing: 0`.
- Bold weight is `600`; the cockpit never uses 700+.

### Letter-case

| When | Case |
|---|---|
| Route titles | `UPPERCASE` |
| Group heads | `UPPERCASE` |
| Panel titles | `UPPERCASE` |
| Pills / chips | `UPPERCASE` |
| Card titles, prose, slice-stop summaries | Sentence case |
| IDs, ts, code, lane names | as-is, mono |

---

## Spacing + scale

The cockpit doesn't use a 4 / 8 grid religiously — but most paddings land on
**4, 6, 8, 10, 12, 14, 16, 18, 24, 32** pixels. Add new spacing only at these
stops unless there's a measured reason.

| Token | Value | Where |
|---|---|---|
| `--m-rail-w`  | `240px` | Desktop rail. Shrinks to `64px` ≤ 1279 px and `0` ≤ 767 px. |
| `--m-head-h`  | `56px`  | Sticky stage header. |
| `--m-foot-h`  | `36px`  | Sticky stage footer (composer). |
| `--m-dock-h`  | `64px`  | Mobile bottom dock. |
| `--m-radius-md` | `6px` | Default panel + button radius. |

Panel internal padding: `12 14` (compact), `16 18` (default), `20 22` (hero). Vertical
gap between sibling panels: `12px` desktop, `10px` mobile.

---

## Lines + borders

- **Default panel border:** `1px solid var(--m-bg-3)`. Subtle, almost
  invisible at rest. The panel reads as a *region* of the canvas, not a
  raised tile.
- **Active panel border** (hover, focus, palette result): `1px solid var(--m-accent)`.
- **Strong divider** between major regions: `1px solid var(--m-line)`.
- **Soft separator** between rows inside a panel: `1px solid var(--m-line-soft)`.
- **Border radius**: 6 px on panels, 4 px on buttons and inputs, 2 px on
  pills and small chips. Never use `border-radius: 50%` (donuts use SVG
  arcs, badges use 7 px stadium).

### Glow-reactive borders (signature law)

**Wherever a surface carries a corner or edge glow, its border tints toward
that glow's hue along the same edge.** Glow and border must read as one light
source — a card lit electric-blue in its top-right corner has a border that
warms to electric blue *in that same corner*; a lime-lit corner gets a lime
border. The stretch of border between lit corners stays neutral steel-blue
(`--m-line` / `--m-bg-3`).

- **Why.** An untinted border running alongside a colored glow looks like two
  unrelated effects pasted together. Tinting the shared edge fuses them — the
  panel reads as *lit*, not *decorated*. This is the same lit-cabin logic as
  the `body::before` atmosphere, applied at the panel scale.
- **How.** Render the border as a gradient with the `padding-box` /
  `border-box` background trick: a 1 px transparent border over two stacked
  backgrounds — the fill clipped to `padding-box`, a directional gradient
  (`to top right`, etc.) clipped to `border-box`, brightening to the accent
  only at the lit corners. Register the edge-tint custom properties with
  `@property { syntax: "<color>" }` so the tint can animate on hover in step
  with the glow.
- **Coherence rule.** The glow corners and the bright stops of the border
  gradient always point the same way. Move a glow, move the border tint with
  it — the two are specified *together*, never independently. A glow with a
  flat border, or a tinted border with no matching glow, is a bug.

Reference implementation: `.m-card` in the marketing landing page (lives in the
`maddu-site` repo, served at `maddu.frdyx.com`) — electric-blue top-right, lime
bottom-left, matching its dual-corner glow exactly. Cockpit panels that carry a
corner glow adopt the same pairing.

---

## Motion

Eight rules. All durations honor `prefers-reduced-motion: reduce` via the
global kill switch in `cockpit.css` (zeroes every animation + transition
duration in one rule).

| Rule | Duration | Easing |
|---|---|---|
| Color / border / opacity transitions | `120 ms` | linear (CSS default) |
| Panel slide / drawer open | `180–220 ms` | `cubic-bezier(0.2, 0.7, 0.2, 1)` |
| Route view fade-in (per route change) | `180 ms` | `cubic-bezier(0.2, 0.7, 0.2, 1)` |
| Focus-flash on panel (after palette commit) | `1600 ms` | `cubic-bezier(0.2, 0.7, 0.2, 1)` |
| Skeleton shimmer | `1400 ms` | `linear`, `infinite` |
| The slice-stop line | `~900 ms` | `cubic-bezier(0.2, 0.7, 0.2, 1)` |
| KPI count-up (one-shot per visit) | `400 ms` | ease-out |
| Pulse-on-content-change (banner) | `1500 ms` | one shot |

**The slice-stop line** is the cockpit's signature motion. A single 2 px lime
line traces left → right across the very top of the viewport in ~900 ms and
dissolves. It fires once per `SLICE_STOP` event, from every route, and it is
the *only* motion that fires from a spine event. Nothing else competes.

**Banned motion patterns:** scaling on hover, rotating glyphs, infinite-loop
shimmer on stable content, toast queues, confetti bursts, parallax on scroll,
spring physics, anything > 220 ms on a hover.

---

## Components

Each component is documented here as **anatomy → tokens used → states**. Every
one of these exists in `cockpit.css` and is reproduced faithfully in the
marketing video components.

### Rail group

The left-rail building block. One per phase-of-work cluster.

| Part | Token |
|---|---|
| Group head text | `--m-fg-3` · `--m-font-cond` · 10 px · `letter-spacing: 0.14em` · uppercase |
| Tick (lime, 2 px wide × 10 px tall) | `--m-accent` — only when the group contains the active route |
| Group glyph (left of label) | `--m-fg-4` at rest, `--m-accent` when has-active |
| Chevron (right of label) | `--m-fg-4` · rotated 90° when expanded |
| Route row | `--m-fg-2` at rest · `--m-fg-0` on hover/active · 2 px left gutter (`--m-accent`) on active |
| Anchor glyph (◆) | `--m-accent-2` (filled) on anchors · `--m-fg-4` (◇ outline) on satellites |
| Active-route background | `--m-bg-2` |
| Badge (e.g. Approvals count) | `rgba(242,189,92,1)` fill · text on `--m-bg-0` · 14 px tall stadium |

### KPI tile

The Conductor and Roadmap KPI strip. Always 4 across on desktop.

| Part | Token |
|---|---|
| Outer | `--m-bg-1` fill · 1 px border in the metric's tone color · 8 px radius |
| Metric number | `--m-font-cond` · 30 px · `font-weight: 600` · tone color |
| Label | `--m-font-mono` · 10 px · `letter-spacing: 0.08em` · uppercase · `--m-fg-3` |
| Sub-line | `--m-font-mono` · 11 px · `--m-fg-2` |
| Tone variants | `tone-accent` (lime) · `tone-blue` (info) · `tone-warn` (parked) · `tone-ok` (healthy) |

### Panel

The universal container.

```
.panel
├─ .panel-head
│  ├─ .panel-title    (Plex Cond, 13 px, 600, uppercase, --m-fg-0)
│  └─ .panel-aside    (Plex Mono, 10 px, --m-fg-3 — meta on the right)
└─ .panel body content
```

Outer: `--m-bg-1` fill · `1 px solid --m-bg-3` · 6 px radius · 14 px head padding · 16 px body padding.

### Button — base

| Part | Token |
|---|---|
| Family | `--m-font-mono` · 11 px · uppercase · `letter-spacing: 0.06em` |
| Color (rest) | `--m-fg-0` · `--m-bg-2` fill · `--m-bg-3` border |
| Hover | border + color lift to `--m-accent` |
| Focus-visible | `--m-accent` border + 2 px lime ring at 28 % opacity |
| Active (press) | `translateY(0.5px)` |
| Disabled | `opacity: 0.45` · `cursor: not-allowed` |

### Button modifiers

| Modifier | When | Color |
|---|---|---|
| `.is-primary` | The one expected action per panel | `--m-accent` fill · `--m-bg-0` text. Reserved. |
| `.is-danger`  | Destructive (Disable, Remove, Reject) | `--m-danger` text + border |
| `.is-ghost`   | Inline icon-style button, no border at rest | transparent → `--m-bg-2` on hover |

### Input

`<input>` / `<textarea>` / `.m-input` / `.lanes-edit-input` share one baseline:

| Part | Token |
|---|---|
| Family | `--m-font-mono` · 12 px |
| Fill | `--m-bg-0` |
| Border | 1 px `--m-bg-3`, hover lifts to `--m-fg-4` |
| Focus | `--m-accent` border + 2 px lime ring at 22 % opacity |
| Placeholder | `--m-fg-4` |
| Native `<select>` | `appearance: none` · custom SVG chevron in `--m-accent` · option list tinted to brand on Chromium |

### Pill / chip

Used for tones (active / parked / refused), keys (kind: rule / discovery), and counters.

| Part | Token |
|---|---|
| Outer | tone color fill at 10 % opacity · tone color border at 70 % opacity · 2 px radius |
| Text | `--m-font-mono` · 9 px · uppercase · `letter-spacing: 0.06–0.08em` · tone color |

### Inspector

Persistent right-side detail panel.

```
.inspector
├─ .inspector-head    (titles + close button)
├─ .inspector-tabs    (Overview · Evidence · Actions · Related · Raw)
└─ .inspector-body    (renders tabs[active])
```

| Viewport | Behavior |
|---|---|
| ≥ 1440 px | Persistent — sits beside the stage; `#app.inspector-open .stage { padding-right: 380px }`. |
| 1024–1439 px | Slide-over with backdrop scrim. Stage doesn't reserve space. |
| < 1024 px | Bottom sheet (78 vh max) with rounded top corners and upward shadow. |

Tabs use a 2 px lime underline on the active tab; inactive tabs sit at `--m-fg-2`.

### Palette result row

| Kind | Glyph | Glyph color | When |
|---|---|---|---|
| Route (anchor) | `◆` | `--m-accent-2` | Top-level destination, depth-upgrade signature |
| Route (regular) | `◇` | `--m-fg-3` | Top-level destination |
| Sub-target | `▸` | `--m-accent` | A specific panel inside a host route |
| Action | `▷` | `--m-accent-2` | A verb the cockpit can run directly |

Active row: `--m-bg-2` fill · `--m-accent` border · same lime glyph color.

### Proposal card (BOSS)

| Risk pill | Border | Background fill |
|---|---|---|
| `LOW RISK` | `--m-ok` 100 % | `rgba(111,168,162,0.06)` |
| `MEDIUM RISK` | `--m-warn` 100 % | `rgba(242,189,92,0.06)` |
| `HIGH RISK` | `--m-warn` 100 % | `rgba(242,189,92,0.08)` |
| `REFUSED` | `--m-danger` 100 % | `rgba(255,94,122,0.06)` |

When refused, the card carries an `enforcer:` line citing
`docs/hard-rules.md#<slug>` in `--m-accent-2` (electric blue).

### Empty + skeleton + error states

| Helper | When | Layout |
|---|---|---|
| `placeholder(name, hint)` | Empty panel | Quieted `◌` glyph · Plex Cond title · 380 px hint |
| `loading(text)` | Default loader | 3 stacked shimmer lines · mono caption underneath |
| `loadingFor('kpi'  )` | Pre-fill of KPI strip | Horizontal strip of 4 tiles with shimmer |
| `loadingFor('grid' )` | Pre-fill of card grid (Agents, Teams) | 6-card responsive grid |
| `loadingFor('table')` | Pre-fill of ledger / index | 5 row stripes with cell shimmers |
| `loadingFor('donut')` | Pre-fill of summary block | Donut + 4 meter lines |
| `errorState(t, d)` | Explicit error | Same shape as `placeholder` with `--m-danger` glyph + title |

---

## Layout primitives

### Three-pose responsive shell

| Viewport | Rail | Stage | Inspector |
|---|---|---|---|
| ≥ 1440 px | 240 px grouped rail | Stage padded right for persistent Inspector | Persistent |
| 1280–1439 px | 240 px grouped rail | Full-width stage | Slide-over with scrim |
| 768–1279 px | 64 px collapsed rail (glyphs + hover-label flyouts) | Full-width stage | Slide-over with scrim |
| < 768 px | Hidden (replaced by bottom dock) | Full-width stage with 12 px body padding | Bottom sheet |

### Stage rhythm

A route page reads top → bottom as:

```
<h2>RouteName</h2>
<p>One-line description.</p>
[ optional KPI strip ]
[ panel · panel · panel … ]
```

Vertical gap between top-level children: 16 px. Inside a panel, between
sibling rows: 6–10 px. Never more than 24 px of vertical air without content.

### Scrollbars

Universal styling via `*` selector — 8 px wide, transparent track,
`--m-bg-3` thumb with 2 px padding-box border, hovers to `--m-accent-2`.
Tab strips (`.inspector-tabs`, `.wb-tabs`, `.h-scroll`) hide their
scrollbar entirely. Main-content scrollers use `scrollbar-gutter: stable`
so content doesn't shift when the scrollbar appears.

---

## Accessibility

- Every interactive element exposes a focus-visible ring (lime, 2 px, 22–28 %
  opacity halo).
- All animations honor `prefers-reduced-motion: reduce` via a global kill
  switch.
- Color is never the only signal — tone pills carry uppercase text labels in
  addition to the tone color.
- Keyboard contract:
  - `Ctrl + K` / `⌘ K` — command palette.
  - `?` — Docs popup.
  - `Esc` — close palette / dock sheet / Inspector / first-run banner.
  - `↑ ↓` — palette result navigation.
  - `Enter` — commit palette result.
- Cards opened in the Inspector carry `role="button"` and `tabindex="0"`.
- Charts (sparklines, donuts, meters) have an accessible label via
  `<title>` and `aria-label` on the parent SVG.

---

## Keeping this in sync

When the cockpit's CSS shifts, update this doc first, then update the token
in `template/maddu/cockpit/cockpit.css` to match. The two must always agree;
if they disagree, the CSS wins because that's what ships.
