// Máddu cockpit — reference route views (low-live read-only pages).
//
// Extracted from cockpit.js (v1.47.0) as the second view-module slice of Phase 1.
// These are the "reference" cluster: goal, tools, loops, search, wiki — pages the
// operator reads rather than drives. Four of them are pure-leaf moves (only
// leaves + route metadata + global fetch); renderGoal alone needs a shell helper
// (panelFocus, which self-registers a command-palette sub-target against the
// shell's SUB_REGISTRY), injected via `ctx.panelFocus`. The module imports ONLY
// leaves + route metadata, so there is no circular import back into cockpit.js.
//
// ctx.panelFocus(title, aside, body, opts) — panel() that also stamps data-focus
// and registers the panel as a palette-reachable sub-target. Owned by cockpit.js
// (it closes over the shell-wide SUB_REGISTRY + the active route).

import { el, panel, placeholder, loading, showToast } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';

export function renderGoal(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Goal'));
  root.appendChild(el('p', {}, ROUTE_META.goal.description));
  const mount = el('div', {});
  mount.appendChild(loading('Reading goal + handoff…'));
  root.appendChild(ctx.panelFocus('Goal & handoff', 'GET /bridge/goal · run `maddu orient` for live success checks', mount,
    { id: 'goal', keywords: 'goal objective success conditions constraints handoff resume next briefing' }));
  (async () => {
    let data = null;
    try { const r = await fetch('/bridge/goal', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch {}
    mount.textContent = '';
    if (!data || !data.goal) {
      mount.appendChild(el('p', {}, 'No goal set. Run: maddu goal set "<objective>" --success "<cmd>::<text>"'));
      return;
    }
    const g = data.goal;
    mount.appendChild(el('p', {}, el('strong', {}, g.objective || '(no objective)')));
    if (data.phase) mount.appendChild(el('p', {}, 'phase: ' + (data.phase.name || data.phase)));
    mount.appendChild(el('h3', {}, `Success conditions (${g.success.length})`));
    const ul = el('ul', {});
    for (const s of g.success) ul.appendChild(el('li', {}, (s.verifiable ? '◇ ' : '? ') + s.text + (s.verifiable ? '' : ' — unverifiable')));
    if (!g.success.length) ul.appendChild(el('li', {}, '(none)'));
    mount.appendChild(ul);
    if (g.constraints.length) {
      mount.appendChild(el('h3', {}, `Constraints (${g.constraints.length})`));
      const cl = el('ul', {});
      for (const c of g.constraints) cl.appendChild(el('li', {}, c));
      mount.appendChild(cl);
    }
    mount.appendChild(el('h3', {}, '▶ Curated handoff'));
    mount.appendChild(el('pre', {}, (data.handoff && data.handoff.body) ? data.handoff.body : '(none — set with: maddu handoff set "…")'));
    if (data.recentSliceStops && data.recentSliceStops.length) {
      mount.appendChild(el('h3', {}, 'Recent slice-stops'));
      const tl = el('ul', {});
      for (const t of data.recentSliceStops) tl.appendChild(el('li', {}, t.summary || '—'));
      mount.appendChild(tl);
    }
  })();
  return root;
}

export function renderTools() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Tools'));
  root.appendChild(el('p', {}, ROUTE_META.tools.description));

  const defaultsMount = el('div', {});
  defaultsMount.appendChild(loading('Loading default tools…'));
  root.appendChild(panel('Default tools (5)', 'git · test · format · lint · install — audited subprocess wrappers (v1.1.0 P1)', defaultsMount));

  const mcpMount = el('div', {});
  mcpMount.appendChild(loading('Loading MCP servers…'));
  root.appendChild(panel('MCP servers', 'Active registrations (v1.1.0 P2 templates installable via maddu mcp install)', mcpMount));

  const recentMount = el('div', {});
  recentMount.appendChild(loading('Loading recent invocations…'));
  root.appendChild(panel('Recent tool events (last 20)', 'TOOL_INVOKED / TOOL_COMPLETED / TOOL_REFUSED', recentMount));

  function fmtArgv(argv) { return Array.isArray(argv) ? argv.join(' ') : ''; }
  function badge(s, color) { return el('span', { style: `display:inline-block;padding:1px 6px;border-radius:3px;background:${color};color:#000;font-family:var(--m-font-mono);font-size:11px;` }, s); }

  async function refresh() {
    let data;
    try { data = await (await fetch('/bridge/tools')).json(); }
    catch (err) {
      defaultsMount.innerHTML = '';
      defaultsMount.appendChild(placeholder('Bridge unreachable', err.message));
      return;
    }
    defaultsMount.innerHTML = '';
    const dlist = el('div', { style: 'display:grid;grid-template-columns:repeat(5,1fr);gap:8px;' });
    for (const t of (data.defaults || [])) {
      const card = el('div', { style: 'border:1px solid var(--m-line);padding:8px 10px;background:var(--m-bg-2);' });
      card.appendChild(el('div', { style: 'font-family:var(--m-font-mono);font-size:13px;font-weight:bold;' }, t.tool));
      card.appendChild(el('div', { style: 'font-size:11px;color:var(--m-fg-2);margin-top:2px;' }, 'audited'));
      dlist.appendChild(card);
    }
    defaultsMount.appendChild(dlist);

    mcpMount.innerHTML = '';
    const mcp = data.mcp || [];
    if (mcp.length === 0) {
      mcpMount.appendChild(placeholder('No MCP servers registered', 'Run `maddu mcp templates list` to see the 5 curated templates.'));
    } else {
      const list = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;' });
      for (const s of mcp) {
        const card = el('div', { style: 'border:1px solid var(--m-line);padding:8px 10px;background:var(--m-bg-2);' });
        const header = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;font-family:var(--m-font-mono);font-size:13px;' });
        header.appendChild(el('span', {}, s.name));
        header.appendChild(el('span', { style: 'font-size:11px;color:var(--m-fg-2);' }, s.transport + (s.enabled ? ' · on' : ' · off')));
        card.appendChild(header);
        // v1.2.0 Phase 2 — provenance row.
        const prov = s.provenance || null;
        if (prov) {
          let provColor = '#888';
          let provLabel = prov.source || 'unknown';
          if (prov.source === 'framework-shipped' && prov.approved) { provColor = '#7c7'; provLabel = 'framework-shipped ✓'; }
          else if (prov.source === 'operator-trusted' && prov.approved) { provColor = '#6cf'; provLabel = 'operator-trusted ✓'; }
          else if (prov.source === 'operator-trusted' && !prov.approved) { provColor = '#e77'; provLabel = 'operator-trusted (pending approval)'; }
          card.appendChild(el('div', { style: `font-size:11px;color:${provColor};margin-top:4px;font-family:var(--m-font-mono);` }, `provenance: ${provLabel}`));
        } else {
          card.appendChild(el('div', { style: 'font-size:11px;color:#cb6;margin-top:4px;font-family:var(--m-font-mono);' }, 'provenance: (none — pre-v1.2.0 install)'));
        }
        const h = (data.health || {})[s.name];
        const note = h?.ok ? 'health: ok' : (h ? `health: ${h.error || 'down'}` : 'no health check yet');
        card.appendChild(el('div', { style: 'font-size:11px;color:var(--m-fg-2);margin-top:4px;' }, note));
        list.appendChild(card);
      }
      mcpMount.appendChild(list);
    }

    recentMount.innerHTML = '';
    const recent = data.recent || [];
    if (recent.length === 0) {
      recentMount.appendChild(placeholder('No tool events yet', 'Run a default tool (e.g. `maddu git status`) to populate.'));
    } else {
      const table = el('table', { style: 'width:100%;border-collapse:collapse;font-family:var(--m-font-mono);font-size:12px;' });
      const head = el('tr', {});
      for (const h of ['ts', 'type', 'tool', 'argv', 'detail']) {
        head.appendChild(el('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);font-weight:normal;' }, h));
      }
      table.appendChild(head);
      for (const ev of recent) {
        const row = el('tr', {});
        const ts = (ev.ts || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z');
        row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, ts));
        let typeColor = '#888';
        if (ev.type === 'TOOL_INVOKED') typeColor = '#6cf';
        else if (ev.type === 'TOOL_COMPLETED') typeColor = ((ev.data?.exitCode === 0) ? '#7c7' : '#e77');
        else if (ev.type === 'TOOL_REFUSED') typeColor = '#e77';
        const typeCell = el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);' });
        typeCell.appendChild(badge(ev.type.replace('TOOL_', ''), typeColor));
        row.appendChild(typeCell);
        row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);' }, ev.data?.tool || '—'));
        row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, fmtArgv(ev.data?.argv).slice(0, 60)));
        const detail = ev.type === 'TOOL_REFUSED' ? (ev.data?.detail || ev.data?.reason || '') :
                       ev.type === 'TOOL_COMPLETED' ? `exit=${ev.data?.exitCode} ${ev.data?.durationMs}ms` :
                       (ev.data?.mode || '');
        row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, String(detail).slice(0, 80)));
        table.appendChild(row);
      }
      recentMount.appendChild(table);
    }
  }
  refresh();
  return root;
}

