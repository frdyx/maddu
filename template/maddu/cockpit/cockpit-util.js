// Máddu cockpit — pure leaf utilities (DOM builder + formatters).
//
// Extracted from cockpit.js (v1.24.0) as the first slice of decomposing the
// SPA monolith. These functions depend on NOTHING in the cockpit module scope
// (only their arguments + standard browser/JS APIs), so they're safe to import
// as a browser ES module. No framework, no build step — the bridge serves this
// as application/javascript and cockpit.js imports from it directly.

// el(tag, attrs, children) — the core DOM builder used across the cockpit.
// `class` sets className, `html` sets innerHTML, anything else is a plain
// attribute; children may be nodes or strings (strings become text nodes),
// null/undefined children are skipped.
export function el(tag, attrs = {}, children = []) {
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

// panel(title, aside, body) — the standard titled panel shell.
export function panel(title, aside, body) {
  return el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('span', { class: 'panel-title' }, title),
      aside ? el('span', { class: 'panel-aside' }, aside) : null
    ]),
    body
  ]);
}

// placeholder(name, planned) — unified empty state (Phase 5). Same signature as
// the old helper so every call site upgrades automatically.
export function placeholder(name, planned) {
  return el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-state-glyph', 'aria-hidden': 'true' }, '◌'),
    el('div', { class: 'empty-state-title' }, name),
    el('div', { class: 'empty-state-hint' }, planned || '')
  ]);
}

// truncatePathFromLeft — keep the right end of a path, ellipsis on the left.
export function truncatePathFromLeft(p, max = 40) {
  if (!p || typeof p !== 'string') return '—';
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

// compactPath — v1.2.2 compact "drive-root … basename" form for the rail-foot
// Path row. Keeps the drive prefix (so operator sees C:/ vs D:/), an ellipsis
// for the middle, and the last path segment (basename, the part that names the
// repo). Width-bounded; the native browser tooltip reveals the full path.
export function compactPath(p) {
  if (!p || typeof p !== 'string') return '—';
  // Normalize separators for display + drop trailing slashes.
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 2) return norm;
  // Windows drive root pattern (e.g. `C:`): keep as-is; else use the first segment.
  const root = /^[A-Za-z]:$/.test(parts[0]) ? parts[0] : parts[0];
  const tail = parts[parts.length - 1];
  return `${root}/…/${tail}`;
}

