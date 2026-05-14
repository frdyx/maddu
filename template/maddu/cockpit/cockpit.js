// Máddu cockpit — vanilla SPA. No framework, no build step.
// Hash-routed; views render into #route-view.

const ROUTES = {
  workbench:  { title: 'Workbench',  render: renderWorkbench,  description: 'OS-like 3-pane shell. Left: lanes + sessions. Center: live event stream filtered by selection. Right: status counts, approvals, mailbox, schedule.' },
  dashboard:  { title: 'Dashboard',  render: renderDashboard,  description: 'Snapshot of every lane, every spawned worker, every open approval.' },
  approvals:  { title: 'Approvals',  render: renderApprovals,  description: 'Pending tool / subprocess approvals. Allow-once, allow-always, or deny — every decision recorded.' },
  events:     { title: 'Events',     render: renderEvents,     description: 'Live cursor stream of the append-only spine. Filters by type. Pause/resume.' },
  mailbox:    { title: 'Mailbox',    render: renderMailbox,    description: 'Per-lane mailbox bus. Async handoffs without simultaneous lane mutation.' },
  tasks:      { title: 'Tasks',      render: renderTasks,      description: 'Dependency-aware task board. Completing a task auto-unblocks dependents.' },
  skills:     { title: 'Skills',     render: renderSkills,     description: 'Reusable recipes distilled from slice-stops. SKILL.md format under .maddu/skills/.' },
  search:     { title: 'Search',     render: renderSearch,     description: 'Cross-corpus search over events, slice-stops, memory, skills, mailbox, and inbox.' },
  runtimes:   { title: 'Runtimes',   render: renderRuntimes,   description: 'Pluggable subprocess workers — Claude Code, Codex, Hermes, future agents. Descriptor + detection + spawn.' },
  mcp:        { title: 'MCP',        render: renderMcp,        description: 'Bridge-owned MCP server registry. stdio / sse / http transports. Per-lane visibility filtering.' },
  schedule:   { title: 'Schedule',   render: renderSchedule,   description: 'NL→cron scheduler. The bridge polls every 30 s; matching schedules fire their action (default: inbox note).' },
  auth:       { title: 'Auth',       render: renderAuth,       description: 'Multi-API-key store with rotation. Keys live in your OS auth dir — never served raw over HTTP. Last 4 chars only.' },
  imports:    { title: 'Imports',    render: renderImports,    description: 'Safe import gateway. Foreign artifacts in — provider secrets always out. Rejected payloads are logged with paths + pattern names only.' },
  operations: { title: 'Operations', render: renderOperations, description: 'Live work in flight. Slice-stops, verifications, checkpoints.' },
  swarm:      { title: 'Swarm',      render: renderSwarm,      description: 'Multi-agent fan-out. Lane-bound workers and their mailboxes.' },
  chats:      { title: 'Chats',      render: renderChats,      description: 'Conversation surfaces. History, attachments, replay.' },
  roadmap:    { title: 'Roadmap',    render: renderRoadmap,    description: 'Planned slices, tagged versions, dependency graph.' },
  docs:       { title: 'Docs',       render: renderDocs,       description: 'End-user manual. Install, concepts, CLI, cockpit tour, troubleshooting. Open from any route with ?' },
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
    if (stuck && stuck > 0) {
      setBanner(`<span>⚠  ${stuck} worker${stuck === 1 ? '' : 's'} silent &gt; 15 s — possible hang</span><a href="#/swarm">View in Swarm →</a>`, 'warn');
    } else {
      setBanner('');
    }
  } else {
    els.bridge.innerHTML = '<span class="signal"></span>offline';
    els.version.textContent = '—';
    els.uptime.textContent = '—';
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

// ─── Widget kit ─────────────────────────────────────────────────────────
//
// All widgets are pure inline SVG / DOM — no chart library (rule #4: no
// broad new deps). Tones map to token CSS vars:
//   ok     → --m-ok        warn  → --m-warn      danger → --m-danger
//   accent → --m-accent    blue  → --m-accent-2  fg-3   → --m-fg-3 (neutral)
//
// The widget helpers return DOM nodes you can drop into a panel body.

const TONE_VAR = {
  ok: 'var(--m-ok)',
  warn: 'var(--m-warn)',
  danger: 'var(--m-danger)',
  accent: 'var(--m-accent)',
  blue: 'var(--m-accent-2)',
  neutral: 'var(--m-fg-3)'
};
function toneColor(t) { return TONE_VAR[t] || TONE_VAR.neutral; }

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(c);
  }
  return node;
}

