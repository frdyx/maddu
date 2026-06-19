// Máddu cockpit — vanilla SPA. No framework, no build step.
// Hash-routed; views render into #route-view.

// Pure leaf utilities (DOM builder + formatters) live in a sibling module —
// the first slice of decomposing this file. Browser ES module import; the
// bridge serves cockpit-util.js as application/javascript.
import { el, panel, placeholder, truncatePathFromLeft, compactPath, formatUptime, formatAge, ageTone, formatTs, loading, loadingFor, showToast, copyToClipboardWithToast, workspaceBadge, laneFromFact } from './cockpit-util.js';
import { statusGrid, bar, segBar, donut, sparkline, meter, binByTime } from './cockpit-widgets.js';
import { renderTelegramPanel, renderDiscordPanel, renderEmailPanel } from './cockpit-comms.js';
import { renderSlashCheatsheet } from './cockpit-backbone-cards.js';
import { classifyEvent, eventRow, prepend, makeDecisionButton } from './cockpit-event-rows.js';
import { renderMarkdown } from './cockpit-markdown.js';
import { ROUTE_META } from './cockpit-route-meta.js';
import { renderPipelinesRoute, renderCostRoute, renderAdvisorsRoute, renderSkillInjectionsRoute, renderModelRoutingRoute, renderTestStatusRoute } from './cockpit-views-backbone.js';
import { renderGoal, renderTools, renderLoops, renderSearch, renderWiki } from './cockpit-views-reference.js';
import { renderDocs } from './cockpit-views-docs.js';
import { renderLearning, renderTeams, renderWorkflows, renderRoadmap, renderAgents } from './cockpit-views-inspect.js';

// ─── Multi-workspace scoping ────────────────────────────────────────────
// The bridge can mount N repos. Every /bridge/* request carries an
// X-Maddu-Workspace header naming which one this call is for. The fetch
// shim below injects it on every request so the 100+ existing call sites
// don't need to change. The active id is persisted to localStorage and
// re-validated against /bridge/_workspaces on boot.
let currentWorkspace = (() => {
  try { return localStorage.getItem('maddu.workspace') || null; } catch { return null; }
})();
let allWorkspacesMode = false; // when true, /bridge/_all/* gets `_all`.

(function installFetchShim() {
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
    if (urlStr.startsWith('/bridge/')) {
      const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
      if (urlStr.startsWith('/bridge/_all/')) {
        if (!headers.has('X-Maddu-Workspace')) headers.set('X-Maddu-Workspace', '_all');
      } else if (currentWorkspace && !headers.has('X-Maddu-Workspace')) {
        headers.set('X-Maddu-Workspace', currentWorkspace);
      }
      init.headers = headers;
    }
    return origFetch(input, init);
  };
})();

// Route registry. The plain metadata (title/group/rank/anchor/description/
// keywords/frameworkOnly) lives in cockpit-route-meta.js so view modules + the
// rail/dock/palette can import it without dragging in the render graph. This
// module is the composition root: it owns the render bindings and merges each
// render fn onto its metadata to build the full ROUTES registry the router
// reads. (render fns are hoisted declarations, so referencing them here — above
// their definitions — is fine.)
const RENDERERS = {
  goal: renderGoal, conductor: renderConductor, boss: renderBoss, queue: renderQueueBoard,
  claims: renderClaimMap, approvals: renderApprovals, tasks: renderTasks, plans: renderPlans,
  workflows: renderWorkflows, agents: renderAgents, teams: renderTeams, workbench: renderWorkbench,
  chats: renderChats, mailbox: renderMailbox, swarm: renderSwarm,
  learning: renderLearning, wiki: renderWiki, events: renderEvents, operations: renderOperations,
  search: renderSearch,
  runtimes: renderRuntimes, mcp: renderMcp, tools: renderTools, auth: renderAuth,
  imports: renderImports, schedule: renderSchedule, settings: renderSettings,
  orientation: renderOrientation, gates: renderGates, reviews: renderReviews,
  pipelines: renderPipelinesRoute, loops: renderLoops, cost: renderCostRoute,
  advisors: renderAdvisorsRoute, skillinjections: renderSkillInjectionsRoute,
  modelrouting: renderModelRoutingRoute, trust: renderTrust, teststatus: renderTestStatusRoute,
  dashboard: renderDashboard, roadmap: renderRoadmap, skills: renderSkills, docs: renderDocs,
};
const ROUTES = {};
for (const id of Object.keys(ROUTE_META)) ROUTES[id] = { ...ROUTE_META[id], render: RENDERERS[id] };

// Five clusters that map every route to a phase-of-work. Order is the order
// they appear in the rail, top to bottom on desktop and left to right on the
// mobile dock. Each glyph is a single geometric primitive so the visual
// vocabulary stays restrained (Scandinavian noir, not iconographic).
const NAV_GROUPS = [
  { id: 'decide',    label: 'Decide',    glyph: '◆', summary: 'what is safe to do next' },
  { id: 'operate',   label: 'Operate',   glyph: '◈', summary: 'agents, lanes, conversations' },
  { id: 'verify',    label: 'Verify',    glyph: '⌬', summary: 'evidence, memory, wiki' },
  { id: 'connect',   label: 'Connect',   glyph: '⌗', summary: 'runtimes, auth, integrations' },
  { id: 'reference', label: 'Reference', glyph: '☷', summary: 'dashboard, docs, roadmap' }
];

// v1.0.3 — framework-only routes are hidden on consumer installs because
// their data sources (e.g. scripts/test/*.mjs) don't ship. Default to
// 'source' so framework contributors see everything before the first
// /bridge/status response lands.
let frameworkLayout = 'source';

function isRouteHidden(route) {
  return route && route.frameworkOnly && frameworkLayout !== 'source';
}

function routesInGroup(groupId) {
  return Object.entries(ROUTES)
    .filter(([, r]) => r.group === groupId && !isRouteHidden(r))
    .sort((a, b) => (a[1].rank || 99) - (b[1].rank || 99))
    .map(([id, r]) => ({ id, ...r }));
}

function groupOf(routeId) {
  return ROUTES[routeId] && ROUTES[routeId].group;
}

const els = {
  app: document.getElementById('app'),
  view: document.getElementById('route-view'),
  title: document.getElementById('route-title'),
  meta: document.getElementById('route-meta'),
  bridge: document.getElementById('status-bridge'),
  version: document.getElementById('status-version'),
  governance: document.getElementById('status-governance'),
  uptime: document.getElementById('status-uptime'),
  host: document.getElementById('status-host'),
  port: document.getElementById('status-port'),
  // v1.2.1 F4 — rail-foot workspace + repoRoot rows.
  workspace: document.getElementById('status-workspace'),
  repoRoot: document.getElementById('status-repo-root'),
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
        if (ev.type === 'SLICE_STOP') flashSliceLine();
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
    // v1.0.3 — propagate layout so framework-only routes hide on installs.
    // Rebuild rail if the value changed (initial fetch transitions from
    // the default 'source' to whatever the bridge reports).
    const newLayout = bridgeStatus?.frameworkLayout || 'source';
    if (newLayout !== frameworkLayout) {
      frameworkLayout = newLayout;
      try { buildRail(); } catch {}
      // If the active route is now hidden, bounce to Conductor.
      if (isRouteHidden(ROUTES[currentRoute()])) {
        location.hash = '#/conductor';
      }
    }
  } catch {
    bridgeStatus = null;
    bridgeOk = false;
  }
  updateChrome();
}

// v1.2.1 F4 — truncate a long path from the LEFT so the basename always
// shows. Operator cue: an ellipsis on the left means "more path above this".
// truncatePathFromLeft / compactPath → moved to cockpit-util.js (v1.24.0).

// copyToClipboardWithToast → moved to cockpit-util.js (v1.43.0).

// ─── v1.2.3 — Entity drawer (reusable right-side detail panel) ─────────
//
// Pattern: any clickable cockpit entity (plan, kanban card, etc.) can call
// openEntityDrawer({ title, subtitle, body, onClose }) to slide a panel in
// from the right showing full details. Closes on Esc / scrim click / × button.
// Singleton — opening a new drawer replaces the current one (no stack).
//
// `body` is a DOM Element OR a function returning Element OR Promise<Element>
// (so callers can pass `async () => fetch + render`). While the promise resolves
// the drawer shows a loading state.

let _entityDrawerEl = null;
let _entityDrawerEscHandler = null;

function closeEntityDrawer() {
  if (!_entityDrawerEl) return;
  const root = _entityDrawerEl;
  root.classList.remove('open');
  // Detach Esc handler immediately; let the close animation finish before removing the DOM.
  if (_entityDrawerEscHandler) {
    document.removeEventListener('keydown', _entityDrawerEscHandler);
    _entityDrawerEscHandler = null;
  }
  setTimeout(() => {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    if (_entityDrawerEl === root) _entityDrawerEl = null;
  }, 220);
}

async function openEntityDrawer({ title, subtitle = null, body, onClose = null } = {}) {
  closeEntityDrawer();
  const scrim = el('div', { class: 'entity-drawer-scrim' });
  const panel = el('aside', {
    class: 'entity-drawer-panel',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || 'Entity detail',
  });
  const head = el('header', { class: 'entity-drawer-head' });
  head.appendChild(el('div', { class: 'entity-drawer-title' }, title || '—'));
  if (subtitle) head.appendChild(el('div', { class: 'entity-drawer-subtitle' }, subtitle));
  const closeBtn = el('button', { class: 'entity-drawer-close', type: 'button', 'aria-label': 'Close' }, '×');
  head.appendChild(closeBtn);
  const bodyMount = el('div', { class: 'entity-drawer-body' });
  panel.appendChild(head);
  panel.appendChild(bodyMount);
  const root = el('div', { class: 'entity-drawer' });
  root.appendChild(scrim);
  root.appendChild(panel);
  document.body.appendChild(root);
  _entityDrawerEl = root;
  // Slide animation — add the 'open' class on the next frame so the transition fires.
  requestAnimationFrame(() => root.classList.add('open'));
  // Wire close affordances.
  const close = () => {
    closeEntityDrawer();
    if (typeof onClose === 'function') try { onClose(); } catch {}
  };
  closeBtn.addEventListener('click', close);
  scrim.addEventListener('click', close);
  _entityDrawerEscHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', _entityDrawerEscHandler);
  // Focus the close button for keyboard users.
  setTimeout(() => closeBtn.focus(), 50);
  // Populate body. Loading placeholder shows while async resolves.
  bodyMount.appendChild(loading('Loading…'));
  try {
    const result = (typeof body === 'function') ? body() : body;
    const resolved = (result && typeof result.then === 'function') ? await result : result;
    bodyMount.innerHTML = '';
    if (resolved instanceof Element) {
      bodyMount.appendChild(resolved);
    } else if (typeof resolved === 'string') {
      bodyMount.appendChild(el('div', {}, resolved));
    }
  } catch (err) {
    bodyMount.innerHTML = '';
    bodyMount.appendChild(placeholder('Failed to load', err.message || String(err)));
  }
}

function updateChrome() {
  if (bridgeOk && bridgeStatus) {
    els.bridge.innerHTML = '<span class="signal live"></span>online';
    els.version.textContent = bridgeStatus.version || 'unknown';
    els.uptime.textContent = formatUptime(bridgeStatus.uptimeMs);
    // v1.2.1 F4 — surface workspace label + repoRoot so the operator can
    // tell tabs apart when browsing multiple cockpits across repos.
    if (els.workspace) {
      els.workspace.textContent = bridgeStatus.workspaceId || '—';
      els.workspace.title = bridgeStatus.workspaceId || '';
    }
    if (els.repoRoot) {
      const full = bridgeStatus.repoRoot || '';
      // v1.2.2 — compact display (drive/…/basename), full path on hover (title),
      // click-to-copy. Width is also CSS-bounded so long paths don't overflow.
      els.repoRoot.textContent = compactPath(full);
      els.repoRoot.title = full ? `${full}  ·  click to copy` : '';
      els.repoRoot.dataset.fullPath = full;
      if (!els.repoRoot.dataset.copyBound) {
        els.repoRoot.dataset.copyBound = '1';
        els.repoRoot.addEventListener('click', () => {
          const path = els.repoRoot.dataset.fullPath || '';
          if (path) copyToClipboardWithToast(path, 'Path');
        });
        // Keyboard accessibility — Enter / Space activate copy.
        els.repoRoot.tabIndex = 0;
        els.repoRoot.setAttribute('role', 'button');
        els.repoRoot.setAttribute('aria-label', 'Copy workspace path to clipboard');
        els.repoRoot.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const path = els.repoRoot.dataset.fullPath || '';
            if (path) copyToClipboardWithToast(path, 'Path');
          }
        });
      }
    }
    // v1.1.0 Phase 3 — governance mode badge (poll once when chrome updates).
    if (els.governance && !els.governance.dataset.fetched) {
      els.governance.dataset.fetched = '1';
      fetch('/bridge/governance').then((r) => r.json()).then((d) => {
        if (!d || !d.mode) { els.governance.textContent = '—'; return; }
        const color = d.mode === 'strict' ? '#e77' : (d.mode === 'relaxed' ? '#ec8' : '#6cf');
        els.governance.innerHTML = `<span style="color:${color};">${d.mode}</span>`;
      }).catch(() => { els.governance.textContent = '—'; });
    }
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
    const sliceStops = (bridgeStatus.counts && bridgeStatus.counts.sliceStops) || 0;
    const dismissed = (() => {
      try { return localStorage.getItem('maddu.firstRunDismissed') === '1'; } catch { return false; }
    })();
    if (stuck && stuck > 0) {
      setBanner(`<span>⚠  ${stuck} worker${stuck === 1 ? '' : 's'} silent &gt; 15 s — possible hang</span><a href="#/swarm">View in Swarm →</a>`, 'warn');
    } else if (sliceStops === 0 && !dismissed) {
      // First-run hint — clears the moment the operator runs a slice-stop,
      // or when they dismiss it explicitly. Stored in localStorage so it
      // doesn't reappear across reloads after dismissal.
      setBanner(
        '<span>👋  First time here? <a href="#/docs?p=18-first-slice">Take the five-minute tour →</a></span>' +
        '<a href="#" data-first-run-dismiss="1">dismiss</a>',
        'info'
      );
    } else {
      setBanner('');
    }
  } else {
    els.bridge.innerHTML = '<span class="signal"></span>offline';
    els.version.textContent = '—';
    els.uptime.textContent = '—';
    if (els.workspace) { els.workspace.textContent = '—'; els.workspace.title = ''; }
    if (els.repoRoot)  { els.repoRoot.textContent  = '—'; els.repoRoot.title  = ''; }
    if (els.governance) { els.governance.textContent = '—'; delete els.governance.dataset.fetched; }
    if (els.approvalsBadge) els.approvalsBadge.hidden = true;
    if (els.mailboxBadge)   els.mailboxBadge.hidden = true;
    if (els.tasksBadge)     els.tasksBadge.hidden = true;
    setBanner('');
  }
}

/**
 * Set the persistent .stage-banner content with severity + activity pulse.
 *
 * The banner is an info channel, not a permanent alarm — at rest there is
 * no glow. Whenever the inner HTML changes we add `.pulse` for ~1.5 s so
 * operators see an activity flash, then it settles back to a quiet strip
 * of severity-tinted colour.
 *
 *  text     — innerHTML to render. Empty/falsey hides the banner.
 *  severity — 'info' (default, blue), 'warn' (amber), 'danger' (red).
 */
function setBanner(text, severity = 'info') {
  const el = els.stuckBanner;
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.classList.remove('warn', 'danger', 'pulse');
    el.innerHTML = '';
    if (el._pulseTimer) { clearTimeout(el._pulseTimer); el._pulseTimer = null; }
    return;
  }
  const wasHidden = el.hidden;
  const prev = el.innerHTML;
  el.hidden = false;
  el.classList.remove('warn', 'danger');
  if (severity === 'warn' || severity === 'danger') el.classList.add(severity);
  el.innerHTML = text;
  // Activity pulse on appear or content change.
  if (wasHidden || prev !== text) {
    el.classList.remove('pulse');
    // Force a reflow so the animation restarts even on rapid content changes.
    void el.offsetWidth;
    el.classList.add('pulse');
    if (el._pulseTimer) clearTimeout(el._pulseTimer);
    el._pulseTimer = setTimeout(() => el.classList.remove('pulse'), 1500);
  }
}

// formatUptime → moved to cockpit-util.js (v1.24.0).

// ─── Inspector (persistent right panel) ─────────────────────────────────
//
// Detail surface for any entity. Tabs: overview · evidence · actions ·
// related · raw. Render is by-kind; renderers below dispatch on entity kind.
// No modals — Inspector lives in #inspector-panel and slides in.

const inspector = {
  open: false,
  entity: null,    // { kind, id, data }
  tab: 'overview',
  el: null,
  bodyEl: null,
  titleEl: null,
  subEl: null,
  tabsEl: null
};

function ensureInspector() {
  if (inspector.el) return inspector.el;
  const panelEl = document.createElement('aside');
  panelEl.id = 'inspector-panel';
  panelEl.className = 'inspector';
  panelEl.hidden = true;
  panelEl.innerHTML = `
    <div class="inspector-head">
      <div class="inspector-titles">
        <div class="inspector-title" id="inspector-title">—</div>
        <div class="inspector-sub" id="inspector-sub">no selection</div>
      </div>
      <button type="button" class="inspector-close" id="inspector-close" aria-label="Close inspector">×</button>
    </div>
    <nav class="inspector-tabs" id="inspector-tabs"></nav>
    <div class="inspector-body" id="inspector-body"></div>
  `;
  document.getElementById('app').appendChild(panelEl);
  inspector.el = panelEl;
  inspector.bodyEl = panelEl.querySelector('#inspector-body');
  inspector.titleEl = panelEl.querySelector('#inspector-title');
  inspector.subEl = panelEl.querySelector('#inspector-sub');
  inspector.tabsEl = panelEl.querySelector('#inspector-tabs');
  panelEl.querySelector('#inspector-close').addEventListener('click', closeInspector);
  // Escape closes.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inspector.open && !e.defaultPrevented) closeInspector();
  });
  // Outside-click closes. pointerdown unifies mouse/touch/pen and fires
  // before the subsequent click, so a card-click that opens a different
  // entity still works (close → reopen with new content in one gesture).
  document.addEventListener('pointerdown', (e) => {
    if (!inspector.open) return;
    const t = e.target;
    if (!t || !(t instanceof Node)) return;
    // Inside the panel — keep open.
    if (panelEl.contains(t)) return;
    // Palette / dock-sheet / first-run banner all have their own scrim
    // close behavior; clicking them is "outside" the inspector and should
    // dismiss it too.
    closeInspector();
  });
  return panelEl;
}

function openInspector(entity) {
  ensureInspector();
  inspector.entity = entity;
  inspector.open = true;
  inspector.tab = 'overview';
  inspector.el.hidden = false;
  document.getElementById('app').classList.add('inspector-open');
  renderInspector();
}

function closeInspector() {
  if (!inspector.el) return;
  inspector.open = false;
  inspector.entity = null;
  inspector.el.hidden = true;
  document.getElementById('app').classList.remove('inspector-open');
}

function renderInspector() {
  const e = inspector.entity;
  if (!e) return;
  const label = inspectorLabel(e);
  inspector.titleEl.textContent = label.title;
  inspector.subEl.textContent = label.sub;
  inspector.tabsEl.replaceChildren(...INSPECTOR_TABS.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'inspector-tab' + (t === inspector.tab ? ' active' : '');
    b.textContent = t;
    b.addEventListener('click', () => { inspector.tab = t; renderInspector(); });
    return b;
  }));
  inspector.bodyEl.replaceChildren(renderInspectorTab(e, inspector.tab));
}

const INSPECTOR_TABS = ['overview', 'evidence', 'actions', 'related', 'raw'];

function inspectorLabel(e) {
  if (!e) return { title: '—', sub: '' };
  // Prefer the route-supplied label when present.
  if (e.label) return { title: e.label, sub: e.kind || '' };
  if (e.kind === 'task')      return { title: e.data?.title || e.id || 'task', sub: `task · ${e.data?.lane || 'no lane'} · ${e.data?.status || ''}` };
  if (e.kind === 'lane')      return { title: e.id || 'lane', sub: `lane · ${e.data?.reasonCode || ''}` };
  if (e.kind === 'session')   return { title: e.data?.label || e.raw?.label || e.id, sub: `session · ${e.data?.role || e.raw?.role || ''}` };
  if (e.kind === 'claim')     return { title: e.data?.lane || e.id, sub: `claim · ${e.data?.actor || ''}` };
  if (e.kind === 'approval')  return { title: e.data?.tool || e.id, sub: `approval · ${e.data?.lane || ''}` };
  if (e.kind === 'event')     return { title: e.data?.type || e.id, sub: `event · ${e.data?.actor || ''}` };
  if (e.kind === 'sliceStop' || e.kind === 'slice-stop') {
    const s = e.data || e.raw || {};
    return { title: s.summary || e.id, sub: `slice-stop · ${s.actor || ''}` };
  }
  if (e.kind === 'finding')        return { title: e.id || 'finding', sub: 'learning finding' };
  if (e.kind === 'workflow-node')  return { title: e.id || 'node', sub: 'workflow blueprint' };
  return { title: e.id || e.kind || '—', sub: e.kind || '' };
}

function renderInspectorTab(entity, tab) {
  const fn = INSPECTOR_RENDERERS[tab] || INSPECTOR_RENDERERS.raw;
  try { return fn(entity); }
  catch (err) { return placeholder('Inspector error', err.message || String(err)); }
}

// Inspector entity shape — two flavours coexist:
//   Legacy (task/lane/approval/event/sliceStop): { kind, id, data: {...} }
//   New     (finding/slice-stop/workflow-node/session/claim/lane from
//            depth-upgrade routes):
//            { kind, id, label, raw, evidence:[{label,value}], actions:[{label,run}], related:[{kind,id,label}] }
// Each renderer normalizes by preferring top-level explicit arrays/refs
// when present, and falling back to the legacy e.data shape otherwise.

function inspectorPayload(e) {
  // Best-effort merged view: prefer top-level explicit slots, then raw,
  // then data, then the entity itself.
  return e.raw || e.data || e || {};
}

const INSPECTOR_RENDERERS = {
  overview(e) {
    const wrap = el('div', {});
    const d = inspectorPayload(e);

    // 1. Top-level evidence array — used by new routes (Learning, Agents,
    //    Teams, Workflows, Roadmap slice index). This is the curated
    //    overview the route author wanted to show.
    if (Array.isArray(e.evidence) && e.evidence.length) {
      const kv = [];
      for (const it of e.evidence) {
        kv.push(el('dt', {}, it.label || ''));
        kv.push(el('dd', {}, it.value == null ? '—' : String(it.value)));
      }
      wrap.appendChild(el('dl', { class: 'kv' }, kv));
      return wrap;
    }

    // 2. Legacy kind-specific renderers.
    if (e.kind === 'task') {
      wrap.appendChild(el('dl', { class: 'kv' }, [
        el('dt', {}, 'title'),       el('dd', {}, d.title || '—'),
        el('dt', {}, 'lane'),        el('dd', {}, d.lane || '—'),
        el('dt', {}, 'owner'),       el('dd', {}, d.owner || '—'),
        el('dt', {}, 'status'),      el('dd', {}, d.status || '—'),
        el('dt', {}, 'description'), el('dd', {}, d.description || '—')
      ]));
      return wrap;
    }
    if (e.kind === 'lane') {
      wrap.appendChild(el('dl', { class: 'kv' }, [
        el('dt', {}, 'lane'),        el('dd', {}, e.id || '—'),
        el('dt', {}, 'scope'),       el('dd', {}, d.scope || '—'),
        el('dt', {}, 'progress'),    el('dd', {}, `${Math.round((d.progress || 0) * 100)}%`),
        el('dt', {}, 'done / total'),el('dd', {}, `${d.done ?? 0} / ${d.total ?? 0}`),
        el('dt', {}, 'open'),        el('dd', {}, String(d.open ?? 0)),
        el('dt', {}, 'claims held'), el('dd', {}, String(d.claimsHeld ?? 0)),
        el('dt', {}, 'reason'),      el('dd', {}, REASON_CODE_LABEL[d.reasonCode] || d.reasonCode || '—')
      ]));
      return wrap;
    }

    // 3. Generic — walk scalar fields of the payload.
    const kv = [];
    if (e.id) { kv.push(el('dt', {}, 'id')); kv.push(el('dd', {}, String(e.id))); }
    if (e.label && e.label !== e.id) { kv.push(el('dt', {}, 'label')); kv.push(el('dd', {}, String(e.label))); }
    for (const k of Object.keys(d)) {
      const v = d[k];
      if (v && typeof v === 'object') continue; // objects belong in raw
      if (k === 'id' && String(v) === String(e.id)) continue; // dup
      kv.push(el('dt', {}, k));
      kv.push(el('dd', {}, v == null ? '—' : String(v)));
    }
    if (!kv.length) {
      return placeholder('No overview', 'This entity exposed no scalar fields. See the Raw tab for the full payload.');
    }
    wrap.appendChild(el('dl', { class: 'kv' }, kv));
    return wrap;
  },

  evidence(e) {
    // Top-level evidence array wins. Same shape the route author passed.
    if (Array.isArray(e.evidence) && e.evidence.length) {
      const kv = [];
      for (const it of e.evidence) {
        kv.push(el('dt', {}, it.label || ''));
        const v = it.value;
        kv.push(el('dd', {}, v == null ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v))));
      }
      return el('dl', { class: 'kv' }, kv);
    }
    // Legacy: pull timestamps + ids out of the payload.
    const d = inspectorPayload(e);
    const items = [];
    if (d.id || e.id) items.push(['id', d.id || e.id]);
    if (d.ts) items.push(['ts', formatTs(d.ts)]);
    if (d.createdAt) items.push(['createdAt', formatTs(d.createdAt)]);
    if (d.updatedAt) items.push(['updatedAt', formatTs(d.updatedAt)]);
    if (Array.isArray(d.blockedBy) && d.blockedBy.length) items.push(['blockedBy', d.blockedBy.join(', ')]);
    if (Array.isArray(d.activeBlockers) && d.activeBlockers.length) items.push(['activeBlockers', d.activeBlockers.join(', ')]);
    if (!items.length) return placeholder('No evidence', 'No timestamped refs to show for this entity.');
    const kv = [];
    for (const [k, v] of items) { kv.push(el('dt', {}, k)); kv.push(el('dd', {}, String(v))); }
    return el('dl', { class: 'kv' }, kv);
  },

  actions(e) {
    const wrap = el('div', { class: 'inspector-actions' });
    // Top-level actions array — author-supplied {label, run} pairs.
    if (Array.isArray(e.actions) && e.actions.length) {
      for (const a of e.actions) {
        const btn = el('button', { class: 'm-btn', type: 'button' }, a.label || 'Run');
        btn.addEventListener('click', () => {
          try { Promise.resolve(a.run && a.run()).catch((err) => console.error('[inspector action]', err)); }
          catch (err) { console.error('[inspector action]', err); }
          if (a.closeOnRun !== false) closeInspector();
        });
        wrap.appendChild(btn);
      }
      return wrap;
    }
    // Legacy hardcoded jumps.
    if (e.kind === 'task') {
      const b = el('button', { class: 'm-btn', type: 'button' }, 'Open in Tasks');
      b.addEventListener('click', () => { location.hash = `#/tasks?focus=${encodeURIComponent(e.id)}`; closeInspector(); });
      wrap.appendChild(b);
    } else if (e.kind === 'lane') {
      const b = el('button', { class: 'm-btn', type: 'button' }, 'Open Swarm');
      b.addEventListener('click', () => { location.hash = '#/swarm'; closeInspector(); });
      wrap.appendChild(b);
    } else if (e.kind === 'approval') {
      const b = el('button', { class: 'm-btn', type: 'button' }, 'Open Approvals');
      b.addEventListener('click', () => { location.hash = '#/approvals'; closeInspector(); });
      wrap.appendChild(b);
    }
    if (!wrap.children.length) wrap.appendChild(placeholder('No actions', 'No quick actions defined for this entity yet.'));
    return wrap;
  },

  related(e) {
    // Top-level related array — author-supplied {kind, id, label} entries.
    if (Array.isArray(e.related) && e.related.length) {
      const list = el('div', { class: 'inspector-related' });
      for (const r of e.related) {
        const row = el('div', { class: 'inspector-related-row' }, [
          el('span', { class: 'mono panel-aside' }, (r.kind || '').toUpperCase()),
          el('span', {}, r.label || r.id || '—')
        ]);
        list.appendChild(row);
      }
      return list;
    }
    // Legacy task blocker/blocks.
    const d = inspectorPayload(e);
    if (e.kind === 'task') {
      const lines = [];
      if (Array.isArray(d.blockedBy) && d.blockedBy.length) lines.push(['blocked by', d.blockedBy.join(', ')]);
      if (Array.isArray(d.blocks) && d.blocks.length) lines.push(['blocks', d.blocks.join(', ')]);
      if (!lines.length) return placeholder('No relations', 'This task has no blockers or dependents.');
      const kv = [];
      for (const [k, v] of lines) { kv.push(el('dt', {}, k)); kv.push(el('dd', {}, v)); }
      return el('dl', { class: 'kv' }, kv);
    }
    return placeholder('No relations', 'No related entities indexed for this kind yet.');
  },

  raw(e) {
    const pre = el('pre', { class: 'inspector-raw' });
    // Raw shows the full entity (raw + data + top-level slots) so nothing
    // is hidden when the operator drops to this tab.
    pre.textContent = JSON.stringify(e.raw || e.data || e, null, 2);
    return pre;
  }
};

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'conductor';
  // Split on / or ? so #/search?q=foo resolves to "search".
  const id = raw.split(/[/?]/)[0];
  if (!ROUTES[id]) return 'conductor';
  // v1.0.3 — deep-link guard. Framework-only routes redirect to Conductor
  // on consumer installs where their data can't exist.
  if (isRouteHidden(ROUTES[id])) return 'conductor';
  return id;
}

