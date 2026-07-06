// Máddu cockpit — Experience route view (EXP phase 6).
//
// The experience ledger + evolve planner, read-only: trajectory manifest with
// trajectory-level signals surfaced (not just counts), signal rollups, recent
// signal-bearing steps (click → Inspector), and the recommend-only evolution
// plan — including the honest no-op, rendered as a first-class result, not an
// empty state. Data: GET /bridge/experience (pure read-time derivation over
// the spine; nothing here writes, adoption stays an operator CLI verb).
//
// SHAPE-VALIDATION LAW: every optional field is type-checked before use
// (Array.isArray / typeof === 'number') — the test harness's permissive
// proxy envelope is TRUTHY for any path, so truthiness alone must never
// pick a render branch.
//
// NOTE: el(tag, attrs, children) takes children as an ARRAY (or a single
// node / string) — multi-child nodes MUST pass an array, never variadic.

import { el, panel, placeholder, loading } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';

const KIND_COLOR = {
  gate: 'var(--m-warn)', review: 'var(--m-accent-2)', drift: 'var(--m-danger)',
  trigger: 'var(--m-accent)', 'learn-scan': 'var(--m-accent)', autonomy: 'var(--m-accent-2)',
};
function kindColor(k) { return KIND_COLOR[k] || 'var(--m-fg-3)'; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function str(v) { return typeof v === 'string' && v ? v : null; }

// The strict shape gate for the /bridge/experience payload. Exported for the
// fixture: a truthy-everywhere proxy MUST fail this (numbers and arrays are
// checked structurally, never by truthiness).
export function hasExperienceShape(data) {
  return !!(data
    && data.stats && typeof data.stats.eventCount === 'number'
    && Array.isArray(data.trajectories));
}

function eyebrow(text) {
  return el('div', { style: 'font-family:var(--m-font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--m-fg-3);margin:14px 0 6px;' }, text);
}
function chip(text, color) {
  return el('span', { style: `font-family:var(--m-font-mono);font-size:10px;padding:2px 8px;border:1px solid var(--m-line);border-radius:999px;color:${color || 'var(--m-fg-2)'};background:var(--m-bg-2);` }, text);
}
function stat(label, value) {
  return el('div', { style: 'display:flex;flex-direction:column;min-width:74px;' }, [
    el('div', { style: 'font-size:22px;font-weight:600;color:var(--m-fg-0);line-height:1.2;' }, String(value)),
    el('div', { style: 'font-family:var(--m-font-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--m-fg-3);' }, label),
  ]);
}

// Inspector entity for a trajectory manifest row — the generic {kind,label,
// id,raw,evidence[],related[]} shape the shell Inspector renders. Exported
// for the fixture.
export function trajectoryEntity(t) {
  const sigs = Array.isArray(t.trajectorySignals) ? t.trajectorySignals : [];
  return {
    kind: 'experience-trajectory',
    label: str(t.label) || str(t.trajectoryId) || 'trajectory',
    id: str(t.trajectoryId),
    raw: t,
    evidence: [
      { label: 'Role', value: str(t.role) || '—' },
      { label: 'Status', value: str(t.status) || '—' },
      { label: 'Steps', value: String(num(t.steps) ?? 0) },
      { label: 'Signals', value: String(num(t.signals) ?? 0) },
      { label: 'Lanes', value: Array.isArray(t.lanes) && t.lanes.length ? t.lanes.join(', ') : '—' },
      { label: 'Span', value: `${str(t.firstTs) || '—'} → ${str(t.lastTs) || '—'}` },
      ...sigs.map((s) => ({ label: `Trajectory signal · ${str(s.kind) || 'signal'}`, value: str(s.verdict) || str(s.attachedBy) || '—' })),
    ],
    related: sigs
      .filter((s) => str(s.sourceEventId))
      .map((s) => ({ kind: 'event', id: s.sourceEventId, label: `${str(s.kind) || 'signal'} source · ${s.sourceEventId}` })),
  };
}

// Inspector entity for a signal-bearing step. Exported for the fixture.
export function stepEntity(s) {
  const sigs = Array.isArray(s.signals) ? s.signals : [];
  return {
    kind: 'experience-step',
    label: `${str(s.kind) || 'step'} · ${sigs.length} signal(s)`,
    id: str(s.stepId),
    raw: s,
    evidence: [
      { label: 'Trajectory', value: str(s.trajectoryId) || '—' },
      { label: 'Role', value: str(s.role) || '—' },
      { label: 'Kind', value: str(s.kind) || '—' },
      { label: 'When', value: str(s.ts) || '—' },
      ...sigs.map((g) => ({ label: `Signal · ${str(g.kind) || '?'} (${str(g.attachedBy) || '?'})`, value: str(g.verdict) || '—' })),
    ],
    related: sigs
      .filter((g) => str(g.sourceEventId))
      .map((g) => ({ kind: 'event', id: g.sourceEventId, label: `${str(g.kind) || 'signal'} · ${g.sourceEventId}` })),
  };
}

function signalBadges(signals) {
  return el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;' },
    signals.map((s) => chip(`${str(s.kind) || '?'}${str(s.verdict) ? ' · ' + s.verdict : ''}`, kindColor(str(s.kind)))));
}

