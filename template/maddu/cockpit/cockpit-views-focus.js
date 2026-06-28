// Máddu cockpit — Focus Director route view.
//
// The operator-facing trajectory instrument: the current direction + score, the
// trajectory of recent turns toward the TARGET (the declared goal), any open
// sustained-drift flag with its swap/revert/continue choice, and a timeline
// strip. Data: GET /bridge/focus. Inspired by the operator mockup, rendered in
// the navy-noir cockpit language (existing --m-* tokens only — no new styles).

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
  return el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--m-fg-3);margin:6px 0;' }, text);
}

export function renderFocus(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Focus'));
  root.appendChild(el('p', {}, ROUTE_META.focus.description));

  const mount = el('div', {});
  mount.appendChild(loading('Reading focus trajectory…'));
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
    const dir = el('div', { style: 'display:flex;gap:28px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px;' });
    dir.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:3px;' },
      eyebrow('Current direction'),
      el('div', { style: 'display:flex;align-items:center;gap:10px;' },
        el('span', { style: `font-size:30px;line-height:1;color:${lt.color};` }, lt.arrow),
        el('span', { style: `font-family:var(--m-font-mono);font-size:22px;font-weight:600;letter-spacing:.06em;color:${lt.color};` }, lt.label))));
    dir.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:3px;' },
      eyebrow('Overall score'),
      el('div', { style: 'font-size:30px;font-weight:600;color:var(--m-fg-0);line-height:1;' }, fmt2(score(last.distanceScore)))));
    const spark = el('div', { style: 'display:flex;align-items:flex-end;gap:3px;height:40px;' });
    for (const w of win) {
      const s = score(w.distanceScore);
      spark.appendChild(el('div', { title: `${tagOf(w.tag).label} ${fmt2(s)}`,
        style: `width:8px;height:${Math.max(5, Math.round(s * 38))}px;background:${tagOf(w.tag).color};border-radius:2px 2px 0 0;opacity:.85;` }));
    }
    dir.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:3px;' }, eyebrow('Trend'), spark));
    mount.appendChild(dir);

    // ── Trajectory → TARGET ──
    mount.appendChild(eyebrow('Trajectory → target'));
    const traj = el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 2px 4px;' });
    for (const w of win) {
      const t = tagOf(w.tag);
      traj.appendChild(el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:4px;' },
        el('div', { title: t.label, style: `width:22px;height:22px;border-radius:50%;background:${t.color};box-shadow:0 0 10px ${t.color};opacity:.92;` }),
        el('div', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);' }, fmt2(score(w.distanceScore)))));
      traj.appendChild(el('span', { style: `color:${t.color};opacity:.7;` }, '→'));
    }
    traj.appendChild(el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:4px;' },
      el('div', { title: 'TARGET', style: `width:26px;height:26px;border-radius:50%;border:2px solid ${TARGET};box-shadow:0 0 14px var(--m-glow-accent-2,${TARGET});display:flex;align-items:center;justify-content:center;color:${TARGET};font-size:13px;` }, '◆'),
      el('div', { style: `font-family:var(--m-font-mono);font-size:10px;color:${TARGET};` }, 'TARGET')));
    mount.appendChild(traj);
    mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-fg-2);margin:4px 0 14px;' },
      goalObj ? ('Goal: ' + goalObj) : 'No declared goal — the director stays silent until `maddu goal set`.'));

    // ── Open flag / friction ──
    if (f.openFlag) {
      const fl = f.openFlag;
      const card = el('div', { style: 'border:1px solid var(--m-danger-border);background:var(--m-danger-bg);border-radius:var(--m-radius-sm,6px);padding:12px 14px;margin-bottom:14px;' });
      card.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px;' },
        el('span', { style: 'color:var(--m-danger);font-size:14px;' }, '⚑'),
        el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;letter-spacing:.14em;color:var(--m-danger);' }, 'DRIFT FLAGGED')));
      card.appendChild(el('div', { style: 'font-size:13px;color:var(--m-fg-0);margin-bottom:10px;' }, fl.reason || 'sustained drift'));
      const menu = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' });
      for (const choice of (Array.isArray(fl.menu) && fl.menu.length ? fl.menu : ['swap', 'revert', 'continue'])) {
        menu.appendChild(el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;padding:4px 10px;border:1px solid var(--m-line);border-radius:var(--m-radius-sm,5px);color:var(--m-fg-1);background:var(--m-bg-2);' }, choice));
      }
      card.appendChild(menu);
      card.appendChild(el('div', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);margin-top:8px;' }, 'resolve: maddu focus resolve <swap|revert|continue>'));
      mount.appendChild(card);
    } else {
      mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-ok);margin-bottom:14px;' }, '✓ On course — no open drift flag.'));
    }

    // ── Timeline ──
    mount.appendChild(eyebrow('Timeline'));
    const tl = el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;' });
    for (const w of win) tl.appendChild(el('div', { title: tagOf(w.tag).label, style: `width:12px;height:12px;border-radius:50%;background:${tagOf(w.tag).color};` }));
    mount.appendChild(tl);

    // ── Legend ──
    const legend = el('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;margin-top:14px;padding-top:10px;border-top:1px solid var(--m-line);' });
    for (const k of ['toward', 'lateral', 'away']) {
      const t = tagOf(k);
      legend.appendChild(el('span', { style: 'display:flex;align-items:center;gap:6px;font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);' },
        el('span', { style: `width:10px;height:10px;border-radius:50%;background:${t.color};` }), t.label.toLowerCase()));
    }
    legend.appendChild(el('span', { style: 'display:flex;align-items:center;gap:6px;font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);' },
      el('span', { style: `width:10px;height:10px;border-radius:50%;border:2px solid ${TARGET};` }), 'target'));
    mount.appendChild(legend);
  })();

  return root;
}
