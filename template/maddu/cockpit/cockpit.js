// Máddu cockpit — vanilla SPA. No framework, no build step.
// Hash-routed; views render into #route-view.

const ROUTES = {
  dashboard:  { title: 'Dashboard',  render: renderDashboard,  description: 'Snapshot of every lane, every spawned worker, every open approval.' },
  approvals:  { title: 'Approvals',  render: renderApprovals,  description: 'Pending tool / subprocess approvals. Allow-once, allow-always, or deny — every decision recorded.' },
  events:     { title: 'Events',     render: renderEvents,     description: 'Live cursor stream of the append-only spine. Filters by type. Pause/resume.' },
  operations: { title: 'Operations', render: renderOperations, description: 'Live work in flight. Slice-stops, verifications, checkpoints.' },
  swarm:      { title: 'Swarm',      render: renderSwarm,      description: 'Multi-agent fan-out. Lane-bound workers and their mailboxes.' },
  chats:      { title: 'Chats',      render: renderChats,      description: 'Conversation surfaces. History, attachments, replay.' },
  roadmap:    { title: 'Roadmap',    render: renderRoadmap,    description: 'Planned slices, tagged versions, dependency graph.' },
  settings:   { title: 'Settings',   render: renderSettings,   description: 'Bridge, lanes, providers, tokens, MCP registry.' }
};

const els = {
  app: document.getElementById('app'),
  view: document.getElementById('route-view'),
  title: document.getElementById('route-title'),
  meta: document.getElementById('route-meta'),
  bridge: document.getElementById('status-bridge'),
  version: document.getElementById('status-version'),
  uptime: document.getElementById('status-uptime'),
  host: document.getElementById('status-host'),
  port: document.getElementById('status-port'),
  approvalsBadge: document.getElementById('approvals-badge')
};

let bridgeStatus = null;
let bridgeOk = false;

// ─── page-wide event stream (cursor long-poll) ───────────────────────────
const stream = {
  cursor: null,
  active: false,
  paused: false,
  bus: new EventTarget()
};

async function streamLoop() {
  if (stream.active) return;
  stream.active = true;
  try {
    while (true) {
      if (stream.paused) { await new Promise((r) => setTimeout(r, 500)); continue; }
      let res;
      try {
        const u = new URL('/bridge/events/wait', location.href);
        if (stream.cursor) u.searchParams.set('after', stream.cursor);
        u.searchParams.set('timeout', '25000');
        const r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) throw new Error('bridge ' + r.status);
        res = await r.json();
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const ev of res.events) {
        stream.cursor = ev.id;
        stream.bus.dispatchEvent(new CustomEvent('event', { detail: ev }));
      }
      if (!res.events.length && res.lastEventId) stream.cursor = res.lastEventId;
      // Trigger one chrome refresh per wait turn so the badge/uptime stay live.
      fetchBridgeStatus();
    }
  } finally {
    stream.active = false;
  }
}

async function seedCursor() {
  try {
    const r = await fetch('/bridge/events/poll', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    stream.cursor = d.lastEventId || null;
  } catch {}
}

async function fetchBridgeStatus() {
  try {
    const r = await fetch('/bridge/status', { cache: 'no-store' });
    if (!r.ok) throw new Error('bridge ' + r.status);
    bridgeStatus = await r.json();
    bridgeOk = true;
  } catch {
    bridgeStatus = null;
    bridgeOk = false;
  }
  updateChrome();
}

function updateChrome() {
  if (bridgeOk && bridgeStatus) {
    els.bridge.innerHTML = '<span class="signal live"></span>online';
    els.version.textContent = bridgeStatus.version || 'unknown';
    els.uptime.textContent = formatUptime(bridgeStatus.uptimeMs);
    if (bridgeStatus.port) els.port.textContent = bridgeStatus.port;
    const open = bridgeStatus.counts && bridgeStatus.counts.openApprovals;
    if (els.approvalsBadge) {
      if (open && open > 0) { els.approvalsBadge.hidden = false; els.approvalsBadge.textContent = String(open); }
      else                  { els.approvalsBadge.hidden = true; }
    }
  } else {
    els.bridge.innerHTML = '<span class="signal"></span>offline';
    els.version.textContent = '—';
    els.uptime.textContent = '—';
    if (els.approvalsBadge) els.approvalsBadge.hidden = true;
  }
}

function formatUptime(ms) {
  if (typeof ms !== 'number') return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  const d = Math.floor(h / 24);
  return d + 'd ' + (h % 24) + 'h';
}

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const id = raw.split('/')[0];
  return ROUTES[id] ? id : 'dashboard';
}