// ─── Phase 1+2 — build the rail dynamically from ROUTES + NAV_GROUPS ──
// v1.0.1 — collapse state. If no persisted entry exists at all (fresh
// operator), we default-collapse every group except the one containing the
// current route so the cockpit fits the viewport. Persisted preferences
// (the user explicitly toggled at least one group) win after that.
function railCollapseRaw() {
  try { return JSON.parse(localStorage.getItem('maddu.railGroups') || 'null'); }
  catch { return null; }
}
function railCollapseState() {
  const raw = railCollapseRaw();
  if (raw && typeof raw === 'object') return raw;
  // No persisted preference — synthesize a default that expands only the
  // group containing the current route (falling back to "decide").
  const activeGroup = groupOf(currentRoute()) || 'decide';
  const s = {};
  for (const g of NAV_GROUPS) if (g.id !== activeGroup) s[g.id] = true;
  return s;
}
function setRailCollapsed(groupId, collapsed) {
  // Materialize the in-memory default before persisting the first edit so
  // we don't lose the auto-collapsed siblings.
  const s = railCollapseState();
  if (collapsed) s[groupId] = true; else delete s[groupId];
  try { localStorage.setItem('maddu.railGroups', JSON.stringify(s)); } catch {}
}

// v1.0.1 — recent-route history (operator-local). Kept short, deduped,
// newest-first. Used to populate the synthetic "Recent" rail group.
function recentRoutes() {
  try {
    const arr = JSON.parse(localStorage.getItem('maddu.routes.recent') || '[]');
    return Array.isArray(arr) ? arr.filter((id) => ROUTES[id]) : [];
  } catch { return []; }
}
function pushRecentRoute(id) {
  if (!id || !ROUTES[id]) return;
  const cur = recentRoutes().filter((r) => r !== id);
  cur.unshift(id);
  while (cur.length > 8) cur.pop();
  try { localStorage.setItem('maddu.routes.recent', JSON.stringify(cur)); } catch {}
}

// ─── Workspace switcher (rail header) ──────────────────────────────────
// Mirrors the registered workspaces from /bridge/_workspaces. In legacy
// single-repo mode (only the synthesized `default` workspace) the slot
// stays hidden — the switcher would have nothing to switch.
let _workspacesCache = null;

async function fetchWorkspaces() {
  try {
    const r = await fetch('/bridge/_workspaces', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── Slice 3 — per-route scope toggle (one workspace vs all) ───────────
// Each toggle-aware renderer asks scopeShouldShow() to decide whether to
// surface the pill (hidden in legacy or single-workspace mode). The
// "all" mode redirects fetches to /bridge/_all/* — the fetch shim already
// injects X-Maddu-Workspace: _all on those URLs so no per-call plumbing
// is needed except for cross-workspace writes (e.g. approval decisions),
// where the caller passes an explicit workspaceId header.
function scopeKey(route) { return `maddu.scope.${route}`; }
function scopeShouldShow() {
  if (!_workspacesCache) return false;
  if (_workspacesCache.legacy) return false;
  return (_workspacesCache.workspaces || []).length >= 2;
}
function getScope(route) {
  if (!scopeShouldShow()) return 'one';
  try { return localStorage.getItem(scopeKey(route)) || 'one'; } catch { return 'one'; }
}
function setScope(route, s) { try { localStorage.setItem(scopeKey(route), s); } catch {} }
function scopedUrl(route, base) {
  return getScope(route) === 'all' ? base.replace('/bridge/', '/bridge/_all/') : base;
}
function scopePill(route, onChange) {
  if (!scopeShouldShow()) return null;
  const cur = getScope(route);
  const pill = el('div', { class: 'scope-pill', role: 'group', 'aria-label': 'Scope' });
  const mkBtn = (val, label) => {
    const active = cur === val;
    const b = el('button', {
      class: 'scope-btn' + (active ? ' active' : ''),
      type: 'button',
      'aria-pressed': active ? 'true' : 'false', // v1.2.2 — a11y + screen-reader state
    }, label);
    b.dataset.scopeValue = val;
    b.addEventListener('click', () => {
      if (getScope(route) === val) return;
      setScope(route, val);
      // v1.2.2 — update the pill's visual + ARIA state in place so the operator
      // sees which option is active. Previously the click changed scope state +
      // refreshed content but never re-applied the `active` class — the pill
      // visually froze on the first-render state.
      for (const sib of pill.querySelectorAll('.scope-btn')) {
        const isNowActive = sib.dataset.scopeValue === val;
        sib.classList.toggle('active', isNowActive);
        sib.setAttribute('aria-pressed', isNowActive ? 'true' : 'false');
      }
      onChange(val);
    });
    return b;
  };
  pill.appendChild(mkBtn('one', 'This workspace'));
  pill.appendChild(mkBtn('all', 'All workspaces'));
  return pill;
}
// workspaceBadge → moved to cockpit-util.js (v1.43.0).

async function renderWorkspaceSwitcher() {
  const host = document.getElementById('rail-workspace');
  if (!host) return;
  const data = await fetchWorkspaces();
  _workspacesCache = data;
  if (!data || !data.workspaces || data.workspaces.length === 0 || data.legacy) {
    // Legacy single-repo mode — hide the slot.
    host.hidden = true;
    host.innerHTML = '';
    currentWorkspace = null;
    return;
  }
  host.hidden = false;
  // Validate persisted selection against the registry.
  if (currentWorkspace && !data.workspaces.find((w) => w.id === currentWorkspace)) {
    currentWorkspace = null;
  }
  if (!currentWorkspace) currentWorkspace = data.active;
  try { localStorage.setItem('maddu.workspace', currentWorkspace); } catch {}

  host.innerHTML = '';
  const label = el('label', { class: 'rail-workspace-label', for: 'rail-workspace-select' }, 'Workspace');
  const select = el('select', { class: 'm-select rail-workspace-select', id: 'rail-workspace-select', 'aria-label': 'Active workspace' });
  for (const w of data.workspaces) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.label || w.id;
    if (w.id === currentWorkspace) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', async () => {
    const id = select.value;
    if (!id || id === currentWorkspace) return;
    currentWorkspace = id;
    try { localStorage.setItem('maddu.workspace', id); } catch {}
    try {
      await fetch('/bridge/_workspaces/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id })
      });
    } catch {}
    // Re-fetch chrome and re-render whatever route is showing.
    await fetchBridgeStatus();
    renderRoute();
    document.dispatchEvent(new CustomEvent('workspace-changed', { detail: { id } }));
  });
  host.appendChild(label);
  host.appendChild(select);
}

function setActiveWorkspace(id) {
  if (!_workspacesCache || !_workspacesCache.workspaces.find((w) => w.id === id)) return;
  const select = document.getElementById('rail-workspace-select');
  if (select && select.value !== id) {
    select.value = id;
    select.dispatchEvent(new Event('change'));
  } else {
    currentWorkspace = id;
    try { localStorage.setItem('maddu.workspace', id); } catch {}
    fetch('/bridge/_workspaces/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id })
    }).catch(() => {});
    fetchBridgeStatus().then(() => renderRoute());
  }
}

function buildRail() {
  const nav = document.querySelector('.rail-nav');
  if (!nav) return;
  nav.innerHTML = '';
  const collapsed = railCollapseState();

  // v1.0.1 — synthetic "Recent" group, rendered above standard groups.
  // Shows up to 5 most-recent routes, excluding the current one. Skipped
  // when the operator has visited fewer than 2 distinct routes.
  const here = currentRoute();
  const recent = recentRoutes().filter((id) => id !== here).slice(0, 5);
  if (recent.length >= 2) {
    const rid = '_recent';
    const isCollapsed = !!collapsed[rid];
    const groupEl = el('div', { class: 'rail-group rail-group-recent' + (isCollapsed ? ' collapsed' : ''), 'data-group': rid });
    const head = el('button', {
      class: 'rail-group-head',
      type: 'button',
      'aria-expanded': isCollapsed ? 'false' : 'true',
      'aria-controls': `rail-group-${rid}`
    }, [
      el('span', { class: 'rail-group-tick', 'aria-hidden': 'true' }),
      el('span', { class: 'rail-group-glyph', 'aria-hidden': 'true' }, '↺'),
      el('span', { class: 'rail-group-label' }, 'RECENT'),
      el('span', { class: 'rail-group-count', 'aria-hidden': 'true' }, String(recent.length)),
      el('span', { class: 'rail-group-chev', 'aria-hidden': 'true' }, '›')
    ]);
    head.addEventListener('click', () => {
      const willCollapse = !groupEl.classList.contains('collapsed');
      groupEl.classList.toggle('collapsed', willCollapse);
      head.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
      setRailCollapsed(rid, willCollapse);
    });
    groupEl.appendChild(head);
    const list = el('div', { class: 'rail-group-list', id: `rail-group-${rid}` });
    for (const id of recent) {
      const r = ROUTES[id];
      if (!r) continue;
      const link = el('a', {
        href: `#/${id}`,
        class: 'rail-link' + (r.anchor ? ' anchor' : ''),
        'data-route': id,
        title: r.description
      }, [
        el('span', { class: 'rail-link-glyph', 'aria-hidden': 'true' }, r.anchor ? '◆' : '◇'),
        el('span', { class: 'rail-link-label' }, r.title)
      ]);
      list.appendChild(link);
    }
    groupEl.appendChild(list);
    nav.appendChild(groupEl);
  }

  for (const g of NAV_GROUPS) {
    const routes = routesInGroup(g.id);
    if (!routes.length) continue;
    const isCollapsed = !!collapsed[g.id];
    const groupEl = el('div', { class: 'rail-group' + (isCollapsed ? ' collapsed' : ''), 'data-group': g.id });
    const head = el('button', {
      class: 'rail-group-head',
      type: 'button',
      'aria-expanded': isCollapsed ? 'false' : 'true',
      'aria-controls': `rail-group-${g.id}`
    }, [
      el('span', { class: 'rail-group-tick', 'aria-hidden': 'true' }),
      el('span', { class: 'rail-group-glyph', 'aria-hidden': 'true' }, g.glyph),
      el('span', { class: 'rail-group-label' }, g.label.toUpperCase()),
      el('span', { class: 'rail-group-count', 'aria-hidden': 'true' }, String(routes.length)),
      el('span', { class: 'rail-group-chev', 'aria-hidden': 'true' }, '›')
    ]);
    head.addEventListener('click', () => {
      const willCollapse = !groupEl.classList.contains('collapsed');
      groupEl.classList.toggle('collapsed', willCollapse);
      head.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
      setRailCollapsed(g.id, willCollapse);
    });
    groupEl.appendChild(head);
    const list = el('div', { class: 'rail-group-list', id: `rail-group-${g.id}` });
    for (const r of routes) {
      const link = el('a', {
        href: `#/${r.id}`,
        class: 'rail-link' + (r.anchor ? ' anchor' : ''),
        'data-route': r.id,
        title: r.description
      }, [
        el('span', { class: 'rail-link-glyph', 'aria-hidden': 'true' }, r.anchor ? '◆' : '◇'),
        el('span', { class: 'rail-link-label' }, r.title)
      ]);
      if (r.id === 'approvals') link.appendChild(el('span', { class: 'rail-link-badge', id: 'approvals-badge', hidden: '' }, '0'));
      if (r.id === 'mailbox')   link.appendChild(el('span', { class: 'rail-link-badge', id: 'mailbox-badge',   hidden: '' }, '0'));
      if (r.id === 'tasks')     link.appendChild(el('span', { class: 'rail-link-badge', id: 'tasks-badge',     hidden: '' }, '0'));
      list.appendChild(link);
    }
    groupEl.appendChild(list);
    nav.appendChild(groupEl);
  }
}

// v1.0.1 — auto-expand the active group when nav lands in a collapsed
// section (e.g. operator dispatched via palette / deep link).
function ensureActiveGroupExpanded(routeId) {
  const gid = groupOf(routeId);
  if (!gid) return;
  const groupEl = document.querySelector(`.rail-group[data-group="${gid}"]`);
  if (!groupEl || !groupEl.classList.contains('collapsed')) return;
  groupEl.classList.remove('collapsed');
  const head = groupEl.querySelector('.rail-group-head');
  if (head) head.setAttribute('aria-expanded', 'true');
  setRailCollapsed(gid, false);
}

// ─── Phase 2 — mobile dock + group sheet ────────────────────────────────
function buildDock() {
  const dock = document.getElementById('dock');
  if (!dock) return;
  dock.innerHTML = '';
  for (const g of NAV_GROUPS) {
    const routes = routesInGroup(g.id);
    if (!routes.length) continue;
    const btn = el('button', {
      class: 'dock-btn',
      type: 'button',
      'data-group': g.id,
      'aria-label': `${g.label} — ${g.summary}`
    }, [
      el('span', { class: 'dock-btn-glyph', 'aria-hidden': 'true' }, g.glyph),
      el('span', { class: 'dock-btn-label' }, g.label)
    ]);
    btn.addEventListener('click', () => openDockSheet(g.id));
    dock.appendChild(btn);
  }
}

function openDockSheet(groupId) {
  const g = NAV_GROUPS.find((x) => x.id === groupId);
  if (!g) return;
  const sheet = document.getElementById('dock-sheet');
  const body  = document.getElementById('dock-sheet-body');
  document.getElementById('dock-sheet-title').textContent = g.label;
  document.getElementById('dock-sheet-summary').textContent = g.summary;
  document.getElementById('dock-sheet-glyph').textContent = g.glyph;
  body.innerHTML = '';
  for (const r of routesInGroup(groupId)) {
    const link = el('a', {
      href: `#/${r.id}`,
      class: 'dock-sheet-link' + (r.anchor ? ' anchor' : '')
    }, [
      el('span', { class: 'dock-sheet-link-glyph', 'aria-hidden': 'true' }, r.anchor ? '◆' : '◇'),
      el('div', { class: 'dock-sheet-link-text' }, [
        el('div', { class: 'dock-sheet-link-title' }, r.title),
        el('div', { class: 'dock-sheet-link-desc' }, r.description)
      ])
    ]);
    link.addEventListener('click', () => { closeDockSheet(); });
    body.appendChild(link);
  }
  sheet.hidden = false;
  // Force layout then animate in
  requestAnimationFrame(() => sheet.classList.add('open'));
}
function closeDockSheet() {
  const sheet = document.getElementById('dock-sheet');
  if (!sheet) return;
  sheet.classList.remove('open');
  setTimeout(() => { sheet.hidden = true; }, 200);
}
function initDock() {
  document.getElementById('dock-sheet-scrim')?.addEventListener('click', closeDockSheet);
  document.getElementById('dock-sheet-close')?.addEventListener('click', closeDockSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDockSheet();
  });
}

function highlightActiveGroup(routeId) {
  const g = groupOf(routeId);
  document.querySelectorAll('.rail-group').forEach((el) => {
    el.classList.toggle('has-active', el.dataset.group === g);
  });
  document.querySelectorAll('.dock-btn').forEach((el) => {
    el.classList.toggle('active', el.dataset.group === g);
  });
}

// Dependency-injection seam for extracted view modules. cockpit.js is the
// composition root: it owns the stateful shell helpers and hands them to view
// renderers via this ctx so views import only leaves + receive ctx, never
// reaching back into cockpit.js (which would be a circular import). Grows as
// more view clusters are extracted. (bindRouteRefresh is a hoisted declaration.)
const ctx = {
  bindRefresh: bindRouteRefresh,
  panelFocus,
  openInspector,
  fetchLanes,
  fetchProjection,
  paletteFocus,
  focusPanelByKeyword,
  scopePill,
  scopedUrl,
  // Narrow "re-render the current route" alias — scope-toggling views call this
  // instead of holding a handle to the whole router. Wrapper form late-binds
  // through the closure so it's safe even if renderRoute is ever reassigned.
  rerender: () => renderRoute(),
};

function renderRoute() {
  const id = currentRoute();
  const route = ROUTES[id];

  // v1.0.1 — operator-local history feeds the rail's "Recent" group.
  // Only rebuild the rail when the visit actually changes the visible
  // recent list (avoids per-navigation flicker for repeats).
  const prevRecent = recentRoutes()[0];
  pushRecentRoute(id);
  // v1.0.1 — if the operator dispatched into a collapsed group (palette
  // / deep link), auto-expand it so the active row is visible.
  ensureActiveGroupExpanded(id);
  if (prevRecent !== id) buildRail();

  document.querySelectorAll('.rail-link').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === id);
  });
  highlightActiveGroup(id);

  // Tell the previous view to tear down its stream subscriptions.
  els.view.dispatchEvent(new Event('routechange'));

  els.title.textContent = route.title.toUpperCase();
  els.meta.textContent = id.toUpperCase();
  els.view.innerHTML = '';
  els.view.classList.remove('fade-in');
  els.view.appendChild(route.render(ctx));
  // Re-trigger entrance animation on every route change.
  void els.view.offsetWidth;
  els.view.classList.add('fade-in');
  els.app.removeAttribute('aria-busy');
}

/* ─────────────── views ─────────────── */

// el / panel / placeholder → moved to cockpit-util.js (v1.24.0).

// ─── Sub-target system (programmatic) ───────────────────────────────────
// Runtime registry — every searchable sub-target the cockpit knows about.
// Static manifest entries land here at boot; DOM-discovered ones land here
// when a route renders. Keyed `<route>:<id>` to allow same-id reuse across
// routes.
const SUB_REGISTRY = new Map();

function registerSubTarget(entry) {
  const key = `${entry.route}:${entry.id}`;
  // Static manifest entries beat DOM-discovered ones (they have curated
  // titles/descriptions).
  const existing = SUB_REGISTRY.get(key);
  if (existing && existing.source === 'manifest' && entry.source !== 'manifest') return;
  SUB_REGISTRY.set(key, entry);
}

// panelFocus(): drop-in replacement for panel() that stamps data-focus and
// self-registers the sub-target. Use this whenever a panel should be
// reachable from the command palette.
function panelFocus(title, aside, body, opts) {
  opts = opts || {};
  const id = opts.id || String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const node = panel(title, aside, body);
  const tokens = `${id} ${opts.keywords || ''}`.trim();
  node.setAttribute('data-focus', tokens);
  // Discovery on render — populate the registry as soon as the route runs
  // so subsequent palette searches see it.
  const route = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]) || 'conductor';
  registerSubTarget({
    source: 'render',
    id,
    route,
    title,
    description: opts.description || (typeof aside === 'string' ? aside : ''),
    keywords: opts.keywords || '',
    group: ROUTES[route] && ROUTES[route].group
  });
  return node;
}

// Static manifest — declared once, indexable before any route has rendered.
// Use this for sub-targets the operator might search for from a cold cockpit
// (i.e. before they've visited the host route).
const SUB_TARGET_MANIFEST = {
  conductor: [
    { id: 'board',      title: 'Now · Next · Waiting · Done', description: 'Kanban board of work in flight.',     keywords: 'board kanban now next waiting done flight work' },
    { id: 'queue',      title: 'Queue card',                   description: 'Scheduler / Queue / Dispatch / Preflights summary card.', keywords: 'queue scheduler dispatch preflight parked' },
    { id: 'score',      title: 'Score matrix',                 description: 'Per-lane progress and reason codes.', keywords: 'score matrix per-lane progress reason claims' },
    { id: 'last-slice', title: 'Last slice-stop',              description: 'Most recent ritual close.',            keywords: 'last slice-stop recent ritual learning' }
  ],
  roadmap: [
    { id: 'kpis',         title: 'Roadmap KPIs',         description: 'Total slice-stops, last 24h/7d, lanes touched, age.', keywords: 'kpi roadmap total recent age metric' },
    { id: 'cadence',      title: 'Closure cadence',      description: '28-day bar chart of slice-stop frequency.',           keywords: 'cadence closure 28-day bar chart' },
    { id: 'mix',          title: 'Lane mix',             description: 'Slice-stops per lane, ranked.',                       keywords: 'mix lanes distribution per-lane' },
    { id: 'slice-index',  title: 'Slice index',          description: 'Every slice-stop, click to open in Inspector.',       keywords: 'slice index history ledger every-stop' },
    { id: 'plan',         title: 'Slice plan',           description: 'The approved depth-upgrade plan (α–ε).',              keywords: 'plan alpha beta gamma delta epsilon zeta eta versions' }
  ],
  approvals: [
    { id: 'open-queue', title: 'Open queue',           description: 'Pending tool / subprocess approvals.',     keywords: 'open queue pending awaiting decision' },
    { id: 'ledger',     title: 'Decision ledger',      description: 'APPROVAL_DECIDED events.',                  keywords: 'ledger decided audit history' },
    { id: 'policies',   title: 'Standing policies',    description: 'Allow-always / deny rules.',                keywords: 'standing policies allow-always allow-once deny rules' }
  ],
  operations: [
    { id: 'activity',     title: 'Activity',           description: 'Slice-stops + memory facts (last 7 days).', keywords: 'activity slice-stops memory facts 7-day timeline' },
    { id: 'slice-ledger', title: 'Slice ledger',       description: 'SLICE_STOP events from the projection.',    keywords: 'slice ledger events history' },
    { id: 'hindsight',    title: 'Hindsight memory',   description: 'Facts derived from slice-stops.',           keywords: 'hindsight memory facts learnings extraction' },
    { id: 'checkpoints',  title: 'Checkpoints',        description: 'Git tags at maddu/checkpoint/<id>.',        keywords: 'checkpoints git tags rollback restore' }
  ],
  settings: [
    { id: 'telegram',  title: 'Telegram',  description: 'Long-poll bot bridge · allowlisted · off by default · message bodies route via Telegram.',     keywords: 'telegram tg messenger chat phone notification mobile bot integrations' },
    { id: 'discord',   title: 'Discord',   description: 'Outbound-only REST (no gateway) · channel allowlist · @everyone blocked.',                      keywords: 'discord channel server guild bot integrations notifications' },
    { id: 'email',     title: 'Email',     description: 'Outbound-only SMTP · TLS required (port 465/587) · recipient allowlist · no IMAP.',             keywords: 'email smtp mail gmail outlook fastmail notifications outbound webhook imap' },
    { id: 'bridge',    title: 'Bridge',    description: 'HTTP server status, port, repo path, uptime.',                                                  keywords: 'bridge http server port host status' },
    { id: 'lanes',     title: 'Lanes',     description: 'Lane catalog & policies — zones, lease, handoff.',                                              keywords: 'lanes zones lease handoff policy catalog' },
    { id: 'providers', title: 'Providers', description: 'API key store summary — full management in /auth.',                                             keywords: 'providers anthropic openai api keys credentials' },
    { id: 'mcp',       title: 'MCP',       description: 'Bridge-owned MCP server registry.',                                                             keywords: 'mcp model-context-protocol servers tools' },
    { id: 'runtimes',  title: 'Runtimes',  description: 'Pluggable subprocess workers — Claude Code, Codex, Hermes.',                                    keywords: 'runtimes workers claude codex hermes spawn' },
    { id: 'paths',     title: 'Storage',   description: 'Resolved paths for repo, state dir, cockpit dir.',                                              keywords: 'storage paths repo state cockpit directory' },
    { id: 'hardrules', title: 'Hard rules', description: 'Files-only · no SQLite · no hosted backends · no broad deps · no SDK in app · no token export.', keywords: 'hard rules invariants compliance security boundary' }
  ]
};

// Phase B — data-driven sub-targets. Fetches /bridge/{auth,mcp,runtimes}
// and registers one sub-target per row. Called at boot and before each
// palette open so freshly-added providers/servers/runtimes are searchable
// immediately. The id matches the row's data-focus token so per-row
// scroll-flash works once renderAuth/renderMcp/renderRuntimes stamp them.
async function refreshDataSubTargets() {
  // Drop previously-discovered dynamic entries so removals stick.
  for (const [k, v] of SUB_REGISTRY.entries()) {
    if (v.source === 'data') SUB_REGISTRY.delete(k);
  }
  try {
    const r = await fetch('/bridge/auth', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      for (const p of (d.providers || [])) {
        registerSubTarget({
          source: 'data', route: 'auth', id: p.provider,
          title: p.provider.charAt(0).toUpperCase() + p.provider.slice(1),
          description: `API key store · ${p.keyCount} key${p.keyCount === 1 ? '' : 's'}${p.activeKeyTail ? ` · active ****${p.activeKeyTail}` : ''}`,
          keywords: `${p.provider} api key tokens credentials oauth`,
          group: 'connect'
        });
      }
    }
  } catch {}
  try {
    const r = await fetch('/bridge/mcp', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      for (const m of (d.mcp || [])) {
        registerSubTarget({
          source: 'data', route: 'mcp', id: m.id || m.name,
          title: m.name || m.id,
          description: `${m.transport || 'mcp'} transport${m.enabled ? '' : ' · disabled'}`,
          keywords: `${m.name || ''} ${m.id || ''} ${m.transport || ''} mcp server tool`.trim(),
          group: 'connect'
        });
      }
    }
  } catch {}
  try {
    const r = await fetch('/bridge/runtimes', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      for (const rt of (d.runtimes || [])) {
        registerSubTarget({
          source: 'data', route: 'runtimes', id: rt.id || rt.name,
          title: rt.name || rt.id,
          description: rt.detected ? 'detected · ready to spawn' : 'registered · not yet detected',
          keywords: `${rt.name || ''} ${rt.id || ''} ${rt.kind || ''} runtime worker`.trim(),
          group: 'connect'
        });
      }
    }
  } catch {}
  // Phase D — Agents / Teams / Skills from the projection.
  try {
    const r = await fetch('/bridge/projection', { cache: 'no-store' });
    if (r.ok) {
      const proj = await r.json();
      for (const s of (proj.activeSessions || [])) {
        registerSubTarget({
          source: 'data', route: 'agents', id: s.id,
          title: s.label || s.id,
          description: `${s.role || 'agent'} · ${s.focus || '(no focus)'}`,
          keywords: `${s.id} ${s.label || ''} ${s.role || ''} ${s.focus || ''}`.toLowerCase(),
          group: 'operate'
        });
      }
      // Lanes for Teams — read from catalog if available, fall back to
      // unique lanes seen in claims/slices.
      const lanesSeen = new Set();
      for (const c of (proj.claims || [])) if (c.lane) lanesSeen.add(c.lane);
      for (const s of (proj.sliceStops || [])) if (s.lane) lanesSeen.add(s.lane);
      for (const lane of lanesSeen) {
        registerSubTarget({
          source: 'data', route: 'teams', id: lane,
          title: lane,
          description: `Lane · ownership and recent activity.`,
          keywords: `${lane} lane team ownership`,
          group: 'operate'
        });
      }
    }
  } catch {}
  try {
    const r = await fetch('/bridge/tasks', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      for (const t of (d.tasks || [])) {
        if (t.status === 'done' || t.status === 'cancelled') continue;
        registerSubTarget({
          source: 'data', route: 'tasks', id: t.id,
          title: t.title,
          description: `${t.status}${t.lane ? ' · lane ' + t.lane : ''}${t.activeBlockers && t.activeBlockers.length ? ' · blocked' : ''}`,
          keywords: `${t.id} ${t.title} ${t.lane || ''} ${t.status} task`.toLowerCase(),
          group: 'decide'
        });
      }
    }
  } catch {}
  try {
    const r = await fetch('/bridge/skills', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      for (const sk of (d.skills || [])) {
        registerSubTarget({
          source: 'data', route: 'skills', id: sk.id || sk.name,
          title: sk.name || sk.id,
          description: sk.summary || sk.description || 'Reusable recipe from slice-stops.',
          keywords: `${sk.name || ''} ${sk.id || ''} skill recipe ${sk.tags ? sk.tags.join(' ') : ''}`.trim(),
          group: 'reference'
        });
      }
    }
  } catch {}
}

