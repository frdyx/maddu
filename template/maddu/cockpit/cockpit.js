// Máddu cockpit — vanilla SPA. No framework, no build step.
// Hash-routed; views render into #route-view.

const ROUTES = {
  dashboard:  { title: 'Dashboard',  render: renderDashboard,  description: 'Snapshot of every lane, every spawned worker, every open approval.' },
  approvals:  { title: 'Approvals',  render: renderApprovals,  description: 'Pending tool / subprocess approvals. Allow-once, allow-always, or deny — every decision recorded.' },
  events:     { title: 'Events',     render: renderEvents,     description: 'Live cursor stream of the append-only spine. Filters by type. Pause/resume.' },
  mailbox:    { title: 'Mailbox',    render: renderMailbox,    description: 'Per-lane mailbox bus. Async handoffs without simultaneous lane mutation.' },
  tasks:      { title: 'Tasks',      render: renderTasks,      description: 'Dependency-aware task board. Completing a task auto-unblocks dependents.' },
  skills:     { title: 'Skills',     render: renderSkills,     description: 'Reusable recipes distilled from slice-stops. SKILL.md format under .maddu/skills/.' },
  search:     { title: 'Search',     render: renderSearch,     description: 'Cross-corpus search over events, slice-stops, memory, skills, mailbox, and inbox.' },
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
  approvalsBadge: document.getElementById('approvals-badge'),
  mailboxBadge: document.getElementById('mailbox-badge'),
  tasksBadge: document.getElementById('tasks-badge'),
  stuckBanner: document.getElementById('stuck-banner')
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
    const unread = bridgeStatus.counts && bridgeStatus.counts.unreadMail;
    if (els.mailboxBadge) {
      if (unread && unread > 0) { els.mailboxBadge.hidden = false; els.mailboxBadge.textContent = String(unread); }
      else                      { els.mailboxBadge.hidden = true; }
    }
    const openTasks = bridgeStatus.counts && bridgeStatus.counts.openTasks;
    if (els.tasksBadge) {
      if (openTasks && openTasks > 0) { els.tasksBadge.hidden = false; els.tasksBadge.textContent = String(openTasks); }
      else                            { els.tasksBadge.hidden = true; }
    }
    const stuck = bridgeStatus.counts && bridgeStatus.counts.stuckWorkers;
    if (els.stuckBanner) {
      if (stuck && stuck > 0) {
        els.stuckBanner.hidden = false;
        els.stuckBanner.innerHTML = `<span>⚠  ${stuck} worker${stuck === 1 ? '' : 's'} silent &gt; 15 s — possible hang</span><a href="#/swarm">View in Swarm →</a>`;
      } else {
        els.stuckBanner.hidden = true;
      }
    }
  } else {
    els.bridge.innerHTML = '<span class="signal"></span>offline';
    els.version.textContent = '—';
    els.uptime.textContent = '—';
    if (els.approvalsBadge) els.approvalsBadge.hidden = true;
    if (els.mailboxBadge)   els.mailboxBadge.hidden = true;
    if (els.tasksBadge)     els.tasksBadge.hidden = true;
    if (els.stuckBanner)    els.stuckBanner.hidden = true;
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
  // Split on / or ? so #/search?q=foo resolves to "search".
  const id = raw.split(/[/?]/)[0];
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

    // Workers panel (Phase B5) — surface stuck workers prominently.
    if (proj && proj.workers && proj.workers.length) {
      const ws = proj.workers;
      const wrap = el('div', {});
      const order = ['stuck', 'running', 'exited', 'killed'];
      for (const status of order) {
        const list = ws.filter((w) => w.status === status);
        if (!list.length) continue;
        const ccls = { stuck: 't-approval', running: 't-lane', exited: 't-inbox', killed: 't-approval' }[status] || '';
        for (const w of list) {
          const ageStr = w.ageMs != null ? (w.ageMs < 1000 ? `${w.ageMs}ms` : w.ageMs < 60000 ? `${Math.floor(w.ageMs / 1000)}s` : `${Math.floor(w.ageMs / 60000)}m`) : '—';
          wrap.appendChild(el('div', { class: 'ledger-row' }, [
            el('span', { class: `event-type ${ccls}` }, status),
            el('span', {}, w.id),
            el('span', {}, w.command ? w.command.slice(0, 60) : '—'),
            el('span', { class: 'event-actor' }, `age ${ageStr}  ${w.lane ? '· ' + w.lane : ''}  ${w.pid ? '· pid ' + w.pid : ''}`)
          ]));
        }
      }
      root.appendChild(panel(`Workers  (${ws.length})`, 'GET /bridge/workers · heartbeat threshold 15 s', wrap));
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

async function fetchMailboxCounts() {
  try {
    const r = await fetch('/bridge/mailbox-counts', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchMailbox(lane) {
  try {
    const r = await fetch(`/bridge/mailbox/${encodeURIComponent(lane)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function renderMailbox() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Mailbox'));
  root.appendChild(el('p', {}, ROUTES.mailbox.description));

  let selectedLane = null;
  const lanesMount = el('div', {});
  const msgsMount = el('div', {});
  root.appendChild(panel('Lanes', 'GET /bridge/mailbox-counts', lanesMount));
  root.appendChild(panel('Messages', 'select a lane', msgsMount));

  function loadMessages(lane) {
    selectedLane = lane;
    msgsMount.innerHTML = '';
    msgsMount.appendChild(loading(`Fetching mailbox for ${lane}…`));
    fetchMailbox(lane).then((m) => {
      msgsMount.innerHTML = '';
      if (!m || m.messages.length === 0) {
        msgsMount.appendChild(placeholder(`Empty mailbox`, `Run \`maddu mailbox send ${lane} --subject "..."\``));
        return;
      }
      for (const msg of m.messages.slice().reverse()) {
        const dot = msg.read ? '' : '<span class="signal live"></span>';
        const head = el('div', { class: 'panel-head' }, [
          el('span', { class: 'panel-title', html: `${dot} ${msg.subject || '(no subject)'}` }),
          el('span', { class: 'panel-aside' }, `${msg.type} · ${msg.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`)
        ]);
        const meta = el('div', { class: 'approval-meta' }, [
          `from ${msg.from || 'anon'}  ·  ${msg.id}` + (msg.read ? `  ·  read by ${msg.readBy || '?'}` : '')
        ]);
        const summary = msg.summary ? el('div', { class: 'approval-summary' }, msg.summary) : null;
        const body = msg.body ? el('pre', { style: 'font-size:11px;color:var(--m-fg-2);background:var(--m-bg-3);padding:8px;margin-top:6px;overflow:auto;white-space:pre-wrap;' }, msg.body) : null;
        const actions = msg.read ? null : el('div', { style: 'margin-top:8px;' }, [
          (() => {
            const b = el('button', {}, 'Mark read');
            b.addEventListener('click', async () => {
              b.disabled = true; b.textContent = '…';
              try {
                await fetch(`/bridge/mailbox/${encodeURIComponent(lane)}/read`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ messageId: msg.id, by: composer.currentSession || null })
                });
                loadMessages(lane);
              } catch (err) { b.textContent = 'error'; console.error(err); }
            });
            return b;
          })()
        ]);
        msgsMount.appendChild(el('div', { class: 'panel' }, [head, meta, summary, body, actions]));
      }
    });
  }

  function loadLanes() {
    lanesMount.innerHTML = '';
    lanesMount.appendChild(loading('Fetching lane mailboxes…'));
    fetchMailboxCounts().then((c) => {
      lanesMount.innerHTML = '';
      if (!c || Object.keys(c.counts).length === 0) {
        lanesMount.appendChild(placeholder('No lane mailboxes yet', 'Send the first message via `/mail <lane> <subject>` or `maddu mailbox send`.'));
        return;
      }
      const list = el('div', {});
      for (const lane of Object.keys(c.counts).sort()) {
        const m = c.counts[lane];
        const dot = m.unread > 0 ? '<span class="signal live"></span>' : '<span class="signal"></span>';
        const row = el('div', { class: 'ledger-row', style: 'cursor:pointer;' + (selectedLane === lane ? 'background:var(--m-bg-3);' : '') }, [
          el('span', { html: dot }),
          el('span', { class: 'event-type' }, lane),
          el('span', { class: m.unread > 0 ? 'event-type t-approval' : 'event-actor' }, m.unread > 0 ? `${m.unread} unread` : 'all read'),
          el('span', { class: 'event-actor' }, `${m.total} total`)
        ]);
        row.addEventListener('click', () => loadMessages(lane));
        list.appendChild(row);
      }
      lanesMount.appendChild(list);
    });
  }

  loadLanes();
  // Live refresh on any MAILBOX_* event.
  const handler = (e) => {
    if (e.detail.type && e.detail.type.startsWith('MAILBOX_')) {
      loadLanes();
      if (selectedLane) loadMessages(selectedLane);
    }
  };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });

  return root;
}