function renderRoute() {
  const id = currentRoute();
  const route = ROUTES[id];

  document.querySelectorAll('.rail-link').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === id);
  });

  // Tell the previous view to tear down its stream subscriptions.
  els.view.dispatchEvent(new Event('routechange'));

  els.title.textContent = route.title.toUpperCase();
  els.meta.textContent = id.toUpperCase();
  els.view.innerHTML = '';
  els.view.appendChild(route.render());
  els.app.removeAttribute('aria-busy');
}

/* ─────────────── views ─────────────── */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function panel(title, aside, body) {
  return el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('span', { class: 'panel-title' }, title),
      aside ? el('span', { class: 'panel-aside' }, aside) : null
    ]),
    body
  ]);
}

function placeholder(name, planned) {
  return el('div', { class: 'placeholder' }, [
    el('strong', {}, name),
    document.createTextNode(planned)
  ]);
}

function renderDashboard() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Dashboard'));
  root.appendChild(el('p', {}, ROUTES.dashboard.description));

  const status = bridgeStatus || {};
  const counts = status.counts || {};
  const kv = el('dl', { class: 'kv' });
  const rows = [
    ['Bridge', bridgeOk ? 'online' : 'offline'],
    ['Version', status.version || '—'],
    ['Host', status.host || '127.0.0.1'],
    ['Port', String(status.port || 4177)],
    ['Repo root', status.repoRoot || '—'],
    ['State', status.stateDir || '.maddu/'],
    ['Uptime', formatUptime(status.uptimeMs)],
    ['Events', String(counts.events ?? '—')],
    ['Active sessions', String(counts.activeSessions ?? '—')],
    ['Lane claims', String(counts.claims ?? '—')],
    ['Slice-stops', String(counts.sliceStops ?? '—')],
    ['Memory facts', String(counts.memoryFacts ?? '—')]
  ];
  for (const [k, v] of rows) {
    kv.appendChild(el('dt', {}, k));
    kv.appendChild(el('dd', {}, v));
  }
  root.appendChild(panel('Bridge status', 'GET /bridge/status', kv));

  const rules = el('ul', { class: 'hard-rules' }, [
    el('li', {}, 'Files-only state'),
    el('li', {}, 'No SQLite / DB'),
    el('li', {}, 'No hosted backends'),
    el('li', {}, 'No broad new deps'),
    el('li', {}, 'No provider SDKs in app code'),
    el('li', {}, 'No token export'),
    el('li', {}, 'Three-layer brand boundary'),
    el('li', {}, 'Lane ownership')
  ]);
  root.appendChild(panel('Hard rules', 'docs/hard-rules.md', rules));

  return root;
}