// ─── Action palette entries ─────────────────────────────────────────────
// Verbs the cockpit can do, exposed as palette results so the operator
// types the intent instead of hunting for the route. Shown as a second
// tier behind a divider; commit invokes run() directly. Use sparingly —
// only actions where the right path is unambiguous and a confirmation
// isn't necessary.
const ACTIONS = [
  {
    id: 'wiki-rebuild',
    title: 'Rebuild wiki from spine',
    description: 'POST /bridge/wiki/rebuild — replays every SLICE_STOP into .maddu/wiki/.',
    keywords: 'wiki rebuild regenerate sync drift refresh',
    group: 'verify',
    run: async () => {
      try {
        const r = await fetch('/bridge/wiki/rebuild', { method: 'POST' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (typeof showToast === 'function') showToast(`Wiki rebuilt · ${j.pagesWritten} page(s)`, 'ok');
      } catch (e) { if (typeof showToast === 'function') showToast(`Rebuild failed: ${e.message}`, 'err'); }
    }
  },
  {
    id: 'memory-extract',
    title: 'Re-extract hindsight memory',
    description: 'POST /bridge/memory/extract — replays SLICE_STOPs into memory.ndjson (idempotent).',
    keywords: 'memory hindsight extract re-extract refresh facts learnings',
    group: 'verify',
    run: async () => {
      try {
        const r = await fetch('/bridge/memory/extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (typeof showToast === 'function') showToast(`+${j.added} fact(s)`, 'ok');
      } catch (e) { if (typeof showToast === 'function') showToast(`Extract failed: ${e.message}`, 'err'); }
    }
  },
  {
    id: 'memory-rebuild',
    title: 'Rebuild memory from scratch',
    description: 'POST /bridge/memory/extract with rebuild=true — truncates memory.ndjson then replays.',
    keywords: 'memory rebuild reset truncate fresh',
    group: 'verify',
    run: async () => {
      if (!confirm('Rebuild memory.ndjson from the spine? This truncates the file then replays every SLICE_STOP.')) return;
      try {
        const r = await fetch('/bridge/memory/extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rebuild: true }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (typeof showToast === 'function') showToast(`Memory rebuilt · ${j.facts} facts`, 'ok');
      } catch (e) { if (typeof showToast === 'function') showToast(`Rebuild failed: ${e.message}`, 'err'); }
    }
  },
  {
    id: 'stream-pause',
    title: 'Pause / resume event stream',
    description: 'Toggle the long-poll loop. Useful when reading a noisy stream on /events.',
    keywords: 'stream pause resume events live freeze',
    group: 'verify',
    run: () => {
      stream.paused = !stream.paused;
      if (typeof showToast === 'function') showToast(stream.paused ? 'Stream paused' : 'Stream resumed', 'ok');
    }
  },
  {
    id: 'inspector-close',
    title: 'Close Inspector',
    description: 'Dismiss the right-side detail panel if it’s open.',
    keywords: 'inspector close hide dismiss panel detail',
    group: 'operate',
    run: () => { if (typeof closeInspector === 'function') closeInspector(); }
  },
  {
    id: 'open-hard-rules',
    title: 'Open hard rules',
    description: 'Jump to docs/hard-rules.md — the eight invariants.',
    keywords: 'hard rules invariants compliance files-only sqlite hosted deps sdk token brand lane',
    group: 'reference',
    run: () => { location.hash = '#/docs?p=hard-rules'; }
  },
  {
    id: 'telegram-test',
    title: 'Open Telegram test sender',
    description: 'Settings → Telegram bridge (must be enabled with an allowlisted chat to send).',
    keywords: 'telegram test send try ping',
    group: 'connect',
    run: () => { location.hash = '#/settings?focus=telegram'; }
  },
  {
    id: 'discord-test',
    title: 'Open Discord test sender',
    description: 'Settings → Discord bridge (must be enabled with an allowlisted channel to send).',
    keywords: 'discord test send try ping',
    group: 'connect',
    run: () => { location.hash = '#/settings?focus=discord'; }
  },
  {
    id: 'email-test',
    title: 'Open email test sender',
    description: 'Settings → Email bridge (must be enabled with an allowlisted recipient to send).',
    keywords: 'email test send try ping smtp mail',
    group: 'connect',
    run: () => { location.hash = '#/settings?focus=email'; }
  },
  {
    id: 'roadmap-open',
    title: 'Open Roadmap → KPIs',
    description: 'Jump to Roadmap and focus the KPI strip.',
    keywords: 'roadmap kpi metric',
    group: 'reference',
    run: () => { location.hash = '#/roadmap?focus=kpis'; }
  },
  {
    id: 'first-slice-tour',
    title: 'Open the five-minute tour',
    description: 'First-time walkthrough: register a session, claim a lane, make a slice-stop, watch the lime line fire.',
    keywords: 'tour onboarding first slice walkthrough getting started new install help',
    group: 'reference',
    run: () => { location.hash = '#/docs?p=18-first-slice'; }
  },
  {
    id: 'reload-cockpit',
    title: 'Reload cockpit',
    description: 'Hard refresh the cockpit page (Ctrl+Shift+R equivalent).',
    keywords: 'reload refresh hard reset cockpit page',
    group: 'reference',
    run: () => { location.reload(); }
  }
];

function actionItems(query) {
  const q = (query || '').toLowerCase().trim();
  const out = [];
  for (const a of ACTIONS) {
    const titleLc = a.title.toLowerCase();
    const kwLc = (a.keywords || '').toLowerCase();
    const descLc = (a.description || '').toLowerCase();
    const hay = `${titleLc} ${kwLc} ${descLc} ${a.id}`;
    if (!q || hay.includes(q)) {
      let score;
      if (!q)                            score = 6; // bottom of empty palette
      else if (titleLc.startsWith(q))    score = 0;
      else if (titleLc.includes(q))      score = 1;
      else if (kwLc.includes(q))         score = 2;
      else                               score = 5;
      // Bias action results slightly below routes/sub-targets when the
      // user is searching for a destination, but let strong matches win.
      out.push({
        kind: 'action', id: a.id,
        title: a.title, group: a.group, desc: a.description,
        run: a.run, score: score + 0.5
      });
    }
  }
  out.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
  return out;
}

function loadManifest() {
  for (const [route, entries] of Object.entries(SUB_TARGET_MANIFEST)) {
    for (const e of entries) {
      registerSubTarget({
        source: 'manifest', route,
        id: e.id, title: e.title, description: e.description, keywords: e.keywords,
        group: ROUTES[route] && ROUTES[route].group
      });
    }
  }
}

function allSubTargets() {
  return Array.from(SUB_REGISTRY.values());
}
// errorState → moved to cockpit-util.js (v1.43.0).

// ─── Widget kit → moved to ./cockpit-widgets.js (v1.35.0). statusGrid / bar /
// segBar / donut / sparkline / meter / binByTime are imported above.

// ─── Workbench (Phase D1) ────────────────────────────────────────────────

function renderWorkbench() {
  const root = el('div', { class: 'view' });
  // workbench takes the full stage body — no title chrome
  root.style.maxWidth = 'none';
  root.appendChild(el('p', { style: 'margin:0 0 12px;' }, ROUTES.workbench.description));

  // 3-pane shell
  const left = el('div', { class: 'wb-pane' });
  const center = el('div', { class: 'wb-pane', style: 'min-width:0;' });
  const right = el('div', { class: 'wb-pane' });
  const shell = el('div', { class: 'wb' }, [left, center, right]);
  root.appendChild(shell);

  // Selection state — survives within the route's lifetime
  let selectedLane = null;           // null = ALL
  let activeTab = 'stream';          // 'stream' | 'slices' | 'approvals' | 'memory'

  // ─── left pane: lanes + sessions ────────────────────────────────────
  left.appendChild(el('div', { class: 'wb-pane-head' }, [
    el('span', { class: 'wb-pane-title' }, 'Lanes'),
    el('span', {}, [
      (() => {
        const all = document.createElement('span');
        all.textContent = 'all';
        all.style.cssText = 'cursor:pointer;color:var(--m-fg-2);font-family:var(--m-font-mono);';
        all.addEventListener('click', () => { selectedLane = null; refreshAll(); });
        return all;
      })()
    ])
  ]));
  const laneList = el('div', { class: 'wb-pane-body' });
  laneList.appendChild(loading('Fetching lanes…'));
  left.appendChild(laneList);

  function renderLanes(catalog, claims, eventsByLane) {
    laneList.innerHTML = '';
    if (!catalog) { laneList.appendChild(el('div', { class: 'wb-empty' }, 'Loading…')); return; }
    const claimMap = new Map((claims || []).map((c) => [c.lane, c]));
    // "ALL" pseudo-row
    const allRow = el('div', { class: 'wb-list-row' + (selectedLane === null ? ' active' : '') }, [
      el('span', { class: 'wb-list-name' }, '— all lanes —'),
      el('span', { class: 'wb-list-count' }, '*')
    ]);
    allRow.addEventListener('click', () => { selectedLane = null; refreshAll(); });
    laneList.appendChild(allRow);
    for (const l of catalog.lanes) {
      const claimed = claimMap.has(l.id);
      const eventCount = (eventsByLane && eventsByLane[l.id]) || 0;
      const row = el('div', { class: 'wb-list-row' + (selectedLane === l.id ? ' active' : '') }, [
        el('span', { class: 'wb-list-name' }, l.id),
        el('span', { class: 'wb-list-count' + (claimed || eventCount > 0 ? ' live' : '') }, claimed ? '★' : String(eventCount))
      ]);
      row.addEventListener('click', () => { selectedLane = l.id; refreshAll(); });
      laneList.appendChild(row);
    }
  }

  // sessions section, appended below lanes
  const sessHeader = el('div', { class: 'wb-pane-head', style: 'border-top:1px solid var(--m-line);' }, [
    el('span', { class: 'wb-pane-title' }, 'Active sessions'),
    el('span', { class: 'wb-list-count', id: 'wb-sess-count' }, '0')
  ]);
  const sessList = el('div', { class: 'wb-pane-body', style: 'max-height:200px;flex:none;' });
  sessList.appendChild(loading('Fetching sessions…'));
  left.appendChild(sessHeader);
  left.appendChild(sessList);

  function renderSessions(sessions) {
    sessList.innerHTML = '';
    const active = (sessions || []).filter((s) => s.status === 'active');
    document.getElementById('wb-sess-count').textContent = String(active.length);
    if (active.length === 0) { sessList.appendChild(el('div', { class: 'wb-empty' }, '(none)')); return; }
    for (const s of active) {
      sessList.appendChild(el('div', { class: 'wb-list-row' }, [
        el('span', { class: 'wb-list-name' }, [
          el('div', { style: 'color:var(--m-fg-0);' }, s.id.slice(-14)),
          el('div', { style: 'color:var(--m-fg-3);font-size:10px;' }, `${s.role || '—'} · ${s.label || ''}`)
        ]),
        el('span', { class: 'wb-list-count' }, '●')
      ]));
    }
  }

  // ─── center pane: tabs + filtered content ───────────────────────────
  const tabs = el('div', { class: 'wb-tabs' });
  const tabIds = [
    { id: 'stream',    label: 'Stream' },
    { id: 'slices',    label: 'Slices' },
    { id: 'approvals', label: 'Approvals' },
    { id: 'memory',    label: 'Memory' }
  ];
  const tabCounts = { stream: 0, slices: 0, approvals: 0, memory: 0 };
  const tabEls = {};
  for (const t of tabIds) {
    const tEl = el('div', { class: 'wb-tab' }, [
      t.label,
      el('span', { class: 'wb-tab-count', id: `wb-tab-count-${t.id}` }, '0')
    ]);
    tEl.addEventListener('click', () => { activeTab = t.id; updateTabs(); refreshCenter(); });
    tabEls[t.id] = tEl;
    tabs.appendChild(tEl);
  }
  function updateTabs() {
    for (const t of tabIds) {
      tabEls[t.id].classList.toggle('active', t.id === activeTab);
      // The first refreshAll() runs before this view is attached to #route-view,
      // so the count span isn't reachable by id yet — guard it (counts get set on
      // the post-attach refresh). Was an uncaught throw that aborted first-paint.
      const countEl = document.getElementById(`wb-tab-count-${t.id}`);
      if (countEl) countEl.textContent = String(tabCounts[t.id] || 0);
    }
  }
  const centerBody = el('div', { class: 'wb-center-body' });
  center.appendChild(tabs);
  center.appendChild(centerBody);

  // ─── right pane: status panel ───────────────────────────────────────
  right.appendChild(el('div', { class: 'wb-pane-head' }, [
    el('span', { class: 'wb-pane-title' }, 'Status'),
    el('span', { id: 'wb-status-version' }, '')
  ]));
  const statusBody = el('div', { style: 'overflow:auto;flex:1;' });
  statusBody.appendChild(loading('Fetching status…'));
  right.appendChild(statusBody);

  function renderStatus(s) {
    statusBody.innerHTML = '';
    const c = (s && s.counts) || {};
    const rows = [
      ['Events',         c.events,         null],
      ['Active sessions', c.activeSessions, c.activeSessions > 0 ? 'live' : null],
      ['Lane claims',    c.claims,         c.claims > 0 ? 'live' : null],
      ['Open approvals', c.openApprovals,  c.openApprovals > 0 ? 'warn' : null],
      ['Mailbox unread', c.unreadMail,     c.unreadMail > 0 ? 'warn' : null],
      ['Open tasks',     c.openTasks,      null],
      ['Schedules',      c.enabledSchedules, null],
      ['Workers running', c.runningWorkers, c.runningWorkers > 0 ? 'live' : null],
      ['Stuck workers',  c.stuckWorkers,   c.stuckWorkers > 0 ? 'warn' : null],
      ['Skills',         c.skills,         null],
      ['Memory facts',   c.memoryFacts,    null],
      ['Checkpoints',    c.checkpoints,    null],
      ['Runtimes',       c.runtimes,       null],
      ['MCP servers',    c.mcpEnabled != null ? `${c.mcpEnabled}/${c.mcp}` : '—', null],
      ['Auth providers', c.authProviders,  null]
    ];
    for (const [label, value, cls] of rows) {
      if (value == null) continue;
      statusBody.appendChild(el('div', { class: 'wb-stat-row' }, [
        el('span', { class: 'wb-stat-label' }, label),
        el('span', { class: 'wb-stat-value' + (cls ? ' ' + cls : '') }, String(value))
      ]));
    }
    const v = document.getElementById('wb-status-version');
    if (v && s) v.textContent = `v${s.version || ''}  ${formatUptime(s.uptimeMs)}`;
  }

  // ─── data refresh fan-out ────────────────────────────────────────────
  async function refreshAll() {
    updateTabs();
    const [lanes, proj, status] = await Promise.all([fetchLanes(), fetchProjection(), fetchBridgeStatus().then(() => bridgeStatus)]);
    // Build eventsByLane from projection's slice-stops (a crude usage indicator)
    const eventsByLane = {};
    if (proj && proj.sliceStops) for (const s of proj.sliceStops) if (s.lane) eventsByLane[s.lane] = (eventsByLane[s.lane] || 0) + 1;
    renderLanes(lanes ? lanes.catalog : null, lanes ? lanes.claims : [], eventsByLane);
    renderSessions(proj ? proj.sessions : []);
    renderStatus(status);
    // tab counts come from projection
    if (proj) {
      tabCounts.slices = proj.sliceStops.length;
      tabCounts.approvals = proj.approvals.open.length;
    }
    refreshCenter();
  }

  // ─── center renderers per tab ───────────────────────────────────────
  async function refreshCenter() {
    centerBody.innerHTML = '';
    if (activeTab === 'stream') {
      // Pull last 50 events filtered by selectedLane
      const r = await fetchJsonSafe('/bridge/events/poll');
      if (!r) { centerBody.appendChild(el('div', { class: 'wb-empty' }, 'Offline')); return; }
      let events = (r.events || []).slice();
      if (selectedLane) events = events.filter((e) => e.lane === selectedLane);
      tabCounts.stream = events.length;
      updateTabs();
      if (events.length === 0) {
        centerBody.appendChild(el('div', { class: 'wb-empty' }, selectedLane ? `(no events for lane "${selectedLane}")` : '(no events yet)'));
        return;
      }
      for (const ev of events.slice(-200).reverse()) centerBody.appendChild(eventRow(ev, false));
    } else if (activeTab === 'slices') {
      const proj = await fetchProjection();
      let slices = (proj && proj.sliceStops) || [];
      if (selectedLane) slices = slices.filter((s) => s.lane === selectedLane);
      tabCounts.slices = slices.length;
      updateTabs();
      if (slices.length === 0) {
        centerBody.appendChild(el('div', { class: 'wb-empty' }, selectedLane ? `(no slice-stops for lane "${selectedLane}")` : '(no slice-stops yet)'));
        return;
      }
      for (const s of slices.slice().reverse()) {
        centerBody.appendChild(el('div', { class: 'panel', style: 'background:var(--m-bg-2);' }, [
          el('div', { class: 'panel-head' }, [
            el('span', { class: 'panel-title' }, `[${s.lane || '—'}]  ${s.summary}`),
            el('span', { class: 'panel-aside' }, s.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z'))
          ]),
          s.next && s.next.length ? el('div', { class: 'view' }, [
            el('div', { class: 'panel-title' }, 'NEXT'),
            el('ul', { class: 'hard-rules' }, s.next.map((n) => el('li', {}, n)))
          ]) : null
        ]));
      }
    } else if (activeTab === 'approvals') {
      const a = await fetchApprovals();
      let open = (a && a.open) || [];
      if (selectedLane) open = open.filter((x) => x.lane === selectedLane);
      tabCounts.approvals = open.length;
      updateTabs();
      if (open.length === 0) {
        centerBody.appendChild(el('div', { class: 'wb-empty' }, selectedLane ? `(no approvals for lane "${selectedLane}")` : '(no pending approvals)'));
        return;
      }
      for (const ap of open) {
        const card = el('div', { class: 'approval' }, [
          el('div', { class: 'approval-body' }, [
            el('div', { class: 'approval-tool' }, ap.tool),
            el('div', { class: 'approval-meta' }, `lane:${ap.lane || '—'} · asked by:${ap.actor || 'anon'}`),
            ap.action ? el('div', { class: 'approval-action' }, ap.action) : null,
            ap.summary ? el('div', { class: 'approval-summary' }, ap.summary) : null
          ]),
          el('div', { class: 'approval-actions' }, [
            makeDecisionButton('allow-once',   'Allow once',   'btn-allow',     ap.approvalId, refreshAll),
            makeDecisionButton('allow-always', 'Allow always', 'btn-allow',     ap.approvalId, refreshAll),
            makeDecisionButton('deny',         'Deny',         'btn-deny',      ap.approvalId, refreshAll),
            makeDecisionButton('deny-always',  'Deny always',  'btn-deny-hard', ap.approvalId, refreshAll)
          ])
        ]);
        centerBody.appendChild(card);
      }
    } else if (activeTab === 'memory') {
      const m = await fetchMemory(100);
      let facts = (m && m.facts) || [];
      if (selectedLane) facts = facts.filter((f) => (f.source && f.source.lane) === selectedLane);
      tabCounts.memory = facts.length;
      updateTabs();
      if (facts.length === 0) {
        centerBody.appendChild(el('div', { class: 'wb-empty' }, selectedLane ? `(no memory facts for lane "${selectedLane}")` : '(no memory facts yet)'));
        return;
      }
      for (const f of facts.slice().reverse()) {
        centerBody.appendChild(el('div', { class: 'ledger-row' }, [
          el('span', {}, f.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
          el('span', { class: 'event-type t-' + (f.kind === 'rule' ? 'framework' : f.kind === 'constraint' ? 'approval' : f.kind === 'summary' ? 'slice' : 'session') }, f.kind),
          el('span', {}, f.text),
          el('span', { class: 'event-actor' }, (f.tags || []).join(' '))
        ]));
      }
    }
  }

  async function fetchJsonSafe(p) { try { const r = await fetch(p, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; } }

  refreshAll();

  // Subscribe to the page-wide event stream so the workbench feels live.
  const handler = () => { refreshCenter(); /* lane counts + status will catch up on next slow refresh */ };
  const statusHandler = () => renderStatus(bridgeStatus);
  stream.bus.addEventListener('event', handler);
  // Slow tick (every 8 s) refreshes lane counts + sessions + status
  const slow = setInterval(() => refreshAll(), 8000);
  els.view.addEventListener('routechange', () => {
    stream.bus.removeEventListener('event', handler);
    clearInterval(slow);
  }, { once: true });

  return root;
}

// ─── Conductor (Slice α default landing) ────────────────────────────────
//
// Operator's command-control surface. Reads GET /bridge/conductor for a
// derived view: KPI strip, "Next Command" (safe-next-action), Operation
// Score Matrix (per-lane progress + reason codes), and Now/Next/Waiting/Done
// task board. Everything reflects canonical state — no UI memory.

function renderConductor() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Conductor'));
  root.appendChild(el('p', {}, ROUTES.conductor.description));

  const pill = scopePill('conductor', () => load());
  if (pill) root.appendChild(pill);

  // ── Next Command strip (front and center) ──
  const nextHost = el('div', { class: 'conductor-next' });
  nextHost.appendChild(loading('Computing safe next action…'));
  root.appendChild(nextHost);

  // ── KPI strip ──
  const kpiHost = el('div', {});
  root.appendChild(kpiHost);

  // ── Now / Next / Waiting / Done board ──
  const boardHost = el('div', { class: 'conductor-board' });
  boardHost.appendChild(loading('Loading task board…'));
  root.appendChild(panelFocus('Now · Next · Waiting · Done', 'GET /bridge/conductor', boardHost,
    { id: 'board', keywords: 'now next waiting done board kanban work-in-flight' }));

  // ── Queue Board summary card ──
  const queueHost = el('div', {});
  queueHost.appendChild(loading('Loading queue counts…'));
  const queueCard = panelFocus('Queue Board', 'scheduler · queue · dispatch · preflights', queueHost,
    { id: 'queue', keywords: 'queue scheduler dispatch preflight parked reason-code' });
  queueCard.style.cursor = 'pointer';
  queueCard.addEventListener('click', () => { location.hash = '#/queue'; });
  root.appendChild(queueCard);

  // ── Operation Score Matrix ──
  const matrixHost = el('div', {});
  matrixHost.appendChild(loadingFor('table', 'Loading per-lane score matrix…'));
  root.appendChild(panelFocus('Operation Score Matrix', 'per-lane progress · claims · reason codes', matrixHost,
    { id: 'score', keywords: 'score matrix progress per-lane claims reason' }));

  // ── Recent slice-stop summary ──
  const sliceHost = el('div', {});
  root.appendChild(panelFocus('Last slice-stop', 'most recent ritual close', sliceHost,
    { id: 'last-slice', keywords: 'last slice-stop recent ritual learning' }));

  // ── Slash-command quick reference (moved here in v0.19.2) ──
  root.appendChild(panelFocus('Slash-command quick reference', '/maddu-*', renderSlashCheatsheet(),
    { id: 'slash-cheatsheet', keywords: 'slash commands cheatsheet quick reference maddu-help maddu-autopilot' }));

  let dataLoaded = false;
  const load = async () => {
    let view;
    try {
      const r = await fetch(scopedUrl('conductor', '/bridge/conductor'), { cache: 'no-store' });
      view = await r.json();
    } catch {
      nextHost.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    dataLoaded = true;

    // Next Command
    nextHost.replaceChildren(renderNextCommand(view.nextCommand));

    // KPI strip
    const k = view.kpi || {};
    kpiHost.replaceChildren(statusGrid([
      { value: k.activeClaims ?? '—',  label: 'Active claims',    tone: (k.activeClaims > 0 ? 'accent' : 'neutral'), onClick: () => { location.hash = '#/swarm'; } },
      { value: k.openApprovals ?? '—', label: 'Open approvals',   tone: (k.openApprovals > 0 ? 'warn' : 'ok'),       onClick: () => { location.hash = '#/approvals'; } },
      { value: k.stuckWorkers ?? '—',  label: 'Stuck workers',    tone: (k.stuckWorkers > 0 ? 'danger' : 'ok'),      onClick: () => { location.hash = '#/swarm'; } },
      { value: k.idleSessions ?? '—',  label: 'Idle sessions',    tone: (k.idleSessions > 0 ? 'warn' : 'ok'),        onClick: () => { location.hash = '#/swarm'; } },
      { value: k.openTasks ?? '—',     label: 'Open tasks',       tone: 'accent',                                    onClick: () => { location.hash = '#/tasks'; } },
      { value: formatAge(k.lastSliceAgeMs), label: 'Last slice-stop', tone: ageTone(k.lastSliceAgeMs),               onClick: () => { location.hash = '#/operations'; } }
    ]));

    // Board
    boardHost.replaceChildren(renderConductorBoard(view.board || {}));

    // Score matrix
    matrixHost.replaceChildren(renderScoreMatrix(view.scoreMatrix || []));

    // Queue Board summary (counts per column)
    try {
      const qr = await fetch(scopedUrl('conductor', '/bridge/queue'), { cache: 'no-store' });
      if (qr.ok) {
        const qv = await qr.json();
        const segs = (qv.columns || []).map((col) => {
          const toneMap = { scheduler: 'blue', queue: 'accent', dispatch: 'ok', preflights: 'warn' };
          return { label: col.title, value: col.items.length, tone: toneMap[col.id] || 'neutral' };
        });
        queueHost.replaceChildren(segBar(segs));
      } else {
        queueHost.replaceChildren(placeholder('Offline', 'Queue endpoint unavailable.'));
      }
    } catch {
      queueHost.replaceChildren(placeholder('Offline', 'Queue endpoint unavailable.'));
    }

    // Last slice
    if (k.lastSlice) {
      sliceHost.replaceChildren(
        el('dl', { class: 'kv' }, [
          el('dt', {}, 'id'),      el('dd', {}, k.lastSlice.id || '—'),
          el('dt', {}, 'when'),    el('dd', {}, formatTs(k.lastSlice.ts)),
          el('dt', {}, 'age'),     el('dd', {}, formatAge(k.lastSliceAgeMs)),
          el('dt', {}, 'summary'), el('dd', {}, k.lastSlice.summary || '(no summary)')
        ])
      );
    } else {
      sliceHost.replaceChildren(placeholder('No slice-stops yet', 'Run your first slice-stop to start writing learnings into the spine.'));
    }
  };
  load();

  // Refresh whenever a new event lands. Debounce by skipping if a load is in flight.
  let pending = false;
  const onEvent = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  };
  stream.bus.addEventListener('event', onEvent);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', onEvent), { once: true });

  return root;
}

const REASON_CODE_TONE = {
  approvals_pending: 'warn',
  workers_stuck:     'danger',
  task_ready:        'accent',
  task_blocked:      'warn',
  slice_stale:       'warn',
  slice_never:       'blue',
  all_clear:         'ok',
  lane_active:       'accent',
  lane_unclaimed:    'warn',
  lane_idle:         'ok',
  lane_empty:        'neutral'
};
const REASON_CODE_LABEL = {
  approvals_pending: 'approvals pending',
  workers_stuck:     'workers stuck',
  task_ready:        'task ready',
  task_blocked:      'task blocked',
  slice_stale:       'slice stale',
  slice_never:       'first slice',
  all_clear:         'all clear',
  lane_active:       'active',
  lane_unclaimed:    'unclaimed',
  lane_idle:         'idle',
  lane_empty:        'empty'
};

function renderNextCommand(nc) {
  if (!nc) return placeholder('No signal', 'Bridge returned no next-command.');
  const tone = REASON_CODE_TONE[nc.reasonCode] || 'accent';
  const wrap = el('div', { class: `next-command tone-${tone}` });
  wrap.appendChild(el('span', { class: 'next-command-glyph' }, '▸'));
  const body = el('div', { class: 'next-command-body' });
  body.appendChild(el('div', { class: 'next-command-text' }, nc.text || ''));
  if (nc.hint) body.appendChild(el('div', { class: 'next-command-hint' }, nc.hint));
  const meta = el('div', { class: 'next-command-meta' }, [
    el('span', { class: `next-command-pill tone-${tone}` }, REASON_CODE_LABEL[nc.reasonCode] || nc.reasonCode || 'unknown'),
    nc.route ? el('span', { class: 'next-command-route' }, `→ /${nc.route}`) : null
  ]);
  body.appendChild(meta);
  wrap.appendChild(body);
  if (nc.route) {
    wrap.style.cursor = 'pointer';
    wrap.addEventListener('click', () => {
      if (nc.ref && nc.ref.kind === 'task' && nc.ref.id) {
        location.hash = `#/tasks?inspect=task:${encodeURIComponent(nc.ref.id)}`;
      } else {
        location.hash = `#/${nc.route}`;
      }
    });
  }
  return wrap;
}

function renderConductorBoard(board) {
  const wrap = el('div', { class: 'board-grid' });
  const columns = [
    { id: 'now',     title: 'Now',     tone: 'blue',    items: board.now || [],     hint: 'in-progress' },
    { id: 'next',    title: 'Next',    tone: 'accent',  items: board.next || [],    hint: 'ready · no blockers' },
    { id: 'waiting', title: 'Waiting', tone: 'warn',    items: board.waiting || [], hint: 'blocked on dependency' },
    { id: 'done',    title: 'Done',    tone: 'ok',      items: board.done || [],    hint: 'recent · last 8' }
  ];
  for (const col of columns) {
    const c = el('div', { class: 'board-col' });
    c.appendChild(el('div', { class: `board-col-head tone-${col.tone}` }, [
      el('span', { class: 'board-col-title' }, col.title),
      el('span', { class: 'board-col-count' }, String(col.items.length))
    ]));
    c.appendChild(el('div', { class: 'board-col-hint' }, col.hint));
    if (col.items.length === 0) {
      c.appendChild(el('div', { class: 'board-empty' }, '—'));
    } else {
      for (const t of col.items.slice(0, 12)) {
        const card = el('div', { class: 'board-card' });
        card.appendChild(el('div', { class: 'board-card-title' }, t.title || '(untitled)'));
        const metaParts = [];
        if (t.lane) metaParts.push(t.lane);
        if (t.owner) metaParts.push(`@${t.owner}`);
        if ((t.activeBlockers || []).length > 0) metaParts.push(`blocked×${t.activeBlockers.length}`);
        const meta = el('div', { class: 'board-card-meta' });
        const badge = workspaceBadge(t);
        if (badge) { meta.appendChild(badge); meta.appendChild(document.createTextNode(' ')); }
        meta.appendChild(document.createTextNode(metaParts.join(' · ') || '—'));
        card.appendChild(meta);
        card.addEventListener('click', () => openInspector({ kind: 'task', id: t.id, data: t }));
        c.appendChild(card);
      }
    }
    wrap.appendChild(c);
  }
  return wrap;
}

function renderScoreMatrix(rows) {
  if (!rows.length) return placeholder('No lanes', 'Lane catalog is empty.');
  const wrap = el('div', { class: 'score-matrix' });
  for (const r of rows) {
    const tone = REASON_CODE_TONE[r.reasonCode] || 'neutral';
    const row = el('div', { class: 'score-row' });
    const headChildren = [];
    const badge = workspaceBadge(r);
    if (badge) headChildren.push(badge);
    headChildren.push(
      el('span', { class: 'score-lane' }, r.lane),
      el('span', { class: `score-pill tone-${tone}` }, REASON_CODE_LABEL[r.reasonCode] || r.reasonCode),
      el('span', { class: 'score-counts' }, `${r.done}/${r.total}${r.claimsHeld ? ` · claims ×${r.claimsHeld}` : ''}`)
    );
    const head = el('div', { class: 'score-head' }, headChildren);
    row.appendChild(head);
    row.appendChild(bar(r.progress * 100, r.scope || '', { tone, right: `${Math.round(r.progress * 100)}%` }));
    row.addEventListener('click', () => openInspector({ kind: 'lane', id: r.lane, data: r }));
    wrap.appendChild(row);
  }
  return wrap;
}

// formatAge / ageTone / formatTs → moved to cockpit-util.js (v1.38.0).

// ─── Queue Board (Slice β) ──────────────────────────────────────────────
//
// Four-lane kanban — Scheduler · Queue · Dispatch · Preflights. Reads
// GET /bridge/queue. Every parked card carries its reason code and a
// safe next action affordance.

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

function renderQueueBoard() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Queue Board'));
  root.appendChild(el('p', {}, ROUTES.queue.description));

  const pill = scopePill('queue', () => load());
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
      const r = await fetch(scopedUrl('queue', '/bridge/queue'), { cache: 'no-store' });
      view = await r.json();
    } catch {
      host.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      return;
    }
    host.replaceChildren(renderQueueColumns(view.columns || []));
  };
  load();
  const onEvent = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  };
  stream.bus.addEventListener('event', onEvent);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', onEvent), { once: true });

  return root;
}

function renderQueueColumns(columns) {
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
        c.appendChild(renderQueueCard(item, col.id));
      }
    }
    wrap.appendChild(c);
  }
  return wrap;
}