// v1.1.0 Phase 6 — Loops cockpit route.
export function renderLoops() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Loops'));
  root.appendChild(el('p', {}, ROUTE_META.loops.description));
  const mount = el('div', {});
  mount.appendChild(loading('Loading loops…'));
  root.appendChild(panel('All loops', 'GET /bridge/loops · LOOP_* events', mount));
  fetch('/bridge/loops').then((r) => r.json()).then((d) => {
    mount.innerHTML = '';
    const loops = d.loops || [];
    if (loops.length === 0) {
      mount.appendChild(placeholder('No loops yet', 'Run `maddu loop ralph --goal "<task>" --verify "<cmd>"` to start one.'));
      return;
    }
    const table = el('table', { style: 'width:100%;border-collapse:collapse;font-family:var(--m-font-mono);font-size:12px;' });
    const head = el('tr', {});
    for (const h of ['loopId', 'kind', 'status', 'iters/max', 'cooldown', 'goal']) {
      head.appendChild(el('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);font-weight:normal;' }, h));
    }
    table.appendChild(head);
    for (const l of loops) {
      const row = el('tr', {});
      row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, l.loopId));
      row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);' }, l.kind || '—'));
      const sColor = l.status === 'completed' ? '#7c7' : (l.status === 'halted' ? '#e77' : '#6cf');
      row.appendChild(el('td', { style: `padding:4px 6px;border-bottom:1px solid var(--m-line);color:${sColor};` }, l.status + (l.reason ? ` (${l.reason})` : '')));
      row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);' }, `${l.iters}/${l.maxIter || '?'}`));
      row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, l.cooldownMs ? `${l.cooldownMs}ms` : '—'));
      row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, (l.goal || '').slice(0, 60)));
      table.appendChild(row);
    }
    mount.appendChild(table);
  }).catch((err) => { mount.innerHTML = ''; mount.appendChild(placeholder('Bridge unreachable', err.message)); });
  return root;
}

