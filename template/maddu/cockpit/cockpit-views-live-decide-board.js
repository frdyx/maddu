// Maddu cockpit - decide-cluster board views (the decision queues + ledgers).
// Views: Tasks, Approvals, Orientation, Queue Board, Claim Map. Split out of cockpit-views-live.js (v1.71.0 decomposition,
// 2026-07-08). Each renders behind the ctx seam; imports leaves + route-meta only,
// no back-edge into cockpit.js. Private helpers live beside their owning view.

import { el, panel, placeholder, loading, loadingFor, showToast, workspaceBadge, formatTs, formatAge } from './cockpit-util.js';
import { statusGrid, donut } from './cockpit-widgets.js';
import { makeDecisionButton } from './cockpit-event-rows.js';
import { ROUTE_META } from './cockpit-route-meta.js';
import { renderProse } from './cockpit-prose.js';


// ---- Tasks ----
async function fetchTasks() {
  try {
    const r = await fetch('/bridge/tasks', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export function renderTasks(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Tasks'));
  root.appendChild(el('p', {}, ROUTE_META.tasks.description));

  // Create form
  const titleInput = el('input', { type: 'text', placeholder: 'New task title…', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const laneInput = el('input', { type: 'text', placeholder: 'lane (opt)', style: 'width:140px;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const createBtn = el('button', {}, 'Create');
  const form = el('div', { style: 'display:flex;gap:6px;margin-bottom:12px;' }, [titleInput, laneInput, createBtn]);
  root.appendChild(form);

  const boardMount = el('div', {});
  root.appendChild(boardMount);

  createBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) return;
    createBtn.disabled = true;
    try {
      await fetch('/bridge/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, lane: laneInput.value.trim() || null, createdBy: ctx.currentSession() || null })
      });
      titleInput.value = '';
      laneInput.value = '';
      refresh();
    } finally {
      createBtn.disabled = false;
    }
  });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createBtn.click(); });

  function refresh() {
    boardMount.innerHTML = '';
    boardMount.appendChild(loading('Fetching task graph…'));
    fetchTasks().then((t) => {
      boardMount.innerHTML = '';
      if (!t) { boardMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); return; }
      const tasks = t.tasks || [];

      // Summary widget: status distribution
      const counts = { 'in-progress': 0, todo: 0, blocked: 0, done: 0, cancelled: 0 };
      for (const x of tasks) counts[x.status] = (counts[x.status] || 0) + 1;
      const open = (counts.todo || 0) + (counts['in-progress'] || 0) + (counts.blocked || 0);
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;margin-bottom:14px;' });
      summary.appendChild(donut([
        { label: 'in-progress', value: counts['in-progress'], tone: 'blue' },
        { label: 'todo',        value: counts.todo,           tone: 'accent' },
        { label: 'blocked',     value: counts.blocked,        tone: 'warn' },
        { label: 'done',        value: counts.done,           tone: 'ok' },
        { label: 'cancelled',   value: counts.cancelled,      tone: 'neutral' }
      ], { centerLabel: tasks.length === 1 ? 'task' : 'tasks' }));
      summary.appendChild(statusGrid([
        { value: open,                  label: 'Open',        tone: open > 0 ? 'warn' : 'ok' },
        { value: counts['in-progress'], label: 'In progress', tone: 'blue' },
        { value: counts.blocked,        label: 'Blocked',     tone: counts.blocked > 0 ? 'warn' : 'ok' },
        { value: counts.done,           label: 'Done',        tone: 'ok' }
      ]));
      boardMount.appendChild(panel('Summary', `${tasks.length} total`, summary));

      const cols = ['in-progress', 'todo', 'blocked', 'done', 'cancelled'];
      const byStatus = new Map(cols.map((s) => [s, []]));
      for (const x of tasks) (byStatus.get(x.status) || (byStatus.set(x.status, []), byStatus.get(x.status))).push(x);

      const board = el('div', { class: 'taskboard' });
      for (const s of cols) {
        const list = byStatus.get(s) || [];
        const col = el('div', { class: 'task-col' }, [
          el('div', { class: 'task-col-head' }, [
            el('span', {}, s.replace('-', ' ')),
            el('span', { class: 'task-col-count' }, String(list.length))
          ]),
          el('div', { class: 'task-col-body' }, list.map((x) => taskCard(x, refresh, ctx)))
        ]);
        board.appendChild(col);
      }
      boardMount.appendChild(board);
      const f = ctx.paletteFocus();
      if (f) ctx.focusPanelByKeyword(root, f);
    });
  }

  refresh();
  ctx.onSpineEvent((e) => {
    if (e.detail.type && e.detail.type.startsWith('TASK_')) refresh();
  });

  return root;
}

