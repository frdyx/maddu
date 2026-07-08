// Máddu cockpit — Oversight route view.
//
// The non-coder oversight readout. A vibe coder can't inspect a skill's code,
// but they CAN see what the agent DID with it, in plain language, on three legs:
//   1 (HERO) Skills fed vs WITHHELD — and WHY, in plain English (the URL-swap
//            payoff made visible: the block nobody could see before).
//   2        Did it stay on your goal? — the Focus Director's drift readout.
//   3        Is the record intact? — tamper-evident spine + published contract,
//            independently checkable with plain sha256.
// Data: GET /bridge/oversight. Navy-noir language, existing --m-* tokens only.
// Accountability substrate — NOT a claim that the skill is "safe."
//
// NOTE: el(tag, attrs, children) takes children as an ARRAY (or a single node /
// string) — multi-child nodes MUST pass an array, never variadic args.

import { el, panel, placeholder, loading } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';

function eyebrow(text) {
  return el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--m-fg-3);margin:0 0 6px;' }, text);
}

// Display-time "how long ago" from the bridge-computed ageMs (the projection
// stays wall-clock-free; humanizing happens here). Exported for the fixture.
export function humanAge(ms) {
  if (typeof ms !== 'number' || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function mono(text, extra = '') {
  return el('span', { style: `font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);${extra}` }, text);
}

// ── LEG 1 — a single WITHHELD skill card (the hero). Danger-tinted, reason big. ──
function withheldCard(row) {
  const items = Array.isArray(row.refused) ? row.refused : [];
  const age = humanAge(row.ageMs);
  return el('div', { style: 'border:1px solid var(--m-danger-border);background:var(--m-danger-bg);border-radius:var(--m-radius-sm,6px);padding:12px 14px;margin-bottom:10px;' },
    items.map((it) => el('div', { style: 'margin:2px 0;' }, [
      el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:4px;' }, [
        el('span', { style: 'color:var(--m-danger);font-size:14px;' }, '⃠'),
        el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;letter-spacing:.14em;color:var(--m-danger);' }, 'WITHHELD'),
        el('span', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-1);' }, it.id || '(skill)'),
      ]),
      el('div', { style: 'font-size:14px;color:var(--m-fg-0);margin-bottom:4px;' }, it.plain || 'blocked'),
      el('div', {}, [
        mono(it.provenance ? `provenance: ${it.provenance}` : ''),
        age ? mono(` · ${age}`) : null,
      ]),
    ])));
}

// ── LEG 1 — a fed-skill row (muted; context, not alarm). ──
function fedRow(row) {
  const ids = Array.isArray(row.skillIds) ? row.skillIds : [];
  const ctxBits = [
    (row.triggers || []).length ? `triggers: ${row.triggers.join(', ')}` : null,
    (row.tags || []).length ? `tags: ${row.tags.join(', ')}` : null,
    `${row.totalBytes || 0} B`,
    humanAge(row.ageMs),
  ].filter(Boolean).join(' · ');
  return el('div', { style: 'padding:6px 0;border-bottom:1px solid var(--m-line);' }, [
    el('div', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-1);' }, ids.length ? ids.join(', ') : '(skill)'),
    el('div', {}, mono(ctxBits)),
  ]);
}

