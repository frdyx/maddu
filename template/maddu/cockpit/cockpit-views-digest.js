// Máddu cockpit — Digest route view ("while you were away").
//
// The catch-up readout: the delta since the operator last looked, fused with
// what needs them now. Answers "what changed and what wants me?" in one glance:
//   - headline (2 sentences, plain language)
//   - NEEDS YOU: open approvals (the operator is the gate)
//   - gates run / failing, drift flagged
//   - SLICES LANDED: recent slice-stops
//   - goal ✓/○/? from the cached success eval (never a live spawn)
// Data: GET /bridge/digest. Read-only; every "how long ago" comes from the
// bridge-computed ageMs (the projection stays wall-clock-free).
//
// NOTE: el(tag, attrs, children) takes children as an ARRAY (or a single node /
// string). Type-narrow EVERY field — the cockpit fake bridge returns a truthy
// Proxy for unknown endpoints, so an un-narrowed access throws under Playwright.

import { el, panel, placeholder, loading } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';

function eyebrow(text) {
  return el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--m-fg-3);margin:0 0 6px;' }, text);
}

function mono(text, extra = '') {
  return el('span', { style: `font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);${extra}` }, text);
}

// Humanize the bridge-computed ageMs at display time. Exported for the fixture.
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

// One "needs you" card — an open approval the operator has to decide.
function needsYouCard(a) {
  const age = humanAge(a && typeof a.ageMs === 'number' ? a.ageMs : null);
  const label = (a && typeof a.action === 'string' && a.action) || (a && typeof a.tool === 'string' && a.tool) || 'approval';
  const summary = a && typeof a.summary === 'string' ? a.summary : '';
  return el('div', { style: 'border:1px solid var(--m-warn-border,var(--m-line));background:var(--m-warn-bg,var(--m-bg-2));border-radius:var(--m-radius-sm,6px);padding:10px 12px;margin-bottom:8px;' }, [
    el('div', { style: 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;' }, [
      el('span', { style: 'color:var(--m-warn);font-family:var(--m-font-mono);font-size:11px;letter-spacing:.14em;' }, '▸ NEEDS YOU'),
      el('span', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-1);' }, label),
      age ? mono(`· ${age}`) : null,
    ]),
    summary ? el('div', { style: 'font-size:13px;color:var(--m-fg-0);margin-top:4px;' }, summary) : null,
  ]);
}

export function renderDigest(ctx) {
  const root = el('div', { class: 'view' }, [
    el('h2', {}, 'Digest'),
    el('p', {}, ROUTE_META.digest.description),
  ]);

  const mount = el('div', {}, loading('Reading what changed…'));
  const body = ctx && ctx.panelFocus
    ? ctx.panelFocus('Digest', 'GET /bridge/digest · while you were away · the delta since you last looked',  mount,
        { id: 'digest', keywords: 'digest while you were away delta approvals needs-you slices gates drift resume catch-up' })
    : panel('Digest', 'GET /bridge/digest · while you were away', mount);
  root.appendChild(body);

  (async () => {
    let data = null;
    try { const r = await fetch('/bridge/digest', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch {}
    mount.textContent = '';
    if (!data || typeof data !== 'object' || typeof data.headline !== 'string') {
      mount.appendChild(placeholder('Nothing to catch up on yet', 'Once agents run under Máddu, this shows what changed since you last looked — slices landed, gates run, drift flagged — and what needs you now.'));
      return;
    }

    // ── Headline (2 sentences, plain language) ──
    mount.appendChild(el('div', { style: 'font-size:15px;color:var(--m-fg-0);line-height:1.5;margin-bottom:14px;' }, data.headline));

    // ── NEEDS YOU — open approvals ──
    const needsYou = Array.isArray(data.needsYou) ? data.needsYou : [];
    if (needsYou.length) {
      mount.appendChild(eyebrow(`Needs you (${needsYou.length})`));
      needsYou.forEach((a) => mount.appendChild(needsYouCard(a)));
    }

    // ── Gates + drift ──
    const gates = (data.gates && typeof data.gates === 'object') ? data.gates : {};
    const ran = typeof gates.ran === 'number' ? gates.ran : 0;
    const failed = typeof gates.failed === 'number' ? gates.failed : 0;
    const failing = Array.isArray(gates.failing) ? gates.failing : [];
    const driftCount = typeof data.driftCount === 'number' ? data.driftCount : 0;
    const drift = Array.isArray(data.drift) ? data.drift : [];
    if (ran || driftCount) {
      const chips = [];
      if (failed) chips.push(el('span', { style: 'color:var(--m-danger);font-size:13px;' }, `✗ ${failed} gate(s) failing: ${failing.map((g) => (g && typeof g.gateId === 'string' ? g.gateId : '?')).join(', ')}`));
      else if (ran) chips.push(el('span', { style: 'color:var(--m-ok);font-size:13px;' }, `✓ gates green (${ran} ran)`));
      if (driftCount) {
        const first = drift[0] && typeof drift[0].reason === 'string' ? drift[0].reason : (drift[0] && typeof drift[0].runs === 'number' ? `${drift[0].runs} turns off-axis` : 'flagged');
        chips.push(el('span', { style: 'color:var(--m-warn);font-size:13px;' }, `⚠ drift flagged${driftCount > 1 ? ` (${driftCount})` : ''}: ${first}`));
      }
      mount.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:4px;margin:10px 0 14px;' }, chips));
    }

    // ── SLICES LANDED ──
    const slices = Array.isArray(data.sliceStops) ? data.sliceStops : [];
    const sliceCount = typeof data.sliceStopCount === 'number' ? data.sliceStopCount : slices.length;
    if (sliceCount) {
      mount.appendChild(el('div', { style: 'margin-top:6px;' }, [eyebrow(`Slices landed (${sliceCount})`)]));
      mount.appendChild(el('div', {}, slices.map((s) => {
        const age = humanAge(s && typeof s.ageMs === 'number' ? s.ageMs : null);
        const summary = s && typeof s.summary === 'string' ? s.summary : '—';
        return el('div', { style: 'padding:6px 0;border-bottom:1px solid var(--m-line);' }, [
          el('div', { style: 'font-size:13px;color:var(--m-fg-1);' }, summary),
          age ? el('div', {}, mono(age)) : null,
        ]);
      })));
      if (sliceCount > slices.length) {
        mount.appendChild(el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);margin-top:6px;' }, `… and ${sliceCount - slices.length} more`));
      }
    }

    // ── Goal ✓/○/? from the cached success eval ──
    const goal = (data.goal && typeof data.goal === 'object') ? data.goal : {};
    if (typeof goal.objective === 'string' && goal.objective) {
      const met = typeof goal.metCount === 'number' ? goal.metCount : null;
      const total = typeof goal.total === 'number' ? goal.total : null;
      const allMet = goal.allMet === true;
      const gstr = allMet ? 'all conditions met' : (met != null && total ? `${met}/${total} met` : 'in progress');
      mount.appendChild(el('div', { style: 'margin-top:14px;' }, [
        eyebrow('Goal'),
        el('div', { style: 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;' }, [
          el('span', { style: `font-family:var(--m-font-mono);font-size:13px;color:${allMet ? 'var(--m-ok)' : 'var(--m-fg-1)'};` }, gstr),
          el('span', { style: 'font-size:12px;color:var(--m-fg-2);' }, goal.objective),
        ]),
      ]));
    }
  })();

  return root;
}
