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
  // Fixed viewBox + width:100% → the chart always fills the container width and
  // scales with it (responsive). X spacing auto-fits any node count; node/label
  // sizes scale by a density factor so adding nodes gracefully "zooms out"
  // (smaller, denser) and a sparse trajectory "zooms in" (larger, spaced) —
  // and very dense runs drop the per-node score labels. Never overflows.
  const W = 640, H = 200, padL = 60, padR = 86, padT = 26, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = win.length;
  const stepX = n > 1 ? plotW / (n - 1) : 0;
  const d = Math.max(0.6, Math.min(1.15, 8 / Math.max(n, 1)));     // zoom / density factor
  const r = +(6.4 * d).toFixed(2), sw = +(2.6 * d).toFixed(2), fs = +Math.max(8, 10 * d).toFixed(2);
  const labels = n <= 10;                                          // de-crowd: hide scores when very dense
  const X = (i) => +(padL + i * stepX).toFixed(1);
  const Y = (s) => +(padT + (1 - s) * plotH).toFixed(1);
  const pts = win.map((w, i) => ({ x: X(i), y: Y(score(w.distanceScore)), tag: w.tag, s: score(w.distanceScore) }));
  const tx = +(padL + plotW + padR * 0.5).toFixed(1), ty = Y(1);

  let grid = '';
  for (const [s, label] of [[1, 'toward'], [0.5, ''], [0, 'away']]) {
    const y = Y(s);
    grid += `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" style="stroke:var(--m-line);opacity:.5"/>`;
    if (label) grid += `<text x="6" y="${y + 3}" style="fill:var(--m-fg-3);font:10px var(--m-font-mono)">${label}</text>`;
  }
  let segs = '';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    segs += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" style="stroke:${svgColor(b.tag)};stroke-width:${sw};opacity:.8"/>`;
  }
  const last = pts[pts.length - 1];
  segs += `<line x1="${last.x}" y1="${last.y}" x2="${tx}" y2="${ty}" style="stroke:var(--m-accent-2);stroke-width:1.5;opacity:.5;stroke-dasharray:3 4"/>`;
  let nodes = '';
  for (const p of pts) {
    nodes += `<circle cx="${p.x}" cy="${p.y}" r="${r}" style="fill:${svgColor(p.tag)}"/>`;
    if (labels) nodes += `<text x="${p.x}" y="${+(p.y - r - 5).toFixed(1)}" text-anchor="middle" style="fill:var(--m-fg-3);font:${fs}px var(--m-font-mono)">${fmt2(p.s)}</text>`;
  }
  nodes += `<circle cx="${tx}" cy="${ty}" r="9" style="fill:none;stroke:var(--m-accent-2);stroke-width:2"/>`;
  nodes += `<circle cx="${tx}" cy="${ty}" r="3.5" style="fill:var(--m-accent-2)"/>`;
  nodes += `<text x="${tx}" y="${ty - 15}" text-anchor="middle" style="fill:var(--m-accent-2);font:10px var(--m-font-mono)">TARGET</text>`;
  const xhint = `<text x="${padL}" y="${H - 6}" style="fill:var(--m-fg-3);font:10px var(--m-font-mono)">older</text><text x="${padL + plotW}" y="${H - 6}" text-anchor="end" style="fill:var(--m-fg-3);font:10px var(--m-font-mono)">newer →</text>`;
  // Invisible, generous hit-targets on top — comfortable hover/click even when
  // the visible nodes shrink in the zoomed-out (dense) view. data-i indexes back
  // into the node array for the popover + Inspector.
  let hits = '';
  pts.forEach((p, i) => { hits += `<circle cx="${p.x}" cy="${p.y}" r="${Math.max(13, +(r + 7).toFixed(1))}" data-i="${i}" style="fill:transparent;cursor:pointer"/>`; });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;overflow:visible">${grid}${segs}${nodes}${xhint}${hits}</svg>`;
}