function renderQueueCard(item, columnId) {
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
    openInspector({
      kind: columnId === 'preflights' ? 'approval' : (item.kind || (columnId === 'scheduler' ? 'schedule' : 'task')),
      id: item.id,
      data: item
    });
  });
  return card;
}

// ─── Claim Map (Slice β) ────────────────────────────────────────────────
//
// Active claims by lane. Joins claims with session info; surfaces lease
// state and heartbeat age. Operator can request a handoff with one click.

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

function renderClaimMap() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Claim Map'));
  root.appendChild(el('p', {}, ROUTES.claims.description));

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
    host.replaceChildren(renderClaimsTable(view.claims, load));
  };
  load();
  const onEvent = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  };
  stream.bus.addEventListener('event', onEvent);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', onEvent), { once: true });

  return root;
}

function renderClaimsTable(claims, reload) {
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
    row.addEventListener('click', () => openInspector({ kind: 'claim', id: c.lane, data: c }));
    wrap.appendChild(row);
  }
  return wrap;
}

// ─── BOSS (Slice γ) ──────────────────────────────────────────────────────
//
// BOSS proposes · Enforcer cites · Operator decides. Terminal-style
// transcript (no chat bubbles). Composer creates proposals through
// /bridge/proposals; the Enforcer's deterministic reply is mirrored into
// the same transcript distinguished by glyph. Operator strip surfaces
// claims, approvals, and parked items so decisions are state-grounded.

const PROPOSAL_RISK_TONE = { low: 'ok', medium: 'warn', high: 'danger' };
const ENFORCER_ACTION_KINDS = ['claim-lane', 'release-lane', 'slice-stop', 'request-handoff', 'approve', 'run-focused-gate', 'write-file'];

