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

import { el, panel, placeholder, loading, loadingFor, laneFromFact, formatTs, formatAge, showToast } from './cockpit-util.js';
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

// renderTeams — lane-ownership map (catalog × active claims × slice frequency).
// Each lane card opens in the Inspector on click. Shell deps injected via ctx:
// fetchLanes/fetchProjection (bridge fetch helpers), openInspector, and the
// command-palette focus pair paletteFocus/focusPanelByKeyword (so a
// #/teams?focus=<lane> deep link scrolls + flashes the matching card).
export function renderTeams(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Teams'));
  root.appendChild(el('p', {}, ROUTE_META.teams.description));

  const mapBody = el('div', {});
  mapBody.appendChild(loadingFor('grid', 'Building ownership map…'));
  root.appendChild(panel('Lane ownership', 'lanes catalog × active claims × slice-stop frequency', mapBody));

  (async () => {
    const [lanes, proj] = await Promise.all([ctx.fetchLanes(), ctx.fetchProjection()]);
    if (!lanes || !proj) {
      mapBody.innerHTML = '';
      mapBody.appendChild(placeholder('Error', 'Could not fetch lanes or projection.'));
      return;
    }
    const catalog = (lanes.catalog && lanes.catalog.lanes) || [];
    const claims = proj.claims || [];
    const slices = proj.sliceStops || [];
    const sessions = proj.activeSessions || [];
    const sessById = Object.fromEntries(sessions.map((s) => [s.id, s]));

    // Stats per lane
    const sliceCountByLane = {};
    const lastSliceByLane = {};
    for (const s of slices) {
      const l = s.lane || '(none)';
      sliceCountByLane[l] = (sliceCountByLane[l] || 0) + 1;
      const prev = lastSliceByLane[l];
      if (!prev || prev.ts < s.ts) lastSliceByLane[l] = s;
    }
    const claimByLane = Object.fromEntries(claims.map((c) => [c.lane, c]));

    mapBody.innerHTML = '';
    if (!catalog.length) {
      mapBody.appendChild(placeholder('No lanes', 'Add lanes via Settings or .maddu/lanes/catalog.json.'));
      return;
    }
    const list = el('div', { class: 'team-map' });
    for (const lane of catalog) {
      const claim = claimByLane[lane.id];
      const lastSlice = lastSliceByLane[lane.id];
      const claimSess = claim ? sessById[claim.sessionId] : null;
      const card = el('div', { class: 'team-lane-card' + (claim ? ' active' : ''), 'data-focus': lane.id }, [
        el('div', { class: 'team-lane-head' }, [
          el('span', { class: 'pill tone-accent' }, lane.id),
          claim ? el('span', { class: 'pill tone-ok' }, 'held') : el('span', { class: 'pill tone-fg-3' }, 'free'),
          el('span', { class: 'panel-aside' }, `${sliceCountByLane[lane.id] || 0} slice${(sliceCountByLane[lane.id] || 0) === 1 ? '' : 's'}`)
        ]),
        el('div', { class: 'team-lane-scope' }, lane.scope || '(no scope)'),
        claim ? el('div', { class: 'team-lane-holder' }, [
          el('span', { class: 'panel-aside' }, 'held by: '),
          el('span', { class: 'mono' }, claimSess ? (claimSess.label || claim.sessionId) : claim.sessionId),
          el('span', { class: 'panel-aside mono' }, `· ${claim.focus || '(no focus)'}`)
        ]) : null,
        lastSlice ? el('div', { class: 'team-lane-last panel-aside' }, [
          el('span', {}, 'last slice: '),
          el('span', { class: 'mono' }, formatTs ? formatTs(lastSlice.ts) : lastSlice.ts),
          document.createTextNode(' · '),
          document.createTextNode(lastSlice.summary || '')
        ]) : null,
        lane.policy ? el('div', { class: 'team-lane-policy panel-aside mono' },
          `zones: ${(lane.policy.zones || []).join(', ') || 'n/a'} · lease ${lane.policy.leaseSeconds || 0}s · handoff ${lane.policy.handoffRule || 'n/a'}`
        ) : null
      ]);
      card.addEventListener('click', () => {
        if (typeof ctx.openInspector === 'function') {
          ctx.openInspector({
            kind: 'lane',
            label: lane.id,
            id: lane.id,
            raw: { lane, claim, lastSlice },
            evidence: [
              { label: 'Scope', value: lane.scope },
              { label: 'Held by', value: claim ? claim.sessionId : '(free)' },
              { label: 'Last slice', value: lastSlice ? lastSlice.summary : '(none)' }
            ],
            related: []
          });
        }
      });
      list.appendChild(card);
    }
    mapBody.appendChild(list);
    const f = ctx.paletteFocus();
    if (f) ctx.focusPanelByKeyword(root, f);
  })();

  return root;
}