async function fetchMemory(limit = 30) {
  try {
    const r = await fetch(`/bridge/memory?limit=${limit}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchProjection() {
  try {
    const r = await fetch('/bridge/projection', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchLanes() {
  try {
    const r = await fetch('/bridge/lanes', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function loading(text) {
  return el('div', { class: 'placeholder' }, [
    el('strong', {}, 'Loading…'),
    document.createTextNode(text)
  ]);
}

function renderOperations() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Operations'));
  root.appendChild(el('p', {}, ROUTES.operations.description));

  const slicesMount = el('div', {});
  slicesMount.appendChild(loading('Fetching slice-stop ledger…'));
  root.appendChild(panel('Slice ledger', 'GET /bridge/projection · SLICE_STOP events', slicesMount));

  const memMount = el('div', {});
  memMount.appendChild(loading('Fetching hindsight facts…'));
  root.appendChild(panel('Hindsight memory', 'GET /bridge/memory · facts derived from slice-stops', memMount));

  function refresh() {
    fetchProjection().then((proj) => {
      slicesMount.innerHTML = '';
      if (!proj || !proj.sliceStops || proj.sliceStops.length === 0) {
        slicesMount.appendChild(placeholder('Empty', 'Run `maddu slice-stop` to append the first entry.'));
        return;
      }
      const list = el('div', {});
      for (const s of proj.sliceStops.slice().reverse()) {
        const row = el('div', { class: 'panel' }, [
          el('div', { class: 'panel-head' }, [
            el('span', { class: 'panel-title' }, `[${s.lane || '—'}]  ${s.summary}`),
            el('span', { class: 'panel-aside' }, s.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z'))
          ]),
          s.next && s.next.length
            ? el('div', { class: 'view' }, [
                el('div', { class: 'panel-title' }, 'NEXT'),
                el('ul', { class: 'hard-rules' }, s.next.map((n) => el('li', {}, n)))
              ])
            : null
        ]);
        list.appendChild(row);
      }
      slicesMount.appendChild(list);
    });

    fetchMemory(50).then((m) => {
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
  }

  refresh();
  const handler = (e) => {
    if (e.detail.type === 'SLICE_STOP') refresh();
  };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });

  return root;
}

function renderSwarm() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Swarm'));
  root.appendChild(el('p', {}, ROUTES.swarm.description));

  const lanesMount = el('div', {});
  lanesMount.appendChild(loading('Fetching lane catalog…'));
  root.appendChild(panel('Lane roster', 'GET /bridge/lanes', lanesMount));

  Promise.all([fetchLanes(), fetchProjection()]).then(([lanes, proj]) => {
    lanesMount.innerHTML = '';
    if (!lanes) { lanesMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); return; }
    const claimed = new Map((lanes.claims || []).map((c) => [c.lane, c]));
    const tbl = el('dl', { class: 'kv' });
    for (const l of lanes.catalog.lanes) {
      const c = claimed.get(l.id);
      tbl.appendChild(el('dt', {}, l.id));
      tbl.appendChild(el('dd', {}, c
        ? `claimed by ${c.sessionId} · ${c.focus || l.scope}`
        : l.scope));
    }
    lanesMount.appendChild(tbl);

    if (proj && proj.activeSessions && proj.activeSessions.length) {
      const sess = el('div', {});
      for (const s of proj.activeSessions) {
        const k = el('dl', { class: 'kv' }, [
          el('dt', {}, 'role'),  el('dd', {}, s.role || '—'),
          el('dt', {}, 'label'), el('dd', {}, s.label || '—'),
          el('dt', {}, 'focus'), el('dd', {}, s.focus || '—'),
          el('dt', {}, 'since'), el('dd', {}, s.registeredAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z'))
        ]);
        sess.appendChild(panel(s.id, 'active session', k));
      }
      root.appendChild(panel('Active sessions', `${proj.activeSessions.length} live`, sess));
    }
  });

  return root;
}

function renderChats() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Chats'));
  root.appendChild(el('p', {}, ROUTES.chats.description));

  const mount = el('div', {});
  mount.appendChild(loading('Fetching sessions…'));
  root.appendChild(panel('Sessions', 'GET /bridge/sessions', mount));

  fetchProjection().then((proj) => {
    mount.innerHTML = '';
    if (!proj || proj.sessions.length === 0) {
      mount.appendChild(placeholder('No sessions yet', 'Register one with `maddu session register`.'));
      return;
    }
    const list = el('div', {});
    for (const s of proj.sessions.slice().reverse()) {
      const dot = s.status === 'active' ? '<span class="signal live"></span>' : '<span class="signal"></span>';
      const head = el('div', { class: 'panel-head' }, [
        el('span', { class: 'panel-title', html: `${dot} ${s.id}` }),
        el('span', { class: 'panel-aside' }, s.status)
      ]);
      const kv = el('dl', { class: 'kv' }, [
        el('dt', {}, 'role'),  el('dd', {}, s.role || '—'),
        el('dt', {}, 'label'), el('dd', {}, s.label || '—'),
        el('dt', {}, 'focus'), el('dd', {}, s.focus || '—')
      ]);
      list.appendChild(el('div', { class: 'panel' }, [head, kv]));
    }
    mount.appendChild(list);
  });

  return root;
}

function renderRoadmap() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Roadmap'));
  root.appendChild(el('p', {}, ROUTES.roadmap.description));

  const phases = [
    ['A — Foundations', 'A1 /approvals · A2 /events/live · A3 hindsight'],
    ['B — Operator productivity', 'B1–B6 slash commands · mailbox · tasks · skills · heartbeat · search'],
    ['C — Power user', 'C1–C5 runtimes · MCP registry · NL→cron · checkpoint timeline · key rotation'],
    ['D — Vision', 'D1 /workbench · D2 /imports · D3 office preview']
  ];
  const list = el('div', {});
  for (const [name, body] of phases) {
    const row = el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('span', { class: 'panel-title' }, name),
        el('span', { class: 'panel-aside' }, 'docs/maddu-v0.3-roadmap.md')
      ]),
      el('div', { class: 'view' }, body)
    ]);
    list.appendChild(row);
  }
  root.appendChild(list);
  return root;
}

async function fetchApprovals() {
  try {
    const r = await fetch('/bridge/approvals', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function postApprovalDecision(approvalId, decision, reason) {
  const r = await fetch('/bridge/approvals/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approvalId, decision, reason })
  });
  return r.json();
}

function renderApprovals() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Approvals'));
  root.appendChild(el('p', {}, ROUTES.approvals.description));

  const openMount = el('div', {});
  openMount.appendChild(loading('Fetching open approvals…'));
  root.appendChild(panel('Open queue', 'GET /bridge/approvals', openMount));

  const ledgerMount = el('div', {});
  root.appendChild(panel('Decision ledger', '.maddu/events/*.ndjson · APPROVAL_DECIDED', ledgerMount));

  const policyMount = el('div', {});
  root.appendChild(panel('Standing policies', 'APPROVAL_POLICY_SET', policyMount));

  function refresh() {
    fetchApprovals().then((a) => {
      openMount.innerHTML = '';
      ledgerMount.innerHTML = '';
      policyMount.innerHTML = '';
      if (!a) {
        openMount.appendChild(placeholder('Offline', 'Bridge not reachable.'));
        return;
      }
      if (a.open.length === 0) {
        openMount.appendChild(placeholder('No pending approvals', 'A worker can request one via POST /bridge/approvals/request.'));
      } else {
        for (const ap of a.open) {
          const card = el('div', { class: 'approval' }, [
            el('div', { class: 'approval-body' }, [
              el('div', { class: 'approval-tool' }, ap.tool),
              el('div', { class: 'approval-meta' }, [
                `lane: ${ap.lane || '—'}  ·  asked by: ${ap.actor || 'anon'}  ·  ${ap.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`
              ]),
              ap.action  ? el('div', { class: 'approval-action' }, ap.action) : null,
              ap.summary ? el('div', { class: 'approval-summary' }, ap.summary) : null
            ]),
            el('div', { class: 'approval-actions' }, [
              makeDecisionButton('allow-once', 'Allow once', 'btn-allow', ap.approvalId, refresh),
              makeDecisionButton('allow-always', 'Allow always', 'btn-allow', ap.approvalId, refresh),
              makeDecisionButton('deny', 'Deny', 'btn-deny', ap.approvalId, refresh),
              makeDecisionButton('deny-always', 'Deny always', 'btn-deny-hard', ap.approvalId, refresh)
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
          ledgerMount.appendChild(el('div', { class: 'ledger-row' }, [
            el('span', {}, d.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
            el('span', { class: cls }, d.decision),
            el('span', {}, `${d.tool || '—'}@${d.lane || '—'}`),
            el('span', {}, d.reason || '')
          ]));
        }
      }

      if (a.policies.length === 0) {
        policyMount.appendChild(placeholder('No standing policies', 'Choose "Allow always" or "Deny always" on a decision, or set via `maddu approval policy`.'));
      } else {
        for (const p of a.policies) {
          const cls = p.decision === 'allow-always' ? 'ledger-decision-allow' : 'ledger-decision-deny';
          policyMount.appendChild(el('div', { class: 'ledger-row' }, [
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
  const handler = (e) => {
    if (e.detail.type && e.detail.type.startsWith('APPROVAL_')) refresh();
  };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });

  return root;
}

function classifyEvent(type) {
  if (type === 'SLICE_STOP')              return 't-slice';
  if (type === 'DOCTOR_REPORT')           return 't-doctor';
  if (type === 'INBOX_MESSAGE')           return 't-inbox';
  if (type.startsWith('FRAMEWORK_'))      return 't-framework';
  if (type.startsWith('SESSION_'))        return 't-session';
  if (type.startsWith('LANE_'))           return 't-lane';
  if (type.startsWith('APPROVAL_'))       return 't-approval';
  return '';
}

function summarize(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'FRAMEWORK_INSTALLED': return `installed v${d.version} (${d.files} files)`;
    case 'FRAMEWORK_UPGRADED':  return `${d.from} → ${d.to}  +${d.added} ~${d.updated} -${d.removed}`;
    case 'FRAMEWORK_BOOTED':    return `bridge on :${d.port}`;
    case 'DOCTOR_REPORT':       return `${d.counts.PASS} pass · ${d.counts.WARN} warn · ${d.counts.FAIL} fail`;
    case 'SESSION_REGISTERED':  return `${d.role || '—'}  ${d.label || ''}`;
    case 'SESSION_HEARTBEAT':   return d.focus || '';
    case 'SESSION_CLOSED':      return d.handoff || '';
    case 'LANE_CLAIMED':        return d.focus || '';
    case 'LANE_RELEASED':       return '';
    case 'SLICE_STOP':          return d.summary || '';
    case 'INBOX_MESSAGE':       return d.message || '';
    case 'APPROVAL_REQUESTED':  return `${d.tool}  ${d.action || ''}`;
    case 'APPROVAL_DECIDED':    return `${d.decision}  ${d.tool || ''}`;
    case 'APPROVAL_POLICY_SET': return `${d.decision}  ${d.tool}@${d.lane || '*'}`;
    default: return '';
  }
}

function eventRow(ev, fresh = false) {
  const row = el('div', { class: 'event-row' + (fresh ? ' new' : '') }, [
    el('span', { class: 'event-time' }, ev.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
    el('span', { class: `event-type ${classifyEvent(ev.type)}` }, ev.type),
    el('span', { class: 'event-lane' }, ev.lane || '—'),
    el('span', {}, [
      el('span', { class: 'event-summary' }, summarize(ev) + '  '),
      el('span', { class: 'event-actor' }, ev.actor ? `· ${ev.actor}` : '')
    ])
  ]);
  return row;
}

function renderEvents() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Events'));
  root.appendChild(el('p', {}, ROUTES.events.description));

  // Controls
  const filter = el('select', { class: '' });
  for (const t of ['(all)', 'FRAMEWORK_*', 'SESSION_*', 'LANE_*', 'SLICE_STOP', 'APPROVAL_*', 'DOCTOR_REPORT', 'INBOX_MESSAGE']) {
    const opt = el('option', { value: t === '(all)' ? '' : t }, t);
    filter.appendChild(opt);
  }
  filter.style.cssText = 'font-family:var(--m-font-mono);font-size:12px;background:var(--m-bg-2);color:var(--m-fg-1);border:1px solid var(--m-line);padding:4px 8px;';
  const pauseBtn = el('button', {}, stream.paused ? 'Resume' : 'Pause');
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
  stream.bus.addEventListener('event', handler);

  pauseBtn.addEventListener('click', () => {
    stream.paused = !stream.paused;
    pauseBtn.textContent = stream.paused ? 'Resume' : 'Pause';
  });
  clearBtn.addEventListener('click', () => { list.innerHTML = ''; });

  els.view.addEventListener('routechange', () => {
    stream.bus.removeEventListener('event', handler);
  }, { once: true });

  return root;
}

function prepend(parent, child) {
  if (parent.firstChild) parent.insertBefore(child, parent.firstChild);
  else parent.appendChild(child);
}

function makeDecisionButton(decision, label, klass, approvalId, onDone) {
  const btn = el('button', { class: klass }, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await postApprovalDecision(approvalId, decision, null);
      onDone();
    } catch (err) {
      btn.textContent = 'error';
      console.error(err);
    }
  });
  return btn;
}

function renderSettings() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Settings'));
  root.appendChild(el('p', {}, ROUTES.settings.description));
  root.appendChild(placeholder('Lane defaults', 'Lands in Slice 3 — .maddu/lanes/catalog.json.'));
  root.appendChild(placeholder('Provider bindings', 'Lands in Slice 4 — auth + OAuth status panel.'));
  root.appendChild(placeholder('MCP registry', 'Lands in Phase C2 — bridge-owned MCP visual registry.'));
  return root;
}

/* ─────────────── boot ─────────────── */

window.addEventListener('hashchange', renderRoute);

async function boot() {
  if (!location.hash) location.hash = '#/dashboard';
  await fetchBridgeStatus();
  await seedCursor();
  renderRoute();
  streamLoop();
  // Fallback chrome refresh in case stream stalls.
  setInterval(fetchBridgeStatus, 15000);
}

boot();