function taskCard(t, onChange, ctx) {
  const card = el('div', { class: 'task-card task-status-' + t.status, 'data-focus': t.id }, [
    el('div', { class: 'task-card-title' }, t.title),
    el('div', { class: 'task-card-meta' }, [
      t.lane ? `lane: ${t.lane}  ·  ` : '',
      t.owner ? `owner: ${t.owner.slice(-12)}  ·  ` : '',
      el('span', { class: 'task-card-id' }, t.id)
    ]),
    (t.activeBlockers && t.activeBlockers.length)
      ? el('div', { class: 'task-card-meta task-card-blockers' }, `↩ blocked by ${t.activeBlockers.length}`)
      : null,
    (t.blocks && t.blocks.length)
      ? el('div', { class: 'task-card-meta' }, `↦ blocks ${t.blocks.length}`)
      : null
  ]);
  if (t.status !== 'done' && t.status !== 'cancelled') {
    const actions = el('div', { class: 'task-card-actions' });
    if (t.status === 'todo' && (!t.activeBlockers || t.activeBlockers.length === 0)) {
      const start = el('button', {}, 'Start');
      start.addEventListener('click', async () => {
        await fetch(`/bridge/tasks/${t.id}/update`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'in-progress', by: ctx.currentSession() || null })
        });
        onChange();
      });
      actions.appendChild(start);
    }
    const done = el('button', { class: 'btn-allow' }, 'Done');
    done.addEventListener('click', async () => {
      await fetch(`/bridge/tasks/${t.id}/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ by: ctx.currentSession() || null })
      });
      onChange();
    });
    actions.appendChild(done);
    card.appendChild(actions);
  }
  return card;
}

// ---- Approvals (v1.62.0): the approval queue + decision ledger + standing
// policies (workspace + global). Scope-aware (ctx.scopePill), registers palette
// panels via ctx.panelFocus, stream-coupled (APPROVAL_* via ctx.onSpineEvent).
// fetchApprovals stays in cockpit.js (shared with the still-inline workbench) and
// is reached through ctx.fetchApprovals. Decision buttons via makeDecisionButton
// (cockpit-event-rows); workspace tags via workspaceBadge (cockpit-util).

export function renderApprovals(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Approvals'));
  root.appendChild(el('p', {}, ROUTE_META.approvals.description));

  const pill = ctx.scopePill('approvals', () => refresh());
  if (pill) root.appendChild(pill);

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading ledger…'));
  root.appendChild(ctx.panelFocus('Summary', 'open queue + decision distribution', summaryMount,
    { id: 'summary', keywords: 'summary open decisions distribution overview' }));

  const openMount = el('div', {});
  openMount.appendChild(loadingFor('table', 'Fetching open approvals…'));
  root.appendChild(ctx.panelFocus('Open queue', 'GET /bridge/approvals', openMount,
    { id: 'open-queue', keywords: 'open queue pending awaiting decision' }));

  const ledgerMount = el('div', {});
  root.appendChild(ctx.panelFocus('Decision ledger', '.maddu/events/*.ndjson · APPROVAL_DECIDED', ledgerMount,
    { id: 'ledger', keywords: 'ledger decided audit history approval' }));

  const policyMount = el('div', {});
  root.appendChild(ctx.panelFocus('Standing policies', 'APPROVAL_POLICY_SET', policyMount,
    { id: 'policies', keywords: 'standing policies allow-always allow-once deny rules' }));

  // Slice 4: global policies — machine-scope rules at
  // ~/.config/maddu/global/policies.json. Auto-decide hits every
  // workspace's spine with a real APPROVAL_DECIDED event tagged
  // triggered_by:{kind:'global_policy', id}.
  const globalPolicyMount = el('div', {});
  root.appendChild(ctx.panelFocus('Standing policies (global)', 'GET /bridge/_global/policies', globalPolicyMount,
    { id: 'global-policies', keywords: 'global standing policies machine-scope allow-always deny' }));

  function refresh() {
    // Global policies — independent fetch; failure renders empty, not an error
    // (the route 404s in legacy bridges that haven't been upgraded yet).
    fetch('/bridge/_global/policies', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((g) => {
      globalPolicyMount.innerHTML = '';
      const list = (g && g.policies) || [];
      if (!list.length) {
        globalPolicyMount.appendChild(placeholder('No global policies', '`maddu global policy add --tool <name> --decision deny`'));
        return;
      }
      for (const p of list) {
        const cls = p.decision === 'allow-always' ? 'ledger-decision-allow' : 'ledger-decision-deny';
        globalPolicyMount.appendChild(el('div', { class: 'ledger-row' }, [
          el('span', { class: 'workspace-badge mono' }, 'global'),
          el('span', {}, (p.setAt || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z') || '—'),
          el('span', { class: cls }, p.decision),
          el('span', {}, `${p.tool || '*'}@${p.lane || '*'}`),
          el('span', {}, p.setBy || '')
        ]));
      }
    }).catch(() => {
      globalPolicyMount.innerHTML = '';
      globalPolicyMount.appendChild(placeholder('Offline', 'Global endpoint unavailable.'));
    });
    ctx.fetchApprovals('approvals').then((a) => {
      summaryMount.innerHTML = '';
      openMount.innerHTML = '';
      ledgerMount.innerHTML = '';
      policyMount.innerHTML = '';
      if (!a) {
        openMount.appendChild(placeholder('Offline', 'Bridge not reachable.'));
        summaryMount.appendChild(placeholder('Offline', 'Bridge not reachable.'));
        return;
      }
      // Summary donut: decision distribution from ledger + open count
      const ledger = a.ledger || [];
      const dist = { 'allow-once': 0, 'allow-always': 0, deny: 0, 'deny-always': 0 };
      for (const d of ledger) if (d.decision in dist) dist[d.decision]++;
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(donut([
        { label: 'allow-once',   value: dist['allow-once'],   tone: 'ok' },
        { label: 'allow-always', value: dist['allow-always'], tone: 'accent' },
        { label: 'deny',         value: dist.deny,            tone: 'warn' },
        { label: 'deny-always',  value: dist['deny-always'],  tone: 'danger' }
      ], { centerLabel: 'decided' }));
      summary.appendChild(statusGrid([
        { value: a.open.length,                                    label: 'Open queue',  tone: (a.open.length > 0 ? 'warn' : 'ok') },
        { value: ledger.length,                                    label: 'Decided',     tone: 'blue' },
        { value: (a.policies || []).length,                        label: 'Standing policies', tone: 'accent' },
        { value: (dist['allow-once'] + dist['allow-always']) || 0, label: 'Allow total', tone: 'ok' }
      ]));
      summaryMount.appendChild(summary);
      if (a.open.length === 0) {
        openMount.appendChild(placeholder('No pending approvals', 'A worker can request one via POST /bridge/approvals/request.'));
      } else {
        for (const ap of a.open) {
          const card = el('div', { class: 'approval' }, [
            el('div', { class: 'approval-body' }, [
              el('div', { class: 'approval-tool' }, [
                workspaceBadge(ap),
                document.createTextNode(ap.tool)
              ]),
              el('div', { class: 'approval-meta' }, [
                `lane: ${ap.lane || '—'}  ·  asked by: ${ap.actor || 'anon'}  ·  ${ap.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`
              ]),
              ap.action  ? el('div', { class: 'approval-action' }, ap.action) : null,
              ap.summary ? el('div', { class: 'approval-summary' }, ap.summary) : null
            ]),
            el('div', { class: 'approval-actions' }, [
              makeDecisionButton('allow-once', 'Allow once', 'btn-allow', ap.approvalId, refresh, ap.workspace_id),
              makeDecisionButton('allow-always', 'Allow always', 'btn-allow', ap.approvalId, refresh, ap.workspace_id),
              makeDecisionButton('deny', 'Deny', 'btn-deny', ap.approvalId, refresh, ap.workspace_id),
              makeDecisionButton('deny-always', 'Deny always', 'btn-deny-hard', ap.approvalId, refresh, ap.workspace_id)
            ])
          ]);
          openMount.appendChild(card);
        }
      }

      if (a.ledger.length === 0) {
        ledgerMount.appendChild(placeholder('No decisions yet', 'Decisions appended as APPROVAL_DECIDED events.'));
      } else {
        for (const d of a.ledger.slice().reverse()) {
          const cls = d.decision.startsWith('allow') ? 'ledger-decision-allow' : 'ledger-decision-deny';
          const isGlobal = d.reason && d.reason.startsWith('global-policy:');
          const reasonChildren = [];
          if (isGlobal) reasonChildren.push(el('span', { class: 'workspace-badge mono', style: 'background:rgba(80,113,149,0.32);' }, 'global'));
          reasonChildren.push(document.createTextNode(d.reason || ''));
          ledgerMount.appendChild(el('div', { class: 'ledger-row' }, [
            workspaceBadge(d),
            el('span', {}, d.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
            el('span', { class: cls }, d.decision),
            el('span', {}, `${d.tool || '—'}@${d.lane || '—'}`),
            el('span', {}, reasonChildren)
          ]));
        }
      }

      if (a.policies.length === 0) {
        policyMount.appendChild(placeholder('No standing policies', 'Choose "Allow always" or "Deny always" on a decision, or set via `maddu approval policy`.'));
      } else {
        for (const p of a.policies) {
          const cls = p.decision === 'allow-always' ? 'ledger-decision-allow' : 'ledger-decision-deny';
          policyMount.appendChild(el('div', { class: 'ledger-row' }, [
            workspaceBadge(p),
            el('span', {}, p.setAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
            el('span', { class: cls }, p.decision),
            el('span', {}, `${p.tool || '*'}@${p.lane || '*'}`),
            el('span', {}, p.setBy || '')
          ]));
        }
      }
    });
  }

  refresh();
  // Refresh on every APPROVAL_* event from the page-wide stream.
  ctx.onSpineEvent((e) => {
    if (e.detail.type && e.detail.type.startsWith('APPROVAL_')) refresh();
  });

  return root;
}

// ---- Orientation + Gates + Reviews (v1.63.0): three clean read-only ledger
// views. Each registers a palette panel via ctx.panelFocus and refreshes on a
// debounced ctx.onSpineEvent subscription (no filtering - any spine event
// reloads). No composer, no scope, no inspector - leaves + ctx only.

// ---- Orientation ----
export function renderOrientation(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Orientation'));
  root.appendChild(el('p', {}, ROUTE_META.orientation.description));

  const mount = el('div', {});
  mount.appendChild(loading('Reading orientation digest…'));
  root.appendChild(ctx.panelFocus('Brief', 'GET /bridge/orientation · goal / phase / last slice / open follow-ups', mount,
    { id: 'orientation-brief', keywords: 'goal phase orientation brief handoff' }));

  // v0.17 Phase 7: Sessions panel — renders the parent → child session
  // tree and the inline janitor's recent activity. Reads the projection
  // directly so a stale handoff.md doesn't hide a live spawn fan-out.
  const sessionsMount = el('div', {});
  sessionsMount.appendChild(loading('Reading sessions tree…'));
  root.appendChild(ctx.panelFocus('Sessions', 'GET /bridge/projection · sessions tree + janitor activity', sessionsMount,
    { id: 'orientation-sessions', keywords: 'sessions tree janitor stale auto-close parent child' }));

  async function loadSessions() {
    try {
      const r = await fetch('/bridge/projection', { cache: 'no-store' });
      const proj = await r.json();
      sessionsMount.innerHTML = '';
      const tree = proj.sessionsTree || {};
      const sessionsById = {};
      for (const s of (proj.sessions || [])) sessionsById[s.id] = s;
      const roots = Object.keys(tree).filter((id) => !tree[id].parentSessionId);
      const summary = el('div', { class: 'widget-stat' }, [
        el('div', { class: 'widget-stat-num' }, [
          el('span', { class: 'widget-stat-value' }, String(Object.keys(tree).length)),
          el('span', { class: 'widget-stat-trend' }, ` total · ${roots.length} root(s)`),
        ]),
        el('div', { class: 'widget-stat-label' },
          `janitor: ${(proj.janitor?.staleSessions || []).length} stale · ${proj.janitor?.autoClosedTotal || 0} auto-closed`),
      ]);
      sessionsMount.appendChild(summary);
      if (roots.length === 0) {
        sessionsMount.appendChild(placeholder('No sessions yet', 'Run `./maddu/run register` to bootstrap one.'));
        return;
      }
      const list = el('ul', { class: 'hard-rules' });
      const walk = (id, depth) => {
        const s = sessionsById[id] || { label: '—' };
        const n = tree[id] || {};
        const stale = n.state === 'stale' ? ' · stale' : '';
        const closed = n.state === 'closed' ? ' · closed' : '';
        const indent = '  '.repeat(depth);
        list.appendChild(el('li', {}, `${indent}${depth > 0 ? '└─ ' : ''}${s.label || id}  ${n.source ? '(' + n.source + ')' : ''}${stale}${closed}`));
        const kids = (n.childSessionIds || []).slice().sort();
        for (const k of kids) walk(k, depth + 1);
      };
      for (const r of roots.sort()) walk(r, 0);
      sessionsMount.appendChild(list);
    } catch (err) {
      sessionsMount.innerHTML = '';
      sessionsMount.appendChild(placeholder('Unavailable', String(err.message || err)));
    }
  }
  loadSessions();

  async function load() {
    try {
      const r = await fetch('/bridge/orientation', { cache: 'no-store' });
      const data = await r.json();
      const o = data.orientation || {};
      mount.innerHTML = ''; const lines = [];
      lines.push(['Goal', o.goal?.objective || '—']);
      if (o.goal?.constraints?.length) lines.push(['Constraints', o.goal.constraints.join(' · ')]);
      lines.push(['Phase', o.phase?.name ? `${o.phase.name}${typeof o.phase.tier === 'string' && o.phase.tier ? ` · tier: ${o.phase.tier} (sterile — governance escalates while active)` : ''}` : '—']);
      if (typeof o.autonomy?.lane === 'string' && o.autonomy.lane) lines.push(['Autonomy', `${o.autonomy.lane}: ${o.autonomy.fromRung} → ${o.autonomy.toRung}${o.autonomy.muted ? ' (muted — active phase)' : typeof o.autonomy.recommendation === 'string' ? ` · ${o.autonomy.recommendation} (recommend-only)` : ''}`]);
      lines.push(['Active session', o.activeSession?.id || '—']);
      lines.push(['Counters', JSON.stringify(o.counters || {})]);
      lines.push(['Open follow-ups', String((o.openFollowups || []).length)]);
      const tbl = el('table', { class: 'ledger' });
      for (const [k, v] of lines) {
        tbl.appendChild(el('tr', {}, [el('td', { class: 'event-actor' }, k), el('td', {}, String(v))]));
      }
      mount.appendChild(tbl);
      if (o.lastSliceStop?.summary) {
        mount.appendChild(el('h3', {}, 'Last slice'));
        mount.appendChild(renderProse(o.lastSliceStop.summary));
      }
      if ((o.openFollowups || []).length) {
        const list = el('ul', { class: 'hard-rules' });
        for (const f of o.openFollowups) {
          list.appendChild(el('li', {}, `[${f.severity}] ${f.fromReviewEventId}  scope=${(f.draftScope || []).join(', ')}`));
        }
        mount.appendChild(list);
      }
      if (data.handoff) {
        mount.appendChild(el('h3', {}, 'Handoff'));
        mount.appendChild(renderProse(data.handoff));
      }
    } catch (err) {
      mount.innerHTML = '';
      mount.appendChild(placeholder('Unavailable', String(err.message || err)));
    }
  }
  load();
  loadSessions();
  let pending = false;
  ctx.onSpineEvent(() => {
    if (pending) return;
    pending = true;
    setTimeout(async () => {
      try { await load(); await loadSessions(); }
      finally { pending = false; }
    }, 400);
  });
  return root;
}

// ---- Queue Board + Claim Map (v1.65.0): two scheduler/lane views. Queue is
// scope-aware (ctx.scopePill/scopedUrl); both refresh on a debounced
// ctx.onSpineEvent subscription and open the Inspector on card/row click via
// ctx.openInspector. Their private builders (renderQueueColumns/renderQueueCard/
// renderClaimsTable) + reason-code palettes ride along; the builders take ctx so
// their click handlers reach ctx.openInspector.

// ---- Queue Board ----
const QUEUE_REASON_TONE = {
  scheduled_next:     'blue',
  scheduled_paused:   'neutral',
  queue_ready:        'accent',
  queue_blocked:      'warn',
  dispatch_running:   'ok',
  dispatch_stuck:     'danger',
  preflight_pending:  'warn'
};

const QUEUE_REASON_LABEL = {
  scheduled_next:    'scheduled',
  scheduled_paused:  'paused',
  queue_ready:       'ready',
  queue_blocked:     'blocked',
  dispatch_running:  'running',
  dispatch_stuck:    'stuck',
  preflight_pending: 'pending'
};

export function renderQueueBoard(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Queue Board'));
  root.appendChild(el('p', {}, ROUTE_META.queue.description));

  const pill = ctx.scopePill('queue', () => load());
  if (pill) root.appendChild(pill);

  const host = el('div', {});
  host.appendChild(loading('Loading queue view…'));
  root.appendChild(host);

  const legend = el('div', { class: 'queue-legend' }, [
    el('span', { class: 'next-command-pill tone-blue' }, 'Scheduler · scheduled / paused'),
    el('span', { class: 'next-command-pill tone-accent' }, 'Queue · ready / blocked'),
    el('span', { class: 'next-command-pill tone-ok' }, 'Dispatch · running / stuck'),
    el('span', { class: 'next-command-pill tone-warn' }, 'Preflights · pending')
  ]);
  root.appendChild(panel('Reason codes', 'every parked card carries one', legend));

  let pending = false;
  const load = async () => {
    let view;
    try {
      const r = await fetch(ctx.scopedUrl('queue', '/bridge/queue'), { cache: 'no-store' });
      view = await r.json();
    } catch {
      host.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    host.replaceChildren(renderQueueColumns(view.columns || [], ctx));
  };
  load();
  ctx.onSpineEvent(() => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  });

  return root;
}

function renderQueueColumns(columns, ctx) {
  const wrap = el('div', { class: 'queue-grid' });
  for (const col of columns) {
    const c = el('div', { class: 'queue-col' });
    c.appendChild(el('div', { class: `queue-col-head tone-${col.tone}` }, [
      el('span', { class: 'queue-col-title' }, col.title),
      el('span', { class: 'queue-col-count' }, String(col.items.length))
    ]));
    c.appendChild(el('div', { class: 'queue-col-hint' }, col.hint));
    if (col.items.length === 0) {
      c.appendChild(el('div', { class: 'queue-empty' }, '—'));
    } else {
      for (const item of col.items) {
        c.appendChild(renderQueueCard(item, col.id, ctx));
      }
    }
    wrap.appendChild(c);
  }
  return wrap;
}

function renderQueueCard(item, columnId, ctx) {
  const tone = QUEUE_REASON_TONE[item.reasonCode] || 'neutral';
  const card = el('div', { class: 'queue-card' });
  card.appendChild(el('div', { class: 'queue-card-label' }, item.label || '(untitled)'));
  if (item.detail) card.appendChild(el('div', { class: 'queue-card-detail' }, item.detail));
  if (item.summary) card.appendChild(el('div', { class: 'queue-card-summary' }, item.summary));
  const meta = el('div', { class: 'queue-card-meta' }, [
    workspaceBadge(item),
    el('span', { class: `next-command-pill tone-${tone}` }, QUEUE_REASON_LABEL[item.reasonCode] || item.reasonCode || 'unknown'),
    item.nextFireTs ? el('span', { class: 'queue-card-next' }, `next: ${formatTs(item.nextFireTs)}`) : null,
    (item.blockers && item.blockers.length) ? el('span', { class: 'queue-card-blockers' }, `blocked by ${item.blockers.length}`) : null
  ]);
  card.appendChild(meta);
  if (item.action && item.route) {
    const btn = el('button', { class: 'm-btn queue-card-btn', type: 'button' }, item.action);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      location.hash = `#/${item.route}`;
    });
    card.appendChild(btn);
  }
  card.addEventListener('click', () => {
    ctx.openInspector({
      kind: columnId === 'preflights' ? 'approval' : (item.kind || (columnId === 'scheduler' ? 'schedule' : 'task')),
      id: item.id,
      data: item
    });
  });
  return card;
}