async function fetchTasks() {
  try {
    const r = await fetch('/bridge/tasks', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function renderTasks() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Tasks'));
  root.appendChild(el('p', {}, ROUTES.tasks.description));

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
        body: JSON.stringify({ title, lane: laneInput.value.trim() || null, createdBy: composer.currentSession || null })
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
          el('div', { class: 'task-col-body' }, list.map((x) => taskCard(x, refresh)))
        ]);
        board.appendChild(col);
      }
      boardMount.appendChild(board);
    });
  }

  refresh();
  const handler = (e) => {
    if (e.detail.type && e.detail.type.startsWith('TASK_')) refresh();
  };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });

  return root;
}

function taskCard(t, onChange) {
  const card = el('div', { class: 'task-card task-status-' + t.status }, [
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
          body: JSON.stringify({ status: 'in-progress', by: composer.currentSession || null })
        });
        onChange();
      });
      actions.appendChild(start);
    }
    const done = el('button', { class: 'btn-allow' }, 'Done');
    done.addEventListener('click', async () => {
      await fetch(`/bridge/tasks/${t.id}/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ by: composer.currentSession || null })
      });
      onChange();
    });
    actions.appendChild(done);
    card.appendChild(actions);
  }
  return card;
}

async function fetchSkills() {
  try { const r = await fetch('/bridge/skills', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function fetchSkill(id) {
  try { const r = await fetch(`/bridge/skills/${encodeURIComponent(id)}`, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

function renderSkills() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Skills'));
  root.appendChild(el('p', {}, ROUTES.skills.description));

  let selected = null;

  // create form
  const ftitle = el('input', { type: 'text', placeholder: 'Skill title…', style: 'flex:2;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const fwhen = el('input', { type: 'text', placeholder: 'when (one line)…', style: 'flex:2;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const ftags = el('input', { type: 'text', placeholder: 'tags (comma)', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const fbtn = el('button', {}, 'Create');
  const form = el('div', { style: 'display:flex;gap:6px;margin-bottom:12px;' }, [ftitle, fwhen, ftags, fbtn]);
  root.appendChild(form);

  const grid = el('div', { style: 'display:grid;grid-template-columns:340px 1fr;gap:12px;align-items:start;' });
  const listMount = el('div', {});
  const detailMount = el('div', {});
  grid.appendChild(listMount);
  grid.appendChild(detailMount);
  root.appendChild(grid);

  fbtn.addEventListener('click', async () => {
    const title = ftitle.value.trim();
    if (!title) return;
    fbtn.disabled = true;
    try {
      const r = await fetch('/bridge/skills', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title, when: fwhen.value.trim(),
          tags: ftags.value.split(',').map((x) => x.trim()).filter(Boolean),
          by: composer.currentSession || null
        })
      });
      const d = await r.json();
      ftitle.value = ''; fwhen.value = ''; ftags.value = '';
      selected = d.skill.id;
      refresh();
    } finally { fbtn.disabled = false; }
  });

  function refresh() {
    listMount.innerHTML = '';
    listMount.appendChild(loading('Loading skills…'));
    fetchSkills().then((d) => {
      listMount.innerHTML = '';
      if (!d || d.skills.length === 0) {
        listMount.appendChild(placeholder('No skills yet', 'Create one above or run `maddu skill from-slice <eventId>`.'));
        detailMount.innerHTML = '';
        return;
      }
      for (const s of d.skills) {
        const isSel = selected === s.id;
        const row = el('div', {
          style: 'padding:8px 10px;border-bottom:1px solid var(--m-line-soft);cursor:pointer;' + (isSel ? 'background:var(--m-bg-3);' : '')
        }, [
          el('div', { style: 'font-family:var(--m-font-cond);font-weight:500;color:var(--m-fg-0);font-size:13px;letter-spacing:0.03em;' }, s.title),
          el('div', { class: 'event-actor', style: 'margin-top:2px;' }, s.id),
          s.when ? el('div', { class: 'approval-summary' }, s.when) : null,
          s.tags.length ? el('div', { class: 'event-actor' }, s.tags.join(' · ')) : null
        ]);
        row.addEventListener('click', () => { selected = s.id; refresh(); });
        listMount.appendChild(row);
      }
      if (!selected) selected = d.skills[0].id;
      loadDetail(selected);
    });
  }

  function loadDetail(id) {
    detailMount.innerHTML = '';
    detailMount.appendChild(loading('Loading skill…'));
    fetchSkill(id).then((s) => {
      detailMount.innerHTML = '';
      if (!s) { detailMount.appendChild(placeholder('Not found', id)); return; }
      const applyBtn = el('button', { class: 'btn-allow' }, 'Apply');
      applyBtn.addEventListener('click', async () => {
        applyBtn.disabled = true; applyBtn.textContent = '…';
        try {
          await fetch(`/bridge/skills/${encodeURIComponent(id)}/apply`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ by: composer.currentSession || null, sessionId: composer.currentSession || null })
          });
          applyBtn.textContent = '✓ applied';
          setTimeout(() => { applyBtn.disabled = false; applyBtn.textContent = 'Apply'; }, 1500);
        } catch (err) { applyBtn.textContent = 'error'; console.error(err); }
      });

      detailMount.appendChild(panel(s.title, s.id, el('div', {}, [
        s.when ? el('div', { class: 'approval-meta' }, `WHEN: ${s.when}`) : null,
        Array.isArray(s.tags) && s.tags.length ? el('div', { class: 'event-actor', style: 'margin-top:4px;' }, `tags: ${s.tags.join(', ')}`) : null,
        Array.isArray(s.provenance) && s.provenance.length ? el('div', { class: 'event-actor', style: 'margin-top:4px;' }, `provenance: ${s.provenance.length} slice(s) — ${s.provenance.map((p) => p.event).join(', ')}`) : null,
        el('div', { style: 'margin:12px 0;' }, applyBtn),
        el('pre', { style: 'background:var(--m-bg-2);border:1px solid var(--m-line);padding:14px;font-size:12px;color:var(--m-fg-1);overflow:auto;white-space:pre-wrap;' }, s.body || '(empty body)')
      ])));
    });
  }

  refresh();
  const handler = (e) => { if (e.detail.type && e.detail.type.startsWith('SKILL_')) refresh(); };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });
  return root;
}

function renderSearch() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Search'));
  root.appendChild(el('p', {}, ROUTES.search.description));

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

// ─── Composer / slash-command palette ────────────────────────────────────

const composer = {
  input: null,
  suggest: null,
  toast: null,
  hint: null,
  currentSession: null,        // sticky session pointer set via `/use <id>`
  history: [],                 // command history (in-memory; survives within tab session)
  historyIdx: -1,
  selectedSuggestion: 0
};

const COMMANDS = [
  { name: 'help',    args: '',                                       desc: 'List all slash-commands.' },
  { name: 'usage',   args: '',                                       desc: 'Show bridge counts (events, sessions, claims, approvals).' },
  { name: 'use',     args: '<sessionId>',                            desc: 'Set the sticky session id used by other commands.' },
  { name: 'session', args: 'register|close|list <args>',             desc: 'Manage sessions (register / close / list).' },
  { name: 'lane',    args: 'claim|release|list <lane> [session]',    desc: 'Manage lane claims.' },
  { name: 'approve', args: '<approvalId> <decision>',                desc: 'allow-once | allow-always | deny | deny-always.' },
  { name: 'goal',    args: '<text>',                                 desc: 'Pin a goal on the current session (logs as heartbeat focus).' },
  { name: 'steer',   args: '<text>',                                 desc: 'Mid-turn nudge for the current session.' },
  { name: 'resume',  args: '[sessionId]',                            desc: 'Heartbeat "resumed" on a session.' },
  { name: 'stop',    args: '[sessionId] [handoff]',                  desc: 'Close the current session.' },
  { name: 'inbox',   args: '<message>',                              desc: 'Append a note to the operator inbox.' },
  { name: 'mail',    args: '<lane> <subject>',                       desc: 'Send a quick mailbox note to a lane (uses current session as from).' },
  { name: 'mail-read', args: '<lane> <msgId>',                       desc: 'Mark a mailbox message read on a lane.' },
  { name: 'task',    args: '<title>',                                desc: 'Quick-create a task (current session as creator).' },
  { name: 'task-done', args: '<id>',                                 desc: 'Mark a task complete (auto-unblocks dependents).' },
  { name: 'workers', args: '',                                       desc: 'List running / stuck workers.' },
  { name: 'kill',    args: '<workerId> [reason]',                    desc: 'Mark a worker killed (operator-initiated).' },
  { name: 'search',  args: '<query>',                                desc: 'Jump to /search prefilled with the query.' },
  { name: 'rollback',args: '<event-or-approval-id>',                 desc: 'Stub — full git-worktree rollback lands in Phase C4.' },
  { name: 'skills',  args: '',                                       desc: 'List all skills in the gallery.' },
  { name: 'skill',   args: '<id>',                                   desc: 'Apply a skill to the current session.' },
  { name: 'runtime', args: '',                                       desc: 'Stub — runtime adapters land in Phase C1.' },
  { name: 'clear',   args: '',                                       desc: 'Clear the composer.' }
];

function showToast(text, level = 'ok') {
  composer.toast.hidden = false;
  composer.toast.textContent = text;
  composer.toast.className = 'composer-toast' + (level === 'err' ? ' err' : level === 'warn' ? ' warn' : '');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { composer.toast.hidden = true; }, 4500);
}

function updateHint() {
  const sess = composer.currentSession ? `as: ${composer.currentSession.slice(0, 22)}…` : 'no session set ·  /use <id>';
  composer.hint.textContent = sess;
}

function renderSuggestions(input) {
  if (!input.startsWith('/')) { composer.suggest.hidden = true; return; }
  const q = input.slice(1).split(/\s+/)[0].toLowerCase();
  const matches = COMMANDS.filter((c) => c.name.startsWith(q));
  if (matches.length === 0 || (matches.length === 1 && matches[0].name === q)) {
    // Show args hint when command is fully typed.
    if (matches.length === 1) {
      composer.suggest.hidden = false;
      composer.suggest.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'composer-suggest-row active';
      row.innerHTML = `<span class="composer-suggest-cmd">/${matches[0].name} ${matches[0].args}</span><span class="composer-suggest-desc">${matches[0].desc}</span>`;
      composer.suggest.appendChild(row);
      return;
    }
    composer.suggest.hidden = true;
    return;
  }
  composer.suggest.hidden = false;
  composer.suggest.innerHTML = '';
  composer.selectedSuggestion = Math.min(composer.selectedSuggestion, matches.length - 1);
  matches.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'composer-suggest-row' + (i === composer.selectedSuggestion ? ' active' : '');
    row.innerHTML = `<span class="composer-suggest-cmd">/${c.name} ${c.args}</span><span class="composer-suggest-desc">${c.desc}</span>`;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      composer.input.value = '/' + c.name + ' ';
      composer.input.focus();
      renderSuggestions(composer.input.value);
    });
    composer.suggest.appendChild(row);
  });
}

function parseCommand(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const stripped = trimmed.slice(1);
  const m = stripped.match(/^(\S+)\s*(.*)$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: m[2] };
}

async function postJson(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data.error || data.detail || `bridge ${r.status}`);
  return data;
}

async function fetchJson(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`bridge ${r.status}`);
  return r.json();
}

async function runCommand(cmd) {
  const sess = composer.currentSession;
  switch (cmd.name) {
    case 'help': {
      const lines = COMMANDS.map((c) => `/${c.name} ${c.args}  —  ${c.desc}`).join('\n');
      return showToast(lines, 'ok');
    }
    case 'usage': {
      const s = await fetchJson('/bridge/status');
      const c = s.counts || {};
      return showToast(
        `version ${s.version}  ·  uptime ${formatUptime(s.uptimeMs)}\n` +
        `events ${c.events}  ·  active sessions ${c.activeSessions}  ·  claims ${c.claims}\n` +
        `slice-stops ${c.sliceStops}  ·  open approvals ${c.openApprovals}  ·  memory ${c.memoryFacts}`,
        'ok'
      );
    }
    case 'use': {
      const id = cmd.rest.trim();
      if (!id) return showToast('usage: /use <sessionId>', 'err');
      composer.currentSession = id;
      updateHint();
      return showToast(`session set: ${id}`, 'ok');
    }
    case 'session': {
      const m = cmd.rest.match(/^(register|close|list)\s*(.*)$/i);
      if (!m) return showToast('usage: /session register|close|list ...', 'err');
      const sub = m[1].toLowerCase();
      const args = m[2].trim();
      if (sub === 'list') {
        const s = await fetchJson('/bridge/sessions');
        const lines = s.active.map((x) => `${x.id}  ${x.role || '—'}  ${x.label || ''}`).join('\n');
        return showToast(lines || '(no active sessions)', 'ok');
      }
      if (sub === 'register') {
        // freeform: --role X --label Y --focus Z
        const flags = parseFlagsInline(args);
        const r = await postJson('/bridge/sessions/register', flags);
        composer.currentSession = r.sessionId;
        updateHint();
        return showToast(`registered ${r.sessionId}`, 'ok');
      }
      if (sub === 'close') {
        const id = args || sess;
        if (!id) return showToast('usage: /session close <id>  (or /use first)', 'err');
        await postJson('/bridge/sessions/close', { sessionId: id });
        if (id === sess) { composer.currentSession = null; updateHint(); }
        return showToast(`closed ${id}`, 'ok');
      }
      return;
    }
    case 'lane': {
      const m = cmd.rest.match(/^(claim|release|list)\s*(.*)$/i);
      if (!m) return showToast('usage: /lane claim|release|list <lane> [sessionId]', 'err');
      const sub = m[1].toLowerCase();
      const args = m[2].trim().split(/\s+/).filter(Boolean);
      if (sub === 'list') {
        const r = await fetchJson('/bridge/lanes');
        const claims = new Map(r.claims.map((c) => [c.lane, c]));
        const lines = r.catalog.lanes.map((l) => {
          const c = claims.get(l.id);
          return `${l.id.padEnd(22)} ${c ? '★ claimed by ' + c.sessionId : ''}`;
        }).join('\n');
        return showToast(lines, 'ok');
      }
      const lane = args[0];
      const sid = args[1] || sess;
      if (!lane || !sid) return showToast(`usage: /lane ${sub} <lane> [sessionId]  (or /use first)`, 'err');
      await postJson(`/bridge/lanes/${sub}`, { lane, sessionId: sid });
      return showToast(`${sub} ${lane}`, 'ok');
    }
    case 'approve': {
      const args = cmd.rest.trim().split(/\s+/);
      if (args.length < 2) return showToast('usage: /approve <approvalId> <decision>', 'err');
      const [id, decision] = args;
      await postJson('/bridge/approvals/respond', { approvalId: id, decision });
      return showToast(`${decision} ${id}`, 'ok');
    }
    case 'goal':
    case 'steer': {
      if (!sess) return showToast('no session set — run /use <id> first', 'err');
      const focus = cmd.rest.trim();
      if (!focus) return showToast(`usage: /${cmd.name} <text>`, 'err');
      await postJson('/bridge/sessions/heartbeat', { sessionId: sess, focus: cmd.name === 'goal' ? `goal: ${focus}` : focus });
      return showToast(`${cmd.name} ${focus}`, 'ok');
    }
    case 'resume': {
      const id = cmd.rest.trim() || sess;
      if (!id) return showToast('no session set — /resume <id> or /use first', 'err');
      await postJson('/bridge/sessions/heartbeat', { sessionId: id, focus: 'resumed' });
      composer.currentSession = id;
      updateHint();
      return showToast(`resumed ${id}`, 'ok');
    }
    case 'stop': {
      const args = cmd.rest.trim().split(/\s+/).filter(Boolean);
      const id = args[0] || sess;
      const handoff = args.slice(1).join(' ');
      if (!id) return showToast('usage: /stop [sessionId] [handoff]', 'err');
      await postJson('/bridge/sessions/close', { sessionId: id, handoff: handoff || null });
      if (id === sess) { composer.currentSession = null; updateHint(); }
      return showToast(`closed ${id}`, 'ok');
    }
    case 'inbox': {
      const message = cmd.rest.trim();
      if (!message) return showToast('usage: /inbox <message>', 'err');
      await postJson('/bridge/inbox', { message, sessionId: sess, kind: 'operator' });
      return showToast(`inbox: ${message}`, 'ok');
    }
    case 'mail': {
      const m = cmd.rest.match(/^(\S+)\s+(.+)$/);
      if (!m) return showToast('usage: /mail <lane> <subject>', 'err');
      const [, lane, subject] = m;
      const r = await postJson(`/bridge/mailbox/${encodeURIComponent(lane)}`, {
        subject, type: 'note', from: sess
      });
      return showToast(`mail → ${lane}: ${r.message.id}`, 'ok');
    }
    case 'mail-read': {
      const m = cmd.rest.match(/^(\S+)\s+(\S+)$/);
      if (!m) return showToast('usage: /mail-read <lane> <msgId>', 'err');
      const [, lane, mid] = m;
      await postJson(`/bridge/mailbox/${encodeURIComponent(lane)}/read`, { messageId: mid, by: sess });
      return showToast(`read ${mid}`, 'ok');
    }
    case 'task': {
      const title = cmd.rest.trim();
      if (!title) return showToast('usage: /task <title>', 'err');
      const r = await postJson('/bridge/tasks', { title, createdBy: sess });
      return showToast(`task created: ${r.taskId}`, 'ok');
    }
    case 'task-done': {
      const id = cmd.rest.trim();
      if (!id) return showToast('usage: /task-done <id>', 'err');
      await postJson(`/bridge/tasks/${id}/complete`, { by: sess });
      return showToast(`done ${id}`, 'ok');
    }
    case 'workers': {
      const d = await fetchJson('/bridge/workers');
      if (!d.workers.length) return showToast('(no workers registered)', 'ok');
      const lines = d.workers.map((w) => `${w.status.padEnd(8)} ${w.id}  ${(w.command || '').slice(0, 50)}`).join('\n');
      return showToast(lines, 'ok');
    }
    case 'kill': {
      const m = cmd.rest.match(/^(\S+)(?:\s+(.+))?$/);
      if (!m) return showToast('usage: /kill <workerId> [reason]', 'err');
      const [, id, reason] = m;
      await postJson(`/bridge/workers/${id}/kill`, { reason: reason || null, by: sess });
      return showToast(`killed ${id}`, 'ok');
    }
    case 'search': {
      const q = cmd.rest.trim();
      if (!q) return showToast('usage: /search <query>', 'err');
      location.hash = `#/search?q=${encodeURIComponent(q)}`;
      return showToast(`→ /search?q=${q}`, 'ok');
    }
    case 'rollback':
      return showToast('rollback is a stub — full implementation lands in Phase C4 (git-worktree).', 'warn');
    case 'skills': {
      const d = await fetchJson('/bridge/skills');
      if (!d.skills.length) return showToast('(no skills yet)  ·  /task to make one, then /skill <id>', 'ok');
      const lines = d.skills.map((s) => `${s.id}  ${s.title}${s.when ? '  ·  ' + s.when : ''}`).join('\n');
      return showToast(lines, 'ok');
    }
    case 'skill': {
      const id = cmd.rest.trim();
      if (!id) return showToast('usage: /skill <id>', 'err');
      const r = await postJson(`/bridge/skills/${encodeURIComponent(id)}/apply`, { sessionId: sess, by: sess });
      return showToast(`applied: ${r.applied.title}`, 'ok');
    }
    case 'runtime':
      return showToast('runtime adapters land in Phase C1. Try /usage for now.', 'warn');
    case 'clear':
      composer.input.value = '';
      composer.suggest.hidden = true;
      composer.toast.hidden = true;
      return;
    default:
      return showToast(`unknown command: /${cmd.name}  ·  /help for the list`, 'err');
  }
}