// The Inspector entity for a focus turn — generic shape ({kind,label,id,raw,
// evidence[],related[]}) the cockpit Inspector renders across its tabs, with a
// clickable link to the source heartbeat/slice-stop. Exported for the fixture.
export function focusEntity(t) {
  const sig = t.signals || {};
  const tg = tagOf(t.tag);
  return {
    kind: 'focus-turn',
    label: `${tg.label} · ${sig.focusText || 'turn'}`,
    id: t.id || null,
    raw: t,
    evidence: [
      { label: 'Direction', value: tg.label },
      { label: 'Score (toward)', value: fmt2(score(t.distanceScore)) },
      { label: 'Goal-distance', value: t.distanceScore == null ? '—' : fmt2(t.distanceScore) },
      { label: 'Focus', value: sig.focusText || '—' },
      { label: 'On-goal overlap', value: sig.overlap == null ? '—' : `${Math.round(sig.overlap * 100)}%` },
      { label: 'Recent churn', value: sig.churn == null ? '—' : String(sig.churn) },
      { label: 'When', value: t.ts || '—' },
    ],
    related: t.sourceEventId ? [{ kind: 'event', id: t.sourceEventId, label: `source turn · ${t.sourceEventId}` }] : [],
  };
}

// Wire hover popover + click→Inspector on the chart's hit-targets. The popover
// is created lazily-empty (deterministic for goldens); content fills on hover.
function attachNodeInteractions(host, nodes, ctx) {
  const svg = host.querySelector('svg');
  if (!svg) return;
  const pop = el('div', { class: 'focus-pop', style: 'position:fixed;z-index:60;display:none;max-width:280px;pointer-events:none;background:var(--m-bg-3);border:1px solid var(--m-line);border-radius:var(--m-radius-sm,6px);padding:8px 10px;box-shadow:var(--m-shadow-md);' });
  host.appendChild(pop);
  const turnAt = (e) => { const h = e.target && e.target.closest && e.target.closest('[data-i]'); return h ? nodes[+h.dataset.i] : null; };
  svg.addEventListener('mousemove', (e) => {
    const t = turnAt(e);
    if (!t) { pop.style.display = 'none'; return; }
    const sig = t.signals || {}, tg = tagOf(t.tag), meta = [];
    if (sig.overlap != null) meta.push(`${Math.round(sig.overlap * 100)}% on-goal`);
    if (sig.churn != null) meta.push(`churn ${sig.churn}`);
    if (ctx && typeof ctx.openInspector === 'function') meta.push('click for detail');
    pop.replaceChildren(
      el('div', { style: `font-family:var(--m-font-mono);font-size:11px;color:${tg.color};margin-bottom:3px;` }, `${tg.arrow} ${tg.label} · score ${fmt2(score(t.distanceScore))}`),
      ...(sig.focusText ? [el('div', { style: 'font-size:12px;color:var(--m-fg-0);margin-bottom:3px;' }, `"${sig.focusText}"`)] : []),
      el('div', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);' }, meta.join(' · ')),
    );
    const vw = (host.ownerDocument && host.ownerDocument.defaultView && host.ownerDocument.defaultView.innerWidth) || 1280;
    pop.style.display = 'block';
    pop.style.left = Math.min(e.clientX + 14, vw - 292) + 'px';
    pop.style.top = (e.clientY + 14) + 'px';
  });
  svg.addEventListener('mouseleave', () => { pop.style.display = 'none'; });
  svg.addEventListener('click', (e) => {
    const t = turnAt(e);
    if (t && ctx && typeof ctx.openInspector === 'function') ctx.openInspector(focusEntity(t));
  });
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
    // Prefer the full per-turn events (focusText + signals + source event) for
    // hover/Inspector detail; fall back to the lean projection window.
    const nodes = (data && Array.isArray(data.turns) && data.turns.length) ? data.turns : win;
    const enabled = !!(data && data.enabled);
    const goalObj = data && data.goal && data.goal.objective;

    if (!nodes.length) {
      mount.appendChild(placeholder(
        enabled ? 'No trajectory yet' : 'Focus Director is off',
        enabled
          ? 'Tagging begins on the next heartbeat / slice-stop. With no declared goal the director stays silent.'
          : 'Opt in with `maddu focus enable` — then every turn is tagged toward / lateral / away of the declared goal.'));
      return;
    }

    // ── Current Direction ──
    const last = nodes[nodes.length - 1];
    const lt = tagOf(last.tag);
    const spark = el('div', { style: 'display:flex;align-items:flex-end;gap:3px;height:40px;' },
      nodes.map((w) => {
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
    const chartHost = el('div', { style: 'position:relative;padding:6px 2px 2px;', html: buildTrajectorySvg(nodes) });
    mount.appendChild(chartHost);
    attachNodeInteractions(chartHost, nodes, ctx);
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
      nodes.map((w) => el('div', { title: tagOf(w.tag).label, style: `width:12px;height:12px;border-radius:50%;background:${tagOf(w.tag).color};` }))));

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