/**
 * Large stat tile.  bigStat(value, label, { trend?, tone?, spark? })
 *   trend: '+12%' / '-3' etc; rendered as a chip after the number
 *   tone:  color of the number (default fg-0)
 *   spark: optional array of numbers → renders a sparkline under the label
 */
function bigStat(value, label, opts = {}) {
  const { trend, tone, spark } = opts;
  const wrap = el('div', { class: 'widget-stat' });
  const numLine = el('div', { class: 'widget-stat-num' });
  const num = el('span', { class: 'widget-stat-value', style: tone ? `color:${toneColor(tone)}` : '' }, String(value));
  numLine.appendChild(num);
  if (trend) {
    const t = el('span', { class: 'widget-stat-trend' }, trend);
    if (typeof trend === 'string' && trend.startsWith('+')) t.classList.add('up');
    if (typeof trend === 'string' && trend.startsWith('-')) t.classList.add('down');
    numLine.appendChild(t);
  }
  wrap.appendChild(numLine);
  wrap.appendChild(el('div', { class: 'widget-stat-label' }, label));
  if (spark && spark.length) wrap.appendChild(sparkline(spark, { tone: tone || 'blue' }));
  return wrap;
}

/**
 * Status grid — N tiles in a responsive grid.
 *   tiles: [{ value, label, tone?, trend?, spark?, onClick? }]
 */
function statusGrid(tiles) {
  const wrap = el('div', { class: 'widget-grid' });
  for (const t of tiles) {
    const tile = bigStat(t.value, t.label, t);
    if (t.onClick) {
      tile.classList.add('clickable');
      tile.addEventListener('click', t.onClick);
    }
    wrap.appendChild(tile);
  }
  return wrap;
}

/**
 * Horizontal progress fill row.
 *   bar(pct, label, { tone?, right? })  — pct in 0..1 or 0..100
 */
function bar(pct, label, opts = {}) {
  const { tone = 'accent', right } = opts;
  const v = Math.max(0, Math.min(100, pct > 1 ? pct : pct * 100));
  const row = el('div', { class: 'widget-bar' });
  const head = el('div', { class: 'widget-bar-head' }, [
    el('span', { class: 'widget-bar-label' }, label),
    el('span', { class: 'widget-bar-right' }, right != null ? String(right) : `${Math.round(v)}%`)
  ]);
  const track = el('div', { class: 'widget-bar-track' });
  const fill = el('div', { class: 'widget-bar-fill', style: `width:${v}%; background:${toneColor(tone)}` });
  track.appendChild(fill);
  row.appendChild(head);
  row.appendChild(track);
  return row;
}

/**
 * Stacked distribution row (single track, multi-segment).
 *   segBar([{ label, value, tone }])
 */
function segBar(segments) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0) || 1;
  const wrap = el('div', { class: 'widget-segbar' });
  const track = el('div', { class: 'widget-segbar-track' });
  for (const s of segments) {
    const w = ((s.value || 0) / total) * 100;
    if (w <= 0) continue;
    const seg = el('div', {
      class: 'widget-segbar-seg',
      style: `width:${w}%; background:${toneColor(s.tone)}`,
      title: `${s.label}: ${s.value}`
    });
    track.appendChild(seg);
  }
  wrap.appendChild(track);
  const legend = el('div', { class: 'widget-segbar-legend' });
  for (const s of segments) {
    legend.appendChild(el('span', { class: 'widget-segbar-chip' }, [
      el('span', { class: 'widget-segbar-dot', style: `background:${toneColor(s.tone)}` }),
      document.createTextNode(`${s.label} ${s.value}`)
    ]));
  }
  wrap.appendChild(legend);
  return wrap;
}

