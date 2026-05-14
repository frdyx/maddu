// Máddu cockpit — vanilla SPA. No framework, no build step.
// Hash-routed; views render into #route-view.

const ROUTES = {
  dashboard:  { title: 'Dashboard',  render: renderDashboard,  description: 'Snapshot of every lane, every spawned worker, every open approval.' },
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
  port: document.getElementById('status-port')
};

let bridgeStatus = null;
let bridgeOk = false;

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
  } else {
    els.bridge.innerHTML = '<span class="signal"></span>offline';
    els.version.textContent = '—';
    els.uptime.textContent = '—';
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
  const kv = el('dl', { class: 'kv' });
  const rows = [
    ['Bridge', bridgeOk ? 'online' : 'offline'],
    ['Version', status.version || '—'],
    ['Host', status.host || '127.0.0.1'],
    ['Port', String(status.port || 4177)],
    ['State', status.stateDir || '.maddu/'],
    ['Cockpit', status.cockpitDir || '—'],
    ['Uptime', formatUptime(status.uptimeMs)]
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

function renderOperations() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Operations'));
  root.appendChild(el('p', {}, ROUTES.operations.description));
  root.appendChild(placeholder('Slice ledger', 'Lands in Slice 3 — slice-stop ritual + lane claims.'));
  root.appendChild(placeholder('Verification reports', 'Lands in Slice 3 — focused-gate output.'));
  return root;
}

function renderSwarm() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Swarm'));
  root.appendChild(el('p', {}, ROUTES.swarm.description));
  root.appendChild(placeholder('Lane roster', 'Lands in Slice 3 — claims + mailboxes.'));
  root.appendChild(placeholder('Subprocess workers', 'Lands in Slice B5 — heartbeat watcher.'));
  return root;
}

function renderChats() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Chats'));
  root.appendChild(el('p', {}, ROUTES.chats.description));
  root.appendChild(placeholder('Conversation list', 'Lands in Slice 3 — session registrations.'));
  root.appendChild(placeholder('History bridge', 'Lands in Phase B — Hermes-pattern messages_read.'));
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
  renderRoute();
  setInterval(fetchBridgeStatus, 5000);
}

boot();