// formatUptime — humanize a millisecond duration as s / m / h+m / d+h.
export function formatUptime(ms) {
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

// formatAge — humanize a millisecond age as the largest single unit (s/m/h/d).
// Companion to formatUptime; used by heartbeat/recency labels across views.
export function formatAge(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ageTone — map a millisecond age to a semantic tone token (fresh→stale).
export function ageTone(ms) {
  if (ms == null) return 'neutral';
  if (ms < 60 * 60 * 1000) return 'ok';
  if (ms < 4 * 60 * 60 * 1000) return 'accent';
  if (ms < 24 * 60 * 60 * 1000) return 'warn';
  return 'danger';
}

// formatTs — render an ISO timestamp as "YYYY-MM-DD HH:MM:SSZ" (space instead of
// T, fractional seconds dropped). Returns the input unchanged if unparseable.
export function formatTs(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'); }
  catch { return iso; }
}

// loading(text) — the default skeleton placeholder (3 shimmer lines + caption).
export function loading(text) {
  return el('div', { class: 'skel-state' }, [
    el('div', { class: 'skel-line skel-line-lg' }),
    el('div', { class: 'skel-line skel-line-md' }),
    el('div', { class: 'skel-line skel-line-sm' }),
    el('div', { class: 'skel-text', 'aria-live': 'polite' }, text || 'Loading…')
  ]);
}

// loadingFor(kind, text) — shape-aware skeleton variants. Falls back to the
// default loading() for unknown kinds. Each returns the same outer .skel-state
// container so existing CSS that targets the parent still applies.
//   'kpi'     — horizontal strip of 4 tiles (Conductor/Roadmap KPIs)
//   'grid'    — 6-card responsive grid (Agents, Teams, MCP, Runtimes)
//   'table'   — 5 ledger-row stripes (Events, Approvals, Slice index)
//   'donut'   — donut + 4 meters (Mailbox/Imports/Auth summary)
//   'card'    — single card with title+lines (Inspector body, single-pane fetches)
//   'default' / unknown — same as loading(text)
export function loadingFor(kind, text) {
  const caption = el('div', { class: 'skel-text', 'aria-live': 'polite' }, text || 'Loading…');
  const wrap = (children) => el('div', { class: 'skel-state' }, [...children, caption]);
  switch (kind) {
    case 'kpi': {
      const strip = el('div', { class: 'skel-kpi-strip' });
      for (let i = 0; i < 4; i++) {
        strip.appendChild(el('div', { class: 'skel-kpi-tile' }, [
          el('div', { class: 'skel-line skel-line-num' }),
          el('div', { class: 'skel-line skel-line-tag' })
        ]));
      }
      return wrap([strip]);
    }
    case 'grid': {
      const grid = el('div', { class: 'skel-grid' });
      for (let i = 0; i < 6; i++) {
        grid.appendChild(el('div', { class: 'skel-card' }, [
          el('div', { class: 'skel-line skel-line-md' }),
          el('div', { class: 'skel-line skel-line-sm' }),
          el('div', { class: 'skel-line skel-line-lg' })
        ]));
      }
      return wrap([grid]);
    }
    case 'table': {
      const rows = el('div', { class: 'skel-table' });
      for (let i = 0; i < 5; i++) {
        rows.appendChild(el('div', { class: 'skel-row' }, [
          el('div', { class: 'skel-line skel-line-cell-sm' }),
          el('div', { class: 'skel-line skel-line-cell-md' }),
          el('div', { class: 'skel-line skel-line-cell-lg' }),
          el('div', { class: 'skel-line skel-line-cell-sm' })
        ]));
      }
      return wrap([rows]);
    }
    case 'donut': {
      const layout = el('div', { class: 'skel-donut-layout' }, [
        el('div', { class: 'skel-donut' }),
        el('div', { class: 'skel-meters' }, [
          el('div', { class: 'skel-line skel-line-lg' }),
          el('div', { class: 'skel-line skel-line-md' }),
          el('div', { class: 'skel-line skel-line-md' }),
          el('div', { class: 'skel-line skel-line-sm' })
        ])
      ]);
      return wrap([layout]);
    }
    case 'card': {
      return wrap([
        el('div', { class: 'skel-card' }, [
          el('div', { class: 'skel-line skel-line-lg' }),
          el('div', { class: 'skel-line skel-line-md' }),
          el('div', { class: 'skel-line skel-line-md' }),
          el('div', { class: 'skel-line skel-line-sm' })
        ])
      ]);
    }
    default:
      return loading(text);
  }
}

// Transient toast into #toast-region. A leaf UI helper (DOM + setTimeout only,
// no cockpit state), shared by cockpit.js and the route/panel modules. No-ops
// if the region isn't mounted. Duration scales with content (3 s base + 35 ms
// per char, capped at 9 s); the stack is bounded to 5.
export function showToast(text, level = 'ok') {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const t = document.createElement('div');
  t.className = 'toast';
  if (level === 'err' || level === 'warn' || level === 'ok') t.classList.add(level);
  t.textContent = text;
  const ms = Math.min(3000 + (text || '').length * 35, 9000);
  const dismiss = () => {
    if (t._dismissing) return;
    t._dismissing = true;
    t.classList.add('dismissing');
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
  };
  t.addEventListener('click', dismiss);
  region.appendChild(t);
  while (region.children.length > 5) region.removeChild(region.firstChild);
  setTimeout(dismiss, ms);
}