/**
 * Donut chart (SVG).
 *   donut([{label, value, tone}], { size?, hole?, center? })
 *   center: optional center label (string) — defaults to total
 */
function donut(segments, opts = {}) {
  const size = opts.size || 140;
  const stroke = opts.stroke || 18;
  const r = (size - stroke) / 2;
  const cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + (x.value || 0), 0);
  const wrap = el('div', { class: 'widget-donut' });
  const s = svg('svg', { width: String(size), height: String(size), viewBox: `0 0 ${size} ${size}` });
  // Background ring
  s.appendChild(svg('circle', { cx: String(cx), cy: String(cy), r: String(r), fill: 'none', stroke: 'var(--m-bg-3)', 'stroke-width': String(stroke) }));
  if (total > 0) {
    let offset = 0;
    for (const seg of segments) {
      const v = seg.value || 0;
      if (v <= 0) continue;
      const len = (v / total) * C;
      const arc = svg('circle', {
        cx: String(cx), cy: String(cy), r: String(r),
        fill: 'none',
        stroke: toneColor(seg.tone),
        'stroke-width': String(stroke),
        'stroke-dasharray': `${len} ${C - len}`,
        'stroke-dashoffset': String(-offset),
        transform: `rotate(-90 ${cx} ${cy})`
      });
      const title = svg('title', {});
      title.textContent = `${seg.label}: ${v}`;
      arc.appendChild(title);
      s.appendChild(arc);
      offset += len;
    }
  }
  // Center label
  const center = opts.center != null ? opts.center : String(total);
  const cText = svg('text', {
    x: String(cx), y: String(cy + 5),
    'text-anchor': 'middle',
    'font-family': "'IBM Plex Sans Condensed', sans-serif",
    'font-weight': '600',
    'font-size': '24',
    fill: 'var(--m-fg-0)'
  });
  cText.textContent = center;
  s.appendChild(cText);
  if (opts.centerLabel) {
    const lbl = svg('text', {
      x: String(cx), y: String(cy + 22),
      'text-anchor': 'middle',
      'font-family': "'IBM Plex Sans', sans-serif",
      'font-size': '10',
      fill: 'var(--m-fg-3)',
      'text-transform': 'uppercase',
      'letter-spacing': '0.06em'
    });
    lbl.textContent = opts.centerLabel;
    s.appendChild(lbl);
  }
  wrap.appendChild(s);
  // Legend on the right
  const legend = el('div', { class: 'widget-donut-legend' });
  for (const seg of segments) {
    if ((seg.value || 0) <= 0) continue;
    const pct = total ? Math.round((seg.value / total) * 100) : 0;
    legend.appendChild(el('div', { class: 'widget-donut-row' }, [
      el('span', { class: 'widget-segbar-dot', style: `background:${toneColor(seg.tone)}` }),
      el('span', { class: 'widget-donut-label' }, seg.label),
      el('span', { class: 'widget-donut-val' }, `${seg.value} · ${pct}%`)
    ]));
  }
  wrap.appendChild(legend);
  return wrap;
}

/**
 * Sparkline (inline SVG, no axes).
 *   sparkline([n1,n2,...], { tone?, width?, height?, fill? })
 */