// ─── Workflows blueprint — SVG node/edge graph; each node opens the Inspector
// (and offers an "Open <route>" action) on click. Pure but for ctx.openInspector;
// the graph topology constants are private to this view.
const WORKFLOW_NODES = [
  { id: 'operator', x:  60, y: 120, label: 'Operator',  desc: 'Drives every slice via Conductor + composer.' },
  { id: 'boss',     x: 240, y:  60, label: 'BOSS',      desc: 'Proposes low-risk handoffs and slices (LLM voice).' },
  { id: 'enforcer', x: 240, y: 180, label: 'Enforcer',  desc: 'Deterministic — cites state, refuses unsafe actions.' },
  { id: 'queue',    x: 440, y:  60, label: 'Queue',     desc: 'Scheduler / Queue / Dispatch / Preflights — every parked card has a reason code.' },
  { id: 'claims',   x: 440, y: 180, label: 'Claims',    desc: 'Active lane claims by session — write-lock + handoff.' },
  { id: 'fleet',    x: 640, y: 120, label: 'Fleet',     desc: 'Sessions on lanes — claude-code, codex, hermes, future agents.' },
  { id: 'gates',    x: 820, y:  60, label: 'Gates',     desc: 'Focused verification — scoped checks instead of full cycles.' },
  { id: 'reports',  x: 820, y: 180, label: 'Reports',   desc: 'Slice-stop ledger, approvals ledger, verification reports.' },
  { id: 'learning', x: 1000, y: 60, label: 'Learning',  desc: 'Hindsight memory — facts distilled from slice-stops.' },
  { id: 'wiki',     x: 1000, y: 180, label: 'Wiki',     desc: 'Wiki Updater — auto-stamps per-lane pages on every slice-stop.' }
];
const WORKFLOW_EDGES = [
  ['operator', 'boss'], ['operator', 'enforcer'],
  ['boss', 'queue'],    ['boss', 'claims'],
  ['enforcer', 'queue'], ['enforcer', 'claims'],
  ['queue', 'fleet'],   ['claims', 'fleet'],
  ['fleet', 'gates'],   ['fleet', 'reports'],
  ['reports', 'learning'], ['reports', 'wiki'],
  ['gates', 'reports']
];
const WORKFLOW_NODE_ROUTE = {
  operator: '#/conductor', boss: '#/boss', enforcer: '#/boss',
  queue: '#/queue', claims: '#/claims', fleet: '#/agents',
  gates: '#/operations', reports: '#/events',
  learning: '#/learning', wiki: '#/wiki'
};

export function renderWorkflows(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Workflows'));
  root.appendChild(el('p', {}, ROUTE_META.workflows.description));

  const W = 1100;
  const H = 260;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'workflow-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const nodeById = Object.fromEntries(WORKFLOW_NODES.map((n) => [n.id, n]));

  // Edges
  const edgeG = document.createElementNS(svgNS, 'g');
  edgeG.setAttribute('class', 'workflow-edges');
  for (const [a, b] of WORKFLOW_EDGES) {
    const na = nodeById[a]; const nb = nodeById[b];
    if (!na || !nb) continue;
    const line = document.createElementNS(svgNS, 'path');
    const dx = (nb.x - na.x) / 2;
    const d = `M ${na.x + 60} ${na.y} C ${na.x + 60 + dx} ${na.y}, ${nb.x - dx} ${nb.y}, ${nb.x - 60} ${nb.y}`;
    line.setAttribute('d', d);
    line.setAttribute('class', 'workflow-edge');
    edgeG.appendChild(line);
  }
  svg.appendChild(edgeG);

  // Nodes
  const nodeG = document.createElementNS(svgNS, 'g');
  nodeG.setAttribute('class', 'workflow-nodes');
  for (const n of WORKFLOW_NODES) {
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'workflow-node');
    g.setAttribute('transform', `translate(${n.x - 60}, ${n.y - 22})`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', n.label);
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('width', '120');
    rect.setAttribute('height', '44');
    rect.setAttribute('rx', '6');
    rect.setAttribute('class', 'workflow-node-rect');
    g.appendChild(rect);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', '60');
    text.setAttribute('y', '27');
    text.setAttribute('class', 'workflow-node-label');
    text.setAttribute('text-anchor', 'middle');
    text.textContent = n.label;
    g.appendChild(text);
    g.addEventListener('click', () => {
      if (typeof ctx.openInspector === 'function') {
        ctx.openInspector({
          kind: 'workflow-node',
          label: n.label,
          id: n.id,
          raw: n,
          evidence: [{ label: 'Route', value: WORKFLOW_NODE_ROUTE[n.id] || '(none)' }],
          actions: [
            { label: `Open ${n.label}`, run: () => { location.hash = WORKFLOW_NODE_ROUTE[n.id] || '#/conductor'; } }
          ],
          related: []
        });
      } else {
        location.hash = WORKFLOW_NODE_ROUTE[n.id] || '#/conductor';
      }
    });
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter') g.dispatchEvent(new Event('click')); });
    nodeG.appendChild(g);
  }
  svg.appendChild(nodeG);

  const wrap = el('div', { class: 'workflow-wrap' });
  wrap.appendChild(svg);
  root.appendChild(panel('Blueprint', 'click any node to open its route', wrap));

  // Legend
  const legend = el('div', { class: 'workflow-legend' });
  for (const n of WORKFLOW_NODES) {
    legend.appendChild(el('div', { class: 'workflow-legend-row' }, [
      el('span', { class: 'pill tone-accent' }, n.label),
      el('span', {}, n.desc),
      (() => {
        const a = el('a', { href: WORKFLOW_NODE_ROUTE[n.id] || '#/conductor', class: 'workflow-legend-go mono' }, WORKFLOW_NODE_ROUTE[n.id] || '');
        return a;
      })()
    ]));
  }
  root.appendChild(panel('Legend', 'every node maps to a route', legend));

  return root;
}

