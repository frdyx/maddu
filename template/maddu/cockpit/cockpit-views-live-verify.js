// Maddu cockpit - verify-cluster live views (read-only verification ledgers + live event stream).
// Views: Operations, Events, Gates, Reviews. Split out of cockpit-views-live.js (v1.71.0 decomposition,
// 2026-07-08). Each renders behind the ctx seam; imports leaves + route-meta only,
// no back-edge into cockpit.js. Private helpers live beside their owning view.

import { el, panel, placeholder, loading, loadingFor, showToast } from './cockpit-util.js';
import { sparkline, binByTime, segBar } from './cockpit-widgets.js';
import { classifyEvent, eventRow, prepend } from './cockpit-event-rows.js';
import { ROUTE_META } from './cockpit-route-meta.js';
import { renderProse } from './cockpit-prose.js';


// ---- Operations + Swarm (v1.60.0): live read-mostly views. Operations is
// stream-coupled (SLICE_STOP via ctx.onSpineEvent), registers palette panels
// via ctx.panelFocus, reads ctx.fetchProjection/fetchMemory, and stamps a
// checkpoint with by: ctx.currentSession(). Swarm is static (one Promise.all
// over ctx.fetchLanes + ctx.fetchProjection) - no stream sub.

// ---- Operations ----
export function renderOperations(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Operations'));
  root.appendChild(el('p', {}, ROUTE_META.operations.description));

  // v1.1.0 Phase 4 — receipt log feed (newest 50, all event types).
  const receiptsMount = el('div', {});
  receiptsMount.appendChild(loading('Reading receipt log…'));
  root.appendChild(panel('Receipt log', 'GET /bridge/operations · derived from spine · last 50', receiptsMount));
  fetch('/bridge/operations').then((r) => r.json()).then((d) => {
    receiptsMount.innerHTML = '';
    const receipts = (d && d.receipts) || [];
    if (receipts.length === 0) {
      receiptsMount.appendChild(placeholder('No receipts yet', 'Run any operational command (e.g. `maddu git status`) to populate.'));
      return;
    }
    const table = el('table', { style: 'width:100%;border-collapse:collapse;font-family:var(--m-font-mono);font-size:12px;' });
    const head = el('tr', {});
    for (const h of ['ts', 'type', 'lane', 'summary']) {
      head.appendChild(el('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);font-weight:normal;' }, h));
    }
    table.appendChild(head);
    for (const r of receipts.slice(0, 50)) {
      const row = el('tr', {});
      const ts = (r.ts || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z');
      row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, ts));
      row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:#6cf;' }, r.type));
      row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);' }, r.lane || '—'));
      row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, (r.summary || '').slice(0, 110)));
      table.appendChild(row);
    }
    receiptsMount.appendChild(table);
  }).catch((err) => { receiptsMount.innerHTML = ''; receiptsMount.appendChild(placeholder('Bridge unreachable', err.message)); });

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading slice timeline…'));
  root.appendChild(ctx.panelFocus('Activity', 'slice-stops + memory facts · last 7 days', summaryMount,
    { id: 'activity', keywords: 'activity slice-stops memory facts 7-day timeline' }));

  const slicesMount = el('div', {});
  slicesMount.appendChild(loadingFor('table', 'Fetching slice-stop ledger…'));
  root.appendChild(ctx.panelFocus('Slice ledger', 'GET /bridge/projection · SLICE_STOP events', slicesMount,
    { id: 'slice-ledger', keywords: 'slice ledger SLICE_STOP events history' }));

  const memMount = el('div', {});
  memMount.appendChild(loadingFor('table', 'Fetching hindsight facts…'));
  root.appendChild(ctx.panelFocus('Hindsight memory', 'GET /bridge/memory · facts derived from slice-stops', memMount,
    { id: 'hindsight', keywords: 'hindsight memory facts learnings extraction' }));

  const cpMount = el('div', {});
  cpMount.appendChild(loading('Fetching checkpoints…'));
  root.appendChild(ctx.panelFocus('Checkpoints', 'GET /bridge/checkpoints · git tags at maddu/checkpoint/<id>', cpMount,
    { id: 'checkpoints', keywords: 'checkpoints git tags rollback restore' }));

  function refresh() {
    ctx.fetchProjection().then((proj) => {
      slicesMount.innerHTML = '';
      summaryMount.innerHTML = '';
      if (!proj || !proj.sliceStops || proj.sliceStops.length === 0) {
        slicesMount.appendChild(placeholder('Empty', 'Run `maddu slice-stop` to append the first entry.'));
        summaryMount.appendChild(placeholder('No activity', 'Slice-stops will appear here as they happen.'));
        return;
      }

      // ── Activity summary: 7-day sparkline + tile grid ─────────────
      const slices = proj.sliceStops || [];
      const bins = binByTime(slices, 28, 'ts', 7 * 24 * 60 * 60 * 1000); // 7 days, 6h buckets
      const last24h = bins.slice(-4).reduce((s, x) => s + x, 0);
      const wrap = el('div', { class: 'widget-stat' });
      const numLine = el('div', { class: 'widget-stat-num' });
      numLine.appendChild(el('span', { class: 'widget-stat-value' }, String(slices.length)));
      numLine.appendChild(el('span', { class: 'widget-stat-trend' + (last24h > 0 ? ' up' : '') }, `+${last24h} in 24h`));
      wrap.appendChild(numLine);
      wrap.appendChild(el('div', { class: 'widget-stat-label' }, 'slice-stops over the last 7 days'));
      wrap.appendChild(sparkline(bins, { tone: 'accent', width: 480, height: 56 }));
      summaryMount.appendChild(wrap);

      const list = el('div', {});
      for (const s of proj.sliceStops.slice().reverse()) {
        const row = el('div', { class: 'panel' }, [
          el('div', { class: 'panel-head' }, [
            el('span', { class: 'panel-title' }, `[${s.lane || '—'}]`),
            el('span', { class: 'panel-aside' }, s.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z'))
          ]),
          renderProse(s.summary || '—'),
          s.next && s.next.length
            ? el('div', { class: 'view', style: 'margin-top:8px;' }, [
                el('div', { class: 'panel-title' }, 'NEXT'),
                el('ul', { class: 'hard-rules' }, s.next.map((n) => el('li', {}, n)))
              ])
            : null
        ]);
        list.appendChild(row);
      }
      slicesMount.appendChild(list);
    });

    ctx.fetchMemory(50).then((m) => {
      memMount.innerHTML = '';
      if (!m || m.facts.length === 0) {
        memMount.appendChild(placeholder('No facts yet', 'Slice-stops auto-populate this. Try `maddu slice-stop --learnings "A; B" --next "C"`.'));
        return;
      }
      const list = el('div', {});
      for (const f of m.facts.slice().reverse()) {
        list.appendChild(el('div', { class: 'ledger-row' }, [
          el('span', {}, f.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
          el('span', { class: 'event-type t-' + (f.kind === 'rule' ? 'framework' : f.kind === 'constraint' ? 'approval' : f.kind === 'discovery' ? 'session' : f.kind === 'followup' ? 'approval' : f.kind === 'summary' ? 'slice' : '') }, f.kind),
          el('span', {}, f.text),
          el('span', { class: 'event-actor' }, f.tags.join(' '))
        ]));
      }
      memMount.appendChild(list);
    });

    fetch('/bridge/checkpoints', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((d) => {
      cpMount.innerHTML = '';
      if (!d) { cpMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); return; }
      if (!d.gitAvailable) { cpMount.appendChild(placeholder('No git work tree', 'Checkpoints require a git repo in the install root.')); return; }
      const newBtn = el('button', { class: 'btn-allow' }, '+ checkpoint');
      newBtn.addEventListener('click', async () => {
        const title = prompt('Checkpoint title (optional):');
        if (title === null) return;
        await fetch('/bridge/checkpoints', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title || null, by: ctx.currentSession() || null }) });
        refresh();
      });
      cpMount.appendChild(el('div', { style: 'margin-bottom:8px;' }, [newBtn]));
      if (d.checkpoints.length === 0) {
        cpMount.appendChild(placeholder('No checkpoints', 'Click + to tag the current HEAD.'));
        return;
      }
      const list = el('div', {});
      for (const c of d.checkpoints) {
        const row = el('div', { class: 'ledger-row' }, [
          el('span', {}, c.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
          el('span', { class: 'event-type t-slice' }, c.commit.slice(0, 8)),
          el('span', {}, [
            el('div', { style: 'color:var(--m-fg-0);' }, c.title),
            el('div', { class: 'event-actor' }, `${c.lane ? 'lane:' + c.lane + '  ·  ' : ''}${c.branch ? 'branch:' + c.branch : ''}`)
          ]),
          (() => {
            const wrap = el('span', { style: 'display:flex;gap:4px;' });
            const rb = el('button', {}, 'Rollback');
            rb.addEventListener('click', async () => {
              const r = await fetch(`/bridge/checkpoints/${encodeURIComponent(c.id)}/rollback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              const out = await r.json();
              const lines = Object.entries(out.recovery || {}).map(([k, v]) => `${k}:\n  ${v.join('\n  ')}`).join('\n');
              showToast(lines || 'no recovery commands', 'warn');
            });
            const rm = el('button', { class: 'btn-deny-hard' }, '×');
            rm.addEventListener('click', async () => {
              if (!confirm(`Remove checkpoint "${c.title}"?`)) return;
              await fetch(`/bridge/checkpoints/${encodeURIComponent(c.id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
              refresh();
            });
            wrap.appendChild(rb); wrap.appendChild(rm);
            return wrap;
          })()
        ]);
        list.appendChild(row);
      }
      cpMount.appendChild(list);
    });
  }

  refresh();
  ctx.onSpineEvent((e) => {
    if (e.detail.type === 'SLICE_STOP') refresh();
  });

  return root;
}

// ---- Events (v1.61.0): the live event stream view. Subscribes via
// ctx.onSpineEvent and appends each matching row live (prepend/eventRow from
// cockpit-event-rows); the Pause/Resume control toggles the shared long-poll
// flag through ctx.isStreamPaused/toggleStreamPause (never touches the stream
// singleton). 60-min activity sparkline + type-mix segBar up top.

export function renderEvents(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Events'));
  root.appendChild(el('p', {}, ROUTE_META.events.description));

  // ── Summary widget: 60-min activity + type mix ──────────────────────
  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading event tail…'));
  root.appendChild(panel('Activity', 'last 60 min · 200-event type mix', summaryMount));
  (async () => {
    try {
      const r = await fetch('/bridge/events/recent?limit=500', { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      summaryMount.innerHTML = '';
      if (!d || !(d.events || []).length) { summaryMount.appendChild(placeholder('No events', 'Spine is empty.')); return; }
      const bins = binByTime(d.events, 24, 'ts', 60 * 60 * 1000);
      const total = bins.reduce((s, x) => s + x, 0);
      const peak = Math.max(...bins);
      const wrap = el('div', { class: 'widget-stat' });
      const num = el('div', { class: 'widget-stat-num' }, [
        el('span', { class: 'widget-stat-value' }, String(total)),
        el('span', { class: 'widget-stat-trend' }, `peak ${peak}/bin`)
      ]);
      wrap.appendChild(num);
      wrap.appendChild(el('div', { class: 'widget-stat-label' }, `${d.total} total events on spine · last 60 min sample`));
      wrap.appendChild(sparkline(bins, { tone: 'blue', width: 560, height: 56 }));
      summaryMount.appendChild(wrap);

      const tail = (d.events || []).slice(-200);
      const buckets = { 't-framework': 0, 't-session': 0, 't-lane': 0, 't-approval': 0, 't-slice': 0, other: 0 };
      for (const e of tail) {
        const cls = classifyEvent(e.type || '');
        if (cls in buckets) buckets[cls]++; else buckets.other++;
      }
      summaryMount.appendChild(segBar([
        { label: 'framework', value: buckets['t-framework'], tone: 'accent' },
        { label: 'session',   value: buckets['t-session'],   tone: 'blue' },
        { label: 'lane',      value: buckets['t-lane'],      tone: 'ok' },
        { label: 'approval',  value: buckets['t-approval'],  tone: 'warn' },
        { label: 'slice',     value: buckets['t-slice'],     tone: 'danger' },
        { label: 'other',     value: buckets.other,          tone: 'neutral' }
      ]));
    } catch (e) {
      summaryMount.innerHTML = '';
      summaryMount.appendChild(placeholder('Error', String(e)));
    }
  })();

  // Controls
  const filter = el('select', { class: '' });
  for (const t of ['(all)', 'FRAMEWORK_*', 'SESSION_*', 'LANE_*', 'SLICE_STOP', 'APPROVAL_*', 'DOCTOR_REPORT', 'INBOX_MESSAGE']) {
    const opt = el('option', { value: t === '(all)' ? '' : t }, t);
    filter.appendChild(opt);
  }
  filter.style.cssText = 'font-family:var(--m-font-mono);font-size:12px;background:var(--m-bg-2);color:var(--m-fg-1);border:1px solid var(--m-line);padding:4px 8px;';
  const pauseBtn = el('button', {}, ctx.isStreamPaused() ? 'Resume' : 'Pause');
  const clearBtn = el('button', {}, 'Clear');
  const controls = el('div', { class: 'panel-head' }, [
    el('span', { class: 'panel-title' }, 'Stream'),
    el('span', {}, [filter, document.createTextNode(' '), pauseBtn, document.createTextNode(' '), clearBtn])
  ]);

  const list = el('div', { style: 'max-height: 70vh; overflow: auto; border:1px solid var(--m-line); background:var(--m-bg-1);' });
  const block = el('div', { class: 'panel' }, [controls, list]);
  root.appendChild(block);

  // Seed with most recent 30 events.
  fetch('/bridge/events/poll', { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => {
      const recent = (d.events || []).slice(-30);
      for (const ev of recent) prepend(list, eventRow(ev, false));
    });

  function matchFilter(t) {
    const f = filter.value;
    if (!f) return true;
    if (f.endsWith('*')) return t.startsWith(f.slice(0, -1));
    return t === f;
  }

  const handler = (e) => {
    if (!matchFilter(e.detail.type)) return;
    prepend(list, eventRow(e.detail, true));
    // Keep list bounded.
    while (list.children.length > 500) list.removeChild(list.lastChild);
  };
  ctx.onSpineEvent(handler);

  pauseBtn.addEventListener('click', () => {
    const paused = ctx.toggleStreamPause();
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });
  clearBtn.addEventListener('click', () => { list.innerHTML = ''; });


  return root;
}

// ---- Gates ----
export function renderGates(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Gates'));
  root.appendChild(el('p', {}, ROUTE_META.gates.description));

  const mount = el('div', {});
  mount.appendChild(loading('Reading recent gate runs…'));
  root.appendChild(ctx.panelFocus('Recent gate runs', 'GET /bridge/gates · GATE_RAN events', mount,
    { id: 'gate-runs', keywords: 'gates gate-ran doctor verdict severity' }));

  async function load() {
    try {
      const r = await fetch('/bridge/gates?limit=50', { cache: 'no-store' });
      const data = await r.json();
      mount.innerHTML = '';
      const sum = data.summary || { ok: 0, fail: 0, warn: 0 };
      mount.appendChild(el('div', { class: 'widget-stat' }, [
        el('div', { class: 'widget-stat-num' }, [
          el('span', { class: 'widget-stat-value' }, String(sum.ok)),
          el('span', { class: 'widget-stat-trend' + (sum.fail > 0 ? '' : ' up') }, ` ok · ${sum.fail} fail · ${sum.warn} warn`),
        ]),
        el('div', { class: 'widget-stat-label' }, `last run: ${data.lastRunAt || '—'}`),
      ]));
      if (!data.runs || data.runs.length === 0) {
        mount.appendChild(placeholder('No runs yet', 'Run `maddu doctor` to populate.'));
        return;
      }
      const tbl = el('table', { class: 'ledger' });
      tbl.appendChild(el('tr', {}, [
        el('th', {}, 'ts'), el('th', {}, 'gate'), el('th', {}, 'severity'),
        el('th', {}, 'verdict'), el('th', {}, 'duration')
      ]));
      for (const run of data.runs) {
        tbl.appendChild(el('tr', {}, [
          el('td', {}, (run.ts || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
          el('td', {}, run.gateId || ''),
          el('td', {}, run.severity || ''),
          el('td', { class: 'event-type t-' + (run.ok ? 'session' : 'approval') }, run.ok ? 'PASS' : 'FAIL'),
          el('td', {}, `${run.durationMs ?? '—'}ms`),
        ]));
      }
      mount.appendChild(tbl);
    } catch (err) {
      mount.innerHTML = '';
      mount.appendChild(placeholder('Unavailable', String(err.message || err)));
    }
  }
  load();
  let pending = false;
  ctx.onSpineEvent(() => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  });
  return root;
}

// ---- Reviews ----
export function renderReviews(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Reviews'));
  root.appendChild(el('p', {}, ROUTE_META.reviews.description));

  const mount = el('div', {});
  mount.appendChild(loading('Reading post-stop reviews…'));
  root.appendChild(ctx.panelFocus('Recent reviews', 'GET /bridge/reviews · SLICE_REVIEWED events', mount,
    { id: 'recent-reviews', keywords: 'reviews verdict findings P1 P2 P3 followup' }));

  async function load() {
    try {
      const r = await fetch('/bridge/reviews?limit=50', { cache: 'no-store' });
      const data = await r.json();
      mount.innerHTML = '';
      const v = data.byVerdict || {};
      mount.appendChild(el('div', { class: 'widget-stat-label' },
        `Clean ${v.CLEAN || 0} · P1 ${v.P1 || 0} · P2 ${v.P2 || 0} · P3 ${v.P3 || 0} · Info ${v.INFO || 0}`));
      if (!data.recent || data.recent.length === 0) {
        mount.appendChild(placeholder('No reviews yet', 'Run `maddu review run --slice <id>` after a slice-stop.'));
        return;
      }
      const tbl = el('table', { class: 'ledger' });
      tbl.appendChild(el('tr', {}, [
        el('th', {}, 'ts'), el('th', {}, 'verdict'), el('th', {}, 'findings'),
        el('th', {}, 'slice'), el('th', {}, 'archive')
      ]));
      for (const r of data.recent) {
        tbl.appendChild(el('tr', {}, [
          el('td', {}, (r.ts || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
          el('td', { class: 'event-type t-' + (r.verdict === 'CLEAN' ? 'session' : 'approval') }, r.verdict || ''),
          el('td', {}, String(r.findingsCount || 0)),
          el('td', {}, r.sliceEventId || ''),
          el('td', {}, r.reviewPath || ''),
        ]));
      }
      mount.appendChild(tbl);
      if (data.openFollowups && data.openFollowups.length) {
        const list = el('ul', { class: 'hard-rules' });
        list.appendChild(el('li', {}, `Open follow-ups: ${data.openFollowups.length}`));
        for (const f of data.openFollowups) {
          list.appendChild(el('li', {}, `[${f.severity}] from ${f.fromReviewEventId} · scope=${(f.draftScope || []).join(', ')}`));
        }
        mount.appendChild(list);
      }
    } catch (err) {
      mount.innerHTML = '';
      mount.appendChild(placeholder('Unavailable', String(err.message || err)));
    }
  }
  load();
  let pending = false;
  ctx.onSpineEvent(() => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  });
  return root;
}