function sparkline(values, opts = {}) {
  const w = opts.width || 120;
  const h = opts.height || 28;
  const tone = opts.tone || 'blue';
  const fill = opts.fill !== false;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return [x, y];
  });
  const line = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ');
  const area = line + ` L ${w} ${h} L 0 ${h} Z`;
  const s = svg('svg', { class: 'widget-spark', width: String(w), height: String(h), viewBox: `0 0 ${w} ${h}` });
  if (fill) {
    s.appendChild(svg('path', { d: area, fill: toneColor(tone), 'fill-opacity': '0.12', stroke: 'none' }));
  }
  s.appendChild(svg('path', { d: line, fill: 'none', stroke: toneColor(tone), 'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  return s;
}

/**
 * Meter — single bar with explicit numerator/denominator label.
 *   meter(value, max, label, { tone? })
 */
function meter(value, max, label, opts = {}) {
  const tone = opts.tone || (value >= max ? 'warn' : 'accent');
  return bar(max > 0 ? value / max : 0, label, { tone, right: `${value} / ${max}` });
}

/**
 * Time-bin events into N buckets over the trailing window.
 *   binByTime(events, n, fieldOrFn = 'createdAt', windowMs = 60*60*1000)
 *   Returns array of N integers (most-recent at end).
 */
function binByTime(events, n = 24, fieldOrFn = 'createdAt', windowMs = 60 * 60 * 1000) {
  const buckets = new Array(n).fill(0);
  if (!events || !events.length) return buckets;
  const now = Date.now();
  const start = now - windowMs;
  const span = windowMs / n;
  const getTs = typeof fieldOrFn === 'function'
    ? fieldOrFn
    : (e) => {
        const v = e && e[fieldOrFn];
        if (!v) return null;
        const t = typeof v === 'number' ? v : Date.parse(v);
        return Number.isFinite(t) ? t : null;
      };
  for (const e of events) {
    const t = getTs(e);
    if (t == null || t < start) continue;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((t - start) / span)));
    buckets[idx]++;
  }
  return buckets;
}

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
      document.getElementById(`wb-tab-count-${t.id}`).textContent = String(tabCounts[t.id] || 0);
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

function renderDashboard() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Dashboard'));
  root.appendChild(el('p', {}, ROUTES.dashboard.description));

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
      const proj = await fetchProjection();
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
      const r = await fetch('/bridge/events/recent?limit=500', { cache: 'no-store' });
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

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading slice timeline…'));
  root.appendChild(panel('Activity', 'slice-stops + memory facts · last 7 days', summaryMount));

  const slicesMount = el('div', {});
  slicesMount.appendChild(loading('Fetching slice-stop ledger…'));
  root.appendChild(panel('Slice ledger', 'GET /bridge/projection · SLICE_STOP events', slicesMount));

  const memMount = el('div', {});
  memMount.appendChild(loading('Fetching hindsight facts…'));
  root.appendChild(panel('Hindsight memory', 'GET /bridge/memory · facts derived from slice-stops', memMount));

  const cpMount = el('div', {});
  cpMount.appendChild(loading('Fetching checkpoints…'));
  root.appendChild(panel('Checkpoints', 'GET /bridge/checkpoints · git tags at maddu/checkpoint/<id>', cpMount));

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

// ── Docs route ────────────────────────────────────────────────────────────
//
// Reads `<repoRoot>/docs/*.md` (or framework-bundled fallback) via the bridge.
// Sidebar lists every page, right pane renders the chosen one.
//
// URL convention: #/docs                 → opens index (first page)
//                 #/docs?p=<slug>         → opens a specific page

