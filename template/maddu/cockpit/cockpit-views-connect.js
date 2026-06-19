// M�ddu cockpit  connect-cluster route views (settings + trust posture).
//
// Extracted from cockpit.js across v1.55.0–v1.58.0 — the complete "connect"
// cluster (settings, trust, auth, imports, schedule, mcp, runtimes). renderTrust
// is a pure-leaf posture page (its own 15s setInterval, verbatim); renderSettings
// registers command-palette sub-targets via ctx.panelFocus. The rest are stream-
// coupled (AUTH_KEY_/IMPORT_/SCHEDULE_/MCP_/RUNTIME_+WORKER_) and subscribe through
// ctx.onSpineEvent (route-local teardown); write actions stamp by:/sessionId: via
// ctx.currentSession(); ?focus= is honored via ctx.paletteFocus/focusPanelByKeyword;
// renderSchedule is scope-aware (ctx.scopePill/scopeIsGlobal/rerender). The module
// imports only leaves + route metadata + the already-extracted comms panels.

import { el, panel, placeholder, loading, formatUptime, showToast } from './cockpit-util.js';
import { statusGrid, meter, donut } from './cockpit-widgets.js';
import { ROUTE_META } from './cockpit-route-meta.js';
import { renderTelegramPanel, renderDiscordPanel, renderEmailPanel } from './cockpit-comms.js';

