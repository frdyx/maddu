// cockpit-widgets.js — the cockpit widget kit (extracted from cockpit.js, v1.35.0).
//
// All widgets are pure inline SVG / DOM — no chart library (rule #4: no
// broad new deps). They take data and return DOM nodes you can drop into a
// panel body; they hold no cockpit state, so this is a leaf module depending
// only on `el` (from cockpit-util.js) and the DOM. Tones map to token CSS vars:
//   ok     → --m-ok        warn  → --m-warn      danger → --m-danger
//   accent → --m-accent    blue  → --m-accent-2  fg-3   → --m-fg-3 (neutral)
//
// `statusGrid`, `bar`, `segBar`, `donut`, `sparkline`, `meter`, `binByTime`
// are the public API consumed by the route views; `toneColor`, `svg`, `bigStat`
// are module-internal helpers.

import { el } from './cockpit-util.js';

const TONE_VAR = {
  ok: 'var(--m-ok)',
  warn: 'var(--m-warn)',
  danger: 'var(--m-danger)',
  accent: 'var(--m-accent)',
  blue: 'var(--m-accent-2)',
  neutral: 'var(--m-fg-3)'
};
function toneColor(t) { return TONE_VAR[t] || TONE_VAR.neutral; }

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(c);
  }
  return node;
}

/**
 * Large stat tile.  bigStat(value, label, { trend?, tone?, spark? })
 *   trend: '+12%' / '-3' etc; rendered as a chip after the number
 *   tone:  color of the number (default fg-0)
 *   spark: optional array of numbers → renders a sparkline under the label
 */
function bigStat(value, label, opts = {}) {
  const { trend, tone, spark } = opts;
  const wrap = el('div', { class: 'widget-stat' });
  const numLine = el('div', { class: 'widget-stat-num' });
  const num = el('span', { class: 'widget-stat-value', style: tone ? `color:${toneColor(tone)}` : '' }, String(value));
  numLine.appendChild(num);
  if (trend) {
    const t = el('span', { class: 'widget-stat-trend' }, trend);
    if (typeof trend === 'string' && trend.startsWith('+')) t.classList.add('up');
    if (typeof trend === 'string' && trend.startsWith('-')) t.classList.add('down');
    numLine.appendChild(t);
  }
  wrap.appendChild(numLine);
  wrap.appendChild(el('div', { class: 'widget-stat-label' }, label));
  if (spark && spark.length) wrap.appendChild(sparkline(spark, { tone: tone || 'blue' }));
  return wrap;
}

/**
 * Status grid — N tiles in a responsive grid.
 *   tiles: [{ value, label, tone?, trend?, spark?, onClick? }]
 */
export function statusGrid(tiles) {
  const wrap = el('div', { class: 'widget-grid' });
  for (const t of tiles) {
    const tile = bigStat(t.value, t.label, t);
    if (t.onClick) {
      tile.classList.add('clickable');
      tile.addEventListener('click', t.onClick);
    }
    wrap.appendChild(tile);
  }
  return wrap;
}

/**
 * Horizontal progress fill row.
 *   bar(pct, label, { tone?, right? })  — pct in 0..1 or 0..100
 */
export function bar(pct, label, opts = {}) {
  const { tone = 'accent', right } = opts;
  const v = Math.max(0, Math.min(100, pct > 1 ? pct : pct * 100));
  const row = el('div', { class: 'widget-bar' });
  const head = el('div', { class: 'widget-bar-head' }, [
    el('span', { class: 'widget-bar-label' }, label),
    el('span', { class: 'widget-bar-right' }, right != null ? String(right) : `${Math.round(v)}%`)
  ]);
  const track = el('div', { class: 'widget-bar-track' });
  const fill = el('div', { class: 'widget-bar-fill', style: `width:${v}%; background:${toneColor(tone)}` });
  track.appendChild(fill);
  row.appendChild(head);
  row.appendChild(track);
  return row;
}

/**
 * Stacked distribution row (single track, multi-segment).
 *   segBar([{ label, value, tone }])
 */
export function segBar(segments) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0) || 1;
  const wrap = el('div', { class: 'widget-segbar' });
  const track = el('div', { class: 'widget-segbar-track' });
  for (const s of segments) {
    const w = ((s.value || 0) / total) * 100;
    if (w <= 0) continue;
    const seg = el('div', {
      class: 'widget-segbar-seg',
      style: `width:${w}%; background:${toneColor(s.tone)}`,
      title: `${s.label}: ${s.value}`
    });
    track.appendChild(seg);
  }
  wrap.appendChild(track);
  const legend = el('div', { class: 'widget-segbar-legend' });
  for (const s of segments) {
    legend.appendChild(el('span', { class: 'widget-segbar-chip' }, [
      el('span', { class: 'widget-segbar-dot', style: `background:${toneColor(s.tone)}` }),
      document.createTextNode(`${s.label} ${s.value}`)
    ]));
  }
  wrap.appendChild(legend);
  return wrap;
}

/**
 * Donut chart (SVG).
 *   donut([{label, value, tone}], { size?, hole?, center? })
 *   center: optional center label (string) — defaults to total
 */