function renderBoss() {
  const root = el('div', { class: 'view boss-view' });
  root.appendChild(el('h2', {}, 'BOSS'));
  root.appendChild(el('p', {}, ROUTES.boss.description));

  // ── Operator strip (state-grounded context, refreshes on each load) ──
  const stripHost = el('div', { class: 'boss-strip' });
  stripHost.appendChild(loading('Loading operator context…'));
  root.appendChild(stripHost);

  // ── Session selector ──
  const sessionRow = el('div', { class: 'boss-sessions' });
  root.appendChild(sessionRow);

  // ── Transcript ──
  const transcript = el('div', { class: 'boss-transcript' });
  transcript.appendChild(loading('Loading transcript…'));
  root.appendChild(transcript);

  // ── Composer ──
  const composer = renderBossComposer(() => load());
  root.appendChild(composer);

  let currentSession = 'default';
  let pending = false;
  let view;

  const load = async () => {
    try {
      const [stripRes, sessionsRes, viewRes] = await Promise.all([
        fetch('/bridge/conductor', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch('/bridge/boss/sessions', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch(`/bridge/boss/sessions/${encodeURIComponent(currentSession)}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      ]);
      if (stripRes && stripRes.kpi) renderBossStrip(stripHost, stripRes);
      else stripHost.replaceChildren(placeholder('Offline', 'Bridge not reachable.'));
      if (sessionsRes && sessionsRes.sessions) renderBossSessions(sessionRow, sessionsRes.sessions, currentSession, (id) => { currentSession = id; load(); });
      view = viewRes;
      if (view && view.transcript) renderBossTranscript(transcript, view);
      else transcript.replaceChildren(placeholder('Empty transcript', 'No messages on this session yet. Use the composer to propose an action.'));
      // Sync composer's bossSessionId.
      composer.dataset.bossSession = currentSession;
    } catch (e) {
      transcript.replaceChildren(placeholder('Offline', e.message || 'Bridge not reachable.'));
    }
  };
  load();

  const onEvent = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 300);
  };
  stream.bus.addEventListener('event', onEvent);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', onEvent), { once: true });

  return root;
}

function renderBossStrip(host, conductor) {
  const k = conductor.kpi || {};
  const tile = (label, value, tone) => el('div', { class: `boss-strip-tile tone-${tone || 'neutral'}` }, [
    el('div', { class: 'boss-strip-value' }, String(value)),
    el('div', { class: 'boss-strip-label' }, label)
  ]);
  const strip = el('div', { class: 'boss-strip-row' }, [
    tile('Active claims', k.activeClaims ?? 0,    k.activeClaims > 0 ? 'accent' : 'neutral'),
    tile('Open approvals', k.openApprovals ?? 0,  k.openApprovals > 0 ? 'warn' : 'ok'),
    tile('Stuck workers', k.stuckWorkers ?? 0,    k.stuckWorkers > 0 ? 'danger' : 'ok'),
    tile('Open tasks', k.openTasks ?? 0,          'accent'),
    tile('Last slice', formatAge(k.lastSliceAgeMs), ageTone(k.lastSliceAgeMs))
  ]);
  // Next command echoed as a one-liner.
  const nc = conductor.nextCommand;
  const ncEl = nc ? el('div', { class: `boss-strip-next tone-${REASON_CODE_TONE[nc.reasonCode] || 'accent'}` }, [
    el('span', { class: 'boss-strip-next-glyph' }, '▸'),
    el('span', { class: 'boss-strip-next-text' }, nc.text || ''),
    el('span', { class: `next-command-pill tone-${REASON_CODE_TONE[nc.reasonCode] || 'accent'}` }, REASON_CODE_LABEL[nc.reasonCode] || nc.reasonCode)
  ]) : null;
  host.replaceChildren(strip);
  if (ncEl) host.appendChild(ncEl);
}

function renderBossSessions(host, sessions, currentId, onPick) {
  host.replaceChildren();
  for (const s of sessions) {
    const tab = el('button', {
      type: 'button',
      class: 'boss-session-tab' + (s.id === currentId ? ' active' : '')
    }, [
      el('span', { class: 'boss-session-id' }, s.id),
      el('span', { class: 'boss-session-count' }, `${s.messageCount} msg${s.openProposals ? ` · ${s.openProposals} open` : ''}`)
    ]);
    tab.addEventListener('click', () => onPick(s.id));
    host.appendChild(tab);
  }
}

function renderBossTranscript(host, view) {
  const wrap = el('div', { class: 'boss-transcript-inner' });
  const proposalById = new Map((view.proposals || []).map((p) => [p.id, p]));
  for (const msg of view.transcript || []) {
    if (msg.role === 'proposal' && msg.proposalId && proposalById.has(msg.proposalId)) {
      wrap.appendChild(renderProposalCard(proposalById.get(msg.proposalId)));
    } else if (msg.role === 'enforcer') {
      wrap.appendChild(renderEnforcerLine(msg));
    } else if (msg.role === 'decision') {
      wrap.appendChild(renderDecisionLine(msg));
    } else {
      wrap.appendChild(renderOperatorLine(msg));
    }
  }
  if (!wrap.children.length) {
    wrap.appendChild(placeholder('Empty transcript', 'No messages on this session yet.'));
  }
  host.replaceChildren(wrap);
  host.scrollTop = host.scrollHeight;
}

function renderOperatorLine(msg) {
  return el('div', { class: 'boss-line role-operator' }, [
    el('span', { class: 'boss-line-glyph' }, '·'),
    el('span', { class: 'boss-line-actor' }, msg.actor || 'operator'),
    el('span', { class: 'boss-line-text' }, msg.text || ''),
    el('span', { class: 'boss-line-ts' }, formatTs(msg.ts))
  ]);
}

function renderEnforcerLine(msg) {
  return el('div', { class: 'boss-line role-enforcer' }, [
    el('span', { class: 'boss-line-glyph' }, '◆'),
    el('span', { class: 'boss-line-actor' }, 'enforcer'),
    el('span', { class: 'boss-line-text' }, [
      el('span', { class: 'boss-enforcer-code' }, msg.reasonCode || '—'),
      document.createTextNode(' · '),
      document.createTextNode(msg.text || ''),
      msg.citedRule ? el('span', { class: 'boss-enforcer-rule' }, ` (${msg.citedRule})`) : null
    ]),
    el('span', { class: 'boss-line-ts' }, formatTs(msg.ts))
  ]);
}

function renderDecisionLine(msg) {
  return el('div', { class: 'boss-line role-decision' }, [
    el('span', { class: 'boss-line-glyph' }, '▸'),
    el('span', { class: 'boss-line-actor' }, msg.actor || 'operator'),
    el('span', { class: 'boss-line-text' }, `decision: ${msg.text}`),
    el('span', { class: 'boss-line-ts' }, formatTs(msg.ts))
  ]);
}

function renderProposalCard(p) {
  const riskTone = PROPOSAL_RISK_TONE[p.risk] || 'warn';
  const statusTone = p.status === 'open' ? 'accent' : (p.status === 'approved' ? 'ok' : (p.status === 'rejected' ? 'danger' : 'warn'));
  const enforcerTone = p.enforcer ? (p.enforcer.allow ? 'ok' : 'danger') : 'neutral';
  const card = el('div', { class: `proposal-card tone-${statusTone}` });
  // Head row: risk + status + lane
  card.appendChild(el('div', { class: 'proposal-head' }, [
    el('span', { class: `next-command-pill tone-${riskTone}` }, `risk: ${p.risk}`),
    el('span', { class: `next-command-pill tone-${statusTone}` }, p.status),
    p.lane ? el('span', { class: 'proposal-lane' }, p.lane) : null,
    p.action ? el('span', { class: 'proposal-action' }, p.action) : null
  ]));
  // Summary
  card.appendChild(el('div', { class: 'proposal-summary' }, p.summary || '(no summary)'));
  // Enforcer verdict
  if (p.enforcer) {
    card.appendChild(el('div', { class: `proposal-enforcer tone-${enforcerTone}` }, [
      el('span', { class: 'boss-line-glyph' }, '◆'),
      el('span', { class: 'boss-enforcer-code' }, p.enforcer.reasonCode),
      document.createTextNode(' · '),
      document.createTextNode(p.enforcer.hint || (p.enforcer.allow ? 'allowed' : 'refused')),
      p.enforcer.citedRule ? el('span', { class: 'boss-enforcer-rule' }, ` (${p.enforcer.citedRule})`) : null
    ]));
  }
  // Preconditions
  if ((p.preconditions || []).length) {
    const list = el('ul', { class: 'proposal-precs' });
    for (const pc of p.preconditions) list.appendChild(el('li', {}, String(pc)));
    card.appendChild(list);
  }
  // Decision row
  if (p.status === 'open') {
    const row = el('div', { class: 'proposal-decision' });
    const mk = (cls, label, decision) => {
      const b = el('button', { class: `m-btn proposal-btn ${cls}`, type: 'button' }, label);
      b.addEventListener('click', async () => {
        const reason = decision === 'approved' ? null : (prompt(`Reason for ${decision}:`, '') || '');
        try {
          const r = await fetch(`/bridge/proposals/${encodeURIComponent(p.id)}/decide`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision, reason })
          });
          if (!r.ok) { const d = await r.json().catch(() => ({})); showToast(`Decision failed: ${d.error || r.statusText}`, 'err'); }
          else { showToast(`Proposal ${decision}`, decision === 'approved' ? 'ok' : 'warn'); }
        } catch (err) { showToast(`Decision failed: ${err.message}`, 'err'); }
      });
      return b;
    };
    row.appendChild(mk('btn-allow', 'approve', 'approved'));
    row.appendChild(mk('btn-deny-soft', 'negotiate', 'negotiating'));
    row.appendChild(mk('btn-deny-hard', 'reject', 'rejected'));
    card.appendChild(row);
  } else {
    card.appendChild(el('div', { class: 'proposal-decided' }, [
      el('span', { class: 'boss-line-actor' }, p.decidedBy || 'operator'),
      document.createTextNode(' · '),
      el('span', {}, formatTs(p.decidedAt)),
      p.reason ? el('span', { class: 'proposal-reason' }, ` — ${p.reason}`) : null
    ]));
  }
  card.addEventListener('click', (e) => {
    // Don't intercept button clicks.
    if (e.target.closest('button')) return;
    openInspector({ kind: 'proposal', id: p.id, data: p });
  });
  return card;
}

// Which extra Enforcer-input fields a given action kind needs. The composer
// shows just these inputs — pickers populate from live state when possible.
const ACTION_FIELDS = {
  'claim-lane':       ['lane', 'sessionId'],
  'release-lane':     ['lane', 'sessionId'],
  'slice-stop':       ['sessionId'],
  'request-handoff':  ['lane'],
  'approve':          ['approvalId', 'decision'],
  'run-focused-gate': ['gate'],
  'write-file':       ['path']
};

function renderBossComposer(reload) {
  const wrap = el('form', { class: 'boss-composer' });
  wrap.dataset.bossSession = 'default';

  // Top row: action + risk
  const top = el('div', { class: 'boss-composer-row' });
  const actionSel = el('select', { class: 'lanes-edit-select' });
  actionSel.appendChild(el('option', { value: '' }, '— freeform message —'));
  for (const k of ENFORCER_ACTION_KINDS) actionSel.appendChild(el('option', { value: k }, k));
  const riskSel = el('select', { class: 'lanes-edit-select' });
  for (const r of ['low', 'medium', 'high']) riskSel.appendChild(el('option', { value: r }, `risk: ${r}`));
  riskSel.value = 'medium';
  top.appendChild(actionSel);
  top.appendChild(riskSel);
  wrap.appendChild(top);

  // Per-action fields (rebuilt on action change). Lives in its own row so
  // the layout stays clean for freeform messages.
  const fieldsRow = el('div', { class: 'boss-composer-row boss-composer-fields' });
  wrap.appendChild(fieldsRow);

  // Fields cache so values stick across kind changes (e.g. when you pick the
  // same lane again).
  const values = { lane: '', sessionId: '', approvalId: '', decision: 'allow-once', gate: '', path: '' };

  // Live data for dropdowns. Refreshed whenever we render fields.
  let liveSessions = [];
  let liveLanes = [];
  let liveApprovals = [];

  async function refreshLive() {
    try {
      const [proj, lanes] = await Promise.all([
        fetch('/bridge/projection', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
        fetch('/bridge/lanes', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
      ]);
      liveSessions = (proj && proj.activeSessions) ? proj.activeSessions : [];
      liveLanes = (lanes && lanes.catalog && Array.isArray(lanes.catalog.lanes)) ? lanes.catalog.lanes
                : (lanes && Array.isArray(lanes.lanes)) ? lanes.lanes
                : [];
      liveApprovals = (proj && proj.approvals && proj.approvals.open) ? proj.approvals.open : [];
    } catch {}
  }

  function makeFieldInput(name) {
    if (name === 'lane') {
      if (liveLanes.length) {
        const sel = el('select', { class: 'lanes-edit-select boss-field' });
        sel.appendChild(el('option', { value: '' }, '— lane —'));
        for (const l of liveLanes) {
          const o = el('option', { value: l.id }, l.id);
          if (values.lane === l.id) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => { values.lane = sel.value; });
        return sel;
      }
      const inp = el('input', { type: 'text', class: 'lanes-edit-input lanes-edit-input-narrow boss-field', placeholder: 'lane', value: values.lane });
      inp.addEventListener('input', () => { values.lane = inp.value.trim(); });
      return inp;
    }
    if (name === 'sessionId') {
      if (liveSessions.length) {
        const sel = el('select', { class: 'lanes-edit-select boss-field' });
        sel.appendChild(el('option', { value: '' }, '— sessionId —'));
        for (const s of liveSessions) {
          const label = `${s.label || s.id} (${s.role || 'session'})`;
          const o = el('option', { value: s.id }, label);
          if (values.sessionId === s.id) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => { values.sessionId = sel.value; });
        return sel;
      }
      const inp = el('input', { type: 'text', class: 'lanes-edit-input boss-field', placeholder: 'sessionId (no active sessions — register one first)', value: values.sessionId });
      inp.addEventListener('input', () => { values.sessionId = inp.value.trim(); });
      return inp;
    }
    if (name === 'approvalId') {
      if (liveApprovals.length) {
        const sel = el('select', { class: 'lanes-edit-select boss-field' });
        sel.appendChild(el('option', { value: '' }, '— approvalId —'));
        for (const a of liveApprovals) {
          sel.appendChild(el('option', { value: a.approvalId }, `${a.tool || a.action || a.approvalId} · ${a.lane || ''}`));
        }
        sel.addEventListener('change', () => { values.approvalId = sel.value; });
        return sel;
      }
      const inp = el('input', { type: 'text', class: 'lanes-edit-input boss-field', placeholder: 'approvalId (no open approvals)', value: values.approvalId });
      inp.addEventListener('input', () => { values.approvalId = inp.value.trim(); });
      return inp;
    }
    if (name === 'decision') {
      const sel = el('select', { class: 'lanes-edit-select boss-field' });
      for (const d of ['allow-once', 'allow-always', 'deny']) {
        const o = el('option', { value: d }, d);
        if (values.decision === d) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { values.decision = sel.value; });
      return sel;
    }
    if (name === 'gate') {
      const inp = el('input', { type: 'text', class: 'lanes-edit-input boss-field', placeholder: 'gate id (free-form)', value: values.gate });
      inp.addEventListener('input', () => { values.gate = inp.value.trim(); });
      return inp;
    }
    if (name === 'path') {
      const inp = el('input', { type: 'text', class: 'lanes-edit-input boss-field', placeholder: 'path (relative to repo root)', value: values.path });
      inp.addEventListener('input', () => { values.path = inp.value.trim(); });
      return inp;
    }
    return null;
  }

  async function renderFields() {
    await refreshLive();
    fieldsRow.replaceChildren();
    const kind = actionSel.value;
    if (!kind) {
      fieldsRow.appendChild(el('span', { class: 'boss-field-hint' }, 'freeform — no enforcer fields'));
      return;
    }
    const need = ACTION_FIELDS[kind] || [];
    if (!need.length) {
      fieldsRow.appendChild(el('span', { class: 'boss-field-hint' }, 'no extra fields required'));
      return;
    }
    for (const f of need) {
      const node = makeFieldInput(f);
      if (node) fieldsRow.appendChild(node);
    }
    // Tip line so the operator knows what's required.
    fieldsRow.appendChild(el('span', { class: 'boss-field-hint' }, `required: ${need.join(' · ')}`));
  }
  actionSel.addEventListener('change', renderFields);
  renderFields();

  const textarea = el('textarea', { class: 'boss-composer-text', placeholder: 'Propose an action or say something. Shift+Enter for newline.', rows: '3' });
  const checkBtn = el('button', { type: 'button', class: 'm-btn' }, 'Pre-check (Enforcer)');
  const sendBtn = el('button', { type: 'submit', class: 'btn-allow' }, 'Send proposal');
  const sayBtn = el('button', { type: 'button', class: 'm-btn' }, 'Just say it');
  const bottom = el('div', { class: 'boss-composer-row' }, [checkBtn, sayBtn, sendBtn]);
  wrap.appendChild(textarea);
  wrap.appendChild(bottom);

  function buildAction() {
    const kind = actionSel.value;
    if (!kind) return null;
    const action = { kind };
    for (const f of ACTION_FIELDS[kind] || []) {
      if (values[f]) action[f] = values[f];
    }
    return action;
  }

  // Pre-check uses the Enforcer endpoint without creating a proposal.
  checkBtn.addEventListener('click', async () => {
    const action = buildAction();
    if (!action) { showToast('Pick an action kind first', 'warn'); return; }
    try {
      const r = await fetch('/bridge/enforcer/check', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const d = await r.json();
      const dec = d.decision || {};
      showToast(`${dec.allow ? '✓' : '✗'} ${dec.reasonCode} — ${dec.hint || ''}`, dec.allow ? 'ok' : 'err');
    } catch (e) { showToast(`Pre-check failed: ${e.message}`, 'err'); }
  });

  sayBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    try {
      await fetch('/bridge/boss/message', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, bossSessionId: wrap.dataset.bossSession, role: 'operator' })
      });
      textarea.value = '';
      reload();
    } catch (e) { showToast(`Send failed: ${e.message}`, 'err'); }
  });

  wrap.addEventListener('submit', async (e) => {
    e.preventDefault();
    const summary = textarea.value.trim();
    if (!summary) { showToast('Summary required', 'warn'); return; }
    const action = buildAction();
    const body = {
      summary,
      lane: values.lane || null,
      risk: riskSel.value,
      bossSessionId: wrap.dataset.bossSession
    };
    if (action) {
      body.action = action.kind;
      body.actionFields = { ...action };
      delete body.actionFields.kind;
    }
    try {
      const r = await fetch('/bridge/proposals', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); showToast(`Proposal failed: ${d.error || r.statusText}`, 'err'); return; }
      textarea.value = '';
      reload();
    } catch (err) { showToast(`Proposal failed: ${err.message}`, 'err'); }
  });

  return wrap;
}

function renderDashboard() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Dashboard'));
  root.appendChild(el('p', {}, ROUTES.dashboard.description));

  const pill = scopePill('dashboard', () => {
    // Re-render the whole route — dashboard's data layers are too tangled
    // to surgically swap fetches, and the projection/events endpoints both
    // need the scoped URL.
    renderRoute();
  });
  if (pill) root.appendChild(pill);

  const status = bridgeStatus || {};
  const counts = status.counts || {};

  // ── Headline tiles (top-of-page status grid) ────────────────────────
  // Populated immediately from cached bridgeStatus; sparklines fill in
  // asynchronously once /bridge/events/recent returns.
  const headline = statusGrid([
    { value: counts.events ?? '—',          label: 'Events',          tone: 'blue',   onClick: () => location.hash = '#/events' },
    { value: counts.activeSessions ?? '—',  label: 'Active sessions', tone: 'accent', onClick: () => location.hash = '#/swarm' },
    { value: counts.openApprovals ?? '—',   label: 'Open approvals',  tone: (counts.openApprovals > 0 ? 'warn' : 'accent'), onClick: () => location.hash = '#/approvals' },
    { value: counts.openTasks ?? '—',       label: 'Open tasks',      tone: 'accent', onClick: () => location.hash = '#/tasks' },
    { value: counts.stuckWorkers ?? '—',    label: 'Stuck workers',   tone: (counts.stuckWorkers > 0 ? 'danger' : 'ok'), onClick: () => location.hash = '#/swarm' },
    { value: counts.unreadMail ?? '—',      label: 'Mailbox unread',  tone: (counts.unreadMail > 0 ? 'warn' : 'accent'), onClick: () => location.hash = '#/mailbox' }
  ]);
  root.appendChild(headline);

  // ── Distribution donuts (tasks + workers) ───────────────────────────
  const donutRow = el('div', { class: 'widget-donut-row-pair' });
  const tasksPanel = panel('Tasks by status', 'GET /bridge/projection', el('div', { class: 'placeholder' }, [el('strong', {}, 'Loading…'), document.createTextNode('')]));
  const workersPanel = panel('Workers by status', 'GET /bridge/projection · 15 s stuck threshold', el('div', { class: 'placeholder' }, [el('strong', {}, 'Loading…'), document.createTextNode('')]));
  donutRow.appendChild(tasksPanel);
  donutRow.appendChild(workersPanel);
  root.appendChild(donutRow);

  // ── Activity sparkline panel (event rate over last 60 min) ──────────
  const sparkBody = el('div', {});
  sparkBody.appendChild(loading('Reading event timeline…'));
  root.appendChild(panel('Event activity', 'last 60 min · 24 buckets · GET /bridge/events/recent', sparkBody));

  // ── Capacity meters ─────────────────────────────────────────────────
  const meters = el('div', {});
  meters.appendChild(meter(counts.mcpEnabled ?? 0, counts.mcp ?? 0, 'MCP servers enabled', { tone: 'blue' }));
  meters.appendChild(meter(counts.enabledSchedules ?? 0, counts.schedules ?? 0, 'Schedules enabled', { tone: 'accent' }));
  meters.appendChild(meter(counts.importsAccepted ?? 0, (counts.importsAccepted ?? 0) + (counts.importsRejected ?? 0), 'Imports accepted vs total', { tone: 'ok' }));
  if ((counts.runtimes ?? 0) > 0) {
    meters.appendChild(meter(counts.runtimes ?? 0, counts.runtimes ?? 0, 'Runtimes registered', { tone: 'accent' }));
  }
  root.appendChild(panel('Capacity', 'enabled · accepted · registered', meters));

  // ── Bridge identity (compact KV — the operator-relevant rows only) ──
  const idKv = el('dl', { class: 'kv' }, [
    el('dt', {}, 'bridge'),    el('dd', { html: bridgeOk ? '<span class="signal live"></span>online' : '<span class="signal"></span>offline' }),
    el('dt', {}, 'version'),   el('dd', {}, status.version || '—'),
    el('dt', {}, 'host'),      el('dd', {}, `${status.host || '127.0.0.1'}:${status.port || 4177}`),
    el('dt', {}, 'uptime'),    el('dd', {}, formatUptime(status.uptimeMs)),
    el('dt', {}, 'repo root'), el('dd', {}, status.repoRoot || '—'),
    el('dt', {}, 'state'),     el('dd', {}, status.stateDir || '.maddu/')
  ]);
  root.appendChild(panel('Bridge', 'GET /bridge/status', idKv));

  // ── Hard rules quick reference ──────────────────────────────────────
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

  // ── Async: fetch projection + recent events to populate widgets ─────
  (async () => {
    try {
      const projUrl = scopedUrl('dashboard', '/bridge/projection');
      const projResp = await fetch(projUrl, { cache: 'no-store' });
      const proj = projResp.ok ? await projResp.json() : null;
      if (proj) {
        // Tasks donut
        const t = proj.tasks || [];
        const tCounts = { todo: 0, in_progress: 0, blocked: 0, done: 0 };
        for (const x of t) tCounts[x.status] = (tCounts[x.status] || 0) + 1;
        const tasksDonut = donut([
          { label: 'todo',        value: tCounts.todo,        tone: 'accent' },
          { label: 'in_progress', value: tCounts.in_progress, tone: 'blue' },
          { label: 'blocked',     value: tCounts.blocked,     tone: 'warn' },
          { label: 'done',        value: tCounts.done,        tone: 'ok' }
        ], { centerLabel: t.length === 1 ? 'task' : 'tasks' });
        tasksPanel.replaceChild(tasksDonut, tasksPanel.lastChild);

        // Workers donut
        const w = proj.workers || [];
        const wCounts = { running: 0, stuck: 0, exited: 0, killed: 0 };
        for (const x of w) wCounts[x.status] = (wCounts[x.status] || 0) + 1;
        const workersDonut = donut([
          { label: 'running', value: wCounts.running, tone: 'ok' },
          { label: 'stuck',   value: wCounts.stuck,   tone: 'danger' },
          { label: 'exited',  value: wCounts.exited,  tone: 'neutral' },
          { label: 'killed',  value: wCounts.killed,  tone: 'warn' }
        ], { centerLabel: w.length === 1 ? 'worker' : 'workers' });
        workersPanel.replaceChild(workersDonut, workersPanel.lastChild);
      } else {
        tasksPanel.replaceChild(placeholder('Offline', 'Bridge not reachable.'), tasksPanel.lastChild);
        workersPanel.replaceChild(placeholder('Offline', 'Bridge not reachable.'), workersPanel.lastChild);
      }
    } catch (e) {
      tasksPanel.replaceChild(placeholder('Error', String(e)), tasksPanel.lastChild);
      workersPanel.replaceChild(placeholder('Error', String(e)), workersPanel.lastChild);
    }

    try {
      const r = await fetch(scopedUrl('dashboard', '/bridge/events/recent') + '?limit=500', { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      sparkBody.innerHTML = '';
      if (!d || !d.events || d.events.length === 0) {
        sparkBody.appendChild(placeholder('No events yet', 'Run `maddu session register` or any slice-stop.'));
        return;
      }
      const bins = binByTime(d.events, 24, 'createdAt', 60 * 60 * 1000);
      const total = bins.reduce((s, x) => s + x, 0);
      const peak = Math.max(...bins);
      const wrap = el('div', { class: 'widget-stat' });
      const numLine = el('div', { class: 'widget-stat-num' });
      numLine.appendChild(el('span', { class: 'widget-stat-value' }, String(total)));
      numLine.appendChild(el('span', { class: 'widget-stat-trend' }, `peak ${peak}/bin`));
      wrap.appendChild(numLine);
      wrap.appendChild(el('div', { class: 'widget-stat-label' }, 'events in the last 60 minutes'));
      wrap.appendChild(sparkline(bins, { tone: 'blue', width: 480, height: 56 }));
      sparkBody.appendChild(wrap);

      // Event-type segmented bar (most recent 200 grouped by classifyEvent palette)
      const tail = d.events.slice(-200);
      const buckets = { 't-framework': 0, 't-session': 0, 't-lane': 0, 't-approval': 0, 't-slice': 0, other: 0 };
      for (const e of tail) {
        const cls = classifyEvent(e.type || '');
        if (cls in buckets) buckets[cls]++;
        else buckets.other++;
      }
      const seg = segBar([
        { label: 'framework', value: buckets['t-framework'], tone: 'accent' },
        { label: 'session',   value: buckets['t-session'],   tone: 'blue' },
        { label: 'lane',      value: buckets['t-lane'],      tone: 'ok' },
        { label: 'approval',  value: buckets['t-approval'],  tone: 'warn' },
        { label: 'slice',     value: buckets['t-slice'],     tone: 'danger' },
        { label: 'other',     value: buckets.other,          tone: 'neutral' }
      ]);
      const segPanel = panel('Event type mix', 'last 200 events · classifyEvent palette', seg);
      sparkBody.appendChild(segPanel);
    } catch (e) {
      sparkBody.innerHTML = '';
      sparkBody.appendChild(placeholder('Error', String(e)));
    }
  })();

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

// Phase 5 — Skeleton shimmer in place of static "Loading…" text.
// loading() — default 3-line skeleton. Use for narrative/prose blocks
// (slice ledger entries, wiki body, learning facts).
// loading / loadingFor → moved to cockpit-util.js (v1.39.0).

function renderOperations() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Operations'));
  root.appendChild(el('p', {}, ROUTES.operations.description));

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
  root.appendChild(panelFocus('Activity', 'slice-stops + memory facts · last 7 days', summaryMount,
    { id: 'activity', keywords: 'activity slice-stops memory facts 7-day timeline' }));

  const slicesMount = el('div', {});
  slicesMount.appendChild(loadingFor('table', 'Fetching slice-stop ledger…'));
  root.appendChild(panelFocus('Slice ledger', 'GET /bridge/projection · SLICE_STOP events', slicesMount,
    { id: 'slice-ledger', keywords: 'slice ledger SLICE_STOP events history' }));

  const memMount = el('div', {});
  memMount.appendChild(loadingFor('table', 'Fetching hindsight facts…'));
  root.appendChild(panelFocus('Hindsight memory', 'GET /bridge/memory · facts derived from slice-stops', memMount,
    { id: 'hindsight', keywords: 'hindsight memory facts learnings extraction' }));

  const cpMount = el('div', {});
  cpMount.appendChild(loading('Fetching checkpoints…'));
  root.appendChild(panelFocus('Checkpoints', 'GET /bridge/checkpoints · git tags at maddu/checkpoint/<id>', cpMount,
    { id: 'checkpoints', keywords: 'checkpoints git tags rollback restore' }));

  function refresh() {
    fetchProjection().then((proj) => {
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

    fetch('/bridge/checkpoints', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((d) => {
      cpMount.innerHTML = '';
      if (!d) { cpMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); return; }
      if (!d.gitAvailable) { cpMount.appendChild(placeholder('No git work tree', 'Checkpoints require a git repo in the install root.')); return; }
      const newBtn = el('button', { class: 'btn-allow' }, '+ checkpoint');
      newBtn.addEventListener('click', async () => {
        const title = prompt('Checkpoint title (optional):');
        if (title === null) return;
        await fetch('/bridge/checkpoints', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title || null, by: composer.currentSession || null }) });
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

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading projection…'));
  root.appendChild(panel('Summary', 'workers + sessions distribution', summaryMount));

  const lanesMount = el('div', {});
  lanesMount.appendChild(loading('Fetching lane catalog…'));
  root.appendChild(panel('Lane roster', 'GET /bridge/lanes', lanesMount));

  Promise.all([fetchLanes(), fetchProjection()]).then(([lanes, proj]) => {
    // ── Summary panel (donut + grid) ─────────────────────────────────
    summaryMount.innerHTML = '';
    if (proj) {
      const ws = proj.workers || [];
      const wCounts = { running: 0, stuck: 0, exited: 0, killed: 0 };
      for (const w of ws) wCounts[w.status] = (wCounts[w.status] || 0) + 1;
      const claimedLanes = (lanes?.claims || []).length;
      const totalLanes = (lanes?.catalog?.lanes || []).length;
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(donut([
        { label: 'running', value: wCounts.running, tone: 'ok' },
        { label: 'stuck',   value: wCounts.stuck,   tone: 'danger' },
        { label: 'exited',  value: wCounts.exited,  tone: 'neutral' },
        { label: 'killed',  value: wCounts.killed,  tone: 'warn' }
      ], { centerLabel: ws.length === 1 ? 'worker' : 'workers' }));
      summary.appendChild(statusGrid([
        { value: (proj.activeSessions || []).length, label: 'Active sessions', tone: 'accent' },
        { value: wCounts.running,                    label: 'Running workers', tone: 'ok' },
        { value: wCounts.stuck,                      label: 'Stuck workers',   tone: wCounts.stuck > 0 ? 'danger' : 'ok' },
        { value: `${claimedLanes}/${totalLanes}`,    label: 'Lanes claimed',   tone: 'blue' }
      ]));
      summaryMount.appendChild(summary);
    } else {
      summaryMount.appendChild(placeholder('Offline', 'Bridge not reachable.'));
    }

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

// v1.6.0 — Goal panel: objective + measurable success conditions + constraints
// + the curated cross-session handoff. Read-only (GET /bridge/goal). Live ✓/○/?
// success verification is the `maddu orient` CLI's job (running operator verify
// commands on an HTTP GET would be unsafe), so conditions show as declared here.
// renderGoal → moved to cockpit-views-reference.js (v1.47.0); receives the
// shell's panelFocus via ctx (self-registers a command-palette sub-target).

// renderRoadmap � moved to cockpit-views-inspect.js (v1.52.0)  KPIs/cadence/
// lane-mix charts (inline) + a slice index whose rows open the Inspector. Shell
// deps via ctx: panelFocus, fetchProjection, openInspector (no ctx growth).

// ── Docs route ────────────────────────────────────────────────────────────
//
// Reads `<repoRoot>/docs/*.md` (or framework-bundled fallback) via the bridge.
// Sidebar lists every page, right pane renders the chosen one.
//
// URL convention: #/docs                 → opens index (first page)
//                 #/docs?p=<slug>         → opens a specific page

// renderDocs � moved to cockpit-views-docs.js (v1.48.0)  pure move
// (leaves + donut/statusGrid + renderMarkdown + ROUTE_META; route-local
// hashchange listener self-removes on leaving #/docs).

// renderMarkdown → moved to cockpit-markdown.js (v1.42.0).

async function fetchApprovals(scopeRoute) {
  try {
    const url = scopeRoute ? scopedUrl(scopeRoute, '/bridge/approvals') : '/bridge/approvals';
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// postApprovalDecision → moved to cockpit-event-rows.js (v1.41.0).

function renderApprovals() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Approvals'));
  root.appendChild(el('p', {}, ROUTES.approvals.description));

  const pill = scopePill('approvals', () => refresh());
  if (pill) root.appendChild(pill);

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading ledger…'));
  root.appendChild(panelFocus('Summary', 'open queue + decision distribution', summaryMount,
    { id: 'summary', keywords: 'summary open decisions distribution overview' }));

  const openMount = el('div', {});
  openMount.appendChild(loadingFor('table', 'Fetching open approvals…'));
  root.appendChild(panelFocus('Open queue', 'GET /bridge/approvals', openMount,
    { id: 'open-queue', keywords: 'open queue pending awaiting decision' }));

  const ledgerMount = el('div', {});
  root.appendChild(panelFocus('Decision ledger', '.maddu/events/*.ndjson · APPROVAL_DECIDED', ledgerMount,
    { id: 'ledger', keywords: 'ledger decided audit history approval' }));

  const policyMount = el('div', {});
  root.appendChild(panelFocus('Standing policies', 'APPROVAL_POLICY_SET', policyMount,
    { id: 'policies', keywords: 'standing policies allow-always allow-once deny rules' }));

  // Slice 4: global policies — machine-scope rules at
  // ~/.config/maddu/global/policies.json. Auto-decide hits every
  // workspace's spine with a real APPROVAL_DECIDED event tagged
  // triggered_by:{kind:'global_policy', id}.
  const globalPolicyMount = el('div', {});
  root.appendChild(panelFocus('Standing policies (global)', 'GET /bridge/_global/policies', globalPolicyMount,
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
    fetchApprovals('approvals').then((a) => {
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
  const handler = (e) => {
    if (e.detail.type && e.detail.type.startsWith('APPROVAL_')) refresh();
  };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });

  return root;
}

// classifyEvent / summarize / eventRow → moved to cockpit-event-rows.js (v1.41.0).

function renderEvents() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Events'));
  root.appendChild(el('p', {}, ROUTES.events.description));

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

// prepend / makeDecisionButton → moved to cockpit-event-rows.js (v1.41.0).

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

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading mailbox counts…'));
  root.appendChild(panel('Summary', 'unread distribution across lane mailboxes', summaryMount));

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
    summaryMount.innerHTML = '';
    lanesMount.appendChild(loading('Fetching lane mailboxes…'));
    fetchMailboxCounts().then((c) => {
      lanesMount.innerHTML = '';
      summaryMount.innerHTML = '';
      if (!c || Object.keys(c.counts).length === 0) {
        lanesMount.appendChild(placeholder('No lane mailboxes yet', 'Send the first message via `/mail <lane> <subject>` or `maddu mailbox send`.'));
        summaryMount.appendChild(placeholder('No mailboxes', 'Distribution will appear once a lane gets its first message.'));
        return;
      }

      // Summary: totals + per-lane unread bars
      const lanes = Object.keys(c.counts);
      const totalUnread = lanes.reduce((s, l) => s + (c.counts[l].unread || 0), 0);
      const totalMsgs   = lanes.reduce((s, l) => s + (c.counts[l].total || 0), 0);
      const lanesWithUnread = lanes.filter((l) => c.counts[l].unread > 0).length;
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(statusGrid([
        { value: lanes.length,        label: 'Lane mailboxes', tone: 'accent' },
        { value: totalMsgs,           label: 'Total messages', tone: 'blue' },
        { value: totalUnread,         label: 'Unread',         tone: totalUnread > 0 ? 'warn' : 'ok' },
        { value: lanesWithUnread,     label: 'Lanes w/ unread', tone: lanesWithUnread > 0 ? 'warn' : 'ok' }
      ]));
      const bars = el('div', {});
      const sorted = lanes.slice().sort((a, b) => (c.counts[b].unread || 0) - (c.counts[a].unread || 0));
      const maxUnread = Math.max(1, ...sorted.map((l) => c.counts[l].unread || 0));
      for (const lane of sorted.slice(0, 6)) {
        const u = c.counts[lane].unread || 0;
        bars.appendChild(meter(u, maxUnread, lane, { tone: u > 0 ? 'warn' : 'ok' }));
      }
      summary.appendChild(bars);
      summaryMount.appendChild(summary);

      const list = el('div', {});
      for (const lane of Object.keys(c.counts).sort()) {
        const m = c.counts[lane];
        const dot = m.unread > 0 ? '<span class="signal live"></span>' : '<span class="signal"></span>';
        const row = el('div', { class: 'ledger-row', 'data-focus': lane, style: 'cursor:pointer;' + (selectedLane === lane ? 'background:var(--m-bg-3);' : '') }, [
          el('span', { html: dot }),
          el('span', { class: 'event-type' }, lane),
          el('span', { class: m.unread > 0 ? 'event-type t-approval' : 'event-actor' }, m.unread > 0 ? `${m.unread} unread` : 'all read'),
          el('span', { class: 'event-actor' }, `${m.total} total`)
        ]);
        row.addEventListener('click', () => loadMessages(lane));
        list.appendChild(row);
      }
      lanesMount.appendChild(list);
      const f = paletteFocus();
      if (f) {
        if (Object.keys(c.counts).includes(f)) loadMessages(f);
        focusPanelByKeyword(root, f);
      }
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
          el('div', { class: 'task-col-body' }, list.map((x) => taskCard(x, refresh)))
        ]);
        board.appendChild(col);
      }
      boardMount.appendChild(board);
      const f = paletteFocus();
      if (f) focusPanelByKeyword(root, f);
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

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading skill registry…'));
  root.appendChild(panel('Summary', 'gallery composition · tags · provenance', summaryMount));

  let selected = paletteFocus();

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
    summaryMount.innerHTML = '';
    listMount.appendChild(loading('Loading skills…'));
    fetchSkills().then((d) => {
      listMount.innerHTML = '';
      summaryMount.innerHTML = '';
      if (!d || d.skills.length === 0) {
        listMount.appendChild(placeholder('No skills yet', 'Create one above or run `maddu skill from-slice <eventId>`.'));
        summaryMount.appendChild(placeholder('No skills', 'Distill a slice-stop into a skill to populate the gallery.'));
        detailMount.innerHTML = '';
        return;
      }

      // Summary: total · from-slice · distinct tags + tag distribution bars
      const skills = d.skills || [];
      const fromSlice = skills.filter((s) => Array.isArray(s.provenance) && s.provenance.length > 0).length;
      const tagCounts = {};
      for (const s of skills) for (const t of (s.tags || [])) tagCounts[t] = (tagCounts[t] || 0) + 1;
      const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(statusGrid([
        { value: skills.length,             label: 'Skills',            tone: 'accent' },
        { value: fromSlice,                 label: 'From slice-stop',   tone: 'blue' },
        { value: Object.keys(tagCounts).length, label: 'Distinct tags', tone: 'ok' },
        { value: skills.length - fromSlice, label: 'Authored direct',   tone: 'neutral' }
      ]));
      const tagBars = el('div', {});
      if (topTags.length === 0) {
        tagBars.appendChild(placeholder('No tags', 'Tag skills on creation to populate this chart.'));
      } else {
        const maxN = topTags[0][1];
        for (const [tag, n] of topTags) tagBars.appendChild(meter(n, maxN, tag, { tone: 'blue' }));
      }
      summary.appendChild(tagBars);
      summaryMount.appendChild(summary);

      for (const s of d.skills) {
        const isSel = selected === s.id;
        const row = el('div', {
          'data-focus': s.id,
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
      if (!selected || !d.skills.find((s) => s.id === selected)) {
        selected = d.skills[0] && d.skills[0].id;
      }
      if (selected) loadDetail(selected);
      const f = paletteFocus();
      if (f) focusPanelByKeyword(root, f);
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

async function fetchImports() {
  try { const r = await fetch('/bridge/imports', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

function renderImports() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Imports'));
  root.appendChild(el('p', {}, ROUTES.imports.description));

  root.appendChild(el('div', { class: 'panel', style: 'border-left:3px solid var(--m-accent-warm);' }, [
    el('div', { class: 'panel-title', style: 'color:var(--m-accent-warm);' }, 'TOKEN BOUNDARY'),
    el('div', { class: 'event-actor', style: 'margin-top:6px;color:var(--m-fg-2);' },
      'Any payload containing a key-shaped string is rejected entirely. The rejection log records the JSON path and pattern name only — never the value.'
    )
  ]));

  // Compose form
  const kindSel = el('select', { style: 'background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  for (const k of ['skill', 'memory-note', 'lane', 'brief', 'inbox-note']) kindSel.appendChild(el('option', { value: k }, k));
  const ta = el('textarea', {
    rows: '10',
    placeholder: '{\n  "title": "…",\n  "body": "# …\\n…"\n}',
    style: 'width:100%;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:10px;font-family:var(--m-font-mono);font-size:12px;'
  });
  const scanBtn = el('button', {}, 'Scan only');
  const subBtn = el('button', { class: 'btn-allow' }, 'Submit');
  const ctl = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:8px;' }, [
    el('span', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-3);' }, 'kind:'),
    kindSel, scanBtn, subBtn
  ]);
  root.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('span', { class: 'panel-title' }, 'Compose'),
      el('span', { class: 'panel-aside' }, 'POST /bridge/imports')
    ]),
    ta,
    ctl
  ]));

  scanBtn.addEventListener('click', async () => {
    let payload;
    try { payload = JSON.parse(ta.value); } catch (e) { showToast(`JSON parse error: ${e.message}`, 'err'); return; }
    const r = await fetch('/bridge/imports/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload }) });
    const d = await r.json();
    if (d.ok) showToast('✓ clean — safe to submit', 'ok');
    else      showToast(`✗ ${d.hitCount} hit${d.hitCount === 1 ? '' : 's'}\n` + d.hits.map((h) => `  ${h.path}  (${h.pattern})`).join('\n'), 'err');
  });
  subBtn.addEventListener('click', async () => {
    let payload;
    try { payload = JSON.parse(ta.value); } catch (e) { showToast(`JSON parse error: ${e.message}`, 'err'); return; }
    subBtn.disabled = true;
    try {
      const r = await fetch('/bridge/imports', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: kindSel.value, payload, by: composer.currentSession || null })
      });
      const d = await r.json();
      if (d.rejected) {
        showToast(`REJECTED  ${d.id}\n` + d.hits.map((h) => `  ${h.path}  (${h.pattern})`).join('\n'), 'err');
      } else if (d.ok) {
        showToast(`accepted  ${d.id}  ref:${d.refId || '—'}`, 'ok');
        ta.value = '';
      } else {
        showToast(`failed: ${d.error || d.reason}`, 'err');
      }
      refresh();
    } finally { subBtn.disabled = false; }
  });

  const summaryMount = el('div', {}); summaryMount.appendChild(loading('Reading import ledger…'));
  root.appendChild(panel('Summary', 'accepted vs rejected · breakdown by kind', summaryMount));

  const accMount = el('div', {}); accMount.appendChild(loading('Loading…'));
  const rejMount = el('div', {});
  root.appendChild(panel('Accepted', '.maddu/imports/accepted.ndjson', accMount));
  root.appendChild(panel('Rejected (secrets detected)', '.maddu/imports/rejected-secrets.ndjson', rejMount));

  function refresh() {
    fetchImports().then((d) => {
      summaryMount.innerHTML = '';
      accMount.innerHTML = '';
      rejMount.innerHTML = '';
      if (!d) {
        summaryMount.appendChild(placeholder('Offline', 'Bridge not reachable.'));
        accMount.appendChild(placeholder('Offline', 'Bridge not reachable.'));
        return;
      }
      const acc = d.accepted || [];
      const rej = d.rejected || [];
      const byKind = {};
      for (const a of acc) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(donut([
        { label: 'accepted', value: acc.length, tone: 'ok' },
        { label: 'rejected', value: rej.length, tone: 'danger' }
      ], { centerLabel: 'imports' }));
      const bars = el('div', {});
      const total = acc.length + rej.length;
      bars.appendChild(meter(acc.length, total, 'Accepted', { tone: 'ok' }));
      bars.appendChild(meter(rej.length, total, 'Rejected (secrets)', { tone: 'danger' }));
      for (const [kind, n] of Object.entries(byKind)) {
        bars.appendChild(meter(n, acc.length, `Accepted: ${kind}`, { tone: 'blue' }));
      }
      summary.appendChild(bars);
      summaryMount.appendChild(summary);

      if (d.accepted.length === 0) accMount.appendChild(placeholder('No imports yet', 'Compose a payload above and click Submit.'));
      else {
        for (const a of d.accepted) accMount.appendChild(el('div', { class: 'ledger-row' }, [
          el('span', {}, a.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
          el('span', { class: 'event-type t-lane' }, a.kind),
          el('span', {}, [
            el('div', { style: 'color:var(--m-fg-0);' }, a.id),
            el('div', { class: 'event-actor' }, `ref: ${a.refId || '—'}`)
          ]),
          el('span', { class: 'event-actor' }, a.by || '')
        ]));
      }
      if (d.rejected.length === 0) rejMount.appendChild(placeholder('No rejections', 'Good. No secret-shaped payloads attempted.'));
      else {
        for (const r of d.rejected) rejMount.appendChild(el('div', { class: 'ledger-row' }, [
          el('span', {}, r.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')),
          el('span', { class: 'event-type t-approval' }, r.reason),
          el('span', {}, [
            el('div', { style: 'color:var(--m-fg-0);' }, `${r.kind}  ${r.id}`),
            el('div', { class: 'event-actor' }, (r.hits || []).slice(0, 3).map((h) => `${h.path} (${h.pattern})`).join('  ·  ') + (r.hits && r.hits.length > 3 ? `  +${r.hits.length - 3} more` : ''))
          ]),
          el('span', { class: 'event-actor' }, r.hits ? `${r.hits.length} hit${r.hits.length === 1 ? '' : 's'}` : '')
        ]));
      }
    });
  }

  refresh();
  const handler = (e) => { if (e.detail.type && e.detail.type.startsWith('IMPORT_')) refresh(); };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });
  return root;
}

async function fetchAuth() {
  try { const r = await fetch('/bridge/auth', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function fetchAuthProvider(provider) {
  try { const r = await fetch(`/bridge/auth/${encodeURIComponent(provider)}`, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

function renderAuth() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Auth'));
  root.appendChild(el('p', {}, ROUTES.auth.description));

  const note = el('div', { class: 'panel', style: 'border-left:3px solid var(--m-accent-warm);' }, [
    el('div', { class: 'panel-title', style: 'color:var(--m-accent-warm);' }, 'TOKEN BOUNDARY'),
    el('div', { class: 'event-actor', style: 'margin-top:6px;color:var(--m-fg-2);' }, [
      'Raw key values are never returned by /bridge/auth. The cockpit only sees label + last-4 chars. ',
      'To add a key, use the CLI: ',
      el('code', { style: 'color:var(--m-fg-0);' }, 'echo sk-… | maddu auth add <provider> --label "personal"')
    ])
  ]);
  root.appendChild(note);

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading auth state…'));
  root.appendChild(panel('Summary', 'providers · keys · rate-limit state', summaryMount));

  // Honor ?focus=<provider> from the palette — pre-select before first render.
  let selectedProvider = paletteFocus();
  const grid = el('div', { style: 'display:grid;grid-template-columns:280px 1fr;gap:12px;align-items:start;' });
  const listMount = el('div', {});
  const detailMount = el('div', {});
  grid.appendChild(listMount);
  grid.appendChild(detailMount);
  root.appendChild(grid);

  function loadDetail(provider) {
    detailMount.innerHTML = '';
    detailMount.appendChild(loading(`Fetching keys for ${provider}…`));
    fetchAuthProvider(provider).then((d) => {
      detailMount.innerHTML = '';
      if (!d) { detailMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); return; }
      detailMount.appendChild(el('div', { class: 'panel' }, [
        el('div', { class: 'panel-head' }, [
          el('span', { class: 'panel-title' }, provider),
          el('span', { class: 'panel-aside' }, `${d.keys.length} key${d.keys.length === 1 ? '' : 's'} · active …${d.active?.tail || '—'}`)
        ]),
        (() => {
          const wrap = el('div', {});
          for (const k of d.keys) {
            const limited = k.rateLimitedUntil && new Date(k.rateLimitedUntil) > new Date();
            wrap.appendChild(el('div', { class: 'ledger-row' }, [
              el('span', {}, `…${k.tail}`),
              el('span', { class: 'event-type ' + (limited ? 't-approval' : 't-lane') }, limited ? 'rate-limited' : 'ready'),
              el('span', {}, [
                el('div', { style: 'color:var(--m-fg-0);' }, k.label),
                el('div', { class: 'event-actor' }, `${k.id}  ·  added ${k.addedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`)
              ]),
              (() => {
                const wrap = el('span', { style: 'display:flex;gap:4px;' });
                const rate = el('button', {}, '↯ rate-limit');
                rate.addEventListener('click', async () => {
                  if (!confirm(`Mark ${k.label} as rate-limited for 5 minutes?`)) return;
                  await fetch(`/bridge/auth/${encodeURIComponent(provider)}/rate-limit`, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ keyId: k.id, until: new Date(Date.now() + 5 * 60_000).toISOString() })
                  });
                  loadDetail(provider);
                });
                const rm = el('button', { class: 'btn-deny-hard' }, '×');
                rm.addEventListener('click', async () => {
                  if (!confirm(`Remove key ${k.label} (…${k.tail})?`)) return;
                  await fetch(`/bridge/auth/${encodeURIComponent(provider)}/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
                  refresh();
                });
                wrap.appendChild(rate); wrap.appendChild(rm);
                return wrap;
              })()
            ]));
          }
          if (d.keys.length === 0) wrap.appendChild(placeholder('No keys', 'Add via CLI.'));
          return wrap;
        })()
      ]));
    });
  }

  function refresh() {
    listMount.innerHTML = '';
    summaryMount.innerHTML = '';
    listMount.appendChild(loading('Fetching providers…'));
    fetchAuth().then((d) => {
      listMount.innerHTML = '';
      summaryMount.innerHTML = '';
      if (!d || d.providers.length === 0) {
        listMount.appendChild(placeholder('No providers', `Add a key via:\n  maddu auth add anthropic --label personal --value …\n\nStorage path:\n  ${d ? d.storage.path : '(unknown)'}`));
        summaryMount.appendChild(placeholder('No providers', 'Add a key to populate the summary.'));
        detailMount.innerHTML = '';
        return;
      }

      // Summary: total keys / providers / rate-limited count + per-provider bars
      const totalKeys = d.providers.reduce((s, p) => s + (p.keyCount || 0), 0);
      const limited = d.providers.reduce((s, p) => s + (p.rateLimitedCount || 0), 0);
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(statusGrid([
        { value: d.providers.length, label: 'Providers',     tone: 'accent' },
        { value: totalKeys,          label: 'Total keys',    tone: 'blue' },
        { value: limited,            label: 'Rate-limited',  tone: limited > 0 ? 'warn' : 'ok' },
        { value: d.providers.filter((p) => p.keyCount > 0).length, label: 'Active providers', tone: 'ok' }
      ]));
      const bars = el('div', {});
      const maxKeys = Math.max(1, ...d.providers.map((p) => p.keyCount || 0));
      for (const p of d.providers) {
        bars.appendChild(meter(p.keyCount || 0, maxKeys, p.provider, { tone: 'blue' }));
      }
      summary.appendChild(bars);
      summaryMount.appendChild(summary);

      for (const p of d.providers) {
        const isSel = selectedProvider === p.provider;
        const row = el('div', {
          'data-focus': p.provider,
          style: 'padding:8px 10px;border-bottom:1px solid var(--m-line-soft);cursor:pointer;' + (isSel ? 'background:var(--m-bg-3);' : '')
        }, [
          el('div', { style: 'font-family:var(--m-font-cond);color:var(--m-fg-0);font-size:14px;letter-spacing:0.03em;text-transform:uppercase;' }, p.provider),
          el('div', { class: 'event-actor', style: 'margin-top:2px;' }, `${p.keyCount} key${p.keyCount === 1 ? '' : 's'} · active …${p.activeKeyTail || '—'}`)
        ]);
        row.addEventListener('click', () => { selectedProvider = p.provider; refresh(); });
        listMount.appendChild(row);
      }
      if (!selectedProvider || !d.providers.find((p) => p.provider === selectedProvider)) {
        selectedProvider = d.providers[0].provider;
      }
      loadDetail(selectedProvider);
      // Honor palette focus: flash the matching provider row.
      const f = paletteFocus();
      if (f) focusPanelByKeyword(root, f);
    });
  }

  refresh();
  const handler = (e) => { if (e.detail.type && e.detail.type.startsWith('AUTH_KEY_')) refresh(); };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });
  return root;
}

async function fetchSchedules() {
  try { const r = await fetch('/bridge/schedules', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

function renderSchedule() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Schedule'));
  root.appendChild(el('p', {}, ROUTES.schedule.description));

  // Slice 4: scope pill (this workspace vs global). Hidden in legacy
  // single-workspace mode. Global schedules live in
  // ~/.config/maddu/global/schedules.ndjson and fan out to N workspaces.
  const pill = scopePill('schedule', () => renderRoute());
  if (pill) root.appendChild(pill);
  const isGlobal = scopeShouldShow() && getScope('schedule') === 'all';
  const baseUrl = isGlobal ? '/bridge/_global/schedules' : '/bridge/schedules';

  const inpTitle = el('input', { type: 'text', placeholder: 'title (e.g. Daily summary)', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const inpNL = el('input', { type: 'text', placeholder: 'natural (e.g. every evening at 6pm)', style: 'flex:2;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const inpTargets = isGlobal
    ? el('input', { type: 'text', placeholder: 'targets (comma; blank = all)', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' })
    : null;
  const preview = el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);min-width:160px;' }, '');
  const createBtn = el('button', {}, isGlobal ? 'Create (global)' : 'Create');
  const formChildren = [inpTitle, inpNL];
  if (inpTargets) formChildren.push(inpTargets);
  formChildren.push(preview, createBtn);
  const form = el('div', { style: 'display:flex;gap:6px;margin-bottom:12px;align-items:center;' }, formChildren);
  root.appendChild(form);

  // Live preview of NL→cron
  let previewTimer = null;
  inpNL.addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const text = inpNL.value.trim();
      if (!text) { preview.textContent = ''; preview.style.color = 'var(--m-fg-3)'; return; }
      try {
        const r = await fetch(isGlobal ? '/bridge/_global/schedules/parse' : '/bridge/schedules/parse', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ natural: text, text })
        });
        const d = await r.json();
        if (d.cron) { preview.textContent = `→ ${d.cron}`; preview.style.color = 'var(--m-signal)'; }
        else        { preview.textContent = '↪ unparseable'; preview.style.color = 'var(--m-accent-warm)'; }
      } catch { preview.textContent = ''; }
    }, 200);
  });

  createBtn.addEventListener('click', async () => {
    const title = inpTitle.value.trim();
    const nat = inpNL.value.trim();
    if (!title || !nat) return;
    createBtn.disabled = true;
    try {
      const body = { title, natural: nat, by: composer.currentSession || null };
      if (isGlobal && inpTargets) {
        body.targets = inpTargets.value.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const r = await fetch(baseUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.ok) {
        inpTitle.value = ''; inpNL.value = '';
        if (inpTargets) inpTargets.value = '';
        preview.textContent = ''; refresh();
      } else { const d = await r.json().catch(() => ({})); showToast(`create failed: ${d.error || 'unknown'}`, 'err'); }
    } finally { createBtn.disabled = false; }
  });

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading schedules…'));
  root.appendChild(panel('Summary', 'enabled · disabled · fire totals', summaryMount));

  const mount = el('div', {});
  root.appendChild(mount);

  function refresh() {
    mount.innerHTML = '';
    summaryMount.innerHTML = '';
    mount.appendChild(loading('Fetching schedules…'));
    fetch(baseUrl, { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((d) => {
      mount.innerHTML = '';
      summaryMount.innerHTML = '';
      if (!d || d.schedules.length === 0) {
        mount.appendChild(placeholder('No schedules yet', 'Create one above, or via `maddu schedule create --natural "every hour" --title "ping"`.'));
        summaryMount.appendChild(placeholder('No schedules', 'Create one to populate this summary.'));
        return;
      }

      // Summary
      const sch = d.schedules || [];
      const enabled = sch.filter((s) => s.enabled).length;
      const fired = sch.reduce((t, s) => t + (s.fireCount || 0), 0);
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(donut([
        { label: 'enabled',  value: enabled,            tone: 'ok' },
        { label: 'disabled', value: sch.length - enabled, tone: 'neutral' }
      ], { centerLabel: 'schedules' }));
      summary.appendChild(statusGrid([
        { value: sch.length, label: 'Schedules',        tone: 'accent' },
        { value: enabled,    label: 'Enabled',          tone: 'ok' },
        { value: fired,      label: 'Total fires',      tone: 'blue' },
        { value: sch.reduce((m, s) => Math.max(m, s.fireCount || 0), 0), label: 'Top fire count', tone: 'blue' }
      ]));
      summaryMount.appendChild(summary);

      for (const s of d.schedules) {
        const enabled = s.enabled;
        const card = el('div', { class: 'panel', style: enabled ? '' : 'opacity:0.55;' }, [
          el('div', { class: 'panel-head' }, [
            el('span', { class: 'panel-title' }, s.title),
            el('span', { class: 'panel-aside' }, `fired ${s.fireCount} time${s.fireCount === 1 ? '' : 's'}`)
          ]),
          el('dl', { class: 'kv' }, [
            el('dt', {}, 'cron'),    el('dd', {}, s.cron),
            s.natural ? el('dt', {}, 'natural') : null,
            s.natural ? el('dd', {}, s.natural) : null,
            el('dt', {}, 'action'),  el('dd', {}, `${s.action?.kind}: ${s.action?.value || '—'}`),
            isGlobal ? el('dt', {}, 'targets') : null,
            isGlobal ? el('dd', {}, (() => {
              const wrap = el('span', {});
              const ts = (s.targets && s.targets.length) ? s.targets : [];
              if (!ts.length) {
                wrap.appendChild(el('span', { class: 'workspace-badge mono' }, '(all workspaces)'));
              } else {
                for (const t of ts) wrap.appendChild(el('span', { class: 'workspace-badge mono', style: 'margin-right:4px;' }, t));
              }
              return wrap;
            })()) : null,
            el('dt', {}, 'last'),    el('dd', {}, s.lastRun ? s.lastRun.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'),
            el('dt', {}, 'id'),      el('dd', {}, s.id)
          ]),
          (() => {
            const actions = el('div', { style: 'display:flex;gap:6px;margin-top:8px;' });
            const tog = el('button', {}, enabled ? 'Disable' : 'Enable');
            tog.addEventListener('click', async () => {
              tog.disabled = true;
              await fetch(`${baseUrl}/${encodeURIComponent(s.id)}/${enabled ? 'disable' : 'enable'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              refresh();
            });
            const rem = el('button', { class: 'btn-deny-hard' }, 'Remove');
            rem.addEventListener('click', async () => {
              if (!confirm(`Remove schedule "${s.title}"?`)) return;
              await fetch(`${baseUrl}/${encodeURIComponent(s.id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
              refresh();
            });
            actions.appendChild(tog); actions.appendChild(rem);
            return actions;
          })()
        ]);
        mount.appendChild(card);
      }
    });
  }

  refresh();
  const handler = (e) => { if (e.detail.type && e.detail.type.startsWith('SCHEDULE_')) refresh(); };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });
  setTimeout(() => inpTitle.focus(), 0);
  return root;
}

async function fetchMcp() {
  try { const r = await fetch('/bridge/mcp', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

// v1.2.0 Phase 6 — Trust cockpit route. Pulls /bridge/trust and renders the
// supply-chain posture: pin list, last audit, violations, secret-scan
// refusals, worker env policy, MCP provenance distribution, skill
// provenance distribution.
function renderTrust() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Trust'));
  root.appendChild(el('p', {}, ROUTES.trust.description));

  const summaryMount = el('div', {}); summaryMount.appendChild(loading('Loading trust posture…'));
  root.appendChild(panel('Posture', 'Last audit timestamp, pin count, recent violation count', summaryMount));

  const pinsMount = el('div', {});
  root.appendChild(panel('Pinned packages', 'From .maddu/config/trust.json — locked versions', pinsMount));

  const violationsMount = el('div', {});
  root.appendChild(panel('Recent violations (last 20)', 'TRUST_VIOLATION_DETECTED — pin drift or freshness block', violationsMount));

  const secretsMount = el('div', {});
  root.appendChild(panel('Secret refusals (last 20)', 'SECRET_DETECTED_IN_ARGV — pattern type only, never the raw value', secretsMount));

  const envMount = el('div', {});
  root.appendChild(panel('Worker env policy', 'Default-deny on AWS_*, OPENAI_*, GITHUB_TOKEN. Recent WORKER_ENV_FILTERED summaries.', envMount));

  const mcpMount = el('div', {});
  root.appendChild(panel('MCP provenance', 'framework-shipped (hash-verified) vs operator-trusted (approved/pending)', mcpMount));

  const skillsMount = el('div', {});
  root.appendChild(panel('Skill provenance', 'Distribution of provenance across .maddu/skills/', skillsMount));

  function dimBox(text) { return el('div', { style: 'font-size:12px;color:var(--m-fg-2);' }, text); }
  function row(k, v) { return el('div', { style: 'font-family:var(--m-font-mono);font-size:12px;padding:2px 0;' }, `${k}: ${v}`); }

  async function refresh() {
    let data;
    try { data = await (await fetch('/bridge/trust')).json(); }
    catch (err) { summaryMount.innerHTML = ''; summaryMount.appendChild(dimBox('error loading: ' + err.message)); return; }

    summaryMount.innerHTML = '';
    const la = data.lastAudit;
    summaryMount.appendChild(row('last audit', la ? `${la.ts}  audited=${la.data?.audited ?? '?'}  violations=${la.data?.violations ?? 0}  warns=${la.data?.warns ?? 0}` : '— (run `maddu trust audit`)'));
    summaryMount.appendChild(row('pin count', data.pinnedPackages.length));
    summaryMount.appendChild(row('freshness thresholds', `warn=${data.auditThresholds.freshness_warn_days}d  block=${data.auditThresholds.freshness_block_days}d`));

    pinsMount.innerHTML = '';
    if (data.pinnedPackages.length === 0) pinsMount.appendChild(dimBox('(no pins)'));
    for (const p of data.pinnedPackages) {
      pinsMount.appendChild(row(p.name, `@${p.version}${p.sha256 ? ` sha256=${p.sha256.slice(0, 12)}…` : ''}`));
    }

    violationsMount.innerHTML = '';
    if (data.violations.length === 0) violationsMount.appendChild(dimBox('(no recent violations)'));
    for (const v of data.violations) {
      violationsMount.appendChild(row(v.ts, `${v.data?.kind || 'unknown'}  ${v.data?.pkg || '—'}  ${v.data?.detail || ''}`));
    }

    secretsMount.innerHTML = '';
    if (data.secretRefusals.length === 0) secretsMount.appendChild(dimBox('(no secret refusals)'));
    for (const s of data.secretRefusals) {
      secretsMount.appendChild(row(s.ts, `${s.data?.tool || '?'}  pattern=${s.data?.pattern_type || s.data?.patternType || '?'}  argv_index=${s.data?.argv_index ?? s.data?.position ?? '?'}  override=${s.data?.override || 'none'}`));
    }

    envMount.innerHTML = '';
    envMount.appendChild(row('allow', `${data.workerEnvPolicy.allow_count} entries`));
    envMount.appendChild(row('deny',  `${data.workerEnvPolicy.deny_count} entries`));
    envMount.appendChild(row('per-lane overrides', data.workerEnvPolicy.per_lane));
    envMount.appendChild(el('div', { style: 'margin-top:8px;font-weight:bold;' }, 'Recent WORKER_ENV_FILTERED:'));
    if (data.envFiltered.length === 0) envMount.appendChild(dimBox('(no spawns yet)'));
    for (const w of data.envFiltered) {
      envMount.appendChild(row(w.ts, `workerId=${w.data?.workerId}  allowed=${w.data?.allowedCount}  denied=${w.data?.deniedCount}`));
    }

    mcpMount.innerHTML = '';
    mcpMount.appendChild(row('verified events',  data.mcpProvenance.verified));
    mcpMount.appendChild(row('mismatch events',  data.mcpProvenance.mismatch));
    mcpMount.appendChild(row('registered',       data.mcpProvenance.registered));
    mcpMount.appendChild(row('approved',         data.mcpProvenance.approved));
    mcpMount.appendChild(row('pending approval', data.mcpProvenance.pending));

    skillsMount.innerHTML = '';
    for (const [k, v] of Object.entries(data.skillProvenance)) {
      skillsMount.appendChild(row(k, v));
    }
  }
  refresh();
  setInterval(refresh, 15000);
  return root;
}

// v1.1.0 Phase 2 — unified Tools cockpit route.
// renderTools, renderLoops → moved to cockpit-views-reference.js (v1.47.0)
// (pure-leaf views — leaves + route metadata + global fetch, no ctx needed).

// v1.1.0 Phase 5 — Plans + Kanban cockpit route.
function renderPlans() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Plans'));
  root.appendChild(el('p', {}, ROUTES.plans.description));

  const kanbanMount = el('div', {});
  kanbanMount.appendChild(loading('Loading plans + kanban…'));
  root.appendChild(panel('Kanban', 'Now · Next · Blocked · Done (derived from PLAN_* events)', kanbanMount));

  const listMount = el('div', {});
  listMount.appendChild(loading('Loading plan list…'));
  root.appendChild(panel('All plans', 'Open + completed + cancelled (newest first)', listMount));

  fetch('/bridge/plans').then((r) => r.json()).then((d) => {
    kanbanMount.innerHTML = '';
    const k = d.kanban || { now: [], next: [], blocked: [], done: [] };
    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;' });
    for (const [label, items, color] of [['Now', k.now, '#6cf'], ['Next', k.next, '#cb6'], ['Blocked', k.blocked, '#e77'], ['Done', k.done, '#7c7']]) {
      const col = el('div', { style: 'border:1px solid var(--m-line);padding:8px;background:var(--m-bg-2);min-height:120px;' });
      col.appendChild(el('div', { style: `font-family:var(--m-font-mono);font-size:12px;color:${color};margin-bottom:6px;` }, `${label}  (${items.length})`));
      for (const it of items) {
        // v1.2.3 — kanban cards become clickable entity-drawer triggers.
        const card = el('div', {
          class: 'entity-card',
          style: 'background:var(--m-bg-1);padding:5px 7px;margin-bottom:4px;font-size:11px;cursor:pointer;',
          tabindex: '0',
          role: 'button',
          'aria-label': `Open plan ${it.planId || ''}`,
        });
        card.appendChild(el('div', { style: 'font-weight:bold;' }, it.title || '(untitled)'));
        if (it.phase) card.appendChild(el('div', { style: 'color:var(--m-fg-2);' }, '→ ' + it.phase));
        if (it.status) card.appendChild(el('div', { style: 'color:var(--m-fg-2);' }, it.status));
        const openDrawer = () => openPlanDrawer(it.planId);
        card.addEventListener('click', openDrawer);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(); } });
        col.appendChild(card);
      }
      grid.appendChild(col);
    }
    kanbanMount.appendChild(grid);

    listMount.innerHTML = '';
    const plans = d.plans || [];
    if (plans.length === 0) {
      listMount.appendChild(placeholder('No plans yet', 'Create one with `maddu plan new "<title>" --phases "a,b,c"`.'));
    } else {
      const table = el('table', { style: 'width:100%;border-collapse:collapse;font-family:var(--m-font-mono);font-size:12px;' });
      const head = el('tr', {});
      for (const h of ['planId', 'status', 'title', 'phases', 'revs']) {
        head.appendChild(el('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);font-weight:normal;' }, h));
      }
      table.appendChild(head);
      for (const p of plans) {
        // v1.2.3 — plans table rows also open the entity drawer on click/Enter.
        const row = el('tr', {
          class: 'entity-row',
          style: 'cursor:pointer;',
          tabindex: '0',
          role: 'button',
          'aria-label': `Open plan ${p.planId}`,
        });
        row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, p.planId));
        const done = (p.phases || []).filter((x) => x.status === 'completed').length;
        const total = (p.phases || []).length;
        const sColor = p.status === 'completed' ? '#7c7' : (p.status === 'cancelled' ? '#cc8' : '#6cf');
        row.appendChild(el('td', { style: `padding:4px 6px;border-bottom:1px solid var(--m-line);color:${sColor};` }, p.status || 'open'));
        row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);' }, p.title || '(untitled)'));
        row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, `${done}/${total}`));
        row.appendChild(el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--m-line);color:var(--m-fg-2);' }, String(p.revisionCount || 0)));
        const openDrawer = () => openPlanDrawer(p.planId);
        row.addEventListener('click', openDrawer);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(); } });
        table.appendChild(row);
      }
      listMount.appendChild(table);
    }
  }).catch((err) => {
    kanbanMount.innerHTML = '';
    kanbanMount.appendChild(placeholder('Bridge unreachable', err.message));
  });

  return root;
}

// v1.2.3 — fetch single plan and open the entity drawer with structured details.
function openPlanDrawer(planId) {
  if (!planId) return;
  openEntityDrawer({
    title: planId,
    subtitle: 'plan detail',
    body: async () => {
      const r = await fetch(`/bridge/plans/${encodeURIComponent(planId)}`, { cache: 'no-store' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(err.error || `bridge ${r.status}`);
      }
      const state = await r.json();
      const wrap = el('div', { class: 'plan-detail' });

      // Summary line: title + status pill + revision count.
      const sumColor = state.status === 'completed' ? '#7c7' : (state.status === 'cancelled' ? '#cc8' : (state.status === 'blocked' ? '#e77' : '#6cf'));
      const sumRow = el('div', { style: 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:10px;' });
      sumRow.appendChild(el('div', { style: 'font-size:15px;font-weight:600;color:var(--m-fg-0);' }, state.title || '(untitled)'));
      sumRow.appendChild(el('div', { style: `font-family:var(--m-font-mono);font-size:11px;padding:2px 8px;border:1px solid ${sumColor};color:${sumColor};border-radius:3px;` }, state.status || 'open'));
      sumRow.appendChild(el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);' }, `${state.revisionCount || 0} revision(s)`));
      wrap.appendChild(sumRow);

      if (state.goal) {
        wrap.appendChild(el('h4', { style: 'margin:14px 0 4px;color:var(--m-fg-2);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;' }, 'Goal'));
        wrap.appendChild(el('div', { style: 'color:var(--m-fg-1);font-size:13px;margin-bottom:10px;' }, state.goal));
      }

      // Phases — checkboxes-as-glyphs + colored status.
      wrap.appendChild(el('h4', { style: 'margin:14px 0 4px;color:var(--m-fg-2);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;' }, `Phases (${state.phases?.length || 0})`));
      const phases = state.phases || [];
      if (phases.length === 0) {
        wrap.appendChild(el('div', { style: 'color:var(--m-fg-3);font-size:12px;' }, '(no phases — add with `maddu plan add-phase`)'));
      } else {
        const list = el('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
        for (const p of phases) {
          const glyph = p.status === 'completed' ? '✓' : (p.status === 'blocked' ? '◯' : '○');
          const gColor = p.status === 'completed' ? '#7c7' : (p.status === 'blocked' ? '#e77' : 'var(--m-fg-3)');
          const row = el('div', { style: 'display:flex;gap:8px;font-family:var(--m-font-mono);font-size:12px;align-items:baseline;padding:4px 6px;background:var(--m-bg-1);' });
          row.appendChild(el('span', { style: `color:${gColor};` }, glyph));
          row.appendChild(el('span', { style: 'color:var(--m-fg-0);min-width:120px;' }, p.name));
          row.appendChild(el('span', { style: 'color:var(--m-fg-3);flex:1;' }, p.intent || ''));
          if (p.summary) row.appendChild(el('span', { style: 'color:var(--m-fg-2);' }, p.summary));
          if (p.reason && p.status === 'blocked') row.appendChild(el('span', { style: 'color:#e77;' }, `blocked: ${p.reason}`));
          list.appendChild(row);
        }
        wrap.appendChild(list);
      }

      // Revisions — newest first.
      const revs = state.revisions || [];
      if (revs.length) {
        wrap.appendChild(el('h4', { style: 'margin:14px 0 4px;color:var(--m-fg-2);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;' }, `Revisions (${revs.length})`));
        const rlist = el('div', { style: 'display:flex;flex-direction:column;gap:4px;' });
        for (const rev of revs.slice().reverse().slice(0, 20)) {
          const item = el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;padding:4px 6px;background:var(--m-bg-1);' });
          item.appendChild(el('div', { style: 'color:var(--m-fg-3);' }, rev.ts || ''));
          item.appendChild(el('div', { style: 'color:var(--m-fg-1);' }, rev.diff || rev.note || '(no description)'));
          rlist.appendChild(item);
        }
        wrap.appendChild(rlist);
      }

      // Copy plan id button.
      const cpy = el('button', { class: 'entity-drawer-action', type: 'button' }, 'Copy plan id');
      cpy.addEventListener('click', () => copyToClipboardWithToast(state.planId, 'Plan id'));
      const actions = el('div', { style: 'margin-top:14px;display:flex;gap:8px;' }, [cpy]);
      wrap.appendChild(actions);
      return wrap;
    },
  });
}

function renderMcp() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'MCP Registry'));
  root.appendChild(el('p', {}, ROUTES.mcp.description));

  // Compact register form
  const nname = el('input', { type: 'text', placeholder: 'name', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const ntr = el('select', { style: 'background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  for (const t of ['stdio', 'sse', 'http']) ntr.appendChild(el('option', { value: t }, t));
  const ncmd = el('input', { type: 'text', placeholder: 'command (stdio) or url (sse/http)', style: 'flex:2;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const nargs = el('input', { type: 'text', placeholder: 'args (comma, stdio only)', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const nlanes = el('input', { type: 'text', placeholder: 'lanes (comma, * = any)', style: 'width:140px;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const nbtn = el('button', {}, 'Register');
  const form = el('div', { style: 'display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;' }, [nname, ntr, ncmd, nargs, nlanes, nbtn]);
  const allBtn = el('button', {}, 'Test all');
  const tools = el('div', { style: 'display:flex;gap:6px;margin-bottom:12px;' }, [allBtn]);
  root.appendChild(form);
  root.appendChild(tools);

  nbtn.addEventListener('click', async () => {
    const name = nname.value.trim();
    if (!name) return;
    const transport = ntr.value;
    const body = {
      name,
      transport,
      enabled: true,
      lanes: nlanes.value.split(',').map((x) => x.trim()).filter(Boolean).length
        ? nlanes.value.split(',').map((x) => x.trim()).filter(Boolean)
        : ['*'],
      by: composer.currentSession || null
    };
    if (transport === 'stdio') {
      body.stdio = {
        command: ncmd.value.trim() || null,
        args: nargs.value.split(',').map((x) => x.trim()).filter(Boolean),
        env: []
      };
    } else if (transport === 'sse') {
      body.sse = { url: ncmd.value.trim() || null };
    } else if (transport === 'http') {
      body.http = { url: ncmd.value.trim() || null };
    }
    nbtn.disabled = true;
    try {
      await fetch('/bridge/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      nname.value = ''; ncmd.value = ''; nargs.value = ''; nlanes.value = '';
      refresh();
    } finally { nbtn.disabled = false; }
  });
  allBtn.addEventListener('click', async () => {
    allBtn.disabled = true; allBtn.textContent = 'Testing…';
    try { await fetch('/bridge/mcp/test-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); refresh(); }
    finally { allBtn.disabled = false; allBtn.textContent = 'Test all'; }
  });

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading MCP registry…'));
  root.appendChild(panel('Summary', 'transports · enabled · health', summaryMount));

  const mount = el('div', {});
  root.appendChild(mount);

  function refresh() {
    mount.innerHTML = '';
    summaryMount.innerHTML = '';
    mount.appendChild(loading('Fetching MCP registry…'));
    fetchMcp().then((d) => {
      mount.innerHTML = '';
      summaryMount.innerHTML = '';
      if (!d || d.mcp.length === 0) {
        mount.appendChild(placeholder('No MCP servers registered', 'Register one above, or via `maddu mcp register`.'));
        summaryMount.appendChild(placeholder('No MCP servers', 'Register one to populate this summary.'));
        return;
      }

      // Summary
      const mcp = d.mcp || [];
      const enabled = mcp.filter((s) => s.enabled).length;
      const transports = { stdio: 0, sse: 0, http: 0, other: 0 };
      for (const s of mcp) (transports[s.transport] != null ? transports[s.transport]++ : transports.other++);
      const health = d.health || {};
      const ok = Object.values(health).filter((h) => h && h.ok).length;
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(donut([
        { label: 'stdio', value: transports.stdio, tone: 'accent' },
        { label: 'sse',   value: transports.sse,   tone: 'blue' },
        { label: 'http',  value: transports.http,  tone: 'ok' },
        { label: 'other', value: transports.other, tone: 'neutral' }
      ], { centerLabel: 'servers' }));
      summary.appendChild(statusGrid([
        { value: mcp.length,           label: 'Registered',    tone: 'accent' },
        { value: enabled,              label: 'Enabled',       tone: 'ok' },
        { value: ok,                   label: 'Healthy',       tone: ok > 0 ? 'ok' : 'neutral' },
        { value: mcp.length - enabled, label: 'Disabled',      tone: 'neutral' }
      ]));
      summaryMount.appendChild(summary);

      for (const r of d.mcp) {
        const h = (d.health || {})[r.name];
        const enabled = r.enabled;
        const status = h?.ok ? `<span class="signal live"></span>${h.status || h.note || 'ok'}` :
                       h ? `<span class="signal"></span>${h.error || ('status ' + h.status)}` :
                       `<span class="signal"></span>${enabled ? 'untested' : 'disabled'}`;
        const detailLine = r.transport === 'stdio'
          ? `${r.stdio?.command || '—'}  ${(r.stdio?.args || []).join(' ')}`
          : `${r[r.transport]?.url || '—'}`;
        const card = el('div', { class: 'panel', 'data-focus': r.name, style: enabled ? '' : 'opacity:0.55;' }, [
          el('div', { class: 'panel-head' }, [
            el('span', { class: 'panel-title' }, r.displayName || r.name),
            el('span', { class: 'panel-aside', html: status })
          ]),
          el('dl', { class: 'kv' }, [
            el('dt', {}, 'name'),      el('dd', {}, r.name),
            el('dt', {}, 'transport'), el('dd', {}, r.transport),
            el('dt', {}, 'lanes'),     el('dd', {}, (r.lanes || ['*']).join(', ')),
            el('dt', {}, r.transport === 'stdio' ? 'command' : 'url'), el('dd', {}, detailLine),
            r.notes ? el('dt', {}, 'notes') : null,
            r.notes ? el('dd', {}, r.notes) : null
          ]),
          (() => {
            const actions = el('div', { style: 'display:flex;gap:6px;margin-top:8px;' });
            const tog = el('button', {}, enabled ? 'Disable' : 'Enable');
            tog.addEventListener('click', async () => {
              tog.disabled = true;
              await fetch(`/bridge/mcp/${encodeURIComponent(r.name)}/${enabled ? 'disable' : 'enable'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              refresh();
            });
            const tst = el('button', { class: 'btn-allow' }, 'Test');
            tst.addEventListener('click', async () => {
              tst.disabled = true; tst.textContent = '…';
              await fetch(`/bridge/mcp/${encodeURIComponent(r.name)}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              refresh();
            });
            const rem = el('button', { class: 'btn-deny-hard' }, 'Remove');
            rem.addEventListener('click', async () => {
              if (!confirm(`Remove MCP server "${r.name}"?`)) return;
              await fetch(`/bridge/mcp/${encodeURIComponent(r.name)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
              refresh();
            });
            actions.appendChild(tog); actions.appendChild(tst); actions.appendChild(rem);
            return actions;
          })()
        ]);
        mount.appendChild(card);
      }
      const f = paletteFocus();
      if (f) focusPanelByKeyword(root, f);
    });
  }

  refresh();
  const handler = (e) => { if (e.detail.type && e.detail.type.startsWith('MCP_')) refresh(); };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });
  return root;
}

async function fetchRuntimes() {
  try { const r = await fetch('/bridge/runtimes', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

function renderRuntimes() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Runtimes'));
  root.appendChild(el('p', {}, ROUTES.runtimes.description));

  // Register form
  const nname = el('input', { type: 'text', placeholder: 'name (e.g. claude-code)', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const nbin = el('input', { type: 'text', placeholder: 'binary', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const nargs = el('input', { type: 'text', placeholder: 'args (comma)', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const ndet = el('input', { type: 'text', placeholder: 'detect command (e.g. claude --version)', style: 'flex:2;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const nbtn = el('button', {}, 'Register');
  const form = el('div', { style: 'display:flex;gap:6px;margin-bottom:8px;' }, [nname, nbin, nargs, ndet, nbtn]);
  const allBtn = el('button', {}, 'Detect all');
  const tools = el('div', { style: 'display:flex;gap:6px;margin-bottom:12px;' }, [allBtn]);
  root.appendChild(form);
  root.appendChild(tools);

  nbtn.addEventListener('click', async () => {
    const name = nname.value.trim();
    if (!name) return;
    nbtn.disabled = true;
    try {
      await fetch('/bridge/runtimes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          binary: nbin.value.trim() || null,
          args: nargs.value.split(',').map((x) => x.trim()).filter(Boolean),
          detect: { command: ndet.value.trim() || null, expectExit: 0 },
          by: composer.currentSession || null
        })
      });
      nname.value = ''; nbin.value = ''; nargs.value = ''; ndet.value = '';
      refresh();
    } finally { nbtn.disabled = false; }
  });
  allBtn.addEventListener('click', async () => {
    allBtn.disabled = true; allBtn.textContent = 'Detecting…';
    try { await fetch('/bridge/runtimes/detect-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); refresh(); }
    finally { allBtn.disabled = false; allBtn.textContent = 'Detect all'; }
  });

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading runtime adapters…'));
  root.appendChild(panel('Summary', 'detected · capabilities · spawn surface', summaryMount));

  const mount = el('div', {});
  root.appendChild(mount);

  function refresh() {
    mount.innerHTML = '';
    summaryMount.innerHTML = '';
    mount.appendChild(loading('Fetching runtimes…'));
    fetchRuntimes().then((d) => {
      mount.innerHTML = '';
      summaryMount.innerHTML = '';
      if (!d || d.runtimes.length === 0) {
        mount.appendChild(placeholder('No runtimes registered', 'Register one above, or via `maddu runtime register --name … --binary …`.'));
        summaryMount.appendChild(placeholder('No runtimes', 'Register one to populate this summary.'));
        return;
      }

      // Summary
      const rts = d.runtimes || [];
      const health = d.health || {};
      const detected = rts.filter((r) => health[r.name]?.ok).length;
      const capMcp = rts.filter((r) => r.capabilities?.mcp).length;
      const capTools = rts.filter((r) => r.capabilities?.tools).length;
      const capStreaming = rts.filter((r) => r.capabilities?.streaming).length;
      const summary = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center;' });
      summary.appendChild(donut([
        { label: 'detected',     value: detected,           tone: 'ok' },
        { label: 'not detected', value: rts.length - detected, tone: 'neutral' }
      ], { centerLabel: 'runtimes' }));
      const bars = el('div', {});
      bars.appendChild(meter(detected, rts.length, 'Detected on host', { tone: 'ok' }));
      bars.appendChild(meter(capMcp, rts.length, 'MCP capable', { tone: 'blue' }));
      bars.appendChild(meter(capTools, rts.length, 'Tools capable', { tone: 'accent' }));
      bars.appendChild(meter(capStreaming, rts.length, 'Streaming capable', { tone: 'blue' }));
      summary.appendChild(bars);
      summaryMount.appendChild(summary);

      for (const r of d.runtimes) {
        const h = (d.health || {})[r.name];
        const status = h?.ok ? `<span class="signal live"></span>${h.version || 'detected'}` :
                       h ? `<span class="signal"></span>${h.error || 'exit ' + h.exitCode}` :
                       `<span class="signal"></span>not detected`;
        const card = el('div', { class: 'panel', 'data-focus': r.name }, [
          el('div', { class: 'panel-head' }, [
            el('span', { class: 'panel-title' }, r.displayName || r.name),
            el('span', { class: 'panel-aside', html: status })
          ]),
          el('dl', { class: 'kv' }, [
            el('dt', {}, 'name'),         el('dd', {}, r.name),
            el('dt', {}, 'binary'),       el('dd', {}, r.binary || '—'),
            el('dt', {}, 'args'),         el('dd', {}, (r.args || []).join(' ') || '—'),
            el('dt', {}, 'protocol'),     el('dd', {}, r.protocol || '—'),
            el('dt', {}, 'capabilities'), el('dd', {}, `mcp:${r.capabilities?.mcp ? 'yes' : 'no'}  tools:${r.capabilities?.tools ? 'yes' : 'no'}  streaming:${r.capabilities?.streaming ? 'yes' : 'no'}  approval:${r.capabilities?.approval || '—'}`),
            el('dt', {}, 'detect'),       el('dd', {}, r.detect?.command || '—'),
            r.notes ? el('dt', {}, 'notes') : null,
            r.notes ? el('dd', {}, r.notes) : null
          ]),
          (() => {
            const actions = el('div', { style: 'display:flex;gap:6px;margin-top:8px;' });
            const det = el('button', {}, 'Detect');
            det.addEventListener('click', async () => {
              det.disabled = true; det.textContent = '…';
              await fetch(`/bridge/runtimes/${encodeURIComponent(r.name)}/detect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              refresh();
            });
            const spw = el('button', { class: 'btn-allow' }, 'Spawn');
            spw.addEventListener('click', async () => {
              spw.disabled = true; spw.textContent = '…';
              try {
                const rr = await fetch(`/bridge/runtimes/${encodeURIComponent(r.name)}/spawn`, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId: composer.currentSession || null })
                });
                const o = await rr.json();
                spw.textContent = o.ok ? `✓ ${o.workerId.slice(-12)}` : '✗';
              } catch { spw.textContent = '✗'; }
              setTimeout(() => { spw.disabled = false; spw.textContent = 'Spawn'; }, 2000);
            });
            const rem = el('button', { class: 'btn-deny-hard' }, 'Remove');
            rem.addEventListener('click', async () => {
              if (!confirm(`Remove runtime "${r.name}"?`)) return;
              await fetch(`/bridge/runtimes/${encodeURIComponent(r.name)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
              refresh();
            });
            actions.appendChild(det); actions.appendChild(spw); actions.appendChild(rem);
            return actions;
          })()
        ]);
        mount.appendChild(card);
      }
      const f = paletteFocus();
      if (f) focusPanelByKeyword(root, f);
    });
  }

  refresh();
  const handler = (e) => { if (e.detail.type && (e.detail.type.startsWith('RUNTIME_') || e.detail.type.startsWith('WORKER_'))) refresh(); };
  stream.bus.addEventListener('event', handler);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', handler), { once: true });
  return root;
}

// renderSearch → moved to cockpit-views-reference.js (v1.47.0)
// (pure-leaf view — leaves + route metadata + global fetch).

function renderSettings() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Settings'));
  root.appendChild(el('p', {}, ROUTES.settings.description));

  // Each panel below uses panelFocus() — stamps data-focus and registers
  // the sub-target. Keys match SUB_TARGET_MANIFEST.settings for parity.
  const bridgeMount = el('div', {});
  bridgeMount.appendChild(loading('Reading bridge status…'));
  root.appendChild(panelFocus('Bridge', 'GET /bridge/status', bridgeMount,
    { id: 'bridge', keywords: 'bridge http server port host status uptime version' }));

  const lanesMount = el('div', {});
  lanesMount.appendChild(loading('Fetching lane catalog…'));
  root.appendChild(panelFocus('Lanes', 'GET /bridge/lanes  ·  edit .maddu/lanes/catalog.json', lanesMount,
    { id: 'lanes', keywords: 'lanes zones lease handoff policy catalog' }));

  const authMount = el('div', {});
  authMount.appendChild(loading('Fetching providers…'));
  root.appendChild(panelFocus('Providers', 'GET /bridge/auth  ·  full management in /auth', authMount,
    { id: 'providers', keywords: 'providers anthropic openai api keys credentials oauth tokens' }));

  const mcpMount = el('div', {});
  mcpMount.appendChild(loading('Fetching MCP registry…'));
  root.appendChild(panelFocus('MCP registry', 'GET /bridge/mcp  ·  full management in /mcp', mcpMount,
    { id: 'mcp', keywords: 'mcp model-context-protocol servers tools stdio sse' }));

  const rtMount = el('div', {});
  rtMount.appendChild(loading('Fetching runtimes…'));
  root.appendChild(panelFocus('Runtimes', 'GET /bridge/runtimes  ·  full management in /runtimes', rtMount,
    { id: 'runtimes', keywords: 'runtimes workers claude codex hermes spawn subprocess' }));

  // ── Integrations (Telegram / Discord / Email) — provided by the `comms`
  // plugin. Shown only when the plugin is enabled (GET /bridge/plugins), so a
  // disabled plugin contributes zero cockpit weight. A slot keeps panel order
  // stable while the enabled-state is fetched asynchronously.
  const commsSlot = el('div', {});
  root.appendChild(commsSlot);
  (async () => {
    let enabled = false;
    try {
      const r = await fetch('/bridge/plugins', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); enabled = (j.plugins || []).some((p) => p.name === 'comms' && p.enabled); }
    } catch {}
    if (!enabled) {
      commsSlot.appendChild(panelFocus('Integrations (comms plugin)',
        'Telegram / Discord / Email — disabled. Enable with `maddu plugin enable comms`, then restart the bridge.',
        el('div', {}),
        { id: 'comms', keywords: 'telegram discord email comms plugin integrations notifications disabled enable' }));
      return;
    }
    const tgMount = el('div', {});
    tgMount.appendChild(loading('Reading Telegram status…'));
    commsSlot.appendChild(panelFocus('Telegram bridge', 'optional · long-poll, allowlisted · message bodies route via Telegram', tgMount,
      { id: 'telegram', keywords: 'telegram tg messenger chat phone notification mobile bot integrations' }));
    renderTelegramPanel(tgMount);

    const dcMount = el('div', {});
    dcMount.appendChild(loading('Reading Discord status…'));
    commsSlot.appendChild(panelFocus('Discord bridge', 'optional · outbound-only (no gateway) · message bodies route via Discord', dcMount,
      { id: 'discord', keywords: 'discord channel server guild bot integrations notifications' }));
    renderDiscordPanel(dcMount);

    const emMount = el('div', {});
    emMount.appendChild(loading('Reading email status…'));
    commsSlot.appendChild(panelFocus('Email bridge', 'optional · outbound-only SMTP · TLS required (port 465/587)', emMount,
      { id: 'email', keywords: 'email smtp mail gmail outlook fastmail notifications outbound webhook imap' }));
    renderEmailPanel(emMount);
  })();

  const pathsMount = el('div', {});
  pathsMount.appendChild(loading('Resolving paths…'));
  root.appendChild(panelFocus('Storage paths', 'Resolved at bridge boot', pathsMount,
    { id: 'paths', keywords: 'storage paths repo state cockpit directory' }));

  // ── Hard rules + docs deep-link ─────────────────────────────────────
  const rulesBody = el('div', {});
  rulesBody.appendChild(el('p', { html:
    'Máddu enforces eight invariants: files-only state, append-only spine, no hosted backends, no broad deps, no provider SDKs in app code, no token export, three-layer brand boundary, lane ownership. ' +
    '<a href="#/docs?p=hard-rules" style="color:var(--m-accent-2)">Read the full rationale →</a>'
  }));
  const ruleBtns = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;' });
  for (const [label, slug] of [
    ['Hard rules', 'hard-rules'],
    ['Getting started', '01-getting-started'],
    ['Concepts', '02-concepts'],
    ['CLI reference', '03-cli-reference'],
    ['Architecture', '15-architecture']
  ]) {
    const b = el('button', {}, label);
    b.addEventListener('click', () => { location.hash = `#/docs?p=${slug}`; });
    ruleBtns.appendChild(b);
  }
  rulesBody.appendChild(ruleBtns);
  root.appendChild(panelFocus('Hard rules · Docs', 'Open the manual', rulesBody,
    { id: 'hardrules', keywords: 'hard rules invariants compliance security boundary files-only sqlite hosted deps sdk token export brand lane ownership' }));

  // Honor ?focus=<keyword> from the palette — placed last so every panel
  // is in the DOM before the scroll-flash fires.
  const focus = paletteFocus();
  if (focus) focusPanelByKeyword(root, focus);

  (async () => {
    // Bridge
    try {
      const r = await fetch('/bridge/status', { cache: 'no-store' });
      const s = r.ok ? await r.json() : null;
      bridgeMount.innerHTML = '';
      if (!s) { bridgeMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); }
      else {
        bridgeMount.appendChild(el('dl', { class: 'kv' }, [
          el('dt', {}, 'status'),   el('dd', { html: '<span class="signal live"></span>online' }),
          el('dt', {}, 'version'),  el('dd', {}, s.version || '—'),
          el('dt', {}, 'host'),     el('dd', {}, `${s.host || '127.0.0.1'}:${s.port || '4177'}`),
          el('dt', {}, 'uptime'),   el('dd', {}, formatUptime(s.uptimeMs)),
          el('dt', {}, 'pid'),      el('dd', {}, String(s.pid || '—'))
        ]));
      }
    } catch (e) { bridgeMount.innerHTML = ''; bridgeMount.appendChild(placeholder('Offline', String(e))); }

    // Storage paths (from same status response)
    try {
      const r = await fetch('/bridge/status', { cache: 'no-store' });
      const s = r.ok ? await r.json() : null;
      pathsMount.innerHTML = '';
      if (!s) { pathsMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); }
      else {
        pathsMount.appendChild(el('dl', { class: 'kv' }, [
          el('dt', {}, 'repo root'),   el('dd', {}, s.repoRoot || '—'),
          el('dt', {}, 'state dir'),   el('dd', {}, s.stateDir || '—'),
          el('dt', {}, 'cockpit dir'), el('dd', {}, s.cockpitDir || '—'),
          el('dt', {}, 'auth dir'),    el('dd', {}, s.authDir || '~/.config/maddu/auth/  ·  %APPDATA%\\maddu\\auth\\ on Windows')
        ]));
      }
    } catch (e) { pathsMount.innerHTML = ''; pathsMount.appendChild(placeholder('Offline', String(e))); }

    // Lanes — editable defaults table (runtime + model bindings per lane).
    let availableRuntimes = [];
    try {
      const rtR = await fetch('/bridge/runtimes', { cache: 'no-store' });
      const rtD = rtR.ok ? await rtR.json() : null;
      availableRuntimes = (rtD && rtD.runtimes) ? rtD.runtimes.map((r) => r.name) : [];
    } catch {}

    function renderLanes() {
      return (async () => {
        const r = await fetch('/bridge/lanes', { cache: 'no-store' });
        const d = r.ok ? await r.json() : null;
        lanesMount.innerHTML = '';
        if (!d) { lanesMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); return; }
        const lanes = (d.catalog && d.catalog.lanes) || [];
        const claims = new Map((d.claims || []).map((c) => [c.lane, c]));
        const withDefaults = lanes.filter((l) => l.defaults && Object.keys(l.defaults).length > 0).length;

        const head = el('div', { style: 'margin-bottom:10px;color:var(--m-fg-2);font-size:13px;display:flex;justify-content:space-between;align-items:center;' }, [
          el('span', {}, `${lanes.length} lane${lanes.length === 1 ? '' : 's'}  ·  ${d.claims?.length || 0} claimed  ·  ${withDefaults} with runtime bindings`),
          (() => {
            const btn = el('button', {}, 'Open Swarm →');
            btn.addEventListener('click', () => { location.hash = '#/swarm'; });
            return btn;
          })()
        ]);
        lanesMount.appendChild(head);

        if (lanes.length === 0) {
          lanesMount.appendChild(placeholder('No lanes', 'Define lanes in .maddu/lanes/catalog.json.'));
        } else {
          const table = el('div', { class: 'lanes-table' });
          for (const l of lanes) {
            const claim = claims.get(l.id);
            const def = l.defaults || {};
            const row = el('div', { class: 'lanes-row' });

            // Lane id + scope
            row.appendChild(el('div', { class: 'lanes-cell lanes-cell-id' }, [
              el('div', { class: 'lanes-id' }, l.id),
              el('div', { class: 'lanes-scope' }, l.scope || '(no scope)')
            ]));

            // Claim status
            row.appendChild(el('div', { class: 'lanes-cell lanes-cell-claim' }, claim
              ? el('span', { class: 'lanes-claim-pill warn' }, `claimed · ${claim.sessionId.slice(-12)}`)
              : el('span', { class: 'lanes-claim-pill ok' }, 'free')));

            // Defaults (read mode) + edit affordance
            const defRead = el('div', { class: 'lanes-cell lanes-cell-defaults' });
            const summary = def.runtime || def.model || def.provider
              ? `${def.runtime || '—'}  ·  ${def.model || '—'}` + (def.provider ? `  ·  ${def.provider}` : '')
              : el('span', { style: 'color:var(--m-fg-3)' }, 'inherit global default');
            const summarySpan = typeof summary === 'string' ? el('span', { class: 'lanes-defaults-summary' }, summary) : summary;
            const editBtn = el('button', { class: 'lanes-edit-btn' }, def.runtime || def.model ? 'Edit' : 'Bind');
            defRead.appendChild(summarySpan);
            defRead.appendChild(editBtn);
            row.appendChild(defRead);

            // Edit form (hidden until clicked)
            const editForm = el('div', { class: 'lanes-edit-form', style: 'display:none;' });
            const rtSel = el('select', { class: 'lanes-edit-select' });
            rtSel.appendChild(el('option', { value: '' }, '— inherit —'));
            for (const rt of availableRuntimes) {
              const opt = el('option', { value: rt }, rt);
              if (def.runtime === rt) opt.selected = true;
              rtSel.appendChild(opt);
            }
            const modelInp = el('input', { type: 'text', class: 'lanes-edit-input', placeholder: 'model (e.g. claude-opus-4-7)', value: def.model || '' });
            const provInp = el('input', { type: 'text', class: 'lanes-edit-input lanes-edit-input-narrow', placeholder: 'provider', value: def.provider || '' });
            const saveBtn = el('button', { class: 'btn-allow' }, 'Save');
            const cancelBtn = el('button', {}, 'Cancel');
            const removeBtn = el('button', { class: 'btn-deny-hard' }, '×');
            editForm.appendChild(rtSel);
            editForm.appendChild(modelInp);
            editForm.appendChild(provInp);
            editForm.appendChild(saveBtn);
            editForm.appendChild(cancelBtn);
            editForm.appendChild(removeBtn);

            editBtn.addEventListener('click', () => {
              defRead.style.display = 'none';
              editForm.style.display = 'flex';
            });
            cancelBtn.addEventListener('click', () => {
              defRead.style.display = '';
              editForm.style.display = 'none';
            });
            saveBtn.addEventListener('click', async () => {
              saveBtn.disabled = true;
              try {
                const resp = await fetch('/bridge/lanes/defaults', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    lane: l.id,
                    runtime: rtSel.value || null,
                    model: modelInp.value.trim() || null,
                    provider: provInp.value.trim() || null
                  })
                });
                if (resp.ok) { showToast(`Saved defaults for ${l.id}`, 'ok'); renderLanes(); }
                else { const e = await resp.json().catch(() => ({})); showToast(`save failed: ${e.error || resp.status}`, 'err'); }
              } finally { saveBtn.disabled = false; }
            });
            removeBtn.addEventListener('click', async () => {
              if (!confirm(`Remove lane "${l.id}"? This rewrites catalog.json. Refuses if currently claimed.`)) return;
              const resp = await fetch(`/bridge/lanes/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
              const e = resp.ok ? null : (await resp.json().catch(() => ({})));
              if (resp.ok) { showToast(`Removed lane ${l.id}`, 'ok'); renderLanes(); }
              else showToast(`remove failed: ${e?.error || resp.status}`, 'err');
            });

            row.appendChild(editForm);

            // ── Claim policy strip (Slice β) ──
            const pol = l.policy || {};
            const policyRow = el('div', { class: 'lanes-policy-row' });
            policyRow.appendChild(el('span', { class: 'lanes-policy-label' }, 'claim policy'));
            const zonesInp = el('input', {
              type: 'text', class: 'lanes-edit-input',
              placeholder: 'zones (comma-sep, e.g. src/auth/**, server/**)',
              value: Array.isArray(pol.zones) ? pol.zones.join(', ') : ''
            });
            const leaseInp = el('input', {
              type: 'number', class: 'lanes-edit-input lanes-edit-input-narrow',
              placeholder: 'lease s', min: '60', step: '60',
              value: pol.leaseSeconds || ''
            });
            const handoffSel = el('select', { class: 'lanes-edit-select' });
            for (const opt of ['manual', 'auto', 'refuse']) {
              const o = el('option', { value: opt }, `handoff: ${opt}`);
              if ((pol.handoffRule || 'manual') === opt) o.selected = true;
              handoffSel.appendChild(o);
            }
            const polSaveBtn = el('button', { class: 'btn-allow' }, 'Save policy');
            polSaveBtn.addEventListener('click', async () => {
              polSaveBtn.disabled = true;
              try {
                const zones = zonesInp.value.split(',').map((s) => s.trim()).filter(Boolean);
                const leaseSeconds = leaseInp.value ? Number(leaseInp.value) : null;
                const resp = await fetch(`/bridge/lanes/${encodeURIComponent(l.id)}/policy`, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ zones, leaseSeconds, handoffRule: handoffSel.value })
                });
                if (resp.ok) { showToast(`Policy saved for ${l.id}`, 'ok'); renderLanes(); }
                else { const e = await resp.json().catch(() => ({})); showToast(`policy save failed: ${e.error || resp.status}`, 'err'); }
              } finally { polSaveBtn.disabled = false; }
            });
            policyRow.appendChild(zonesInp);
            policyRow.appendChild(leaseInp);
            policyRow.appendChild(handoffSel);
            policyRow.appendChild(polSaveBtn);
            row.appendChild(policyRow);

            table.appendChild(row);
          }
          lanesMount.appendChild(table);
        }

        // Add-lane form
        const addWrap = el('div', { class: 'lanes-add' });
        const idInp = el('input', { type: 'text', placeholder: 'new-lane-id', class: 'lanes-edit-input lanes-edit-input-narrow' });
        const scopeInp = el('input', { type: 'text', placeholder: 'scope description', class: 'lanes-edit-input' });
        const addBtn = el('button', { class: 'btn-allow' }, 'Add lane');
        addBtn.addEventListener('click', async () => {
          const id = idInp.value.trim();
          if (!id) return;
          addBtn.disabled = true;
          try {
            const resp = await fetch('/bridge/lanes', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, scope: scopeInp.value.trim() })
            });
            if (resp.ok) { showToast(`Added lane ${id}`, 'ok'); idInp.value = ''; scopeInp.value = ''; renderLanes(); }
            else { const e = await resp.json().catch(() => ({})); showToast(`add failed: ${e.error || resp.status}`, 'err'); }
          } finally { addBtn.disabled = false; }
        });
        addWrap.appendChild(idInp);
        addWrap.appendChild(scopeInp);
        addWrap.appendChild(addBtn);
        lanesMount.appendChild(addWrap);
      })().catch((e) => { lanesMount.innerHTML = ''; lanesMount.appendChild(placeholder('Offline', String(e))); });
    }
    renderLanes();

    // Auth / providers
    try {
      const r = await fetch('/bridge/auth', { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      authMount.innerHTML = '';
      if (!d) { authMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); }
      else {
        const providers = d.providers || [];
        const head = el('div', { style: 'margin-bottom:8px;color:var(--m-fg-2);font-size:13px;' },
          `${providers.length} provider${providers.length === 1 ? '' : 's'}  ·  tokens stay device-bound (rule #6)`);
        authMount.appendChild(head);
        if (providers.length === 0) {
          authMount.appendChild(placeholder('No providers', 'Sign in via /auth or `maddu auth add --provider <p> --key …`.'));
        } else {
          const kv = el('dl', { class: 'kv' });
          for (const p of providers) {
            const keys = p.keys || [];
            const active = keys.find((k) => k.active);
            const dot = keys.length > 0 ? '<span class="signal live"></span>' : '<span class="signal"></span>';
            kv.appendChild(el('dt', { html: `${dot}${p.name}` }));
            kv.appendChild(el('dd', { html:
              keys.length === 0 ? '<span style="color:var(--m-fg-3)">no keys</span>'
                : `${keys.length} key${keys.length === 1 ? '' : 's'}` +
                  (active ? ` · active …${(active.last4 || '????')}` : '') +
                  (p.rateLimited ? ' · <span style="color:var(--m-warn)">rate-limited</span>' : '')
            }));
          }
          authMount.appendChild(kv);
        }
        const btn = el('button', {}, 'Open Auth →');
        btn.style.marginTop = '8px';
        btn.addEventListener('click', () => { location.hash = '#/auth'; });
        authMount.appendChild(btn);
      }
    } catch (e) { authMount.innerHTML = ''; authMount.appendChild(placeholder('Offline', String(e))); }

    // MCP — inline enable/disable + open-in-/mcp deep-link
    function renderMcpPanel() {
      return (async () => {
        const r = await fetch('/bridge/mcp', { cache: 'no-store' });
        const d = r.ok ? await r.json() : null;
        mcpMount.innerHTML = '';
        if (!d) { mcpMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); return; }
        const servers = d.mcp || d.servers || [];
        const enabled = servers.filter((s) => s.enabled).length;
        const head = el('div', { style: 'margin-bottom:10px;color:var(--m-fg-2);font-size:13px;display:flex;justify-content:space-between;align-items:center;' }, [
          el('span', {}, `${servers.length} server${servers.length === 1 ? '' : 's'}  ·  ${enabled} enabled  ·  bridge-owned (rule #5)`),
          (() => {
            const btn = el('button', {}, 'Open MCP →');
            btn.addEventListener('click', () => { location.hash = '#/mcp'; });
            return btn;
          })()
        ]);
        mcpMount.appendChild(head);

        if (servers.length === 0) {
          mcpMount.appendChild(placeholder('No MCP servers', 'Register one in /mcp or `maddu mcp add --name … --transport stdio --command …`.'));
          return;
        }

        const table = el('div', { class: 'lanes-table' });
        for (const s of servers) {
          const h = (d.health || {})[s.name];
          const row = el('div', { class: 'lanes-row' });
          row.appendChild(el('div', { class: 'lanes-cell lanes-cell-id' }, [
            el('div', { class: 'lanes-id' }, [
              el('span', { html: s.enabled ? '<span class="signal live"></span>' : '<span class="signal"></span>' }),
              document.createTextNode(s.name)
            ]),
            el('div', { class: 'lanes-scope' }, `${s.transport || 'stdio'} · ${s.stdio?.command || s[s.transport]?.url || s.command || '—'}`)
          ]));
          row.appendChild(el('div', { class: 'lanes-cell lanes-cell-claim' }, [
            el('span', { class: 'lanes-claim-pill ' + (h?.ok ? 'ok' : 'warn') }, h?.ok ? 'healthy' : (h?.error ? 'error' : 'untested'))
          ]));
          const actions = el('div', { class: 'lanes-cell lanes-cell-defaults' });
          const tog = el('button', {}, s.enabled ? 'Disable' : 'Enable');
          tog.addEventListener('click', async () => {
            tog.disabled = true;
            await fetch(`/bridge/mcp/${encodeURIComponent(s.name)}/${s.enabled ? 'disable' : 'enable'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            renderMcpPanel();
          });
          const tst = el('button', { class: 'btn-allow' }, 'Test');
          tst.addEventListener('click', async () => {
            tst.disabled = true; tst.textContent = '…';
            await fetch(`/bridge/mcp/${encodeURIComponent(s.name)}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            renderMcpPanel();
          });
          actions.appendChild(tog);
          actions.appendChild(tst);
          row.appendChild(actions);
          table.appendChild(row);
        }
        mcpMount.appendChild(table);
      })().catch((e) => { mcpMount.innerHTML = ''; mcpMount.appendChild(placeholder('Offline', String(e))); });
    }
    renderMcpPanel();

    // Runtimes
    try {
      const r = await fetch('/bridge/runtimes', { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      rtMount.innerHTML = '';
      if (!d) { rtMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); }
      else {
        const rts = d.runtimes || [];
        const detected = Object.values(d.health || {}).filter((h) => h && h.ok).length;
        const head = el('div', { style: 'margin-bottom:8px;color:var(--m-fg-2);font-size:13px;' },
          `${rts.length} runtime${rts.length === 1 ? '' : 's'} registered  ·  ${detected} detected on this host`);
        rtMount.appendChild(head);
        if (rts.length === 0) {
          rtMount.appendChild(placeholder('No runtimes', 'Register one in /runtimes or `maddu runtime register --name … --binary …`.'));
        } else {
          const kv = el('dl', { class: 'kv' });
          for (const r of rts) {
            const h = (d.health || {})[r.name];
            const dot = h?.ok ? '<span class="signal live"></span>' : '<span class="signal"></span>';
            kv.appendChild(el('dt', { html: `${dot}${r.displayName || r.name}` }));
            kv.appendChild(el('dd', {}, h?.ok ? (h.version || 'detected') : (h?.error || 'not detected')));
          }
          rtMount.appendChild(kv);
        }
        const btn = el('button', {}, 'Open Runtimes →');
        btn.style.marginTop = '8px';
        btn.addEventListener('click', () => { location.hash = '#/runtimes'; });
        rtMount.appendChild(btn);
      }
    } catch (e) { rtMount.innerHTML = ''; rtMount.appendChild(placeholder('Offline', String(e))); }
  })();

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
  { name: 'rollback',  args: '<checkpointId>',                       desc: 'Print rollback commands for a checkpoint (use `maddu checkpoint rollback --apply` to execute).' },
  { name: 'checkpoint',args: '[<title>]',                            desc: 'Tag the current HEAD as a checkpoint.' },
  { name: 'skills',  args: '',                                       desc: 'List all skills in the gallery.' },
  { name: 'skill',   args: '<id>',                                   desc: 'Apply a skill to the current session.' },
  { name: 'runtime', args: '<name>',                                desc: 'Show a runtime adapter (or list if no name).' },
  { name: 'spawn',   args: '<runtime>',                             desc: 'Spawn a worker from a registered runtime adapter.' },
  { name: 'detect',  args: '[<name>]',                              desc: 'Detect a runtime (or all if no name).' },
  { name: 'mcp',     args: '[<name>]',                              desc: 'Show an MCP server (or list if no name).' },
  { name: 'mcp-test',args: '[<name>]',                              desc: 'Test an MCP server (or all).' },
  { name: 'at',      args: '<natural> -- <title>',                  desc: 'Create a schedule (e.g. /at every evening at 6pm -- Daily summary).' },
  { name: 'wb',      args: '',                                       desc: 'Jump to /workbench.' },
  { name: 'clear',   args: '',                                       desc: 'Clear the composer.' }
];

/**
 * Push a transient toast into the floating top-right toast region.
 *
 *  text   — message body. Newlines preserved via white-space: pre-wrap.
 *  level  — 'ok' | 'warn' | 'err' (default 'ok'; bare info uses default
 *           accent-2 blue left-border).
 *
 * Toasts auto-dismiss after a duration scaled to message length, but cap
 * at 9 s. Click anywhere on the toast to dismiss early. The region stacks
 * vertically — multiple toasts coexist; oldest at top.
 */
// showToast → moved to ./cockpit-util.js (v1.36.0), imported above.

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
    case 'rollback': {
      const id = cmd.rest.trim();
      if (!id) return showToast('usage: /rollback <checkpointId>', 'err');
      const out = await postJson(`/bridge/checkpoints/${encodeURIComponent(id)}/rollback`, {});
      const lines = Object.entries(out.recovery || {}).map(([k, v]) => `${k}:\n  ${v.join('\n  ')}`).join('\n');
      return showToast(lines || 'no recovery commands', 'warn');
    }
    case 'checkpoint': {
      const title = cmd.rest.trim();
      const out = await postJson('/bridge/checkpoints', { title: title || null, by: sess });
      return showToast(out.ok ? `${out.checkpoint.id}  ${out.checkpoint.commit.slice(0, 8)}` : `failed: ${out.error}`, out.ok ? 'ok' : 'err');
    }
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
    case 'runtime': {
      const name = cmd.rest.trim();
      if (!name) {
        const d = await fetchJson('/bridge/runtimes');
        if (!d.runtimes.length) return showToast('(no runtimes registered)  ·  /runtimes for the UI', 'ok');
        return showToast(d.runtimes.map((r) => `${r.name}  ${r.binary || '—'}`).join('\n'), 'ok');
      }
      const r = await fetchJson(`/bridge/runtimes/${encodeURIComponent(name)}`);
      const cap = r.capabilities || {};
      return showToast(`${r.name}  ${r.binary || '—'}\n  capabilities: ${Object.entries(cap).map(([k,v]) => `${k}:${v}`).join(' ')}\n  health: ${r.health?.ok ? '✓ ' + (r.health.version || '') : (r.health ? '✗' : 'not detected')}`, 'ok');
    }
    case 'spawn': {
      const name = cmd.rest.trim();
      if (!name) return showToast('usage: /spawn <runtime>', 'err');
      const r = await postJson(`/bridge/runtimes/${encodeURIComponent(name)}/spawn`, { sessionId: sess });
      return showToast(r.ok ? `spawned ${r.workerId}  pid:${r.pid}` : `spawn failed: ${r.error}`, r.ok ? 'ok' : 'err');
    }
    case 'detect': {
      const name = cmd.rest.trim();
      if (!name) {
        const r = await postJson('/bridge/runtimes/detect-all', {});
        const okN = r.results.filter((x) => x.ok).length;
        return showToast(`detect-all: ${okN}/${r.results.length} ok`, 'ok');
      }
      const r = await postJson(`/bridge/runtimes/${encodeURIComponent(name)}/detect`, {});
      return showToast(r.ok ? `${name}  ✓ ${r.version || ''}` : `${name}  ✗ ${r.error || ('exit ' + r.exitCode)}`, r.ok ? 'ok' : 'err');
    }
    case 'mcp': {
      const name = cmd.rest.trim();
      if (!name) {
        const d = await fetchJson('/bridge/mcp');
        if (!d.mcp.length) return showToast('(no MCP servers registered)  ·  /mcp UI', 'ok');
        return showToast(d.mcp.map((r) => `${r.name}  ${r.transport}  ${r.enabled ? 'on' : 'off'}`).join('\n'), 'ok');
      }
      const r = await fetchJson(`/bridge/mcp/${encodeURIComponent(name)}`);
      const detail = r.transport === 'stdio' ? `${r.stdio?.command} ${(r.stdio?.args || []).join(' ')}` : (r[r.transport]?.url || '');
      return showToast(`${r.name}  ${r.transport}  ${r.enabled ? 'on' : 'off'}\n  ${detail}\n  lanes: ${(r.lanes || []).join(', ')}\n  health: ${r.health?.ok ? '✓' : (r.health ? '✗ ' + (r.health.error || '') : 'untested')}`, 'ok');
    }
    case 'mcp-test': {
      const name = cmd.rest.trim();
      if (!name) {
        const r = await postJson('/bridge/mcp/test-all', {});
        const okN = r.results.filter((x) => x.ok).length;
        return showToast(`mcp test-all: ${okN}/${r.results.length} ok`, okN ? 'ok' : 'warn');
      }
      const r = await postJson(`/bridge/mcp/${encodeURIComponent(name)}/test`, {});
      return showToast(r.ok ? `${name}  ✓` : `${name}  ✗ ${r.error || ('status ' + r.status)}`, r.ok ? 'ok' : 'err');
    }
    case 'at': {
      const m = cmd.rest.match(/^(.+?)\s*--\s*(.+)$/);
      if (!m) return showToast('usage: /at <natural> -- <title>', 'err');
      const [, natural, title] = m;
      const r = await postJson('/bridge/schedules', { natural: natural.trim(), title: title.trim(), by: sess });
      return showToast(r.ok ? `${r.schedule.id}  ${r.schedule.cron}` : `failed: ${r.error}`, r.ok ? 'ok' : 'err');
    }
    case 'wb':
      location.hash = '#/workbench';
      return;
    case 'clear':
      composer.input.value = '';
      if (composer.fit) composer.fit();
      composer.suggest.hidden = true;
      // Sweep any visible toasts.
      document.querySelectorAll('#toast-region .toast').forEach((t) => t.click());
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
  composer.hint = document.getElementById('composer-hint');
  updateHint();
  composer.fit = () => {
    if (!composer.input) return;
    composer.input.style.height = 'auto';
    composer.input.style.height = Math.min(composer.input.scrollHeight, 240) + 'px';
  };

  composer.input.addEventListener('input', () => {
    composer.fit();
    composer.selectedSuggestion = 0;
    renderSuggestions(composer.input.value);
  });

  composer.input.addEventListener('keydown', async (e) => {
    // Enter submits. Shift+Enter inserts a newline (default textarea behavior).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const line = composer.input.value.trim();
      if (!line) return;
      composer.history.push(line);
      composer.historyIdx = composer.history.length;
      composer.input.value = '';
      composer.fit();
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
      composer.fit();
      composer.suggest.hidden = true;
      // Sweep any visible toasts on Escape.
      document.querySelectorAll('#toast-region .toast').forEach((t) => t.click());
      composer.input.blur();
    } else if (e.key === 'ArrowUp') {
      if (!composer.suggest.hidden) {
        e.preventDefault();
        composer.selectedSuggestion = Math.max(0, composer.selectedSuggestion - 1);
        renderSuggestions(composer.input.value);
        return;
      }
      // Only navigate history when single-line; otherwise let the textarea move the caret.
      if (composer.input.value.includes('\n')) return;
      if (composer.historyIdx > 0) {
        e.preventDefault();
        composer.historyIdx--;
        composer.input.value = composer.history[composer.historyIdx];
        composer.fit();
      }
    } else if (e.key === 'ArrowDown') {
      if (!composer.suggest.hidden) {
        e.preventDefault();
        const rows = composer.suggest.querySelectorAll('.composer-suggest-row').length;
        composer.selectedSuggestion = Math.min(rows - 1, composer.selectedSuggestion + 1);
        renderSuggestions(composer.input.value);
        return;
      }
      if (composer.input.value.includes('\n')) return;
      if (composer.historyIdx < composer.history.length - 1) {
        e.preventDefault();
        composer.historyIdx++;
        composer.input.value = composer.history[composer.historyIdx];
        composer.fit();
      } else if (composer.historyIdx < composer.history.length) {
        e.preventDefault();
        composer.historyIdx = composer.history.length;
        composer.input.value = '';
        composer.fit();
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const rows = composer.suggest.querySelectorAll('.composer-suggest-row');
      if (rows.length > 0) {
        const row = rows[composer.selectedSuggestion] || rows[0];
        const cmdName = row.querySelector('.composer-suggest-cmd').textContent.split(' ')[0];
        composer.input.value = cmdName + ' ';
        composer.fit();
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
    composer.fit();
    renderSuggestions(composer.input.value);
  });

  // Global "?" opens the Docs route from anywhere (mirrors OMC's wiki popup).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    if (!location.hash.startsWith('#/docs')) location.hash = '#/docs';
  });
}

// ─── Slice δ — Learning route ───────────────────────────────────────────
// laneFromFact → moved to cockpit-util.js (v1.43.0).

// renderLearning � moved to cockpit-views-inspect.js (v1.49.0)  first
// inspect-heavy slice; its row-click opens the Inspector via ctx.openInspector
// (LEARNING_KIND_TONE moved with it as a private const).

// ─── Slice δ — Wiki route ───────────────────────────────────────────────
// renderWiki → moved to cockpit-views-reference.js (v1.47.0)
// (pure-leaf view — leaves + showToast + route metadata + global fetch).

// ─── Slice ε — Workflows blueprint ──────────────────────────────────────
// renderWorkflows + WORKFLOW_NODES/EDGES/NODE_ROUTE � moved to
// cockpit-views-inspect.js (v1.51.0)  SVG blueprint graph; each node opens the
// Inspector via ctx.openInspector (with an Open-route action).

// ─── Slice ε — Agents (coworker profile grid) ───────────────────────────
// renderAgents � moved to cockpit-views-inspect.js (v1.53.0)  coworker grid;
// cards open the Inspector. Shell deps via ctx: scopePill/scopedUrl + rerender
// (narrow router alias for scope-toggle re-render) + openInspector/paletteFocus/
// focusPanelByKeyword.

// ─── Slice ε — Teams (lane ownership map) ───────────────────────────────
// renderTeams � moved to cockpit-views-inspect.js (v1.50.0)  inspect-heavy;
// lane cards open the Inspector. Shell deps via ctx: fetchLanes/fetchProjection/
// openInspector + paletteFocus/focusPanelByKeyword (deep-link focus).

// ─── Comms settings panels (Telegram/Discord/Email) → moved to
// ./cockpit-comms.js (v1.36.0). render*Panel are imported above.

// ─── Phase 3 — Command palette (⌘K / Ctrl+K) ────────────────────────────
const palette = {
  open: false,
  items: [],
  active: 0
};

function paletteItems(query) {
  const q = (query || '').toLowerCase().trim();
  const out = [];

  // Routes — top-level destinations.
  for (const [id, r] of Object.entries(ROUTES)) {
    if (isRouteHidden(r)) continue;  // v1.0.3 — framework-only on consumer installs
    const titleLc = r.title.toLowerCase();
    const idLc = id.toLowerCase();
    const descLc = (r.description || '').toLowerCase();
    const kwLc = (r.keywords || '').toLowerCase();
    const hay = `${titleLc} ${idLc} ${r.group || ''} ${descLc} ${kwLc}`;
    if (!q || hay.includes(q)) {
      let score;
      if (!q)                            score = r.anchor ? 0 : 1;
      else if (titleLc.startsWith(q))    score = 0;
      else if (titleLc.includes(q))      score = 1;
      else if (idLc.includes(q))         score = 2;
      else if (kwLc.includes(q))         score = 3;
      else                               score = 5; // route via description = lower than sub-target
      out.push({
        kind: 'route', id,
        title: r.title, group: r.group, anchor: r.anchor,
        desc: r.description, score
      });
    }
  }

  // Sub-targets — first-class panel entries inside routes. Sourced from the
  // runtime registry (static manifest + render-discovered + future data-
  // driven entries). Same key (`<route>:<id>`) dedupes naturally.
  for (const s of allSubTargets()) {
    const titleLc = s.title.toLowerCase();
    const kwLc = (s.keywords || '').toLowerCase();
    const descLc = (s.description || '').toLowerCase();
    const hay = `${titleLc} ${kwLc} ${descLc} ${s.id}`;
    if (!q || hay.includes(q)) {
      let score;
      if (!q)                            score = 2;
      else if (titleLc.startsWith(q))    score = 0;
      else if (titleLc.includes(q))      score = 1;
      else if (s.id.toLowerCase().includes(q)) score = 2;
      else if (kwLc.includes(q))         score = 2;
      else                               score = 4;
      out.push({
        kind: 'sub',
        id: `${s.route}:${s.id}`,
        title: s.title,
        group: s.group || ROUTES[s.route]?.group,
        anchor: true,
        desc: s.description,
        targetRoute: s.route,
        focus: s.id,
        score
      });
    }
  }

  // Workspaces — operator can switch the active workspace from anywhere.
  if (_workspacesCache && _workspacesCache.workspaces && _workspacesCache.workspaces.length > 1) {
    for (const w of _workspacesCache.workspaces) {
      if (w.id === currentWorkspace) continue;
      const lbl = (w.label || w.id).toLowerCase();
      const idLc = w.id.toLowerCase();
      const hay = `workspace switch ${lbl} ${idLc}`;
      if (!q || hay.includes(q) || lbl.includes(q) || idLc.includes(q)) {
        let score;
        if (!q)                            score = 3;
        else if (lbl.startsWith(q))        score = 0;
        else if (lbl.includes(q))          score = 1;
        else if (idLc.includes(q))         score = 2;
        else                               score = 4;
        out.push({
          kind: 'workspace',
          id: `workspace:${w.id}`,
          title: `Switch to workspace: ${w.label || w.id}`,
          group: 'connect',
          desc: w.path || '',
          workspaceId: w.id,
          score
        });
      }
    }
  }

  // Actions — verbs the cockpit can run directly.
  for (const a of actionItems(q)) out.push(a);

  out.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
  return out.slice(0, 28);
}

function renderPaletteResults() {
  const host = document.getElementById('palette-results');
  if (!host) return;
  host.innerHTML = '';
  if (!palette.items.length) {
    host.appendChild(el('div', { class: 'palette-empty' }, 'No matches. Try a route name, group, or keyword.'));
    document.getElementById('palette-foot-hint').textContent = '';
    return;
  }
  palette.items.forEach((it, i) => {
    const titleNode = el('div', { class: 'palette-row-title' }, [
      document.createTextNode(it.title)
    ]);
    if (it.kind === 'sub') {
      titleNode.appendChild(el('span', { class: 'palette-row-match' }, ` · in ${(it.targetRoute || '').toUpperCase()}`));
    } else if (it.kind === 'action') {
      titleNode.appendChild(el('span', { class: 'palette-row-match' }, ' · action'));
    }
    const groupLabel = (it.group || '').toUpperCase();
    let glyph;
    if (it.kind === 'action')   glyph = '▷';
    else if (it.kind === 'sub') glyph = '▸';
    else                        glyph = it.anchor ? '◆' : '◇';
    const row = el('div', {
      class: 'palette-row' + (i === palette.active ? ' active' : '') + (it.kind === 'sub' ? ' sub' : '') + (it.kind === 'action' ? ' action' : ''),
      role: 'option',
      'aria-selected': i === palette.active ? 'true' : 'false',
      'data-index': String(i)
    }, [
      el('span', { class: 'palette-row-glyph' }, glyph),
      el('div', { class: 'palette-row-text' }, [
        titleNode,
        el('div', { class: 'palette-row-desc' }, it.desc || '')
      ]),
      el('span', { class: 'palette-row-group' }, groupLabel)
    ]);
    row.addEventListener('click', () => commitPalette(i));
    row.addEventListener('mousemove', () => { palette.active = i; refreshPaletteActive(); });
    host.appendChild(row);
  });
  const it = palette.items[palette.active];
  if (it) document.getElementById('palette-foot-hint').textContent = `→ ${it.title}`;
}

function refreshPaletteActive() {
  document.querySelectorAll('.palette-row').forEach((r, i) => {
    r.classList.toggle('active', i === palette.active);
    r.setAttribute('aria-selected', i === palette.active ? 'true' : 'false');
  });
  const it = palette.items[palette.active];
  if (it) document.getElementById('palette-foot-hint').textContent = `→ ${it.title}`;
}

function openPalette() {
  if (palette.open) return;
  palette.open = true;
  palette.active = 0;
  // Refresh data-driven sub-targets in the background — UI doesn't wait
  // (manifest entries cover the common cases on first open).
  refreshDataSubTargets().then(() => {
    if (palette.open) {
      palette.items = paletteItems(document.getElementById('palette-input').value || '');
      renderPaletteResults();
    }
  });
  palette.items = paletteItems('');
  const node = document.getElementById('palette');
  const input = document.getElementById('palette-input');
  node.hidden = false;
  renderPaletteResults();
  requestAnimationFrame(() => {
    node.classList.add('open');
    input.value = '';
    input.focus();
  });
}

function closePalette() {
  if (!palette.open) return;
  palette.open = false;
  const node = document.getElementById('palette');
  node.classList.remove('open');
  setTimeout(() => { node.hidden = true; }, 160);
}

function commitPalette(i) {
  const it = palette.items[i];
  if (!it) return;
  closePalette();
  if (it.kind === 'action') {
    try { Promise.resolve(it.run()).catch((e) => console.error('[action]', it.id, e)); }
    catch (e) { console.error('[action]', it.id, e); }
  } else if (it.kind === 'sub') {
    location.hash = `#/${it.targetRoute}?focus=${encodeURIComponent(it.focus)}`;
  } else if (it.kind === 'workspace') {
    setActiveWorkspace(it.workspaceId);
  } else {
    location.hash = `#/${it.id}`;
  }
}

// Read ?focus=<keyword> from the current hash. Used by route renderers
// (currently Settings) to scroll-flash a specific panel.
function paletteFocus() {
  const m = location.hash.match(/[?&]focus=([^&]+)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

// Find the panel whose data-focus list includes the keyword, scroll into
// view, and add a brief lime border flash. Called from renderSettings on
// next tick (after the DOM mounts).
// Find the panel whose data-focus list contains the keyword. Scroll-focus
// is retried on a backoff (50/250/600/1200 ms) so async panel content that
// arrives after the first mount can't leave the panel off-screen.
function focusPanelByKeyword(root, keyword) {
  if (!root || !keyword) return;
  const k = String(keyword).toLowerCase();
  function findPanel() {
    const inDoc = document.body.contains(root) ? root : document.getElementById('route-view');
    const panels = (inDoc || document).querySelectorAll('[data-focus]');
    for (const p of panels) {
      const keys = (p.getAttribute('data-focus') || '').toLowerCase().split(/\s+/);
      if (keys.includes(k)) return p;
    }
    return null;
  }
  function doScroll() {
    const p = findPanel();
    if (!p) return false;
    // ScrollIntoView with start alignment respects scroll-margin-top (set
    // in CSS to clear the sticky stage-head).
    p.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }
  function flash() {
    const p = findPanel();
    if (!p) return;
    p.classList.remove('panel-focus');
    void p.offsetWidth;
    p.classList.add('panel-focus');
    setTimeout(() => p.classList.remove('panel-focus'), 1600);
  }
  // Initial RAF + 3 retry passes after async panel content typically settles.
  requestAnimationFrame(() => { doScroll(); flash(); });
  setTimeout(doScroll,  250);
  setTimeout(doScroll,  600);
  setTimeout(doScroll, 1200);
}

function initPalette() {
  const input = document.getElementById('palette-input');
  const scrim = document.getElementById('palette-scrim');
  if (!input || !scrim) return;
  scrim.addEventListener('click', closePalette);
  input.addEventListener('input', () => {
    palette.items = paletteItems(input.value);
    palette.active = 0;
    renderPaletteResults();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palette.active = Math.min(palette.items.length - 1, palette.active + 1); refreshPaletteActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palette.active = Math.max(0, palette.active - 1); refreshPaletteActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); commitPalette(palette.active); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      palette.open ? closePalette() : openPalette();
    } else if (e.key === 'Escape' && palette.open) {
      closePalette();
    }
  });
}

// ─── Phase 6 — Signature lime line on slice-stop ────────────────────────
function flashSliceLine() {
  const line = document.getElementById('slice-line');
  if (!line) return;
  line.classList.remove('flash');
  // Force reflow so the animation re-fires.
  void line.offsetWidth;
  line.classList.add('flash');
}

// ─── Governance Phase 6 render functions ──────────────────────────────────

function renderOrientation() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Orientation'));
  root.appendChild(el('p', {}, ROUTES.orientation.description));

  const mount = el('div', {});
  mount.appendChild(loading('Reading orientation digest…'));
  root.appendChild(panelFocus('Brief', 'GET /bridge/orientation · goal / phase / last slice / open follow-ups', mount,
    { id: 'orientation-brief', keywords: 'goal phase orientation brief handoff' }));

  // v0.17 Phase 7: Sessions panel — renders the parent → child session
  // tree and the inline janitor's recent activity. Reads the projection
  // directly so a stale handoff.md doesn't hide a live spawn fan-out.
  const sessionsMount = el('div', {});
  sessionsMount.appendChild(loading('Reading sessions tree…'));
  root.appendChild(panelFocus('Sessions', 'GET /bridge/projection · sessions tree + janitor activity', sessionsMount,
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
      mount.innerHTML = '';
      const lines = [];
      lines.push(['Goal', o.goal?.objective || '—']);
      if (o.goal?.constraints?.length) lines.push(['Constraints', o.goal.constraints.join(' · ')]);
      lines.push(['Phase', o.phase?.name || '—']);
      lines.push(['Active session', o.activeSession?.id || '—']);
      lines.push(['Last slice', o.lastSliceStop?.summary || '—']);
      lines.push(['Counters', JSON.stringify(o.counters || {})]);
      lines.push(['Open follow-ups', String((o.openFollowups || []).length)]);
      const tbl = el('table', { class: 'ledger' });
      for (const [k, v] of lines) {
        tbl.appendChild(el('tr', {}, [el('td', { class: 'event-actor' }, k), el('td', {}, String(v))]));
      }
      mount.appendChild(tbl);
      if ((o.openFollowups || []).length) {
        const list = el('ul', { class: 'hard-rules' });
        for (const f of o.openFollowups) {
          list.appendChild(el('li', {}, `[${f.severity}] ${f.fromReviewEventId}  scope=${(f.draftScope || []).join(', ')}`));
        }
        mount.appendChild(list);
      }
      if (data.handoff) {
        const pre = el('pre', { class: 'docs-body' }, data.handoff);
        mount.appendChild(pre);
      }
    } catch (err) {
      mount.innerHTML = '';
      mount.appendChild(placeholder('Unavailable', String(err.message || err)));
    }
  }
  load();
  loadSessions();
  let pending = false;
  const onEvent = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => {
      try { await load(); await loadSessions(); }
      finally { pending = false; }
    }, 400);
  };
  stream.bus.addEventListener('event', onEvent);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', onEvent), { once: true });
  return root;
}

function renderGates() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Gates'));
  root.appendChild(el('p', {}, ROUTES.gates.description));

  const mount = el('div', {});
  mount.appendChild(loading('Reading recent gate runs…'));
  root.appendChild(panelFocus('Recent gate runs', 'GET /bridge/gates · GATE_RAN events', mount,
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
  const onEvent = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  };
  stream.bus.addEventListener('event', onEvent);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', onEvent), { once: true });
  return root;
}

function renderReviews() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Reviews'));
  root.appendChild(el('p', {}, ROUTES.reviews.description));

  const mount = el('div', {});
  mount.appendChild(loading('Reading post-stop reviews…'));
  root.appendChild(panelFocus('Recent reviews', 'GET /bridge/reviews · SLICE_REVIEWED events', mount,
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
  const onEvent = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  };
  stream.bus.addEventListener('event', onEvent);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', onEvent), { once: true });
  return root;
}

async function boot() {
  if (!location.hash) location.hash = '#/conductor';
  loadManifest();
  refreshDataSubTargets();
  // First-run banner dismiss — event-delegated so the link survives banner
  // re-renders. Persisted to localStorage; resets when the user clears site
  // data.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('[data-first-run-dismiss]');
    if (!a) return;
    e.preventDefault();
    try { localStorage.setItem('maddu.firstRunDismissed', '1'); } catch {}
    setBanner('');
  });
  buildRail();
  buildDock();
  initDock();
  initPalette();
  await renderWorkspaceSwitcher();
  await fetchBridgeStatus();
  await seedCursor();
  renderRoute();
  streamLoop();
  initComposer();
  // Fallback chrome refresh in case stream stalls.
  setInterval(fetchBridgeStatus, 15000);
}

// ─── v0.18 backbone view (Phase 6) ────────────────────────────────────
// Single route that surfaces the four v0.18 additions in one place:
//   1. Teams panel       (projection.teams)
//   2. Pipelines panel   (projection.pipelines)
//   3. Cost panel        (projection.tokenLedger)
//   4. Slash-command cheatsheet card — derived from a baked-in roster.
//
// Reuses existing cockpit tokens (.view, .panel, .empty-state). No new
// CSS introduced. No state mutation — pure projection-derived views.
// v0.19.2: routes split into dedicated entries. Each route reads the
// matching /bridge/<slice> endpoint (v0.19.1 PR-C4) and renders a
// single-purpose panel. Empty data falls through to placeholder().

function bindRouteRefresh(load) {
  let pending = false;
  load();
  const onEvent = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  };
  stream.bus.addEventListener('event', onEvent);
  els.view.addEventListener('routechange', () => stream.bus.removeEventListener('event', onEvent), { once: true });
}

// renderPipelinesRoute / renderCostRoute / renderAdvisorsRoute /
// renderSkillInjectionsRoute / renderModelRoutingRoute / renderTestStatusRoute
// → moved to cockpit-views-backbone.js (v1.45.0); they receive the shell's
// bindRouteRefresh via ctx.bindRefresh.

// ageMs / ageDays / renderTestStatusCard / renderTeamsCard / renderPipelinesCard /
// renderCostCard / SLASH_CHEATSHEET / renderSlashCheatsheet → moved to
// cockpit-backbone-cards.js (v1.40.0). renderTeamsCard is currently unreferenced
// (v0.18 backbone card) so it is not imported back.

export { boot, renderRoute, ROUTES };
if (!globalThis.__MADDU_COCKPIT_TEST__) boot();