export function renderTrust() {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Trust'));
  root.appendChild(el('p', {}, ROUTE_META.trust.description));

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

export function renderSettings(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Settings'));
  root.appendChild(el('p', {}, ROUTE_META.settings.description));

  // Each panel below uses ctx.panelFocus() — stamps data-focus and registers
  // the sub-target. Keys match SUB_TARGET_MANIFEST.settings for parity.
  const bridgeMount = el('div', {});
  bridgeMount.appendChild(loading('Reading bridge status…'));
  root.appendChild(ctx.panelFocus('Bridge', 'GET /bridge/status', bridgeMount,
    { id: 'bridge', keywords: 'bridge http server port host status uptime version' }));

  const lanesMount = el('div', {});
  lanesMount.appendChild(loading('Fetching lane catalog…'));
  root.appendChild(ctx.panelFocus('Lanes', 'GET /bridge/lanes  ·  edit .maddu/lanes/catalog.json', lanesMount,
    { id: 'lanes', keywords: 'lanes zones lease handoff policy catalog' }));

  const authMount = el('div', {});
  authMount.appendChild(loading('Fetching providers…'));
  root.appendChild(ctx.panelFocus('Providers', 'GET /bridge/auth  ·  full management in /auth', authMount,
    { id: 'providers', keywords: 'providers anthropic openai api keys credentials oauth tokens' }));

  const mcpMount = el('div', {});
  mcpMount.appendChild(loading('Fetching MCP registry…'));
  root.appendChild(ctx.panelFocus('MCP registry', 'GET /bridge/mcp  ·  full management in /mcp', mcpMount,
    { id: 'mcp', keywords: 'mcp model-context-protocol servers tools stdio sse' }));

  const rtMount = el('div', {});
  rtMount.appendChild(loading('Fetching runtimes…'));
  root.appendChild(ctx.panelFocus('Runtimes', 'GET /bridge/runtimes  ·  full management in /runtimes', rtMount,
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
      commsSlot.appendChild(ctx.panelFocus('Integrations (comms plugin)',
        'Telegram / Discord / Email — disabled. Enable with `maddu plugin enable comms`, then restart the bridge.',
        el('div', {}),
        { id: 'comms', keywords: 'telegram discord email comms plugin integrations notifications disabled enable' }));
      return;
    }
    const tgMount = el('div', {});
    tgMount.appendChild(loading('Reading Telegram status…'));
    commsSlot.appendChild(ctx.panelFocus('Telegram bridge', 'optional · long-poll, allowlisted · message bodies route via Telegram', tgMount,
      { id: 'telegram', keywords: 'telegram tg messenger chat phone notification mobile bot integrations' }));
    renderTelegramPanel(tgMount);

    const dcMount = el('div', {});
    dcMount.appendChild(loading('Reading Discord status…'));
    commsSlot.appendChild(ctx.panelFocus('Discord bridge', 'optional · outbound-only (no gateway) · message bodies route via Discord', dcMount,
      { id: 'discord', keywords: 'discord channel server guild bot integrations notifications' }));
    renderDiscordPanel(dcMount);

    const emMount = el('div', {});
    emMount.appendChild(loading('Reading email status…'));
    commsSlot.appendChild(ctx.panelFocus('Email bridge', 'optional · outbound-only SMTP · TLS required (port 465/587)', emMount,
      { id: 'email', keywords: 'email smtp mail gmail outlook fastmail notifications outbound webhook imap' }));
    renderEmailPanel(emMount);
  })();

  const pathsMount = el('div', {});
  pathsMount.appendChild(loading('Resolving paths…'));
  root.appendChild(ctx.panelFocus('Storage paths', 'Resolved at bridge boot', pathsMount,
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
  root.appendChild(ctx.panelFocus('Hard rules · Docs', 'Open the manual', rulesBody,
    { id: 'hardrules', keywords: 'hard rules invariants compliance security boundary files-only sqlite hosted deps sdk token export brand lane ownership' }));

  // Honor ?focus=<keyword> from the palette — placed last so every panel
  // is in the DOM before the scroll-flash fires.
  const focus = ctx.paletteFocus();
  if (focus) ctx.focusPanelByKeyword(root, focus);

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

//     Auth route (provider keys, rate-limit state)                          
// Stream-coupled connect view: re-runs on AUTH_KEY_* spine events via the
// ctx.onSpineEvent seam (route-local teardown). fetchAuth/fetchAuthProvider are
// module-private (renderAuth is their only caller).
async function fetchAuth() {
  try { const r = await fetch('/bridge/auth', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function fetchAuthProvider(provider) {
  try { const r = await fetch(`/bridge/auth/${encodeURIComponent(provider)}`, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

export function renderAuth(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Auth'));
  root.appendChild(el('p', {}, ROUTE_META.auth.description));

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
  let selectedProvider = ctx.paletteFocus();
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
      const f = ctx.paletteFocus();
      if (f) ctx.focusPanelByKeyword(root, f);
    });
  }

  refresh();
  ctx.onSpineEvent((e) => { if (e.detail.type && e.detail.type.startsWith('AUTH_KEY_')) refresh(); });
  return root;
}

//     Imports route (guarded payload intake  skill/memory/lane/brief/inbox)   
// Stream-coupled connect view: re-runs on IMPORT_* spine events via
// ctx.onSpineEvent. Submit stamps `by: ctx.currentSession()`. fetchImports is
// module-private (renderImports is its only caller).
async function fetchImports() {
  try { const r = await fetch('/bridge/imports', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

export function renderImports(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Imports'));
  root.appendChild(el('p', {}, ROUTE_META.imports.description));

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
        body: JSON.stringify({ kind: kindSel.value, payload, by: ctx.currentSession() || null })
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
  ctx.onSpineEvent((e) => { if (e.detail.type && e.detail.type.startsWith('IMPORT_')) refresh(); });
  return root;
}

//    connect-cluster infra views (v1.58.0): schedule + mcp + runtimes   
// The remaining three connect route views, extracted as mechanical ctx-swap
// moves now that every seam they need exists. All three are stream-coupled
// (SCHEDULE_/MCP_/RUNTIME_+WORKER_) via ctx.onSpineEvent and stamp `by:` /
// `sessionId:` through ctx.currentSession(). renderSchedule is scope-aware
// (ctx.scopePill + ctx.scopeIsGlobal + ctx.rerender); renderMcp/renderRuntimes
// honor ?focus= via ctx.paletteFocus/ctx.focusPanelByKeyword. fetchMcp and
// fetchRuntimes ride along as module-private fetch helpers.

export function renderSchedule(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Schedule'));
  root.appendChild(el('p', {}, ROUTE_META.schedule.description));

  // Slice 4: scope pill (this workspace vs global). Hidden in legacy
  // single-workspace mode. Global schedules live in
  // ~/.config/maddu/global/schedules.ndjson and fan out to N workspaces.
  const pill = ctx.scopePill('schedule', () => ctx.rerender());
  if (pill) root.appendChild(pill);
  const isGlobal = ctx.scopeIsGlobal('schedule');
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
      const body = { title, natural: nat, by: ctx.currentSession() || null };
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
  ctx.onSpineEvent((e) => { if (e.detail.type && e.detail.type.startsWith('SCHEDULE_')) refresh(); });
  setTimeout(() => inpTitle.focus(), 0);
  return root;
}

async function fetchMcp() {
  try { const r = await fetch('/bridge/mcp', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

export function renderMcp(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'MCP Registry'));
  root.appendChild(el('p', {}, ROUTE_META.mcp.description));

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
      by: ctx.currentSession() || null
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
      const f = ctx.paletteFocus();
      if (f) ctx.focusPanelByKeyword(root, f);
    });
  }

  refresh();
  ctx.onSpineEvent((e) => { if (e.detail.type && e.detail.type.startsWith('MCP_')) refresh(); });
  return root;
}

async function fetchRuntimes() {
  try { const r = await fetch('/bridge/runtimes', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

export function renderRuntimes(ctx) {
  const root = el('div', { class: 'view' });
  root.appendChild(el('h2', {}, 'Runtimes'));
  root.appendChild(el('p', {}, ROUTE_META.runtimes.description));

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
          by: ctx.currentSession() || null
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
                  body: JSON.stringify({ sessionId: ctx.currentSession() || null })
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
      const f = ctx.paletteFocus();
      if (f) ctx.focusPanelByKeyword(root, f);
    });
  }

  refresh();
  ctx.onSpineEvent((e) => { if (e.detail.type && (e.detail.type.startsWith('RUNTIME_') || e.detail.type.startsWith('WORKER_'))) refresh(); });
  return root;
}
