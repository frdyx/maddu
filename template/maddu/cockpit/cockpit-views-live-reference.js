// Maddu cockpit - reference-cluster live views (read-only reference readouts).
// Views: Skills, Dashboard. Split out of cockpit-views-live.js (v1.71.0 decomposition,
// 2026-07-08). Each renders behind the ctx seam; imports leaves + route-meta only,
// no back-edge into cockpit.js. Private helpers live beside their owning view.

import { el, panel, placeholder, loading, formatUptime } from './cockpit-util.js';
import { statusGrid, meter, donut, sparkline, binByTime, segBar, bar } from './cockpit-widgets.js';
import { classifyEvent } from './cockpit-event-rows.js';
import { ROUTE_META } from './cockpit-route-meta.js';


// ---- Skills ----
async function fetchSkills() {
  try { const r = await fetch('/bridge/skills', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

async function fetchSkill(id) {
  try { const r = await fetch(`/bridge/skills/${encodeURIComponent(id)}`, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

export function renderSkills(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Skills'));
  root.appendChild(el('p', {}, ROUTE_META.skills.description));

  const summaryMount = el('div', {});
  summaryMount.appendChild(loading('Reading skill registry…'));
  root.appendChild(panel('Summary', 'gallery composition · tags · provenance', summaryMount));

  let selected = ctx.paletteFocus();

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
          by: ctx.currentSession() || null
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
      const f = ctx.paletteFocus();
      if (f) ctx.focusPanelByKeyword(root, f);
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
            body: JSON.stringify({ by: ctx.currentSession() || null, sessionId: ctx.currentSession() || null })
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
  ctx.onSpineEvent((e) => { if (e.detail.type && e.detail.type.startsWith('SKILL_')) refresh(); });
  return root;
}

// ---- Dashboard (v1.64.0): the headline operator overview - status tiles,
// task/worker donuts, 60-min activity sparkline + type-mix, capacity meters,
// bridge identity, hard-rules reference. Scope-aware (ctx.scopePill/scopedUrl,
// re-renders the whole route via ctx.rerender on scope toggle). Paints from the
// cached bridge snapshot via ctx.bridgeStatus/bridgeOk. No stream sub, no inspector.

export function renderDashboard(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Dashboard'));
  root.appendChild(el('p', {}, ROUTE_META.dashboard.description));

  const pill = ctx.scopePill('dashboard', () => {
    // Re-render the whole route — dashboard's data layers are too tangled
    // to surgically swap fetches, and the projection/events endpoints both
    // need the scoped URL.
    ctx.rerender();
  });
  if (pill) root.appendChild(pill);

  const status = ctx.bridgeStatus() || {};
  const counts = status.counts || {};

  // ── Headline tiles (top-of-page status grid) ────────────────────────
  // Populated immediately from the cached bridge snapshot; sparklines fill in
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
    el('dt', {}, 'bridge'),    el('dd', { html: ctx.bridgeOk() ? '<span class="signal live"></span>online' : '<span class="signal"></span>offline' }),
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
      const projUrl = ctx.scopedUrl('dashboard', '/bridge/projection');
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
      const r = await fetch(ctx.scopedUrl('dashboard', '/bridge/events/recent') + '?limit=500', { cache: 'no-store' });
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
