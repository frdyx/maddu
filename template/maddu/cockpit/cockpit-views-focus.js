// Máddu cockpit — Focus Director route view.
//
// The operator-facing trajectory instrument: the current direction + score, the
// trajectory of recent turns toward the TARGET (the declared goal), any open
// sustained-drift flag with its swap/revert/continue choice, and a timeline
// strip. Data: GET /bridge/focus. Inspired by the operator mockup, rendered in
// the navy-noir cockpit language (existing --m-* tokens only — no new styles).
//
// NOTE: el(tag, attrs, children) takes children as an ARRAY (or a single node /
// string) — multi-child nodes MUST pass an array, never variadic args.

import { el, panel, placeholder, loading } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';

const TAG = {
  toward:  { label: 'TOWARD',  arrow: '↗', color: 'var(--m-accent)' },
  lateral: { label: 'LATERAL', arrow: '→', color: 'var(--m-warn)' },
  away:    { label: 'AWAY',    arrow: '↘', color: 'var(--m-danger)' },
};
const TARGET = 'var(--m-accent-2)';

function tagOf(t) { return TAG[t] || { label: '—', arrow: '·', color: 'var(--m-fg-3)' }; }
function score(distanceScore) {
  const d = typeof distanceScore === 'number' ? distanceScore : 0;
  return Math.max(0, Math.min(1, 1 - d));
}
function fmt2(n) { return (Math.round(n * 100) / 100).toFixed(2); }
function eyebrow(text) {
  return el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--m-fg-3);margin:0 0 4px;' }, text);
}
function svgColor(tag) { return `var(--m-${tag === 'toward' ? 'accent' : tag === 'lateral' ? 'warn' : 'danger'})`; }

// The trajectory as a zigzag LINE chart: Y = score (toward at top, away at the
// bottom), X = turn order, segments colored by their destination tag, converging
// on the TARGET top-right. Built as an SVG string (deterministic for goldens).
function buildTrajectorySvg(win) {
  const W = 620, H = 210, padL = 44, padR = 82, padT = 22, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = win.length;
  const stepX = n > 1 ? plotW / (n - 1) : 0;
  const X = (i) => +(padL + i * stepX).toFixed(1);
  const Y = (s) => +(padT + (1 - s) * plotH).toFixed(1);
  const pts = win.map((w, i) => ({ x: X(i), y: Y(score(w.distanceScore)), tag: w.tag, s: score(w.distanceScore) }));
  const tx = +(padL + plotW + padR * 0.5).toFixed(1), ty = Y(1);

  let grid = '';
  for (const [s, label] of [[1, 'toward'], [0.5, ''], [0, 'away']]) {
    const y = Y(s);
    grid += `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" style="stroke:var(--m-line);opacity:.5"/>`;
    if (label) grid += `<text x="${padL - 7}" y="${y + 3}" text-anchor="end" style="fill:var(--m-fg-3);font:9px var(--m-font-mono)">${label}</text>`;
  }
  let segs = '';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    segs += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" style="stroke:${svgColor(b.tag)};stroke-width:2.5;opacity:.8"/>`;
  }
  const last = pts[pts.length - 1];
  segs += `<line x1="${last.x}" y1="${last.y}" x2="${tx}" y2="${ty}" style="stroke:var(--m-accent-2);stroke-width:1.5;opacity:.5;stroke-dasharray:3 4"/>`;
  let nodes = '';
  for (const p of pts) {
    nodes += `<circle cx="${p.x}" cy="${p.y}" r="6.5" style="fill:${svgColor(p.tag)}"/>`;
    nodes += `<text x="${p.x}" y="${p.y - 12}" text-anchor="middle" style="fill:var(--m-fg-3);font:9px var(--m-font-mono)">${fmt2(p.s)}</text>`;
  }
  nodes += `<circle cx="${tx}" cy="${ty}" r="9" style="fill:none;stroke:var(--m-accent-2);stroke-width:2"/>`;
  nodes += `<circle cx="${tx}" cy="${ty}" r="3.5" style="fill:var(--m-accent-2)"/>`;
  nodes += `<text x="${tx}" y="${ty - 15}" text-anchor="middle" style="fill:var(--m-accent-2);font:9px var(--m-font-mono)">TARGET</text>`;
  const xhint = `<text x="${padL}" y="${H - 8}" style="fill:var(--m-fg-3);font:9px var(--m-font-mono)">older</text><text x="${padL + plotW}" y="${H - 8}" text-anchor="end" style="fill:var(--m-fg-3);font:9px var(--m-font-mono)">newer →</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto;overflow:visible">${grid}${segs}${nodes}${xhint}</svg>`;
}

