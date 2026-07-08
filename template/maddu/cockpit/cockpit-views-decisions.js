// Máddu cockpit — Decisions route view (the decision ledger).
//
// The curated, high-signal log of decision-grade events — where intent was set,
// a choice was made, a gate failed, or an outcome was reached — each row with
// actor, provenance (human vs which auto-trigger), and its tamper-evident
// stored-line SHA (which equals the next event's prev_hash, so it ties back to
// the verified chain). The header carries the real verifySpine badge.
// Data: GET /bridge/decisions. Read-only; every age is bridge-computed.
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

// Category → accent color. Pure + exported for the fixture.
export function categoryColor(category) {
  switch (category) {
    case 'intent': return 'var(--m-accent-2)';
    case 'decision': return 'var(--m-accent)';
    case 'gate': return 'var(--m-danger)';
    case 'outcome': return 'var(--m-ok)';
    default: return 'var(--m-fg-3)';
  }
}

function decisionRow(r) {
  const category = r && typeof r.category === 'string' ? r.category : 'other';
  const summary = r && typeof r.summary === 'string' ? r.summary : '—';
  const provenance = r && typeof r.provenance === 'string' ? r.provenance : 'system';
  const sha = r && typeof r.sha === 'string' ? r.sha : null;
  const auto = r && r.auto === true;
  const age = humanAge(r && typeof r.ageMs === 'number' ? r.ageMs : null);
  return el('div', { style: 'padding:8px 0;border-bottom:1px solid var(--m-line);display:flex;gap:12px;align-items:baseline;' }, [
    el('span', { style: `font-family:var(--m-font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${categoryColor(category)};min-width:64px;` }, category),
    el('div', { style: 'flex:1;min-width:0;' }, [
      el('div', { style: 'font-size:13px;color:var(--m-fg-0);' }, summary),
      el('div', {}, [
        mono(auto ? `⚙ ${provenance}` : `${provenance}`),
        sha ? mono(`  ·  sha ${sha}`) : null,
        age ? mono(`  ·  ${age}`) : null,
      ]),
    ]),
  ]);
}

export function renderDecisions(ctx) {
  const root = el('div', { class: 'view' }, [
    el('h2', {}, 'Decisions'),
    el('p', {}, ROUTE_META.decisions.description),
  ]);

  const mount = el('div', {}, loading('Curating the record…'));
  const body = ctx && ctx.panelFocus
    ? ctx.panelFocus('Decisions', 'GET /bridge/decisions · the decision-grade record · who decided what, tamper-evident', mount,
        { id: 'decisions', keywords: 'decisions ledger audit provenance approval goal gate trigger sha chain' })
    : panel('Decisions', 'GET /bridge/decisions · the decision ledger', mount);
  root.appendChild(body);

  (async () => {
    let data = null;
    try { const r = await fetch('/bridge/decisions', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch {}
    mount.textContent = '';
    if (!data || typeof data !== 'object' || !Array.isArray(data.decisions)) {
      mount.appendChild(placeholder('No decisions recorded yet', 'Once goals are set, approvals decided, gates run, and outcomes reached, this shows the curated decision-grade record — who decided what, on a tamper-evident chain.'));
      return;
    }

    // ── Header — the real tamper-evidence badge ──
    const v = (data.verify && typeof data.verify === 'object') ? data.verify : {};
    const events = typeof v.events === 'number' ? v.events : null;
    const intact = v.chainIntact === true;
    const tampered = typeof v.tampered === 'number' ? v.tampered : 0;
    const contract = typeof v.contractVersion === 'string' ? v.contractVersion : null;
    if (events !== null) {
      mount.appendChild(el('div', { style: `border:1px solid var(--m-line);border-left:3px solid ${intact ? 'var(--m-ok)' : 'var(--m-danger)'};border-radius:var(--m-radius-sm,6px);padding:8px 12px;margin-bottom:14px;` }, [
        el('span', { style: `font-size:13px;color:${intact ? 'var(--m-ok)' : 'var(--m-danger)'};` }, intact ? '✓' : '⚠'),
        el('span', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-1);margin-left:8px;' },
          `chain ${intact ? 'verified' : 'BROKEN'} · ${events} events · ${tampered} tampered${contract ? ` · contract ${contract}` : ''}`),
      ]));
    }

    // ── Category counts ──
    const byCategory = (data.byCategory && typeof data.byCategory === 'object') ? data.byCategory : {};
    const total = typeof data.total === 'number' ? data.total : 0;
    const shown = typeof data.shown === 'number' ? data.shown : (Array.isArray(data.decisions) ? data.decisions.length : 0);
    const chips = ['intent', 'decision', 'gate', 'outcome']
      .filter((c) => typeof byCategory[c] === 'number' && byCategory[c] > 0)
      .map((c) => el('span', { style: `font-family:var(--m-font-mono);font-size:11px;color:${categoryColor(c)};margin-right:14px;` }, `${byCategory[c]} ${c}`));
    if (chips.length) mount.appendChild(el('div', { style: 'margin-bottom:10px;' }, chips));

    // ── The ledger ──
    if (!data.decisions.length) {
      mount.appendChild(placeholder('No decisions yet', 'Decision-grade moments will appear here as they happen.'));
      return;
    }
    mount.appendChild(el('div', {}, data.decisions.map(decisionRow)));
    if (total > shown) {
      mount.appendChild(el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);margin-top:8px;' }, `showing ${shown} of ${total} — full history: maddu spine verify`));
    }
  })();

  return root;
}
