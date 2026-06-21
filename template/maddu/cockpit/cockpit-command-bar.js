// M�ddu cockpit  the slash-command bar (composer + command palette).
//
// Extracted from cockpit.js (v1.71.0). One cohesive subsystem: the bottom
// composer input (slash-command parsing + dispatch to the bridge via postJson/
// fetchJson + runCommand, sticky session pointer, history) and the Ctrl/Cmd-K
// command palette (fuzzy search over routes + view-registered panel sub-targets
// + workspaces, keyboard nav, ?focus= deep-link writing). Owns the `composer`
// singleton + the COMMANDS table. The shell injects what stays in the composition
// root  the route registry, the framework-only filter, the panel sub-target
// registry, the workspace switcher  via initCommandBar(host). Route views never
// see this; they only read ctx.paletteFocus / focusPanelByKeyword / currentSession,
// which cockpit.js re-exposes from here.
//
// host = { routes, isRouteHidden, allSubTargets, refreshDataSubTargets,
//          getWorkspaces, getCurrentWorkspace, setActiveWorkspace }

import { el, showToast } from './cockpit-util.js';

let host = null;

// Boot entry  cockpit.js calls this once with the shell accessors, which wires
// the composer input + the palette hotkey/overlay.
export function initCommandBar(h) { host = h; initComposer(); initPalette(); }

// Narrow read accessor for the composer's sticky session pointer  cockpit.js
// assigns this onto ctx.currentSession so POST-ing views stamp `by:` with it.
export function currentSession() { return composer.currentSession; }
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

  // Global "?" opens the Docs route from anywhere.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    if (!location.hash.startsWith('#/docs')) location.hash = '#/docs';
  });
}

function paletteItems(query) {
  const q = (query || '').toLowerCase().trim();
  const out = [];

  // Routes — top-level destinations.
  for (const [id, r] of Object.entries(host.routes)) {
    if (host.isRouteHidden(r)) continue;  // v1.0.3 — framework-only on consumer installs
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
  for (const s of host.allSubTargets()) {
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
        group: s.group || host.routes[s.route]?.group,
        anchor: true,
        desc: s.description,
        targetRoute: s.route,
        focus: s.id,
        score
      });
    }
  }

  // Workspaces — operator can switch the active workspace from anywhere.
  if (host.getWorkspaces().length > 1) {
    for (const w of host.getWorkspaces()) {
      if (w.id === host.getCurrentWorkspace()) continue;
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
  host.refreshDataSubTargets().then(() => {
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
    host.setActiveWorkspace(it.workspaceId);
  } else {
    location.hash = `#/${it.id}`;
  }
}

export function paletteFocus() {
  const m = location.hash.match(/[?&]focus=([^&]+)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

export function focusPanelByKeyword(root, keyword) {
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
