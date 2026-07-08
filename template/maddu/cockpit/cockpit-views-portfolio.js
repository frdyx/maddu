// Máddu cockpit — Portfolio route view (cross-workspace wall).
//
// One card per mounted project — goal % · on-goal · drift · approvals · fleet ·
// last slice — with a "Needs the human" list that bubbles up open approvals,
// drift flags, and stuck workers across every project. Attention sorts first.
// Data: GET /bridge/_all/portfolio (the cockpit fetch shim adds the _all
// workspace header automatically on /bridge/_all/* URLs). Read-only fan-out.
//
// NOTE: el(tag, attrs, children) takes children as an ARRAY. Type-narrow EVERY
// field — the fake bridge returns a truthy Proxy for unknown endpoints.

import { el, panel, placeholder, loading } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';

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

// A project card. Border-left tints by attention: danger if drift, warn if
// approvals/stuck, else accent.
function projectCard(c) {
  const project = c && typeof c.project === 'string' ? c.project : (c && typeof c.workspace_label === 'string' ? c.workspace_label : '(project)');
  const goal = c && typeof c.goal === 'string' ? c.goal : null;
  const percent = c && typeof c.percent === 'number' ? c.percent : null;
  const onGoal = c && typeof c.onGoal === 'number' ? c.onGoal : null;
  const drift = c && c.driftFlag && typeof c.driftFlag.reason === 'string' ? c.driftFlag : null;
  const approvals = c && typeof c.openApprovals === 'number' ? c.openApprovals : 0;
  const running = c && typeof c.running === 'number' ? c.running : 0;
  const stuck = c && typeof c.stuck === 'number' ? c.stuck : 0;
  const lastSummary = c && typeof c.lastSliceSummary === 'string' ? c.lastSliceSummary : null;
  const lastAge = humanAge(c && typeof c.lastSliceAgeMs === 'number' ? c.lastSliceAgeMs : null);
  const accent = drift ? 'var(--m-danger)' : (approvals > 0 || stuck > 0) ? 'var(--m-warn)' : 'var(--m-accent)';

  return el('div', { style: `border:1px solid var(--m-line);border-left:3px solid ${accent};border-radius:var(--m-radius-sm,6px);padding:12px 14px;min-width:240px;flex:1 1 260px;max-width:360px;` }, [
    el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px;' }, [
      el('span', { style: 'font-family:var(--m-font-mono);font-size:13px;color:var(--m-fg-0);font-weight:600;' }, project),
      el('span', { style: `font-size:18px;font-weight:600;color:${percent === 100 ? 'var(--m-ok)' : 'var(--m-fg-1)'};` }, percent == null ? '—' : `${percent}%`),
    ]),
    goal ? el('div', { style: 'font-size:12px;color:var(--m-fg-2);margin-bottom:8px;line-height:1.4;' }, goal.length > 96 ? goal.slice(0, 96) + '…' : goal) : null,
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;' }, [
      onGoal != null ? mono(`on-goal ${onGoal.toFixed(2)}`) : null,
      approvals > 0 ? el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-warn);' }, `▸ ${approvals} approval(s)`) : null,
      drift ? el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-danger);' }, '⚠ drift') : null,
      stuck > 0 ? el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-danger);' }, `${stuck} stuck`) : null,
      running > 0 ? mono(`${running} running`) : null,
    ]),
    lastSummary ? el('div', { style: 'margin-top:8px;' }, mono(`${lastSummary.slice(0, 60)}${lastAge ? ' · ' + lastAge : ''}`)) : null,
  ]);
}

export function renderPortfolio(ctx) {
  const root = el('div', { class: 'view' }, [
    el('h2', {}, 'Portfolio'),
    el('p', {}, ROUTE_META.portfolio.description),
  ]);

  const mount = el('div', {}, loading('Reading every project…'));
  const body = ctx && ctx.panelFocus
    ? ctx.panelFocus('Portfolio', 'GET /bridge/_all/portfolio · one card per project · what needs the human, across all of them', mount,
        { id: 'portfolio', keywords: 'portfolio wall cross-workspace projects needs-the-human approvals drift fleet' })
    : panel('Portfolio', 'GET /bridge/_all/portfolio · cross-workspace wall', mount);
  root.appendChild(body);

  (async () => {
    let data = null;
    try { const r = await fetch('/bridge/_all/portfolio', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch {}
    mount.textContent = '';
    if (!data || typeof data !== 'object' || !Array.isArray(data.cards)) {
      mount.appendChild(placeholder('No projects mounted', 'Register workspaces with `maddu workspace add <path>`; each mounted project gets a card here with its goal progress, drift, and what needs you.'));
      return;
    }

    // ── Needs the human (bubbles up across all projects) ──
    const needsHuman = Array.isArray(data.needsHuman) ? data.needsHuman : [];
    if (needsHuman.length) {
      mount.appendChild(eyebrow(`Needs the human (${needsHuman.length})`));
      mount.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:16px;' }, needsHuman.map((n) => {
        const label = n && typeof n.workspace_label === 'string' ? n.workspace_label : (n && typeof n.workspace_id === 'string' ? n.workspace_id : '?');
        const kind = n && typeof n.kind === 'string' ? n.kind : 'attention';
        const detail = n && typeof n.detail === 'string' ? n.detail : kind;
        const color = kind === 'drift' || kind === 'stuck' ? 'var(--m-danger)' : 'var(--m-warn)';
        return el('div', { style: `border:1px solid var(--m-line);border-left:3px solid ${color};border-radius:var(--m-radius-sm,6px);padding:8px 12px;` }, [
          el('span', { style: `font-family:var(--m-font-mono);font-size:11px;color:${color};text-transform:uppercase;letter-spacing:.1em;margin-right:8px;` }, kind),
          el('span', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-1);' }, label),
          el('span', { style: 'font-size:12px;color:var(--m-fg-2);margin-left:8px;' }, detail),
        ]);
      })));
    } else {
      mount.appendChild(el('div', { style: 'font-size:13px;color:var(--m-ok);margin-bottom:16px;' }, '✓ Nothing needs the human right now — no pending approvals, drift, or stuck workers.'));
    }

    // ── Project cards ──
    const count = typeof data.workspaceCount === 'number' ? data.workspaceCount : data.cards.length;
    mount.appendChild(eyebrow(`Projects (${count})`));
    mount.appendChild(el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;' }, data.cards.map(projectCard)));

    // ── Per-workspace errors (isolated, never poison the wall) ──
    const errors = Array.isArray(data.errors) ? data.errors : [];
    if (errors.length) {
      mount.appendChild(el('div', { style: 'margin-top:14px;' }, [
        eyebrow('Unreadable'),
        el('div', {}, errors.map((e) => mono(`${(e && e.workspace_label) || '?'}: ${(e && e.error) || 'error'}`, 'color:var(--m-danger);display:block;'))),
      ]));
    }
  })();

  return root;
}