export function renderFocus(ctx) {
  const root = el('div', { class: 'view' }, [
    el('h2', {}, 'Focus'),
    el('p', {}, ROUTE_META.focus.description),
  ]);

  const mount = el('div', {}, loading('Reading focus trajectory…'));
  const body = ctx && ctx.panelFocus
    ? ctx.panelFocus('Focus Director', 'GET /bridge/focus · domain-blind drift instrument · opt-in via `maddu focus enable`', mount,
        { id: 'focus', keywords: 'focus director drift trajectory toward lateral away goal flag pilot' })
    : panel('Focus Director', 'GET /bridge/focus · domain-blind drift instrument · opt-in via `maddu focus enable`', mount);
  root.appendChild(body);

  (async () => {
    let data = null;
    try { const r = await fetch('/bridge/focus', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch {}
    mount.textContent = '';
    const f = (data && data.focus) || {};
    const win = Array.isArray(f.window) ? f.window : [];
    const enabled = !!(data && data.enabled);
    const goalObj = data && data.goal && data.goal.objective;

    if (!win.length) {
      mount.appendChild(placeholder(
        enabled ? 'No trajectory yet' : 'Focus Director is off',
        enabled
          ? 'Tagging begins on the next heartbeat / slice-stop. With no declared goal the director stays silent.'
          : 'Opt in with `maddu focus enable` — then every turn is tagged toward / lateral / away of the declared goal.'));
      return;
    }

    // ── Current Direction ──
    const last = win[win.length - 1];
    const lt = tagOf(last.tag);
    const spark = el('div', { style: 'display:flex;align-items:flex-end;gap:3px;height:40px;' },
      win.map((w) => {
        const s = score(w.distanceScore);
        return el('div', { title: `${tagOf(w.tag).label} ${fmt2(s)}`,
          style: `width:8px;height:${Math.max(5, Math.round(s * 38))}px;background:${tagOf(w.tag).color};border-radius:2px 2px 0 0;opacity:.85;` });
      }));
    mount.appendChild(el('div', { style: 'display:flex;gap:28px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px;' }, [
      el('div', { style: 'display:flex;flex-direction:column;' }, [
        eyebrow('Current direction'),
        el('div', { style: 'display:flex;align-items:center;gap:10px;' }, [
          el('span', { style: `font-size:30px;line-height:1;color:${lt.color};` }, lt.arrow),
          el('span', { style: `font-family:var(--m-font-mono);font-size:22px;font-weight:600;letter-spacing:.06em;color:${lt.color};` }, lt.label),
        ]),
      ]),
      el('div', { style: 'display:flex;flex-direction:column;' }, [
        eyebrow('Overall score'),
        el('div', { style: 'font-size:30px;font-weight:600;color:var(--m-fg-0);line-height:1;' }, fmt2(score(last.distanceScore))),
      ]),
      el('div', { style: 'display:flex;flex-direction:column;' }, [eyebrow('Trend'), spark]),
    ]));

    // ── Trajectory → TARGET (zigzag line chart: Y = score over time) ──
    mount.appendChild(eyebrow('Trajectory → target'));
    mount.appendChild(el('div', { style: 'padding:6px 2px 2px;', html: buildTrajectorySvg(win) }));
    mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-fg-2);margin:4px 0 14px;' },
      goalObj ? ('Goal: ' + goalObj) : 'No declared goal — the director stays silent until `maddu goal set`.'));

    // ── Open flag / friction ──
    if (f.openFlag) {
      const fl = f.openFlag;
      const menu = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' },
        (Array.isArray(fl.menu) && fl.menu.length ? fl.menu : ['swap', 'revert', 'continue']).map((choice) =>
          el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;padding:4px 10px;border:1px solid var(--m-line);border-radius:var(--m-radius-sm,5px);color:var(--m-fg-1);background:var(--m-bg-2);' }, choice)));
      mount.appendChild(el('div', { style: 'border:1px solid var(--m-danger-border);background:var(--m-danger-bg);border-radius:var(--m-radius-sm,6px);padding:12px 14px;margin-bottom:14px;' }, [
        el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px;' }, [
          el('span', { style: 'color:var(--m-danger);font-size:14px;' }, '⚑'),
          el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;letter-spacing:.14em;color:var(--m-danger);' }, 'DRIFT FLAGGED'),
        ]),
        el('div', { style: 'font-size:13px;color:var(--m-fg-0);margin-bottom:10px;' }, fl.reason || 'sustained drift'),
        menu,
        el('div', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);margin-top:8px;' }, 'resolve: maddu focus resolve <swap|revert|continue>'),
      ]));
    } else {
      mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-ok);margin-bottom:14px;' }, '✓ On course — no open drift flag.'));
    }

    // ── Timeline ──
    mount.appendChild(eyebrow('Timeline'));
    mount.appendChild(el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;' },
      win.map((w) => el('div', { title: tagOf(w.tag).label, style: `width:12px;height:12px;border-radius:50%;background:${tagOf(w.tag).color};` }))));

    // ── Legend ──
    const legItem = (color, text, ring) => el('span', { style: 'display:flex;align-items:center;gap:6px;font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);' }, [
      el('span', { style: `width:10px;height:10px;border-radius:50%;${ring ? `border:2px solid ${color}` : `background:${color}`};` }),
      text,
    ]);
    mount.appendChild(el('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;margin-top:14px;padding-top:10px;border-top:1px solid var(--m-line);' }, [
      ...['toward', 'lateral', 'away'].map((k) => legItem(tagOf(k).color, k)),
      legItem(TARGET, 'target', true),
    ]));
  })();

  return root;
}