export function renderSearch() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Search'));
  root.appendChild(el('p', {}, ROUTE_META.search.description));

  const KINDS = ['event', 'slice', 'memory', 'skill', 'mailbox', 'inbox'];
  const input = el('input', {
    type: 'text', placeholder: 'Type to search across all corpora…',
    style: 'width:100%;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:8px 12px;font-family:var(--m-font-mono);font-size:13px;'
  });
  // Kind filter checkboxes
  const filterBox = el('div', { style: 'display:flex;gap:12px;margin:8px 0;flex-wrap:wrap;font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-2);' });
  const checks = {};
  for (const k of KINDS) {
    const id = `k-${k}`;
    const cb = el('input', { type: 'checkbox', id, checked: 'checked', style: 'margin-right:4px;' });
    cb.checked = true;
    checks[k] = cb;
    const lbl = el('label', { for: id, style: 'cursor:pointer;color:var(--m-fg-2);' });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(k));
    filterBox.appendChild(lbl);
  }

  root.appendChild(input);
  root.appendChild(filterBox);

  const mount = el('div', {});
  root.appendChild(mount);

  let debounceTimer = null;
  let lastQuery = '';

  async function run() {
    const q = input.value.trim();
    lastQuery = q;
    if (!q) { mount.innerHTML = ''; mount.appendChild(placeholder('Type a query', 'Substring match across events, slice-stops, memory, skills, mailbox, inbox.')); return; }
    const enabled = KINDS.filter((k) => checks[k].checked);
    mount.innerHTML = '';
    mount.appendChild(loading(`Searching for "${q}"…`));
    try {
      const r = await fetch(`/bridge/search?q=${encodeURIComponent(q)}&kinds=${enabled.join(',')}&limit=200`, { cache: 'no-store' });
      if (q !== lastQuery) return;
      const d = await r.json();
      mount.innerHTML = '';
      if (d.count === 0) { mount.appendChild(placeholder('No matches', 'Try a different query or expand the kind filters.')); return; }
      mount.appendChild(panel(`${d.count} match${d.count === 1 ? '' : 'es'}`, `GET /bridge/search?q=${encodeURIComponent(q)}`, (() => {
        const list = el('div', {});
        // Group by kind
        const groups = {};
        for (const r of d.results) (groups[r.kind] || (groups[r.kind] = [])).push(r);
        for (const kind of ['slice', 'memory', 'skill', 'mailbox', 'inbox', 'event']) {
          const g = groups[kind];
          if (!g || g.length === 0) continue;
          const ccls = { event: 't-session', slice: 't-slice', memory: 't-framework', skill: 't-lane', mailbox: 't-approval', inbox: 't-inbox' }[kind] || '';
          list.appendChild(el('div', { class: 'panel-title', style: 'margin:12px 0 6px;' }, `${kind.toUpperCase()}  (${g.length})`));
          for (const r of g) {
            list.appendChild(el('div', { class: 'ledger-row' }, [
              el('span', {}, r.ts ? r.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'),
              el('span', { class: `event-type ${ccls}` }, r.kind),
              el('span', {}, [
                el('div', { style: 'color:var(--m-fg-0);' }, r.title || r.id),
                r.snippet && r.snippet !== r.title ? el('div', { class: 'event-actor' }, r.snippet) : null
              ]),
              el('span', { class: 'event-actor' }, r.lane || '')
            ]));
          }
        }
        return list;
      })()));
    } catch (err) {
      mount.innerHTML = '';
      mount.appendChild(placeholder('Search error', err.message || String(err)));
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 250);
  });
  for (const k of KINDS) checks[k].addEventListener('change', run);

  // Allow prefilling via #/search?q=foo
  const hash = location.hash;
  const qm = hash.match(/[?&]q=([^&]+)/);
  if (qm) {
    input.value = decodeURIComponent(qm[1]);
    setTimeout(run, 0);
  } else {
    run();
  }
  setTimeout(() => input.focus(), 0);
  return root;
}