export function renderExperience(ctx) {
  const root = el('div', { class: 'view' }, [
    el('h2', {}, 'Experience'),
    el('p', {}, ROUTE_META.experience.description),
  ]);

  const mount = el('div', {}, loading('Deriving experience from the spine…'));
  const body = ctx && ctx.panelFocus
    ? ctx.panelFocus('Experience ledger', 'GET /bridge/experience · read-time projection, zero writes · step ids are event ids', mount,
        { id: 'experience', keywords: 'experience ledger trajectory steps signals evolve recommendation atdp export learn spine' })
    : panel('Experience ledger', 'GET /bridge/experience · read-time projection, zero writes · step ids are event ids', mount);
  root.appendChild(body);

  // ONE fetch feeds both panels — the endpoint derives the full experience +
  // evolve plan per call, so hitting it twice would double the read-time work.
  const dataP = (async () => {
    try { const r = await fetch('/bridge/experience', { cache: 'no-store' }); if (r.ok) return await r.json(); } catch {}
    return null;
  })();

  (async () => {
    const data = await dataP;
    mount.textContent = '';

    if (!hasExperienceShape(data)) {
      mount.appendChild(placeholder('No experience yet',
        'The ledger derives from the spine at read time — work a few slices and steps appear here. CLI: `maddu experience`.'));
      return;
    }
    const s = data.stats;

    // ── Totals strip ──
    mount.appendChild(el('div', { style: 'display:flex;gap:26px;flex-wrap:wrap;margin-bottom:4px;' }, [
      stat('events', num(s.eventCount) ?? 0),
      stat('steps', num(s.stepCount) ?? 0),
      stat('trajectories', num(s.trajectoryCount) ?? 0),
      stat('signals', num(s.signalCount) ?? 0),
      stat('env steps', num(s.envStepCount) ?? 0),
    ]));

    // ── Signal rollups ──
    const byKind = s.signalsByKind && typeof s.signalsByKind === 'object' ? Object.entries(s.signalsByKind).filter(([, n]) => typeof n === 'number') : [];
    const byAtt = s.signalsByAttachment && typeof s.signalsByAttachment === 'object' ? Object.entries(s.signalsByAttachment).filter(([, n]) => typeof n === 'number') : [];
    if (byKind.length) {
      mount.appendChild(eyebrow('Signals by kind / attachment'));
      mount.appendChild(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' }, [
        ...byKind.map(([k, n]) => chip(`${k} ${n}`, kindColor(k))),
        ...byAtt.map(([k, n]) => chip(`${k} ${n}`)),
      ]));
    }
    if (num(s.unattachedTrailingGates)) {
      mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-warn);margin-top:6px;' },
        `${s.unattachedTrailingGates} trailing gate(s) after the last slice-stop have no forward target yet — reported, never dropped.`));
    }

    // ── Trajectories (most recent first) — trajectory-level signals surfaced ──
    const trajAll = data.trajectories.filter((t) => t && typeof t === 'object');
    const traj = trajAll
      .slice()
      .sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')))
      .slice(0, 8);
    mount.appendChild(eyebrow(`Trajectories (${trajAll.length} total · latest ${traj.length})`));
    for (const t of traj) {
      const tSigs = Array.isArray(t.trajectorySignals) ? t.trajectorySignals : [];
      const row = el('div', { style: 'display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--m-line);border-radius:var(--m-radius-sm,6px);margin-bottom:6px;background:var(--m-bg-2);cursor:pointer;' }, [
        el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;' }, [
          el('span', { style: 'font-size:13px;color:var(--m-fg-0);' }, str(t.label) || str(t.trajectoryId) || '—'),
          chip(str(t.role) || 'session'),
          chip(str(t.status) || '—'),
          el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-3);margin-left:auto;' },
            `${num(t.steps) ?? 0} step(s) · ${num(t.signals) ?? 0} signal(s)`),
        ]),
        ...(tSigs.length ? [el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;' }, [
          el('span', { style: 'font-family:var(--m-font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--m-fg-3);' }, 'trajectory signals'),
          signalBadges(tSigs),
        ])] : []),
      ]);
      if (ctx && typeof ctx.openInspector === 'function') {
        row.addEventListener('click', () => ctx.openInspector(trajectoryEntity(t)));
      }
      mount.appendChild(row);
    }

    // ── Recent signal-bearing steps ──
    const recent = Array.isArray(data.recentSignalSteps) ? data.recentSignalSteps.filter((x) => x && typeof x === 'object') : [];
    if (recent.length) {
      mount.appendChild(eyebrow('Recent signal-bearing steps'));
      for (const st of recent.slice(-8).reverse()) {
        const row = el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 8px;border-bottom:1px solid var(--m-line);cursor:pointer;' }, [
          el('span', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);' }, str(st.stepId) || '—'),
          chip(str(st.kind) || '—'),
          signalBadges(Array.isArray(st.signals) ? st.signals : []),
        ]);
        if (ctx && typeof ctx.openInspector === 'function') {
          row.addEventListener('click', () => ctx.openInspector(stepEntity(st)));
        }
        mount.appendChild(row);
      }
    }

    // ── Export posture (informational — the gate lives in the CLI) ──
    mount.appendChild(el('div', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);margin-top:12px;' },
      'export: maddu experience export --format atdp --out <path> — refuse-on-hit secret gate (no skip flag) · trainingEligibility: false · deterministic bytes'));
  })();

  // ── Evolve planner — recommend-only, honest no-op is a result ──
  const evolveMount = el('div', {}, loading('Reading the evolution plan…'));
  const evolveBody = ctx && ctx.panelFocus
    ? ctx.panelFocus('Evolve planner', 'recommend-only · adoption is an operator verb: `maddu evolve adopt <recId>` · never auto-applied', evolveMount,
        { id: 'evolve', keywords: 'evolve plan recommendation adopt detector no-op evidence threshold' })
    : panel('Evolve planner', 'recommend-only · adoption is an operator verb: `maddu evolve adopt <recId>` · never auto-applied', evolveMount);
  root.appendChild(evolveBody);

  (async () => {
    const data = await dataP;
    evolveMount.textContent = '';
    const ev = data && data.evolve;
    const recs = ev && Array.isArray(ev.recommendations) ? ev.recommendations.filter((x) => x && typeof x === 'object') : [];
    if (!recs.length) {
      evolveMount.appendChild(placeholder('No plan yet',
        'The planner derives recommendations from the experience ledger at read time. CLI: `maddu evolve plan`.'));
      return;
    }
    const noOp = ev.noOp === true;
    for (const r of recs) {
      const conf = num(r.confidence);
      evolveMount.appendChild(el('div', { style: `border:1px solid ${noOp ? 'var(--m-line)' : 'var(--m-accent-border, var(--m-line))'};border-radius:var(--m-radius-sm,6px);padding:10px 12px;margin-bottom:8px;background:var(--m-bg-2);` }, [
        el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;' }, [
          chip(str(r.category) || '?', noOp ? 'var(--m-ok)' : 'var(--m-accent)'),
          chip(str(r.detector) || '?'),
          ...(conf != null ? [chip(`confidence ${conf}`)] : []),
          ...(num(r.evidenceCount) ? [chip(`${r.evidenceCount} evidence`)] : []),
          ...(str(r.recId) ? [el('span', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);margin-left:auto;' }, r.recId)] : []),
        ]),
        el('div', { style: 'font-size:13px;color:var(--m-fg-0);margin-bottom:4px;' }, str(r.summary) || '—'),
        ...(str(r.why) ? [el('div', { style: 'font-size:12px;color:var(--m-fg-2);' }, r.why)] : []),
        ...(!noOp && str(r.recId) ? [el('div', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);margin-top:6px;' }, `adopt: maddu evolve adopt ${r.recId}`)] : []),
      ]));
    }
    const sc = ev.scanned && typeof ev.scanned === 'object' ? ev.scanned : null;
    if (sc && typeof sc.events === 'number') {
      evolveMount.appendChild(el('div', { style: 'font-family:var(--m-font-mono);font-size:10px;color:var(--m-fg-3);margin-top:4px;' },
        `scanned ${sc.events} event(s) · ${typeof sc.steps === 'number' ? sc.steps : '—'} step(s) · ${typeof sc.priorCorrections === 'number' ? sc.priorCorrections : '—'} prior correction(s)`));
    }
  })();

  return root;
}
