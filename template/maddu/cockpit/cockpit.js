// Máddu cockpit — vanilla SPA. No framework, no build step.
// Hash-routed; views render into #route-view.

// Pure leaf utilities (DOM builder + formatters) live in a sibling module —
// the first slice of decomposing this file. Browser ES module import; the
// bridge serves cockpit-util.js as application/javascript.
import { el, panel, placeholder, truncatePathFromLeft, compactPath, formatUptime, formatAge, ageTone, formatTs, loading, loadingFor, showToast, copyToClipboardWithToast, workspaceBadge, laneFromFact } from './cockpit-util.js';
import { statusGrid, bar, segBar, donut, sparkline, meter, binByTime } from './cockpit-widgets.js';
import { renderTelegramPanel, renderDiscordPanel, renderEmailPanel } from './cockpit-comms.js';
import { renderSlashCheatsheet } from './cockpit-backbone-cards.js';
import { classifyEvent, eventRow, prepend, makeDecisionButton, REASON_CODE_TONE, REASON_CODE_LABEL } from './cockpit-event-rows.js';
import { openInspector, closeInspector } from './cockpit-inspector.js';
import { initCommandBar, paletteFocus, focusPanelByKeyword, currentSession } from './cockpit-command-bar.js';
import { renderMarkdown } from './cockpit-markdown.js';
import { ROUTE_META } from './cockpit-route-meta.js';
import { renderPipelinesRoute, renderCostRoute, renderAdvisorsRoute, renderSkillInjectionsRoute, renderModelRoutingRoute, renderTestStatusRoute } from './cockpit-views-backbone.js';
import { renderGoal, renderTools, renderLoops, renderSearch, renderWiki } from './cockpit-views-reference.js';
import { renderDocs } from './cockpit-views-docs.js';
import { renderLearning, renderTeams, renderWorkflows, renderRoadmap, renderAgents, renderPlans } from './cockpit-views-inspect.js';
import { renderTrust, renderSettings, renderAuth, renderImports, renderSchedule, renderMcp, renderRuntimes } from './cockpit-views-connect.js';
import { renderMailbox, renderSwarm, renderChats, renderWorkbench } from './cockpit-views-live-operate.js'; import { renderOperations, renderEvents, renderGates, renderReviews } from './cockpit-views-live-verify.js'; import { renderSkills, renderDashboard } from './cockpit-views-live-reference.js'; import { renderTasks, renderApprovals, renderOrientation, renderQueueBoard, renderClaimMap } from './cockpit-views-live-decide-board.js'; import { renderConductor, renderBoss } from './cockpit-views-live-decide-command.js'; import { renderFocus } from './cockpit-views-focus.js'; import { renderExperience } from './cockpit-views-experience.js'; import { renderModel } from './cockpit-views-model.js'; import { renderOversight } from './cockpit-views-oversight.js'; import { renderDigest } from './cockpit-views-digest.js'; import { renderProject } from './cockpit-views-project.js'; import { renderDecisions } from './cockpit-views-decisions.js'; import { renderPortfolio } from './cockpit-views-portfolio.js';

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
  dashboard: renderDashboard, roadmap: renderRoadmap, skills: renderSkills, docs: renderDocs, focus: renderFocus, experience: renderExperience, model: renderModel, oversight: renderOversight, digest: renderDigest, project: renderProject, decisions: renderDecisions, portfolio: renderPortfolio,
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

// The Inspector (entity-detail drawer) � moved to cockpit-inspector.js (v1.70.0):
// inspector singleton + ensureInspector + open/closeInspector + renderInspector +
// INSPECTOR_TABS/RENDERERS + label/payload/renderInspectorTab. A self-contained
// drawer (leaves + REASON_CODE_LABEL + DOM only). Route views open it via
// ctx.openInspector; cockpit.js imports open/closeInspector (above).








