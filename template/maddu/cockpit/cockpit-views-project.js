// Máddu cockpit — Project route view (single-project cockpit).
//
// "Where does this project stand?" on one screen, fusing what already ships:
//   - goal % to done (cached ✓/○/? — never a live spawn)
//   - the Focus Director on-goal trajectory (a compact sparkline of the window)
//   - the worker fleet (counts + who is running/stuck)
//   - who is steering (active sessions)
//   - the recent slice trail
// Data: GET /bridge/project-cockpit. Read-only; every age is bridge-computed.
//
// NOTE: el(tag, attrs, children) takes children as an ARRAY. Type-narrow EVERY
// field — the fake bridge returns a truthy Proxy for unknown endpoints.

import { el, panel, placeholder, loading } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';
import { renderProse } from './cockpit-prose.js';

function eyebrow(text) {
  return el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--m-fg-3);margin:0 0 6px;' }, text);
}
function mono(text, extra = '') {
  return el('span', { style: `font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);${extra}` }, text);
}

export function humanAge(ms) {
  if (typeof ms !== 'number' || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// A compact on-goal sparkline from the trajectory: one block per turn, colored
// by tag. Pure + exported so a fixture can lock the glyph mapping.
export function trajectoryGlyphs(trajectory) {
  const arr = Array.isArray(trajectory) ? trajectory : [];
  return arr.map((t) => {
    const tag = t && typeof t.tag === 'string' ? t.tag : null;
    const color = tag === 'toward' ? 'var(--m-accent)' : tag === 'away' ? 'var(--m-danger)' : tag === 'lateral' ? 'var(--m-warn)' : 'var(--m-fg-3)';
    const glyph = tag === 'toward' ? '▲' : tag === 'away' ? '▼' : '▬';
    return { glyph, color, tag };
  });
}

// Progress bar for goal % to done.
function progressBar(percent) {
  const p = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : 0;
  return el('div', { style: 'height:8px;background:var(--m-bg-2);border:1px solid var(--m-line);border-radius:5px;overflow:hidden;margin:6px 0;' },
    el('div', { style: `height:100%;width:${p}%;background:${p >= 100 ? 'var(--m-ok)' : 'var(--m-accent)'};` }, ''));
}

export function renderProject(ctx) {
  const root = el('div', { class: 'view' }, [
    el('h2', {}, 'Project'),
    el('p', {}, ROUTE_META.project.description),
  ]);

  const mount = el('div', {}, loading('Reading project state…'));
  const body = ctx && ctx.panelFocus
    ? ctx.panelFocus('Project', 'GET /bridge/project-cockpit · where this project stands, on one screen', mount,
        { id: 'project', keywords: 'project cockpit status percent done trajectory fleet steering overview' })
    : panel('Project', 'GET /bridge/project-cockpit · single-project cockpit', mount);
  root.appendChild(body);

  (async () => {
    let data = null;
    try { const r = await fetch('/bridge/project-cockpit', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch {}
    mount.textContent = '';
    if (!data || typeof data !== 'object' || !data.goal || typeof data.goal !== 'object') {
      mount.appendChild(placeholder('No project state yet', 'Once a goal is set and agents run under Máddu, this shows how far the goal is to done, whether work is on-course, who is steering, and what shipped recently.'));
      return;
    }

    // ── Goal % to done ──
    const goal = data.goal;
    const objective = typeof goal.objective === 'string' ? goal.objective : null;
    const percent = typeof goal.percent === 'number' ? goal.percent : null;
    const met = typeof goal.metCount === 'number' ? goal.metCount : null;
    const total = typeof goal.total === 'number' ? goal.total : null;
    mount.appendChild(eyebrow('Goal'));
    if (objective) {
      mount.appendChild(el('div', { style: 'font-size:14px;color:var(--m-fg-0);margin-bottom:4px;' }, objective));
      mount.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;' }, [
        el('span', { style: 'font-size:24px;font-weight:600;color:var(--m-fg-0);line-height:1;' }, percent == null ? '—' : `${percent}%`),
        met != null && total ? mono(`${met}/${total} conditions met`) : null,
      ]));
      mount.appendChild(progressBar(percent));
    } else {
      mount.appendChild(el('div', { style: 'font-size:13px;color:var(--m-fg-3);margin-bottom:8px;' }, 'No goal set — `maddu goal set`.'));
    }

    // ── On-goal trajectory ──
    const focus = (data.focus && typeof data.focus === 'object') ? data.focus : {};
    const lastTag = typeof focus.lastTag === 'string' ? focus.lastTag : null;
    const onGoal = typeof focus.onGoal === 'number' ? focus.onGoal : null;
    const openFlag = (focus.openFlag && typeof focus.openFlag.reason === 'string') ? focus.openFlag : null;
    const glyphs = trajectoryGlyphs(Array.isArray(focus.trajectory) ? focus.trajectory : []);
    mount.appendChild(el('div', { style: 'margin-top:16px;' }, [eyebrow('On-goal trajectory')]));
    if (glyphs.length) {
      mount.appendChild(el('div', { style: 'display:flex;gap:2px;align-items:center;flex-wrap:wrap;' },
        glyphs.map((g) => el('span', { style: `color:${g.color};font-size:13px;line-height:1;` }, g.glyph))));
    }
    const tagColor = lastTag === 'toward' ? 'var(--m-accent)' : lastTag === 'away' ? 'var(--m-danger)' : lastTag === 'lateral' ? 'var(--m-warn)' : 'var(--m-fg-3)';
    mount.appendChild(el('div', { style: 'margin-top:4px;' }, [
      el('span', { style: `font-family:var(--m-font-mono);font-size:12px;color:${tagColor};` }, (lastTag || 'no signal').toUpperCase()),
      onGoal != null ? mono(`  ·  on-goal ${onGoal.toFixed(2)}`) : null,
    ]));
    if (openFlag) {
      mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-warn);margin-top:4px;' }, `⚠ ${openFlag.reason}`));
    }

    // ── Fleet + steering, side by side ──
    const fleet = (data.fleet && typeof data.fleet === 'object') ? data.fleet : {};
    const steeredBy = Array.isArray(data.steeredBy) ? data.steeredBy : [];
    const cols = el('div', { style: 'display:flex;gap:24px;flex-wrap:wrap;margin-top:16px;' }, [
      el('div', { style: 'min-width:180px;' }, [
        eyebrow('Fleet'),
        el('div', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-1);' },
          `${typeof fleet.running === 'number' ? fleet.running : 0} running · ${typeof fleet.stuck === 'number' ? fleet.stuck : 0} stuck · ${typeof fleet.total === 'number' ? fleet.total : 0} total`),
        el('div', {}, (Array.isArray(fleet.active) ? fleet.active : []).map((w) =>
          el('div', {}, mono(`${(w && typeof w.id === 'string') ? w.id : '?'} · ${(w && typeof w.status === 'string') ? w.status : '?'}${w && typeof w.lane === 'string' && w.lane ? ' · ' + w.lane : ''}`)))),
      ]),
      el('div', { style: 'min-width:180px;' }, [
        eyebrow(`Steering (${steeredBy.length})`),
        el('div', {}, steeredBy.length
          ? steeredBy.map((s) => el('div', { style: 'padding:3px 0;' }, [
              el('div', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-1);' }, `${(s && typeof s.role === 'string') ? s.role : 'session'}${s && typeof s.label === 'string' && s.label ? ' · ' + s.label : ''}`),
              el('div', {}, mono(`${(s && typeof s.focus === 'string' && s.focus) ? s.focus : '—'} · ${humanAge(s && typeof s.beatMs === 'number' ? s.beatMs : null) || 'no beat'}`)),
            ]))
          : [el('div', {}, mono('nobody steering'))]),
      ]),
    ]);
    mount.appendChild(cols);

    // ── Recent slice trail ──
    const slices = Array.isArray(data.recentSlices) ? data.recentSlices : [];
    if (slices.length) {
      mount.appendChild(el('div', { style: 'margin-top:16px;' }, [eyebrow('Recent slices')]));
      mount.appendChild(el('div', {}, slices.map((s) => {
        const age = humanAge(s && typeof s.ageMs === 'number' ? s.ageMs : null);
        return el('div', { style: 'padding:8px 0;border-bottom:1px solid var(--m-line);' }, [
          renderProse((s && typeof s.summary === 'string') ? s.summary : '—'),
          age ? el('div', { style: 'margin-top:2px;' }, mono(age)) : null,
        ]);
      })));
    }
  })();

  return root;
}
