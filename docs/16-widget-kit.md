# Widget kit

The cockpit ships a small pure-SVG widget library — no chart dependency
(rule #4: no broad new dependencies). All widgets are defined in
`maddu/cockpit/cockpit-widgets.js` (one of the cockpit's vanilla ES
modules) and styled by `cockpit.css`. They read tone colors from the cockpit's token palette
(`--m-ok`, `--m-warn`, `--m-danger`, `--m-accent`, `--m-accent-2`,
`--m-fg-3`), so they automatically match the rest of the interface.

This page is for plugin authors and anyone extending the cockpit. End
users don't need to know any of this — they'll just see the widgets in
context.

## Why no chart library

Three reasons:

1. **Hard rule #4** — no broad dependencies. A chart library would pull
   in 50–300 KB of code Máddu doesn't otherwise need.
2. **Token alignment** — every widget reads CSS custom properties, so
   theme changes happen in one place (`cockpit.css` `:root`).
3. **Auditability** — the cockpit is a set of small vanilla ES modules
   (the widgets live in `cockpit-widgets.js`). You can read every line of
   the widget code without leaving the cockpit tree.

## Tones

Every widget that draws colored marks accepts a `tone` field:

| Tone        | CSS var          | Typical meaning                          |
|-------------|------------------|------------------------------------------|
| `ok`        | `--m-ok`         | Healthy / running / accepted / done      |
| `warn`      | `--m-warn`       | Attention needed / blocked / unread      |
| `danger`    | `--m-danger`     | Stuck / rejected / hard error            |
| `accent`    | `--m-accent`     | Interactive / primary action / pending   |
| `blue`      | `--m-accent-2`   | Informational / time-series / neutral hi |
| `neutral`   | `--m-fg-3`       | Inert / disabled / cancelled             |

Unknown tones fall back to `neutral`.

## Widgets

### `bigStat(value, label, opts)`

Large numeric tile. Used as the building block for `statusGrid()`.

```js
bigStat(42, 'Open tasks', { tone: 'warn', trend: '+3' });
```

Options:
- `tone` — color of the number.
- `trend` — string rendered as a chip after the number. If it starts
  with `+` it gets the `.up` styling (green); `-` gets `.down` (red).
- `spark` — array of numbers; if present a sparkline is rendered under
  the label.

### `statusGrid(tiles)`

Responsive grid of `bigStat` tiles. Each tile object accepts the same
fields as `bigStat` plus an optional `onClick` handler — when set, the
tile gets a hover state and routes the click.

```js
statusGrid([
  { value: counts.events, label: 'Events', tone: 'blue',
    onClick: () => location.hash = '#/events' },
  { value: counts.stuckWorkers, label: 'Stuck workers',
    tone: counts.stuckWorkers > 0 ? 'danger' : 'ok' }
]);
```

### `bar(pct, label, opts)`

Single horizontal progress fill. `pct` accepts either `0..1` or
`0..100` (the helper detects which). Options: `tone`, `right` (string
shown on the right side of the row; defaults to "N%").

```js
bar(0.62, 'Schedules enabled', { tone: 'accent' });
```

### `meter(value, max, label, opts)`

Convenience wrapper around `bar()` that renders the right-side label
as `value / max`. Tone defaults to `warn` when `value >= max`,
otherwise `accent`.

```js
meter(counts.mcpEnabled, counts.mcp, 'MCP servers enabled', { tone: 'blue' });
```

### `segBar(segments)`

Stacked-segment distribution bar with a legend below. Each segment is
`{ label, value, tone }`. Widths are computed as percentages of the
sum; zero-value segments are omitted from the track but still appear
in the legend.

```js
segBar([
  { label: 'framework', value: 12, tone: 'accent' },
  { label: 'session',   value: 34, tone: 'blue' },
  { label: 'lane',      value:  8, tone: 'ok' }
]);
```

### `donut(segments, opts)`

SVG donut chart with right-side legend. Defaults: `size: 140`,
`stroke: 18`, center label = total.

```js
donut([
  { label: 'running', value: 4, tone: 'ok' },
  { label: 'stuck',   value: 1, tone: 'danger' },
  { label: 'exited',  value: 7, tone: 'neutral' }
], { centerLabel: 'workers' });
```

Options:
- `size` — outer SVG square (pixels).
- `stroke` — ring thickness.
- `center` — center label (defaults to the total).
- `centerLabel` — small uppercase caption below the center number.

### `sparkline(values, opts)`

Inline SVG line+area chart. No axes, no labels — pure shape.

```js
sparkline([0,1,3,2,4,7,5,2], { tone: 'blue', width: 120, height: 28 });
```

Options:
- `width`, `height` — SVG box size.
- `tone` — line + area color.
- `fill` — set `false` to draw a line only (no area).

### `binByTime(events, n, fieldOrFn, windowMs)`

Helper for sparklines that consume time-series data. Buckets events
into `n` slots over the trailing `windowMs`. `fieldOrFn` is either the
name of a timestamp field on each event (default `'createdAt'`) or a
function that returns a numeric timestamp.

```js
const bins = binByTime(events, 24, 'ts', 60 * 60 * 1000);
sparkline(bins, { tone: 'blue', width: 480, height: 56 });
```

## Composing summaries

The standard summary panel pattern in Máddu cockpit:

```js
const summary = el('div', {
  style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;'
});
summary.appendChild(donut([...]));
summary.appendChild(statusGrid([...]));
panelMount.appendChild(panel('Summary', 'sub-title', summary));
```

For routes with a strong time-series story (`/operations`,
`/dashboard`, `/events`), swap one of the columns for `sparkline()`
inside a styled wrapper:

```js
const wrap = el('div', { class: 'widget-stat' });
wrap.appendChild(el('div', { class: 'widget-stat-num' }, [
  el('span', { class: 'widget-stat-value' }, String(total)),
  el('span', { class: 'widget-stat-trend up' }, `+${delta} in 24h`)
]));
wrap.appendChild(el('div', { class: 'widget-stat-label' }, '7-day trend'));
wrap.appendChild(sparkline(bins, { tone: 'accent', width: 480, height: 56 }));
```

## Where each widget appears today

| Route          | Widget                                                |
|----------------|-------------------------------------------------------|
| `/dashboard`   | 6 status tiles · donut pair · sparkline · segBar · meters |
| `/operations`  | 7-day slice-stop sparkline                            |
| `/approvals`   | decision donut + 4-tile grid                          |
| `/tasks`       | status donut + 4-tile grid                            |
| `/swarm`       | worker donut + 4-tile grid                            |
| `/skills`      | 4-tile grid + top-6 tag bars                          |
| `/events`      | activity sparkline + type segBar                      |
| `/mailbox`     | 4-tile grid + top-6 unread bars                       |
| `/imports`     | donut + meters by kind                                |
| `/auth`        | 4-tile grid + per-provider key bars                   |
| `/schedule`    | enabled donut + fire totals grid                      |
| `/mcp`         | transport donut + 4-tile grid                         |
| `/runtimes`    | detected donut + capability meters                    |
| `/docs`        | section donut + counts grid                           |

## Adding a new widget

1. Define it as a function near the existing kit in `cockpit-widgets.js`.
2. Style it under the `Widget kit` section of `cockpit.css`. Use
   token vars only — never hard-code hex.
3. Add a row to the appearance table above and a usage example to
   this page.
4. Resist the urge to import a chart library, even for "just this one
   thing." See [hard rules](hard-rules.md) rule #4.