// Inspector entity shape — two flavours coexist:
//   Legacy (task/lane/approval/event/sliceStop): { kind, id, data: {...} }
//   New     (finding/slice-stop/workflow-node/session/claim/lane from
//            depth-upgrade routes):
//            { kind, id, label, raw, evidence:[{label,value}], actions:[{label,run}], related:[{kind,id,label}] }
// Each renderer normalizes by preferring top-level explicit arrays/refs
// when present, and falling back to the legacy e.data shape otherwise.



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
  fetchMemory,
  fetchApprovals,
  paletteFocus,
  focusPanelByKeyword,
  scopePill,
  scopedUrl,
  // Narrow boolean accessor for "is this route currently scoped to all
  // workspaces" — scope-aware views (e.g. schedule) read this instead of the
  // raw scopeShouldShow/getScope pair to decide their global-vs-local base URL.
  scopeIsGlobal: (route) => scopeShouldShow() && getScope(route) === 'all',
  openEntityDrawer,
  // Subscribe a handler to the live spine event stream with route-local
  // teardown — the single seam every stream-coupled view uses (filtering is the
  // caller's job: `if (!e.detail.type?.startsWith('X_')) return;`). The `torn`
  // flag closes the race where a handler is registered from an async callback
  // that resolves AFTER the route already changed (it would otherwise leak until
  // the next navigation). Views never touch the raw EventTarget or the teardown.
  onSpineEvent: (handler) => {
    let torn = false;
    els.view.addEventListener('routechange', () => {
      torn = true;
      stream.bus.removeEventListener('event', handler);
    }, { once: true });
    if (torn) return;
    stream.bus.addEventListener('event', handler);
  },
  // Narrow "re-render the current route" alias — scope-toggling views call this
  // instead of holding a handle to the whole router. Wrapper form late-binds
  // through the closure so it's safe even if renderRoute is ever reassigned.
  rerender: () => renderRoute(),
  // Narrow read-only accessor for the composer's sticky session pointer —
  // imported from cockpit-command-bar (which owns the composer singleton); views
  // that POST actions stamp `by: ctx.currentSession()` without holding it.
  currentSession,
  // Narrow accessors for the shared long-poll pause flag — the Events view owns
  // the Pause/Resume control but must not touch the `stream` singleton (the
  // long-poll loop and a composer control also read/write it). Read the current
  // state for the button label; toggle returns the NEW state for the relabel.
  isStreamPaused: () => stream.paused,
  toggleStreamPause: () => (stream.paused = !stream.paused),
  // Narrow read accessors for the cached bridge-status snapshot (refreshed by the
  // status poller). The Dashboard paints its headline tiles + bridge KV from the
  // cached value without holding the shell's mutable `bridgeStatus`/`bridgeOk`.
  bridgeStatus: () => bridgeStatus,
  bridgeOk: () => bridgeOk,
  // Force a status poll and resolve with the freshly-cached snapshot — the
  // Workbench's slow tick refreshes its right-pane status this way.
  refreshStatus: () => fetchBridgeStatus().then(() => bridgeStatus),
  // Register a one-shot route-leave cleanup (mirrors onSpineEvent's teardown but
  // for non-stream resources — e.g. a view's setInterval). Fires once on the next
  // routechange and self-removes.
  onRouteLeave: (fn) => els.view.addEventListener('routechange', fn, { once: true }),
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

// renderWorkbench � moved to cockpit-views-live.js (v1.67.0). The 3-pane operator
// cockpit (composer-free): ctx.fetch* reads + ctx.refreshStatus, live via
// ctx.onSpineEvent, 8s slow-tick setInterval torn down via ctx.onRouteLeave.

// ─── Conductor (Slice α default landing) ────────────────────────────────
//
// Operator's command-control surface. Reads GET /bridge/conductor for a
// derived view: KPI strip, "Next Command" (safe-next-action), Operation
// Score Matrix (per-lane progress + reason codes), and Now/Next/Waiting/Done
// task board. Everything reflects canonical state — no UI memory.

// renderConductor (+ renderNextCommand/renderConductorBoard/renderScoreMatrix) �
// moved to cockpit-views-live.js (v1.68.0). Scope-aware (ctx.scopePill/scopedUrl),
// ctx.panelFocus panels, debounced ctx.onSpineEvent, board/score open the Inspector
// via ctx.openInspector. REASON_CODE_TONE/LABEL � cockpit-event-rows.js (shared with
// the Inspector here + BOSS).





// formatAge / ageTone / formatTs → moved to cockpit-util.js (v1.38.0).

