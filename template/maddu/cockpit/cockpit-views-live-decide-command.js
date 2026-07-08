// Maddu cockpit - decide-cluster command views (the operator command-control surfaces).
// Views: Conductor, Boss. Split out of cockpit-views-live.js (v1.71.0 decomposition,
// 2026-07-08). Each renders behind the ctx seam; imports leaves + route-meta only,
// no back-edge into cockpit.js. Private helpers live beside their owning view.

import { el, placeholder, loading, loadingFor, showToast, workspaceBadge, formatTs, formatAge, ageTone } from './cockpit-util.js';
import { statusGrid, segBar, bar } from './cockpit-widgets.js';
import { REASON_CODE_TONE, REASON_CODE_LABEL } from './cockpit-event-rows.js';
import { renderSlashCheatsheet } from './cockpit-backbone-cards.js';
import { ROUTE_META } from './cockpit-route-meta.js';
import { renderProse } from './cockpit-prose.js';


// ---- Conductor (v1.68.0): the operator command-control surface - Next Command,
// KPI strip, Now/Next/Waiting/Done board, queue summary, Operation Score Matrix,
// last slice-stop, slash cheatsheet. Scope-aware (ctx.scopePill/scopedUrl),
// ctx.panelFocus palette panels, debounced ctx.onSpineEvent. Its board + score
// builders take ctx so their card/row clicks reach ctx.openInspector. Reason-code
// palettes import from cockpit-event-rows (shared with the shell Inspector).

export function renderConductor(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Conductor'));
  root.appendChild(el('p', {}, ROUTE_META.conductor.description));

  const pill = ctx.scopePill('conductor', () => load());
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
  root.appendChild(ctx.panelFocus('Now · Next · Waiting · Done', 'GET /bridge/conductor', boardHost,
    { id: 'board', keywords: 'now next waiting done board kanban work-in-flight' }));

  // ── Queue Board summary card ──
  const queueHost = el('div', {});
  queueHost.appendChild(loading('Loading queue counts…'));
  const queueCard = ctx.panelFocus('Queue Board', 'scheduler · queue · dispatch · preflights', queueHost,
    { id: 'queue', keywords: 'queue scheduler dispatch preflight parked reason-code' });
  queueCard.style.cursor = 'pointer';
  queueCard.addEventListener('click', () => { location.hash = '#/queue'; });
  root.appendChild(queueCard);

  // ── Operation Score Matrix ──
  const matrixHost = el('div', {});
  matrixHost.appendChild(loadingFor('table', 'Loading per-lane score matrix…'));
  root.appendChild(ctx.panelFocus('Operation Score Matrix', 'per-lane progress · claims · reason codes', matrixHost,
    { id: 'score', keywords: 'score matrix progress per-lane claims reason' }));

  // ── Recent slice-stop summary ──
  const sliceHost = el('div', {});
  root.appendChild(ctx.panelFocus('Last slice-stop', 'most recent ritual close', sliceHost,
    { id: 'last-slice', keywords: 'last slice-stop recent ritual learning' }));

  // ── Slash-command quick reference (moved here in v0.19.2) ──
  root.appendChild(ctx.panelFocus('Slash-command quick reference', '/maddu-*', renderSlashCheatsheet(),
    { id: 'slash-cheatsheet', keywords: 'slash commands cheatsheet quick reference maddu-help maddu-autopilot' }));

  let dataLoaded = false;
  const load = async () => {
    let view;
    try {
      const r = await fetch(ctx.scopedUrl('conductor', '/bridge/conductor'), { cache: 'no-store' });
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
    boardHost.replaceChildren(renderConductorBoard(view.board || {}, ctx));

    // Score matrix
    matrixHost.replaceChildren(renderScoreMatrix(view.scoreMatrix || [], ctx));

    // Queue Board summary (counts per column)
    try {
      const qr = await fetch(ctx.scopedUrl('conductor', '/bridge/queue'), { cache: 'no-store' });
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

    // Last slice — id/when/age as a compact kv; the summary is a full record, so
    // render it through the prose formatter (scannable) not a wall in a dd cell.
    if (k.lastSlice) {
      sliceHost.replaceChildren(
        el('dl', { class: 'kv' }, [
          el('dt', {}, 'id'),   el('dd', {}, k.lastSlice.id || '—'),
          el('dt', {}, 'when'), el('dd', {}, formatTs(k.lastSlice.ts)),
          el('dt', {}, 'age'),  el('dd', {}, formatAge(k.lastSliceAgeMs)),
        ]),
        renderProse(k.lastSlice.summary || '(no summary)')
      );
    } else {
      sliceHost.replaceChildren(placeholder('No slice-stops yet', 'Run your first slice-stop to start writing learnings into the spine.'));
    }
  };
  load();

  // Refresh whenever a new event lands. Debounce by skipping if a load is in flight.
  let pending = false;
  ctx.onSpineEvent(() => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 400);
  });

  return root;
}

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