export function renderWiki() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Wiki'));
  root.appendChild(el('p', {}, ROUTE_META.wiki.description));

  const driftBody = el('div', {});
  driftBody.appendChild(loading('Computing drift…'));
  const driftPanel = panel('Drift Drawer', 'GET /bridge/wiki · pages older than the latest slice-stop on their lane', driftBody);

  const pagesBody = el('div', {});
  pagesBody.appendChild(loading('Listing wiki pages…'));
  const pagesPanel = panel('Pages', 'one page per lane · auto-stamped on slice-stop', pagesBody);

  const viewBody = el('div', {});
  viewBody.appendChild(placeholder('Pick a page', 'Click a page on the left to read its rendered markdown.'));
  const viewPanel = panel('Page', 'GET /bridge/wiki/page', viewBody);

  const head = panel('Actions', 'Rebuild rewrites every page from the spine — safe, idempotent.', el('div', { style: 'display:flex;gap:8px;align-items:center;' }, [
    (() => {
      const btn = el('button', { class: 'm-btn' }, 'Rebuild wiki');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const r = await fetch('/bridge/wiki/rebuild', { method: 'POST' });
          const j = await r.json();
          if (typeof showToast === 'function') showToast(`Rebuilt · ${j.pagesWritten} page(s)`, 'ok');
          await refresh();
        } catch (e) {
          if (typeof showToast === 'function') showToast(`Rebuild failed: ${e}`, 'err');
        } finally { btn.disabled = false; }
      });
      return btn;
    })()
  ]));

  root.appendChild(head);
  root.appendChild(driftPanel);
  root.appendChild(pagesPanel);
  root.appendChild(viewPanel);

  async function loadPage(page) {
    viewBody.innerHTML = '';
    viewBody.appendChild(loading(`Reading ${page}…`));
    try {
      const r = await fetch(`/bridge/wiki/page?page=${encodeURIComponent(page)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      viewBody.innerHTML = '';
      const head = el('div', { class: 'wiki-page-head' }, [
        el('span', { class: 'mono' }, page),
        el('span', { class: 'panel-aside' }, `${(j.body || '').length} bytes`)
      ]);
      viewBody.appendChild(head);
      const pre = el('pre', { class: 'wiki-page-body mono' }, j.body || '');
      viewBody.appendChild(pre);
    } catch (e) {
      viewBody.innerHTML = '';
      viewBody.appendChild(placeholder('Error', String(e)));
    }
  }

  async function refresh() {
    let data;
    try {
      const r = await fetch('/bridge/wiki', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } catch (e) {
      driftBody.innerHTML = '';
      driftBody.appendChild(placeholder('Error', String(e)));
      return;
    }

    const pages = data.pages || [];
    const drifted = pages.filter((p) => p.drifted);

    driftBody.innerHTML = '';
    if (!drifted.length) {
      driftBody.appendChild(placeholder('No drift', 'Every wiki page is at least as fresh as its lane\'s last slice-stop.'));
    } else {
      const list = el('div', { class: 'wiki-drift' });
      for (const p of drifted) {
        const row = el('div', { class: 'wiki-drift-row' }, [
          el('span', { class: 'pill tone-warn' }, p.missing ? 'missing' : 'stale'),
          el('span', { class: 'mono' }, p.page),
          el('span', { class: 'panel-aside' }, `lane: ${p.lane || '(none)'} · last slice: ${p.lastSlice || 'n/a'}`)
        ]);
        list.appendChild(row);
      }
      driftBody.appendChild(list);
    }

    pagesBody.innerHTML = '';
    if (!pages.length) {
      pagesBody.appendChild(placeholder('No pages', 'Run a slice-stop or POST /bridge/wiki/rebuild.'));
    } else {
      const list = el('div', { class: 'wiki-pages' });
      for (const p of pages) {
        const row = el('div', { class: 'wiki-page-row', tabindex: '0', role: 'button' }, [
          el('span', { class: 'mono' }, p.page),
          el('span', { class: 'panel-aside' }, `${p.bytes || 0} B · lane ${p.lane || '(none)'}${p.drifted ? ' · drift' : ''}`)
        ]);
        if (p.drifted) row.classList.add('drift');
        row.addEventListener('click', () => loadPage(p.page));
        list.appendChild(row);
      }
      pagesBody.appendChild(list);
    }
  }

  refresh();
  return root;
}