// ─── Queue Board (Slice β) ──────────────────────────────────────────────
//
// Four-lane kanban — Scheduler · Queue · Dispatch · Preflights. Reads
// GET /bridge/queue. Every parked card carries its reason code and a
// safe next action affordance.

// renderQueueBoard + renderClaimMap (+ private renderQueueColumns/renderQueueCard/
// renderClaimsTable + QUEUE_/CLAIM_REASON_TONE/LABEL palettes) � moved to
// cockpit-views-live.js (v1.65.0). Queue scope-aware (ctx.scopePill/scopedUrl);
// both debounced ctx.onSpineEvent + open Inspector via ctx.openInspector.




// ─── Claim Map (Slice β) ────────────────────────────────────────────────
//
// Active claims by lane. Joins claims with session info; surfaces lease
// state and heartbeat age. Operator can request a handoff with one click.




// ─── BOSS (Slice γ) ──────────────────────────────────────────────────────
//
// BOSS proposes · Enforcer cites · Operator decides. Terminal-style
// transcript (no chat bubbles). Composer creates proposals through
// /bridge/proposals; the Enforcer's deterministic reply is mirrored into
// the same transcript distinguished by glyph. Operator strip surfaces
// claims, approvals, and parked items so decisions are state-grounded.

// renderBoss (+ renderBossStrip/Sessions/Transcript, renderOperator/Enforcer/Decision
// Line, renderProposalCard, renderBossComposer + PROPOSAL_RISK_TONE/ENFORCER_ACTION_
// KINDS/ACTION_FIELDS) � moved to cockpit-views-live.js (v1.69.0)  the FINAL route
// view. Debounced ctx.onSpineEvent; proposal cards open the Inspector via
// ctx.openInspector. renderBossComposer is a self-contained form (no ctx). The
// global composer/slash-command singleton below stays shell-core.









// Which extra Enforcer-input fields a given action kind needs. The composer
// shows just these inputs — pickers populate from live state when possible.


// renderDashboard � moved to cockpit-views-live.js (v1.64.0). Headline operator
// overview: scope-aware (ctx.scopePill/scopedUrl/rerender), paints from the cached
// bridge snapshot via ctx.bridgeStatus/bridgeOk. No stream sub, no inspector.

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

// renderOperations + renderSwarm � moved to cockpit-views-live.js (v1.60.0).
// Operations: stream-coupled (SLICE_STOP via ctx.onSpineEvent), ctx.panelFocus
// panels, ctx.fetchProjection/fetchMemory, checkpoint stamps ctx.currentSession().
// Swarm: static read over ctx.fetchLanes + ctx.fetchProjection (no stream sub).


// renderChats � moved to cockpit-views-live.js (v1.66.0). The sessions roster:
// one ctx.fetchProjection read rendered as session panels. The simplest live view.

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

// renderApprovals � moved to cockpit-views-live.js (v1.62.0). Scope-aware
// (ctx.scopePill), ctx.panelFocus palette panels, APPROVAL_* via ctx.onSpineEvent.
// fetchApprovals STAYS here (shared with the inline renderWorkbench) and is
// reached via ctx.fetchApprovals.

// classifyEvent / summarize / eventRow → moved to cockpit-event-rows.js (v1.41.0).

// renderEvents � moved to cockpit-views-live.js (v1.61.0). Live event stream:
// subscribes via ctx.onSpineEvent (appends each matching row), Pause/Resume
// toggles the shared long-poll flag via ctx.isStreamPaused/toggleStreamPause.

// prepend / makeDecisionButton → moved to cockpit-event-rows.js (v1.41.0).

// renderMailbox/renderTasks/renderSkills (+ private fetchMailbox/fetchMailboxCounts/
// fetchTasks/fetchSkills/fetchSkill + taskCard) � moved to cockpit-views-live.js
// (v1.59.0)  first live-cluster slice. Stream-coupled (ctx.onSpineEvent:
// MAILBOX_/TASK_/SKILL_), stamp by:/createdBy:/sessionId: via ctx.currentSession(),
// honor ?focus= via ctx.paletteFocus/focusPanelByKeyword.








// renderImports (+ private fetchImports) � moved to cockpit-views-connect.js
// (v1.57.0)  stream-coupled (IMPORT_* via ctx.onSpineEvent); submit stamps
// by:ctx.currentSession() (narrow composer-pointer accessor).