export function donut(segments, opts = {}) {
  const size = opts.size || 140;
  const stroke = opts.stroke || 18;
  const r = (size - stroke) / 2;
  const cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + (x.value || 0), 0);
  const wrap = el('div', { class: 'widget-donut' });
  const s = svg('svg', { width: String(size), height: String(size), viewBox: `0 0 ${size} ${size}` });
  // Background ring
  s.appendChild(svg('circle', { cx: String(cx), cy: String(cy), r: String(r), fill: 'none', stroke: 'var(--m-bg-3)', 'stroke-width': String(stroke) }));
  if (total > 0) {
    let offset = 0;
    for (const seg of segments) {
      const v = seg.value || 0;
      if (v <= 0) continue;
      const len = (v / total) * C;
      const arc = svg('circle', {
        cx: String(cx), cy: String(cy), r: String(r),
        fill: 'none',
        stroke: toneColor(seg.tone),
        'stroke-width': String(stroke),
        'stroke-dasharray': `${len} ${C - len}`,
        'stroke-dashoffset': String(-offset),
        transform: `rotate(-90 ${cx} ${cy})`
      });
      const title = svg('title', {});
      title.textContent = `${seg.label}: ${v}`;
      arc.appendChild(title);
      s.appendChild(arc);
      offset += len;
    }
  }
  // Center label
  const center = opts.center != null ? opts.center : String(total);
  const cText = svg('text', {
    x: String(cx), y: String(cy + 5),
    'text-anchor': 'middle',
    'font-family': "'IBM Plex Sans Condensed', sans-serif",
    'font-weight': '600',
    'font-size': '24',
    fill: 'var(--m-fg-0)'
  });
  cText.textContent = center;
  s.appendChild(cText);
  if (opts.centerLabel) {
    const lbl = svg('text', {
      x: String(cx), y: String(cy + 22),
      'text-anchor': 'middle',
      'font-family': "'IBM Plex Sans', sans-serif",
      'font-size': '10',
      fill: 'var(--m-fg-3)',
      'text-transform': 'uppercase',
      'letter-spacing': '0.06em'
    });
    lbl.textContent = opts.centerLabel;
    s.appendChild(lbl);
  }
  wrap.appendChild(s);
  // Legend on the right
  const legend = el('div', { class: 'widget-donut-legend' });
  for (const seg of segments) {
    if ((seg.value || 0) <= 0) continue;
    const pct = total ? Math.round((seg.value / total) * 100) : 0;
    legend.appendChild(el('div', { class: 'widget-donut-row' }, [
      el('span', { class: 'widget-segbar-dot', style: `background:${toneColor(seg.tone)}` }),
      el('span', { class: 'widget-donut-label' }, seg.label),
      el('span', { class: 'widget-donut-val' }, `${seg.value} · ${pct}%`)
    ]));
  }
  wrap.appendChild(legend);
  return wrap;
}

/**
 * Sparkline (inline SVG, no axes).
 *   sparkline([n1,n2,...], { tone?, width?, height?, fill? })
 */
export function sparkline(values, opts = {}) {
  const w = opts.width || 120;
  const h = opts.height || 28;
  const tone = opts.tone || 'blue';
  const fill = opts.fill !== false;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return [x, y];
  });
  const line = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ');
  const area = line + ` L ${w} ${h} L 0 ${h} Z`;
  const s = svg('svg', { class: 'widget-spark', width: String(w), height: String(h), viewBox: `0 0 ${w} ${h}` });
  if (fill) {
    s.appendChild(svg('path', { d: area, fill: toneColor(tone), 'fill-opacity': '0.12', stroke: 'none' }));
  }
  s.appendChild(svg('path', { d: line, fill: 'none', stroke: toneColor(tone), 'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  return s;
}

/**
 * Meter — single bar with explicit numerator/denominator label.
 *   meter(value, max, label, { tone? })
 */
export function meter(value, max, label, opts = {}) {
  const tone = opts.tone || (value >= max ? 'warn' : 'accent');
  return bar(max > 0 ? value / max : 0, label, { tone, right: `${value} / ${max}` });
}

/**
 * Time-bin events into N buckets over the trailing window.
 *   binByTime(events, n, fieldOrFn = 'createdAt', windowMs = 60*60*1000)
 *   Returns array of N integers (most-recent at end).
 */
export function binByTime(events, n = 24, fieldOrFn = 'createdAt', windowMs = 60 * 60 * 1000) {
  const buckets = new Array(n).fill(0);
  if (!events || !events.length) return buckets;
  const now = Date.now();
  const start = now - windowMs;
  const span = windowMs / n;
  const getTs = typeof fieldOrFn === 'function'
    ? fieldOrFn
    : (e) => {
        const v = e && e[fieldOrFn];
        if (!v) return null;
        const t = typeof v === 'number' ? v : Date.parse(v);
        return Number.isFinite(t) ? t : null;
      };
  for (const e of events) {
    const t = getTs(e);
    if (t == null || t < start) continue;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((t - start) / span)));
    buckets[idx]++;
  }
  return buckets;
}