// ---- Claim Map ----
const CLAIM_REASON_TONE = {
  claim_healthy: 'ok',
  claim_idle:    'accent',
  claim_stale:   'warn',
  claim_expired: 'danger'
};

const CLAIM_REASON_LABEL = {
  claim_healthy: 'healthy',
  claim_idle:    'idle',
  claim_stale:   'stale',
  claim_expired: 'expired'
};

export function renderClaimMap(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Claim Map'));
  root.appendChild(el('p', {}, ROUTE_META.claims.description));

  const host = el('div', {});
  host.appendChild(loading('Loading active claims…'));
  root.appendChild(host);

  let pending = false;
  const load = async () => {
    let view;
    try {
      const r = await fetch('/bridge/claims', { cache: 'no-store' });
      view = await r.json();
    } catch {
      host.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    if (!view.claims || view.claims.length === 0) {
      host.replaceChildren(placeholder('No active claims', 'No lanes are claimed right now. Claims appear here as sessions register and claim lanes.'));
      return;
    }
    host.replaceChildren(renderClaimsTable(view.claims, load, ctx));
  };
  load();
  ctx.onSpineEvent(() => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  });

  return root;
}

function renderClaimsTable(claims, reload, ctx) {
  const wrap = el('div', { class: 'claims-table' });
  // Header row
  wrap.appendChild(el('div', { class: 'claims-row claims-row-head' }, [
    el('span', {}, 'lane'),
    el('span', {}, 'session'),
    el('span', {}, 'focus'),
    el('span', {}, 'claimed'),
    el('span', {}, 'heartbeat'),
    el('span', {}, 'lease'),
    el('span', {}, 'state'),
    el('span', {}, 'action')
  ]));
  for (const c of claims) {
    const tone = CLAIM_REASON_TONE[c.reasonCode] || 'neutral';
    const leaseLabel = c.leaseSeconds
      ? (c.leaseLeftMs == null ? `${c.leaseSeconds}s` : (c.leaseLeftMs < 0 ? `expired ${formatAge(-c.leaseLeftMs)}` : `${formatAge(c.leaseLeftMs)} left`))
      : '—';
    const row = el('div', { class: `claims-row tone-${tone}` }, [
      el('span', { class: 'claims-lane' }, c.lane),
      el('span', { class: 'claims-session' }, c.sessionLabel || c.sessionId),
      el('span', { class: 'claims-focus' }, c.focus || '—'),
      el('span', { class: 'claims-age' }, formatAge(c.claimAgeMs)),
      el('span', { class: 'claims-heartbeat' }, c.heartbeatAgeMs == null ? '—' : formatAge(c.heartbeatAgeMs)),
      el('span', { class: 'claims-lease' }, leaseLabel),
      el('span', { class: `next-command-pill tone-${tone}` }, CLAIM_REASON_LABEL[c.reasonCode] || c.reasonCode),
      (() => {
        const btn = el('button', { class: 'm-btn', type: 'button' }, 'request handoff');
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const reason = prompt('Handoff reason (shown to the holding session):', 'operator request') || '';
          if (!reason) return;
          try {
            const r = await fetch('/bridge/claims/handoff', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ lane: c.lane, reason, from: 'operator' })
            });
            if (!r.ok) {
              const d = await r.json().catch(() => ({}));
              showToast(`Handoff failed: ${d.error || r.statusText}`, 'err');
            } else {
              showToast(`Handoff requested for ${c.lane}`, 'ok');
              reload();
            }
          } catch (err) {
            showToast(`Handoff failed: ${err.message}`, 'err');
          }
        });
        return btn;
      })()
    ]);
    row.addEventListener('click', () => ctx.openInspector({ kind: 'claim', id: c.lane, data: c }));
    wrap.appendChild(row);
  }
  return wrap;
}