// renderAuth (+ private fetchAuth/fetchAuthProvider) � moved to
// cockpit-views-connect.js (v1.56.0)  first stream-coupled view; re-runs on
// AUTH_KEY_* spine events via the new ctx.onSpineEvent seam (route-local teardown).

async function fetchSchedules() {
  try { const r = await fetch('/bridge/schedules', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

// renderSchedule + fetchMcp/renderMcp + fetchRuntimes/renderRuntimes � moved to
// cockpit-views-connect.js (v1.58.0)  the remaining connect infra views.
// schedule is scope-aware (ctx.scopePill/scopeIsGlobal/rerender); all three are
// stream-coupled (ctx.onSpineEvent) and stamp by:/sessionId: via ctx.currentSession().


// v1.2.0 Phase 6 — Trust cockpit route. Pulls /bridge/trust and renders the
// supply-chain posture: pin list, last audit, violations, secret-scan
// refusals, worker env policy, MCP provenance distribution, skill
// provenance distribution.
// renderTrust � moved to cockpit-views-connect.js (v1.55.0)  pure-leaf posture
// page (keeps its own 15s setInterval refresh, verbatim).

// v1.1.0 Phase 2 — unified Tools cockpit route.
// renderTools, renderLoops → moved to cockpit-views-reference.js (v1.47.0)
// (pure-leaf views — leaves + route metadata + global fetch, no ctx needed).

// v1.1.0 Phase 5 — Plans + Kanban cockpit route.
// renderPlans + openPlanDrawer � moved to cockpit-views-inspect.js (v1.54.0)
//  kanban + plan table; cards/rows open the plan entity drawer via
// ctx.openEntityDrawer (the drawer singleton). Completes the inspect-heavy cluster.




// renderSearch → moved to cockpit-views-reference.js (v1.47.0)
// (pure-leaf view — leaves + route metadata + global fetch).

// renderSettings � moved to cockpit-views-connect.js (v1.55.0)  registers
// command-palette sub-targets via ctx.panelFocus; honors ?focus= via
// ctx.paletteFocus/ctx.focusPanelByKeyword. Imports comms panels from cockpit-comms.

/* ─────────────── boot ─────────────── */

window.addEventListener('hashchange', renderRoute);

// ─── Composer / slash-command palette ────────────────────────────────────

// The slash-command bar (composer + command palette) � moved to
// cockpit-command-bar.js (v1.71.0): the composer singleton + COMMANDS + slash
// parse/dispatch (postJson/fetchJson/runCommand) + Ctrl-K palette (routes +
// sub-targets + workspaces) + paletteFocus/focusPanelByKeyword. cockpit.js injects
// the shell accessors via initCommandBar(host) at boot and re-exposes paletteFocus/
// focusPanelByKeyword/currentSession onto ctx. allSubTargets/refreshDataSubTargets/
// panelFocus + the workspace switcher stay here as the injected host.


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







// Read ?focus=<keyword> from the current hash. Used by route renderers
// (currently Settings) to scroll-flash a specific panel.

// Find the panel whose data-focus list includes the keyword, scroll into
// view, and add a brief lime border flash. Called from renderSettings on
// next tick (after the DOM mounts).
// Find the panel whose data-focus list contains the keyword. Scroll-focus
// is retried on a backoff (50/250/600/1200 ms) so async panel content that
// arrives after the first mount can't leave the panel off-screen.


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

// renderOrientation + renderGates + renderReviews � moved to cockpit-views-live.js
// (v1.63.0)  three clean read-only ledger views: ctx.panelFocus palette panel +
// debounced ctx.onSpineEvent refresh (no filtering). Leaves + ctx only.



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
  initCommandBar({
    routes: ROUTES,
    isRouteHidden,
    allSubTargets,
    refreshDataSubTargets,
    getWorkspaces: () => (_workspacesCache && _workspacesCache.workspaces) || [],
    getCurrentWorkspace: () => currentWorkspace,
    setActiveWorkspace,
  });
  await renderWorkspaceSwitcher();
  await fetchBridgeStatus();
  await seedCursor();
  renderRoute();
  streamLoop();
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
