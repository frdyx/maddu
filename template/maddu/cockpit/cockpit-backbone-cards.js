// Máddu cockpit — backbone card renderers (pure data → DOM leaves).
//
// Extracted from cockpit.js (v1.40.0). These are the "card" halves of the
// v0.18 backbone routes: each takes already-fetched data and returns a DOM
// subtree. They depend on NOTHING in the cockpit module scope — only their
// arguments + the el/placeholder leaf builders + standard JS — so they import
// cleanly as a browser ES module. The route render functions that fetch the
// data and call these stay in cockpit.js (they couple to bindRouteRefresh /
// ROUTES); they import these card builders back.

import { el, placeholder } from './cockpit-util.js';

// ─── advisors ───────────────────────────────────────────────────────────
export function renderAdvisorsCard(advisors) {
  if (!advisors.length) {
    return placeholder('No advisor calls yet', 'Run `/maddu-advise <runtime> "<prompt>"` to produce an advisor artifact. Advisors never claim lanes.');
  }
  const wrap = el('div', {});
  // Newest first.
  const sorted = advisors.slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  for (const a of sorted.slice(0, 50)) {
    const preview = String(a.preview || a.body || a.prompt || '').slice(0, 200);
    wrap.appendChild(el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [
        el('span', { class: 'mono' }, a.id || a.artifactId || '(no id)'),
        el('span', { class: 'tag tone-neutral' }, a.runtime || '(no runtime)'),
        a.refused ? el('span', { class: 'tag tone-warn' }, 'refused') : null,
      ]),
      el('div', { class: 'panel-row-meta' }, [
        el('span', { class: 'mono' }, a.sessionId || ''),
        el('span', { class: 'dim' }, a.ts || ''),
      ]),
      el('div', { class: 'panel-row-detail' }, preview || '(no preview)'),
    ]));
  }
  return wrap;
}

// ─── skill injections ───────────────────────────────────────────────────
export function renderSkillInjectionsCard(injections) {
  if (!injections.length) {
    return placeholder('No skill injections yet', 'Skills get inlined into slices via `/maddu-skill apply <id>`. Each injection writes a SKILL_INJECTED event; the skill-injection-bounded gate caps the per-slice budget.');
  }
  const wrap = el('div', {});
  const sorted = injections.slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  for (const inj of sorted.slice(0, 100)) {
    wrap.appendChild(el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [
        el('span', { class: 'mono' }, inj.skillId || inj.skill || '(no skill)'),
        el('span', { class: 'tag tone-neutral' }, inj.sliceId || '(no slice)'),
      ]),
      el('div', { class: 'panel-row-meta' }, [
        el('span', { class: 'mono' }, inj.sessionId || ''),
        el('span', { class: 'dim' }, inj.ts || ''),
      ]),
      inj.reason ? el('div', { class: 'panel-row-detail' }, inj.reason) : null,
    ]));
  }
  return wrap;
}

// ─── model routing ──────────────────────────────────────────────────────
function formatModelPref(pref) {
  if (pref == null) return '(none)';
  if (typeof pref === 'string') return pref;
  if (typeof pref === 'object') {
    const parts = Object.entries(pref).map(([k, v]) => `${k}: ${v}`);
    return parts.length ? parts.join(' · ') : '(empty)';
  }
  return String(pref);
}

export function renderModelRoutingRuntimes(runtimes) {
  if (!runtimes.length) {
    return placeholder('No runtime descriptors', 'Register a runtime under `.maddu/runtimes/` or via `maddu runtime add`.');
  }
  const wrap = el('div', {});
  for (const r of runtimes) {
    wrap.appendChild(el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [
        el('span', { class: 'mono' }, r.id || r.name || '(no id)'),
        el('span', { class: 'tag tone-neutral' }, r.kind || ''),
      ]),
      el('div', { class: 'panel-row-detail' }, `modelPreference: ${formatModelPref(r.modelPreference)}`),
    ]));
  }
  return wrap;
}

export function renderModelRoutingLanes(lanes) {
  if (!lanes.length) {
    return placeholder('No lanes with model defaults', 'Add `defaults.modelPreference` to a lane in `.maddu/lanes/catalog.json`.');
  }
  const rows = lanes.filter((l) => l.defaults && l.defaults.modelPreference != null);
  if (!rows.length) {
    return placeholder('No lane modelPreference set', 'Lanes inherit the global default. Set `defaults.modelPreference` in `.maddu/lanes/catalog.json` to override per lane.');
  }
  const wrap = el('div', {});
  for (const lane of rows) {
    wrap.appendChild(el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [
        el('span', { class: 'pill tone-accent' }, lane.id),
      ]),
      el('div', { class: 'panel-row-detail' }, `modelPreference: ${formatModelPref(lane.defaults.modelPreference)}`),
    ]));
  }
  return wrap;
}