export function renderOversight(ctx) {
  const root = el('div', { class: 'view' }, [
    el('h2', {}, 'Oversight'),
    el('p', {}, ROUTE_META.oversight.description),
  ]);

  const mount = el('div', {}, loading('Reading the record…'));
  const body = ctx && ctx.panelFocus
    ? ctx.panelFocus('Oversight', 'GET /bridge/oversight · what the agent did with a skill · accountability, not a safety proof', mount,
        { id: 'oversight', keywords: 'oversight skill withheld blocked drift on-goal verify chain contract accountability' })
    : panel('Oversight', 'GET /bridge/oversight · what the agent did with a skill', mount);
  root.appendChild(body);

  (async () => {
    let data = null;
    try { const r = await fetch('/bridge/oversight', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch {}
    mount.textContent = '';
    if (!data || !data.skills) {
      mount.appendChild(placeholder('No record yet', 'Once agents run under Máddu, this shows what skills they were fed, what was withheld and why, whether they stayed on your goal, and that the record is intact.'));
      return;
    }

    const skills = data.skills || {};
    const injected = Array.isArray(skills.injected) ? skills.injected : [];
    const refused = Array.isArray(skills.refused) ? skills.refused : [];
    const withheld = typeof skills.withheldCount === 'number' ? skills.withheldCount : 0;

    // ── LEG 1 (HERO) — Skills fed & WITHHELD ──
    mount.appendChild(eyebrow('Skills'));
    mount.appendChild(el('div', { style: 'display:flex;gap:24px;align-items:baseline;flex-wrap:wrap;margin-bottom:12px;' }, [
      el('div', {}, [
        el('span', { style: 'font-size:30px;font-weight:600;color:var(--m-fg-0);line-height:1;' }, String(injected.length)),
        el('span', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-3);margin-left:6px;' }, 'fed'),
      ]),
      el('div', {}, [
        el('span', { style: `font-size:30px;font-weight:600;line-height:1;color:${withheld > 0 ? 'var(--m-danger)' : 'var(--m-ok)'};` }, String(withheld)),
        el('span', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-3);margin-left:6px;' }, 'withheld'),
      ]),
    ]));

    if (withheld > 0) {
      refused.forEach((row) => mount.appendChild(withheldCard(row)));
    } else {
      mount.appendChild(el('div', { style: 'font-size:13px;color:var(--m-ok);margin-bottom:12px;' },
        `✓ ${skills.emptyState || '0 withheld — nothing blocked yet'}`));
    }

    if (injected.length) {
      mount.appendChild(el('div', { style: 'margin-top:6px;' }, [
        eyebrow('Fed to the agent'),
        el('div', {}, injected.map(fedRow)),
      ]));
    }

    // ── LEG 2 — Did it stay on your goal? ──
    // Type-narrow every field: a permissive/empty bridge envelope must fall
    // through to sensible copy, never throw (e.g. a non-string tag).
    const focus = (data.focus && typeof data.focus === 'object') ? data.focus : {};
    const tag = typeof focus.lastTag === 'string' ? focus.lastTag : null;
    const goal = typeof focus.goal === 'string' ? focus.goal : null;
    const openFlag = (focus.openFlag && typeof focus.openFlag.reason === 'string') ? focus.openFlag : null;
    mount.appendChild(el('div', { style: 'margin-top:18px;' }, [eyebrow('Stayed on your goal?')]));
    const tagColor = tag === 'toward' ? 'var(--m-accent)' : tag === 'away' ? 'var(--m-danger)' : tag === 'lateral' ? 'var(--m-warn)' : 'var(--m-fg-3)';
    const goalLine = el('div', { style: 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px;' }, [
      el('span', { style: `font-family:var(--m-font-mono);font-size:16px;font-weight:600;letter-spacing:.06em;color:${tagColor};` }, (tag || 'no signal').toUpperCase()),
      goal ? el('span', { style: 'font-size:12px;color:var(--m-fg-2);' }, `goal: ${goal}`) : null,
    ]);
    mount.appendChild(goalLine);
    if (openFlag) {
      const menu = (Array.isArray(openFlag.menu) && openFlag.menu.length ? openFlag.menu : ['swap', 'revert', 'continue']);
      mount.appendChild(el('div', { style: 'border:1px solid var(--m-danger-border);background:var(--m-danger-bg);border-radius:var(--m-radius-sm,6px);padding:10px 12px;margin-bottom:6px;' }, [
        el('div', { style: 'font-size:13px;color:var(--m-fg-0);margin-bottom:8px;' }, openFlag.reason),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, menu.map((c) =>
          el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;padding:4px 10px;border:1px solid var(--m-line);border-radius:var(--m-radius-sm,5px);color:var(--m-fg-1);background:var(--m-bg-2);' }, String(c)))),
      ]));
    } else {
      mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-ok);margin-bottom:6px;' }, '✓ On course — no open drift flag.'));
    }
    mount.appendChild(el('a', { href: '#/focus', style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-accent-2);text-decoration:none;' }, 'Open Focus Director →'));

    // ── LEG 3 — Is the record intact + independently checkable? ──
    const v = (data.verify && typeof data.verify === 'object') ? data.verify : {};
    const events = typeof v.events === 'number' ? v.events : null;
    const intact = v.chainIntact === true;
    const contract = typeof v.contractVersion === 'string' ? v.contractVersion : null;
    mount.appendChild(el('div', { style: 'margin-top:18px;' }, [eyebrow('The record')]));
    if (events === null) {
      // No verification payload (empty/permissive envelope) — stay neutral, never
      // assert a false "chain BROKEN".
      mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-fg-3);' }, 'Record not loaded — run `maddu spine verify`.'));
    } else {
      mount.appendChild(el('div', { style: `border:1px solid var(--m-line);border-left:3px solid ${intact ? 'var(--m-ok)' : 'var(--m-danger)'};border-radius:var(--m-radius-sm,6px);padding:10px 14px;` }, [
        el('div', { style: 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;' }, [
          el('span', { style: `font-size:14px;color:${intact ? 'var(--m-ok)' : 'var(--m-danger)'};` }, intact ? '✓' : '⚠'),
          el('span', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-1);' },
            `${events} events · ${intact ? 'chain intact' : 'chain BROKEN'}${contract ? ` · contract ${contract}` : ''}`),
        ]),
        el('div', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);margin-top:6px;' },
          'independently checkable — full uncapped check: maddu spine verify'),
      ]));
    }
  })();

  return root;
}