function renderDocs() {
  const root = el('div', { class: 'view' });
  const layout = el('div', { class: 'docs-layout' });
  const sidebar = el('aside', { class: 'docs-sidebar' });
  const main = el('section', { class: 'docs-main' });
  sidebar.appendChild(loading('Fetching docs…'));
  main.appendChild(loading('Pick a page on the left.'));
  layout.appendChild(sidebar);
  layout.appendChild(main);
  root.appendChild(layout);

  let current = null;

  function getRequestedSlug() {
    const m = location.hash.match(/[?&]p=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setSlugInHash(slug) {
    const base = '#/docs';
    location.hash = slug ? `${base}?p=${encodeURIComponent(slug)}` : base;
  }

  async function loadDoc(slug) {
    main.innerHTML = '';
    main.appendChild(loading('Loading…'));
    try {
      const r = await fetch(`/bridge/docs/${encodeURIComponent(slug)}`, { cache: 'no-store' });
      if (!r.ok) { main.innerHTML = ''; main.appendChild(placeholder('Not found', `No doc named ${slug}`)); return; }
      const doc = await r.json();
      current = doc.slug;
      main.innerHTML = '';
      const article = el('article', { class: 'docs-article' });
      article.innerHTML = renderMarkdown(doc.body);
      main.appendChild(article);
      // Intercept internal cross-links (./foo.md or foo.md) → switch page in-cockpit.
      article.addEventListener('click', (e) => {
        const a = e.target && e.target.closest && e.target.closest('a');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\.?\/?([a-zA-Z0-9_\-]+)\.md$/);
        if (m) { e.preventDefault(); setSlugInHash(m[1]); }
      });
      // Highlight active sidebar entry.
      sidebar.querySelectorAll('a.docs-link').forEach((a) => {
        if (a.dataset.slug === current) a.classList.add('active');
        else a.classList.remove('active');
      });
      main.scrollTo?.({ top: 0 });
    } catch (err) {
      main.innerHTML = '';
      main.appendChild(placeholder('Offline', String(err)));
    }
  }

  (async () => {
    try {
      const r = await fetch('/bridge/docs', { cache: 'no-store' });
      if (!r.ok) { sidebar.innerHTML = ''; sidebar.appendChild(placeholder('Offline', 'Bridge not reachable.')); return; }
      const { docs } = await r.json();
      sidebar.innerHTML = '';
      if (!docs.length) { sidebar.appendChild(placeholder('No docs', 'No markdown files found under docs/.')); return; }
      const nav = el('nav', { class: 'docs-nav' });
      for (const d of docs) {
        const a = el('a', { class: 'docs-link', href: '#', 'data-slug': d.slug });
        a.textContent = d.title || d.slug;
        a.addEventListener('click', (e) => { e.preventDefault(); setSlugInHash(d.slug); });
        nav.appendChild(a);
      }
      sidebar.appendChild(nav);
      const requested = getRequestedSlug();
      const initial = requested && docs.find((d) => d.slug === requested) ? requested : docs[0].slug;
      loadDoc(initial);
    } catch (err) {
      sidebar.innerHTML = '';
      sidebar.appendChild(placeholder('Offline', String(err)));
    }
  })();

  // React to hash-query changes while staying on #/docs.
  const onHashChange = () => {
    if (!location.hash.startsWith('#/docs')) { window.removeEventListener('hashchange', onHashChange); return; }
    const slug = getRequestedSlug();
    if (slug && slug !== current) loadDoc(slug);
  };
  window.addEventListener('hashchange', onHashChange);

  return root;
}

// Tiny CommonMark-ish renderer. Handles:
//   #/##/### headings · paragraphs · bold/italic · `code` · ```fenced``` · - / * lists
//   1. ordered lists · > blockquotes · [text](url) links · --- horizontal rules · tables (pipe).
// Escapes HTML by default; no raw HTML passthrough.
function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  function inline(text) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^\s*][^*]*?)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`);
    return s;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // consume closing fence
      out.push(`<pre class="md-code"${lang ? ` data-lang="${lang}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // Headings
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++; continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // Table (pipe). Heuristic: a line with at least two `|` then a separator row.
    if (/\|/.test(line) && i + 1 < lines.length && /^[\s|:\-]+$/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      const splitRow = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const header = splitRow(line);
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
      const ths = header.map((c) => `<th>${inline(c)}</th>`).join('');
      const trs = rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('');
      out.push(`<table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${buf.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${buf.join('')}</ol>`);
      continue;
    }

    // Paragraph: collect contiguous non-blank, non-special lines.
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\s|>\s?|```|---+\s*$|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return out.join('\n');
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

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading ledger…'));
  root.appendChild(panel('Summary', 'open queue + decision distribution', summaryMount));

  const openMount = el('div', {});
  openMount.appendChild(loading('Fetching open approvals…'));
  root.appendChild(panel('Open queue', 'GET /bridge/approvals', openMount));

  const ledgerMount = el('div', {});
  root.appendChild(panel('Decision ledger', '.maddu/events/*.ndjson · APPROVAL_DECIDED', ledgerMount));

  const policyMount = el('div', {});
  root.appendChild(panel('Standing policies', 'APPROVAL_POLICY_SET', policyMount));

  function refresh() {
    fetchApprovals().then((a) => {
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
  // SINGLE-EVENT specials first
  if (type === 'SLICE_STOP')              return 't-slice';
  if (type === 'DOCTOR_REPORT')           return 't-doctor';
  if (type === 'INBOX_MESSAGE')           return 't-inbox';

  // Lifecycle & versioning ops — lavender (framework family)
  if (type.startsWith('FRAMEWORK_'))      return 't-framework';
  if (type.startsWith('CHECKPOINT_'))     return 't-framework';

  // Session & infrastructure runtime — cyan
  if (type.startsWith('SESSION_'))        return 't-session';
  if (type.startsWith('WORKER_'))         return 't-session';
  if (type.startsWith('RUNTIME_'))        return 't-session';
  if (type.startsWith('MCP_'))            return 't-session';
  if (type.startsWith('SCHEDULE_'))       return 't-session';

  // Lane work — mint green
  if (type.startsWith('LANE_'))           return 't-lane';
  if (type.startsWith('MAILBOX_'))        return 't-lane';
  if (type.startsWith('TASK_'))           return 't-lane';

  // Sensitive ops (approvals, auth, imports) — amber warn
  if (type.startsWith('APPROVAL_'))       return 't-approval';
  if (type.startsWith('AUTH_KEY_'))       return 't-approval';
  if (type.startsWith('IMPORT_'))         return 't-approval';

  // Knowledge work — bold cream (slice family)
  if (type.startsWith('SKILL_'))          return 't-slice';

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

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading skill registry…'));
  root.appendChild(panel('Summary', 'gallery composition · tags · provenance', summaryMount));

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

  let selectedProvider = null;
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
          style: 'padding:8px 10px;border-bottom:1px solid var(--m-line-soft);cursor:pointer;' + (isSel ? 'background:var(--m-bg-3);' : '')
        }, [
          el('div', { style: 'font-family:var(--m-font-cond);color:var(--m-fg-0);font-size:14px;letter-spacing:0.03em;text-transform:uppercase;' }, p.provider),
          el('div', { class: 'event-actor', style: 'margin-top:2px;' }, `${p.keyCount} key${p.keyCount === 1 ? '' : 's'} · active …${p.activeKeyTail || '—'}`)
        ]);
        row.addEventListener('click', () => { selectedProvider = p.provider; refresh(); });
        listMount.appendChild(row);
      }
      if (!selectedProvider) selectedProvider = d.providers[0].provider;
      loadDetail(selectedProvider);
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

  const inpTitle = el('input', { type: 'text', placeholder: 'title (e.g. Daily summary)', style: 'flex:1;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const inpNL = el('input', { type: 'text', placeholder: 'natural (e.g. every evening at 6pm)', style: 'flex:2;background:var(--m-bg-2);color:var(--m-fg-0);border:1px solid var(--m-line);padding:6px 10px;font-family:var(--m-font-mono);font-size:12px;' });
  const preview = el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);min-width:160px;' }, '');
  const createBtn = el('button', {}, 'Create');
  const form = el('div', { style: 'display:flex;gap:6px;margin-bottom:12px;align-items:center;' }, [inpTitle, inpNL, preview, createBtn]);
  root.appendChild(form);

  // Live preview of NL→cron
  let previewTimer = null;
  inpNL.addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const text = inpNL.value.trim();
      if (!text) { preview.textContent = ''; preview.style.color = 'var(--m-fg-3)'; return; }
      try {
        const r = await fetch('/bridge/schedules/parse', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ natural: text })
        });
        const d = await r.json();
        if (d.ok) { preview.textContent = `→ ${d.cron}`; preview.style.color = 'var(--m-signal)'; }
        else      { preview.textContent = '↪ unparseable'; preview.style.color = 'var(--m-accent-warm)'; }
      } catch { preview.textContent = ''; }
    }, 200);
  });

  createBtn.addEventListener('click', async () => {
    const title = inpTitle.value.trim();
    const nat = inpNL.value.trim();
    if (!title || !nat) return;
    createBtn.disabled = true;
    try {
      const r = await fetch('/bridge/schedules', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, natural: nat, by: composer.currentSession || null })
      });
      if (r.ok) { inpTitle.value = ''; inpNL.value = ''; preview.textContent = ''; refresh(); }
      else { const d = await r.json().catch(() => ({})); showToast(`create failed: ${d.error || 'unknown'}`, 'err'); }
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
    fetchSchedules().then((d) => {
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
            el('dt', {}, 'last'),    el('dd', {}, s.lastRun ? s.lastRun.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'),
            el('dt', {}, 'id'),      el('dd', {}, s.id)
          ]),
          (() => {
            const actions = el('div', { style: 'display:flex;gap:6px;margin-top:8px;' });
            const tog = el('button', {}, enabled ? 'Disable' : 'Enable');
            tog.addEventListener('click', async () => {
              tog.disabled = true;
              await fetch(`/bridge/schedules/${encodeURIComponent(s.id)}/${enabled ? 'disable' : 'enable'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              refresh();
            });
            const rem = el('button', { class: 'btn-deny-hard' }, 'Remove');
            rem.addEventListener('click', async () => {
              if (!confirm(`Remove schedule "${s.title}"?`)) return;
              await fetch(`/bridge/schedules/${encodeURIComponent(s.id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
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
        const card = el('div', { class: 'panel', style: enabled ? '' : 'opacity:0.55;' }, [
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
        const card = el('div', { class: 'panel' }, [
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
    });
  }

  refresh();
  const handler = (e) => { if (e.detail.type && (e.detail.type.startsWith('RUNTIME_') || e.detail.type.startsWith('WORKER_'))) refresh(); };
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

  // ── Bridge panel ─────────────────────────────────────────────────────
  const bridgeMount = el('div', {});
  bridgeMount.appendChild(loading('Reading bridge status…'));
  root.appendChild(panel('Bridge', 'GET /bridge/status', bridgeMount));

  // ── Lanes panel ──────────────────────────────────────────────────────
  const lanesMount = el('div', {});
  lanesMount.appendChild(loading('Fetching lane catalog…'));
  root.appendChild(panel('Lanes', 'GET /bridge/lanes  ·  edit .maddu/lanes/catalog.json', lanesMount));

  // ── Auth / providers panel ───────────────────────────────────────────
  const authMount = el('div', {});
  authMount.appendChild(loading('Fetching providers…'));
  root.appendChild(panel('Providers', 'GET /bridge/auth  ·  full management in /auth', authMount));

  // ── MCP registry panel ───────────────────────────────────────────────
  const mcpMount = el('div', {});
  mcpMount.appendChild(loading('Fetching MCP registry…'));
  root.appendChild(panel('MCP registry', 'GET /bridge/mcp  ·  full management in /mcp', mcpMount));

  // ── Runtimes panel ───────────────────────────────────────────────────
  const rtMount = el('div', {});
  rtMount.appendChild(loading('Fetching runtimes…'));
  root.appendChild(panel('Runtimes', 'GET /bridge/runtimes  ·  full management in /runtimes', rtMount));

  // ── Storage paths panel (static, from /bridge/status) ───────────────
  const pathsMount = el('div', {});
  pathsMount.appendChild(loading('Resolving paths…'));
  root.appendChild(panel('Storage paths', 'Resolved at bridge boot', pathsMount));

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
  root.appendChild(panel('Hard rules · Docs', 'Open the manual', rulesBody));

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

    // Lanes
    try {
      const r = await fetch('/bridge/lanes', { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      lanesMount.innerHTML = '';
      if (!d) { lanesMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); }
      else {
        const lanes = (d.catalog && d.catalog.lanes) || [];
        const claims = new Map((d.claims || []).map((c) => [c.lane, c]));
        const head = el('div', { style: 'margin-bottom:8px;color:var(--m-fg-2);font-size:13px;' },
          `${lanes.length} lane${lanes.length === 1 ? '' : 's'} defined  ·  ${d.claims?.length || 0} active claim${(d.claims?.length || 0) === 1 ? '' : 's'}`);
        lanesMount.appendChild(head);
        if (lanes.length === 0) {
          lanesMount.appendChild(placeholder('No lanes', 'Define lanes in .maddu/lanes/catalog.json.'));
        } else {
          const kv = el('dl', { class: 'kv' });
          for (const l of lanes) {
            const c = claims.get(l.id);
            kv.appendChild(el('dt', {}, l.id));
            kv.appendChild(el('dd', { html:
              c ? `<span style="color:var(--m-warn)">claimed</span> by ${c.sessionId} — ${c.focus || l.scope || ''}`
                : `<span style="color:var(--m-fg-3)">free</span> — ${l.scope || '(no scope)'}`
            }));
          }
          lanesMount.appendChild(kv);
        }
        const btn = el('button', {}, 'Open Swarm →');
        btn.style.marginTop = '8px';
        btn.addEventListener('click', () => { location.hash = '#/swarm'; });
        lanesMount.appendChild(btn);
      }
    } catch (e) { lanesMount.innerHTML = ''; lanesMount.appendChild(placeholder('Offline', String(e))); }

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

    // MCP
    try {
      const r = await fetch('/bridge/mcp', { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      mcpMount.innerHTML = '';
      if (!d) { mcpMount.appendChild(placeholder('Offline', 'Bridge not reachable.')); }
      else {
        const servers = d.servers || [];
        const enabled = servers.filter((s) => s.enabled).length;
        const head = el('div', { style: 'margin-bottom:8px;color:var(--m-fg-2);font-size:13px;' },
          `${servers.length} server${servers.length === 1 ? '' : 's'} registered  ·  ${enabled} enabled  ·  bridge-owned (rule #5)`);
        mcpMount.appendChild(head);
        if (servers.length === 0) {
          mcpMount.appendChild(placeholder('No MCP servers', 'Register one in /mcp or `maddu mcp add --name … --transport stdio --command …`.'));
        } else {
          const kv = el('dl', { class: 'kv' });
          for (const s of servers) {
            const dot = s.enabled ? '<span class="signal live"></span>' : '<span class="signal"></span>';
            kv.appendChild(el('dt', { html: `${dot}${s.name}` }));
            kv.appendChild(el('dd', {}, `${s.transport || 'stdio'} · ${s.command || s.url || '—'}`));
          }
          mcpMount.appendChild(kv);
        }
        const btn = el('button', {}, 'Open MCP →');
        btn.style.marginTop = '8px';
        btn.addEventListener('click', () => { location.hash = '#/mcp'; });
        mcpMount.appendChild(btn);
      }
    } catch (e) { mcpMount.innerHTML = ''; mcpMount.appendChild(placeholder('Offline', String(e))); }

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
function showToast(text, level = 'ok') {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const t = document.createElement('div');
  t.className = 'toast';
  if (level === 'err' || level === 'warn' || level === 'ok') t.classList.add(level);
  t.textContent = text;
  // Scale visible-duration with content: ~3 s base + 35 ms per char, max 9 s.
  const ms = Math.min(3000 + (text || '').length * 35, 9000);
  const dismiss = () => {
    if (t._dismissing) return;
    t._dismissing = true;
    t.classList.add('dismissing');
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
  };
  t.addEventListener('click', dismiss);
  region.appendChild(t);
  // Bound the stack so a burst of toasts doesn't paper the screen.
  while (region.children.length > 5) region.removeChild(region.firstChild);
  setTimeout(dismiss, ms);
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