export function renderModelRoutingPipelines(pipelines) {
  if (!pipelines.length) {
    return placeholder('No pipelines with stage hints', 'Pipeline stages can declare `modelPreference` to route different stages to different models.');
  }
  const wrap = el('div', {});
  for (const p of pipelines.slice(-10).reverse()) {
    const stageRows = (p.stages || [])
      .filter((s) => s.modelPreference != null)
      .map((s) => `${s.name}: ${formatModelPref(s.modelPreference)}`);
    if (!stageRows.length) continue;
    wrap.appendChild(el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [
        el('span', { class: 'mono' }, p.id || p.name || ''),
      ]),
      el('div', { class: 'panel-row-detail' }, stageRows.join(' · ')),
    ]));
  }
  if (!wrap.childNodes.length) {
    return placeholder('No stage-level modelPreference set', 'Add `modelPreference` to a pipeline stage to route just that stage to a specific model.');
  }
  return wrap;
}

// ─── test status ────────────────────────────────────────────────────────
function ageMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Date.now() - t;
}

function ageDays(ms) {
  if (ms == null) return null;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function renderTestStatusCard(data) {
  const rows = [
    { key: 'stress', label: 'Stress harness', warnDays: 7, data: data.stress },
    { key: 'upgradeMatrix', label: 'Upgrade matrix', warnDays: 14, data: data.upgradeMatrix },
  ];
  if (rows.every((r) => !r.data)) {
    return placeholder('No test runs recorded', 'Run `node scripts/test/stress-harness.mjs` or the upgrade-matrix verifier to populate `.maddu/state/*-last-run.json`.');
  }
  const wrap = el('div', {});
  for (const row of rows) {
    if (!row.data) {
      wrap.appendChild(el('div', { class: 'panel-row' }, [
        el('div', { class: 'panel-row-head' }, [
          el('span', { class: 'mono' }, row.label),
          el('span', { class: 'tag tone-neutral' }, 'never'),
        ]),
        el('div', { class: 'panel-row-detail dim' }, 'No run recorded yet.'),
      ]));
      continue;
    }
    const ts = row.data.completedAt || row.data.ts || row.data.startedAt || null;
    const age = ageMs(ts);
    const days = ageDays(age);
    const stale = days != null && days > row.warnDays;
    wrap.appendChild(el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [
        el('span', { class: 'mono' }, row.label),
        el('span', { class: `tag tone-${stale ? 'warn' : 'ok'}` }, stale ? `stale (${days}d)` : 'recent'),
      ]),
      el('div', { class: 'panel-row-meta' }, [
        el('span', { class: 'dim' }, ts || '(no timestamp)'),
        el('span', { class: 'dim' }, `threshold: ${row.warnDays}d`),
      ]),
      row.data.summary ? el('div', { class: 'panel-row-detail' }, String(row.data.summary)) : null,
    ]));
  }
  return wrap;
}

// ─── teams (v0.18 backbone card; currently unreferenced — kept with its
// siblings rather than deleted) ───────────────────────────────────────────
export function renderTeamsCard(teams) {
  if (teams.length === 0) {
    return placeholder('No teams open', 'Run `maddu team open --members 2 --lanes a,b` (or `/maddu-team 2 "<task>"`) to fan out.');
  }
  const wrap = el('div', {});
  for (const t of teams) {
    const row = el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [
        el('span', { class: 'mono' }, t.id),
        el('span', { class: `tag tone-${t.status === 'open' ? 'ok' : 'neutral'}` }, t.status),
      ]),
      el('div', { class: 'panel-row-meta' }, [
        el('span', {}, `${(t.lanes || []).length} lane(s)`),
        el('span', {}, `${(t.members || []).length} member(s)`),
        el('span', { class: 'dim' }, t.openedAt || ''),
      ]),
      el('div', { class: 'panel-row-detail' }, `lanes: ${(t.lanes || []).join(', ')}`),
    ]);
    wrap.appendChild(row);
  }
  return wrap;
}

