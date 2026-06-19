// Máddu cockpit — inspect-heavy route views (rows that open the Inspector).
//
// Extracted from cockpit.js (v1.49.0) as the first slice of the "inspect-heavy"
// cluster: views whose rows/cards are clickable triggers that open the shared
// Inspector drawer. The Inspector is a shell singleton, so it's injected via
// `ctx.openInspector` (the dependency-injection seam grows to
// { bindRefresh, panelFocus, openInspector }). The module imports only leaves +
// route metadata, never reaching back into cockpit.js (no circular import).
//
// ctx.openInspector(entity) — opens the shell's Inspector drawer for an entity
// descriptor ({ kind, label, id, raw, evidence, related }). Owned by cockpit.js.

import { el, panel, placeholder, loading, laneFromFact, formatTs, showToast } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';

const LEARNING_KIND_TONE = {
  rule:       'accent',
  constraint: 'warn',
  discovery:  'blue',
  followup:   'ok',
  touched:    'fg-3',
  gate:       'fg-3',
  summary:    'accent'
};

export function renderLearning(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Learning'));
  root.appendChild(el('p', {}, ROUTE_META.learning.description));

  const state = { kind: '', lane: '', q: '' };

  const controls = el('div', { class: 'panel-head', style: 'gap:8px;flex-wrap:wrap;' });
  const kindSel = el('select', { class: 'm-select', 'aria-label': 'Kind filter' });
  kindSel.appendChild(el('option', { value: '' }, 'all kinds'));
  for (const k of ['rule', 'constraint', 'discovery', 'followup', 'touched', 'gate', 'summary']) {
    kindSel.appendChild(el('option', { value: k }, k));
  }
  const laneSel = el('select', { class: 'm-select', 'aria-label': 'Lane filter' });
  laneSel.appendChild(el('option', { value: '' }, 'all lanes'));
  const qIn = el('input', { class: 'm-input', placeholder: 'substring query…', 'aria-label': 'Query' });
  const reextract = el('button', { class: 'm-btn' }, 'Re-extract');
  controls.appendChild(kindSel);
  controls.appendChild(laneSel);
  controls.appendChild(qIn);
  controls.appendChild(reextract);

  const summaryBody = el('div', {});
  const summary = panel('Findings', 'GET /bridge/learning · grouped by kind + lane', summaryBody);
  summary.querySelector('.panel-head').appendChild(controls);

  const factsBody = el('div', {});
  factsBody.appendChild(loading('Fetching findings…'));
  const facts = panel('Recent findings', 'click a row to open in Inspector', factsBody);

  root.appendChild(summary);
  root.appendChild(facts);

  async function refresh() {
    const qs = new URLSearchParams();
    qs.set('limit', '500');
    if (state.kind) qs.set('kind', state.kind);
    if (state.lane) qs.set('lane', state.lane);
    if (state.q)    qs.set('q', state.q);
    factsBody.innerHTML = '';
    factsBody.appendChild(loading('Fetching findings…'));
    let data;
    try {
      const r = await fetch(`/bridge/learning?${qs.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } catch (e) {
      factsBody.innerHTML = '';
      factsBody.appendChild(placeholder('Error', String(e)));
      return;
    }

    // Summary tiles
    summaryBody.innerHTML = '';
    const tiles = el('div', { class: 'kpi-strip' });
    tiles.appendChild(el('div', { class: 'kpi-tile' }, [
      el('div', { class: 'kpi-num' }, String(data.count)),
      el('div', { class: 'kpi-lbl' }, 'facts')
    ]));
    for (const [k, n] of Object.entries(data.byKind || {})) {
      const tone = LEARNING_KIND_TONE[k] || 'fg-3';
      tiles.appendChild(el('div', { class: `kpi-tile tone-${tone}` }, [
        el('div', { class: 'kpi-num' }, String(n)),
        el('div', { class: 'kpi-lbl' }, k)
      ]));
    }
    summaryBody.appendChild(tiles);

    // Repopulate lane filter from observed lanes
    const lanes = Object.keys(data.byLane || {}).sort();
    const prev = laneSel.value;
    laneSel.innerHTML = '';
    laneSel.appendChild(el('option', { value: '' }, 'all lanes'));
    for (const l of lanes) laneSel.appendChild(el('option', { value: l === '(none)' ? '' : l }, l));
    if (prev) laneSel.value = prev;

    // Facts list (newest first)
    factsBody.innerHTML = '';
    if (!data.facts.length) {
      factsBody.appendChild(placeholder('No findings', 'Run a slice-stop with --learnings to populate this.'));
      return;
    }
    const list = el('div', { class: 'learning-list' });
    const sorted = [...data.facts].sort((a, b) => (a.ts < b.ts ? 1 : -1));
    for (const f of sorted) {
      const tone = LEARNING_KIND_TONE[f.kind] || 'fg-3';
      const row = el('div', { class: 'learning-row', tabindex: '0', role: 'button' }, [
        el('div', { class: 'learning-head' }, [
          el('span', { class: `pill tone-${tone}` }, f.kind),
          el('span', { class: 'learning-lane' }, laneFromFact(f) || '(no lane)'),
          el('span', { class: 'learning-ts mono' }, formatTs ? formatTs(f.ts) : f.ts)
        ]),
        el('div', { class: 'learning-text' }, f.text),
        el('div', { class: 'learning-tags mono' }, (f.tags || []).join(' · '))
      ]);
      row.addEventListener('click', () => {
        if (typeof ctx.openInspector === 'function') {
          ctx.openInspector({
            kind: 'finding',
            label: f.text,
            id: f.id,
            raw: f,
            evidence: [{ label: 'Source event', value: f.source && f.source.event }],
            related: f.source && f.source.event ? [{ kind: 'event', id: f.source.event, label: f.source.event }] : []
          });
        }
      });
      list.appendChild(row);
    }
    factsBody.appendChild(list);
  }

  kindSel.addEventListener('change', () => { state.kind = kindSel.value; refresh(); });
  laneSel.addEventListener('change', () => { state.lane = laneSel.value; refresh(); });
  qIn.addEventListener('input', () => { state.q = qIn.value; clearTimeout(qIn._t); qIn._t = setTimeout(refresh, 250); });
  reextract.addEventListener('click', async () => {
    reextract.disabled = true;
    try {
      const r = await fetch('/bridge/memory/extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json();
      if (typeof showToast === 'function') showToast(`Re-extracted · +${j.added} facts`, 'ok');
      await refresh();
    } catch (e) {
      if (typeof showToast === 'function') showToast(`Re-extract failed: ${e}`, 'err');
    } finally { reextract.disabled = false; }
  });

  refresh();
  return root;
}