function renderConductorBoard(board, ctx) {
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
        card.addEventListener('click', () => ctx.openInspector({ kind: 'task', id: t.id, data: t }));
        c.appendChild(card);
      }
    }
    wrap.appendChild(c);
  }
  return wrap;
}

function renderScoreMatrix(rows, ctx) {
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
    row.addEventListener('click', () => ctx.openInspector({ kind: 'lane', id: r.lane, data: r }));
    wrap.appendChild(row);
  }
  return wrap;
}

// ---- BOSS (v1.69.0): the final route view - proposal/enforcer/decision terminal.
// BOSS proposes a Enforcer cites a Operator decides. Transcript + session tabs +
// operator strip + the proposal composer. Debounced ctx.onSpineEvent; proposal
// cards open the Inspector via ctx.openInspector (threaded through transcript).
// renderBossComposer is a self-contained form (raw fetch, no ctx). The `composer`
// local in renderBoss is that form NODE - NOT the shell slash-commander singleton,
// which stays in cockpit.js. Reason-code/risk palettes from event-rows/local consts.

const PROPOSAL_RISK_TONE = { low: 'ok', medium: 'warn', high: 'danger' };
const ENFORCER_ACTION_KINDS = ['claim-lane', 'release-lane', 'slice-stop', 'request-handoff', 'approve', 'run-focused-gate', 'write-file'];

const ACTION_FIELDS = {
  'claim-lane':       ['lane', 'sessionId'],
  'release-lane':     ['lane', 'sessionId'],
  'slice-stop':       ['sessionId'],
  'request-handoff':  ['lane'],
  'approve':          ['approvalId', 'decision'],
  'run-focused-gate': ['gate'],
  'write-file':       ['path']
};

export function renderBoss(ctx) {
  const root = el('div', { class: 'view boss-view' });
  root.appendChild(el('h2', {}, 'BOSS'));
  root.appendChild(el('p', {}, ROUTE_META.boss.description));

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
      if (view && view.transcript) renderBossTranscript(transcript, view, ctx);
      else transcript.replaceChildren(placeholder('Empty transcript', 'No messages on this session yet. Use the composer to propose an action.'));
      // Sync composer's bossSessionId.
      composer.dataset.bossSession = currentSession;
    } catch (e) {
      transcript.replaceChildren(placeholder('Offline', e.message || 'Bridge not reachable.'));
    }
  };
  load();

  ctx.onSpineEvent(() => {
    if (pending) return;
    pending = true;
    setTimeout(async () => { try { await load(); } finally { pending = false; } }, 300);
  });

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

function renderBossTranscript(host, view, ctx) {
  const wrap = el('div', { class: 'boss-transcript-inner' });
  const proposalById = new Map((view.proposals || []).map((p) => [p.id, p]));
  for (const msg of view.transcript || []) {
    if (msg.role === 'proposal' && msg.proposalId && proposalById.has(msg.proposalId)) {
      wrap.appendChild(renderProposalCard(proposalById.get(msg.proposalId), ctx));
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

function renderProposalCard(p, ctx) {
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
    ctx.openInspector({ kind: 'proposal', id: p.id, data: p });
  });
  return card;
}

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