// ─── pipelines ──────────────────────────────────────────────────────────
export function renderPipelinesCard(pipelines) {
  if (pipelines.length === 0) {
    return placeholder('No pipelines run yet', 'Run `maddu pipeline run plan-exec-verify-fix "<goal>"` (or `/maddu-autopilot`) to start one.');
  }
  const wrap = el('div', {});
  for (const p of pipelines.slice(-10).reverse()) {
    const stageNames = (p.stages || []).map((s) => `${s.name}${s.status === 'ok' ? '✓' : (s.exitedAt ? '' : '…')}`).join(' → ');
    const row = el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [
        el('span', { class: 'mono' }, p.id),
        el('span', { class: `tag tone-${p.status === 'completed' ? 'ok' : (p.status === 'halted' ? 'warn' : 'neutral')}` }, p.status),
      ]),
      el('div', { class: 'panel-row-meta' }, [
        el('span', { class: 'mono' }, p.name || ''),
        el('span', { class: 'dim' }, p.goal || ''),
        el('span', { class: 'dim' }, p.startedAt || ''),
      ]),
      el('div', { class: 'panel-row-detail' }, stageNames || '(no stages)'),
    ]);
    wrap.appendChild(row);
  }
  return wrap;
}

// ─── cost ───────────────────────────────────────────────────────────────
export function renderCostCard(ledger) {
  if (ledger.length === 0) {
    return placeholder('No token usage reported', 'Workers emit TOKEN_USAGE_REPORTED events with at least { runtime, sessionId, model, ts }. `maddu cost --unreported-count` surfaces gaps honestly.');
  }
  const byRuntime = new Map();
  let unreported = 0;
  for (const row of ledger) {
    const k = row.runtime || '(unknown)';
    if (!byRuntime.has(k)) byRuntime.set(k, { calls: 0, input: 0, output: 0, unreported: 0 });
    const g = byRuntime.get(k);
    g.calls++;
    if (row.inputTokens != null) g.input += row.inputTokens; else { g.unreported++; unreported++; }
    if (row.outputTokens != null) g.output += row.outputTokens;
  }
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'panel-row-meta' }, [
    el('span', {}, `${ledger.length} call(s)`),
    el('span', { class: unreported > 0 ? 'tag tone-warn' : 'dim' }, `${unreported} unreported`),
  ]));
  for (const [runtime, g] of byRuntime) {
    wrap.appendChild(el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [el('span', { class: 'mono' }, runtime), el('span', { class: 'dim' }, `${g.calls} calls`)]),
      el('div', { class: 'panel-row-detail' }, `in: ${g.input.toLocaleString()} · out: ${g.output.toLocaleString()} · unreported: ${g.unreported}`),
    ]));
  }
  return wrap;
}

// ─── slash cheatsheet ───────────────────────────────────────────────────
// Baked-in roster — kept in sync with template/maddu/agent-files/commands/.
const SLASH_CHEATSHEET = [
  { name: '/maddu-help',      line: 'Discovery guide — list commands by topic.' },
  { name: '/maddu-doctor',    line: 'Run hard-rule gates and surface findings.' },
  { name: '/maddu-autopilot', line: 'Register → claim → pipeline → slice-stop.' },
  { name: '/maddu-plan',      line: 'Plan-only stage; write a brief artifact.' },
  { name: '/maddu-review',    line: 'Post-stop review of a slice.' },
  { name: '/maddu-team',      line: 'Open N child sessions with disjoint lanes.' },
  { name: '/maddu-advise',    line: 'Non-claiming advisor query; artifact-only.' },
  { name: '/maddu-status',    line: 'Pretty-print state across surfaces.' },
  { name: '/maddu-cost',      line: 'Token / call rollup.' },
  { name: '/maddu-skill',     line: 'List / search / apply skills.' },
  { name: '/maddu-cancel',    line: 'Stop the current slice cleanly.' },
  { name: '/maddu-note',      line: 'One-liner into the operator inbox.' },
];

export function renderSlashCheatsheet() {
  const wrap = el('div', {});
  for (const c of SLASH_CHEATSHEET) {
    wrap.appendChild(el('div', { class: 'panel-row' }, [
      el('div', { class: 'panel-row-head' }, [
        el('span', { class: 'mono' }, c.name),
      ]),
      el('div', { class: 'panel-row-detail' }, c.line),
    ]));
  }
  wrap.appendChild(el('p', { class: 'dim' }, 'Natural language works too — type "ship the login form" or "status" and the agent will pick the slash command for you. See MADDU.md §"Intent routing".'));
  return wrap;
}