// renderRoadmap — slice-stop KPIs, 28-day closure cadence, lane mix, and a
// slice index whose rows open in the Inspector. Charts are built inline (no
// widget deps). Shell deps via ctx: panelFocus (palette sub-targets),
// fetchProjection (spine projection), openInspector (slice-index row click).
export function renderRoadmap(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Roadmap'));
  root.appendChild(el('p', {}, ROUTE_META.roadmap.description));

  const kpiMount = el('div', {});
  kpiMount.appendChild(loadingFor('kpi', 'Reading slice timeline…'));
  root.appendChild(ctx.panelFocus('Roadmap KPIs', 'derived from spine SLICE_STOPs', kpiMount,
    { id: 'kpis', keywords: 'kpi roadmap total last lanes age metric' }));

  const cadenceMount = el('div', {});
  cadenceMount.appendChild(loading('Charting closure cadence…'));
  root.appendChild(ctx.panelFocus('Slice closure cadence', 'last 28 days · 1 bar = 1 day', cadenceMount,
    { id: 'cadence', keywords: 'cadence closure 28-day bar chart frequency' }));

  const mixMount = el('div', {});
  mixMount.appendChild(loading('Computing lane mix…'));
  root.appendChild(ctx.panelFocus('Status & lane mix', 'sessions × lanes', mixMount,
    { id: 'mix', keywords: 'mix lanes status distribution sessions' }));

  const indexMount = el('div', {});
  indexMount.appendChild(loadingFor('table', 'Reading slice index…'));
  root.appendChild(ctx.panelFocus('Slice index', 'every slice-stop · click to open in Inspector', indexMount,
    { id: 'slice-index', keywords: 'slice index history list ledger every-stop' }));

  const slicesPlan = [
    ['v0.4.0 · Slice α', 'Conductor + Inspector'],
    ['v0.5.0 · Slice β', 'Queue Board + Claim Map'],
    ['v0.6.0 · Slice γ', 'BOSS/Enforcer duality'],
    ['v0.7.0 · Slice δ', 'Learning Memory + Wiki Updater'],
    ['v0.8.0 · Slice ε', 'Workflows + Roadmap depth + Agents/Teams']
  ];
  const planList = el('div', { class: 'roadmap-plan' });
  for (const [tag, body] of slicesPlan) {
    planList.appendChild(el('div', { class: 'roadmap-plan-row' }, [
      el('span', { class: 'pill tone-accent' }, tag),
      el('span', {}, body)
    ]));
  }
  root.appendChild(ctx.panelFocus('Slice plan', 'approved depth-upgrade plan', planList,
    { id: 'plan', keywords: 'plan slices alpha beta gamma delta epsilon zeta eta versions' }));

  (async () => {
    const proj = await ctx.fetchProjection();
    if (!proj) {
      kpiMount.innerHTML = '';
      kpiMount.appendChild(placeholder('Error', 'Could not fetch projection.'));
      return;
    }
    const slices = proj.sliceStops || [];
    const total = slices.length;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const last7 = slices.filter((s) => now - new Date(s.ts).getTime() < 7 * day).length;
    const last24 = slices.filter((s) => now - new Date(s.ts).getTime() < day).length;
    const lanes = new Set(slices.map((s) => s.lane).filter(Boolean));
    const lastSlice = slices.length ? slices[slices.length - 1] : null;

    kpiMount.innerHTML = '';
    const tiles = el('div', { class: 'kpi-strip' });
    tiles.appendChild(el('div', { class: 'kpi-tile' }, [
      el('div', { class: 'kpi-num' }, String(total)),
      el('div', { class: 'kpi-lbl' }, 'slice-stops total')
    ]));
    tiles.appendChild(el('div', { class: 'kpi-tile tone-accent' }, [
      el('div', { class: 'kpi-num' }, String(last7)),
      el('div', { class: 'kpi-lbl' }, 'last 7 days')
    ]));
    tiles.appendChild(el('div', { class: 'kpi-tile tone-ok' }, [
      el('div', { class: 'kpi-num' }, String(last24)),
      el('div', { class: 'kpi-lbl' }, 'last 24h')
    ]));
    tiles.appendChild(el('div', { class: 'kpi-tile tone-blue' }, [
      el('div', { class: 'kpi-num' }, String(lanes.size)),
      el('div', { class: 'kpi-lbl' }, 'lanes touched')
    ]));
    tiles.appendChild(el('div', { class: 'kpi-tile' }, [
      el('div', { class: 'kpi-num mono' }, lastSlice ? (formatAge ? formatAge(lastSlice.ts) : lastSlice.ts) : 'n/a'),
      el('div', { class: 'kpi-lbl' }, 'since last slice')
    ]));
    kpiMount.appendChild(tiles);

    // Cadence: 28-day bar
    cadenceMount.innerHTML = '';
    const bins = new Array(28).fill(0);
    for (const s of slices) {
      const age = Math.floor((now - new Date(s.ts).getTime()) / day);
      if (age >= 0 && age < 28) bins[27 - age]++;
    }
    const max = Math.max(1, ...bins);
    const bar = el('div', { class: 'cadence-bar' });
    for (const v of bins) {
      const h = Math.round((v / max) * 100);
      bar.appendChild(el('div', { class: 'cadence-cell', style: `height:${h}%` }, [
        el('span', { class: 'cadence-cell-fill', style: `height:${h}%` })
      ]));
    }
    cadenceMount.appendChild(bar);

    // Lane mix table
    mixMount.innerHTML = '';
    const byLane = {};
    for (const s of slices) {
      const l = s.lane || '(none)';
      byLane[l] = (byLane[l] || 0) + 1;
    }
    const mixTable = el('div', { class: 'lane-mix' });
    const sortedLanes = Object.entries(byLane).sort((a, b) => b[1] - a[1]);
    if (!sortedLanes.length) {
      mixMount.appendChild(placeholder('No data', 'No slice-stops yet.'));
    } else {
      const maxN = sortedLanes[0][1];
      for (const [lane, n] of sortedLanes) {
        mixTable.appendChild(el('div', { class: 'lane-mix-row' }, [
          el('span', { class: 'lane-mix-name mono' }, lane),
          el('span', { class: 'lane-mix-bar' }, [
            el('span', { class: 'lane-mix-fill', style: `width:${Math.round((n / maxN) * 100)}%` })
          ]),
          el('span', { class: 'lane-mix-num mono' }, String(n))
        ]));
      }
      mixMount.appendChild(mixTable);
    }

    // Slice index
    indexMount.innerHTML = '';
    if (!slices.length) {
      indexMount.appendChild(placeholder('Empty', 'No slice-stops yet.'));
    } else {
      const list = el('div', { class: 'slice-index' });
      const sorted = [...slices].sort((a, b) => (a.ts < b.ts ? 1 : -1));
      for (const s of sorted) {
        const row = el('div', { class: 'slice-index-row', tabindex: '0', role: 'button' }, [
          el('span', { class: 'mono panel-aside' }, formatTs ? formatTs(s.ts) : s.ts),
          el('span', { class: 'pill tone-accent' }, s.lane || '(no lane)'),
          el('span', {}, s.summary || s.id),
          el('span', { class: 'panel-aside mono' }, `${(s.learnings || []).length}L · ${(s.gates || []).length}G`)
        ]);
        row.addEventListener('click', () => {
          if (typeof ctx.openInspector === 'function') {
            ctx.openInspector({
              kind: 'slice-stop',
              label: s.summary || s.id,
              id: s.id,
              raw: s,
              evidence: [
                { label: 'Event id', value: s.id },
                { label: 'Lane', value: s.lane || '(none)' },
                { label: 'Actor', value: s.actor }
              ],
              related: []
            });
          }
        });
        list.appendChild(row);
      }
      indexMount.appendChild(list);
    }
  })();

  return root;
}