function parseFlagsInline(s) {
  const out = {};
  const re = /--(\S+)\s+(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

function initComposer() {
  composer.input = document.getElementById('composer-input');
  composer.suggest = document.getElementById('composer-suggest');
  composer.toast = document.getElementById('composer-toast');
  composer.hint = document.getElementById('composer-hint');
  updateHint();

  composer.input.addEventListener('input', () => {
    composer.selectedSuggestion = 0;
    renderSuggestions(composer.input.value);
  });

  composer.input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = composer.input.value.trim();
      if (!line) return;
      composer.history.push(line);
      composer.historyIdx = composer.history.length;
      composer.input.value = '';
      composer.suggest.hidden = true;
      const cmd = parseCommand(line);
      if (!cmd) { showToast('commands must start with /', 'err'); return; }
      try {
        await runCommand(cmd);
      } catch (err) {
        showToast(err?.message || String(err), 'err');
      }
    } else if (e.key === 'Escape') {
      composer.input.value = '';
      composer.suggest.hidden = true;
      composer.toast.hidden = true;
      composer.input.blur();
    } else if (e.key === 'ArrowUp') {
      if (!composer.suggest.hidden) {
        e.preventDefault();
        composer.selectedSuggestion = Math.max(0, composer.selectedSuggestion - 1);
        renderSuggestions(composer.input.value);
        return;
      }
      if (composer.historyIdx > 0) {
        e.preventDefault();
        composer.historyIdx--;
        composer.input.value = composer.history[composer.historyIdx];
      }
    } else if (e.key === 'ArrowDown') {
      if (!composer.suggest.hidden) {
        e.preventDefault();
        const rows = composer.suggest.querySelectorAll('.composer-suggest-row').length;
        composer.selectedSuggestion = Math.min(rows - 1, composer.selectedSuggestion + 1);
        renderSuggestions(composer.input.value);
        return;
      }
      if (composer.historyIdx < composer.history.length - 1) {
        composer.historyIdx++;
        composer.input.value = composer.history[composer.historyIdx];
      } else {
        composer.historyIdx = composer.history.length;
        composer.input.value = '';
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const rows = composer.suggest.querySelectorAll('.composer-suggest-row');
      if (rows.length > 0) {
        const row = rows[composer.selectedSuggestion] || rows[0];
        const cmdName = row.querySelector('.composer-suggest-cmd').textContent.split(' ')[0];
        composer.input.value = cmdName + ' ';
        renderSuggestions(composer.input.value);
      }
    }
  });

  // Global "/" focuses the composer unless another input/textarea is focused.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    composer.input.focus();
    if (!composer.input.value.startsWith('/')) composer.input.value = '/';
    renderSuggestions(composer.input.value);
  });
}

async function boot() {
  if (!location.hash) location.hash = '#/dashboard';
  await fetchBridgeStatus();
  await seedCursor();
  renderRoute();
  streamLoop();
  initComposer();
  // Fallback chrome refresh in case stream stalls.
  setInterval(fetchBridgeStatus, 15000);
}

boot();
