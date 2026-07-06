// Máddu cockpit — Model route view (SLM-governance phase 5, plan
// pln_20260706133422_0f60).
//
// The SLM-factory registry, read-only: dataset/run/checkpoint/eval counts,
// per-checkpoint derived stage (the ladder the approvals ride walks),
// unacknowledged critical regressions, pending promotion proposals, recent
// releases/rollbacks. Data: GET /bridge/model (pure deriveModels over the
// spine — zero writes). The cockpit never advances a stage: promotion,
// release, and rollback stay operator CLI verbs, and this view says so.
//
// SHAPE-VALIDATION LAW (the nullProxy lesson): every optional field is
// type-checked before use — truthiness alone never picks a render branch.
//
// NOTE: el(tag, attrs, children) takes children as an ARRAY (or one node).

import { el, panel, placeholder, loading } from './cockpit-util.js';
import { ROUTE_META } from './cockpit-route-meta.js';

const STAGE_COLOR = {
  experiment: 'var(--m-fg-3)', candidate: 'var(--m-accent)',
  canary: 'var(--m-warn)', released: 'var(--m-ok)',
};
function stageColor(s) { return STAGE_COLOR[s] || 'var(--m-fg-3)'; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function str(v) { return typeof v === 'string' && v ? v : null; }
function shortKey(k) { const s = str(k); return s ? `${s.slice(0, 18)}…` : '—'; }

// Strict shape gate for the /bridge/model payload — exported for the
// fixture: the harness's truthy-everywhere proxy MUST fail this.
export function hasModelShape(data) {
  return !!(data
    && data.stats && typeof data.stats.checkpoints === 'number'
    && Array.isArray(data.checkpoints)
    && Array.isArray(data.evals));
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

// Inspector entity for a checkpoint row — the generic {kind,label,id,raw,
// evidence[],related[]} shape the shell Inspector renders. Exported for the
// fixture.
export function checkpointEntity(c, extra = {}) {
  const evidence = [
    { label: 'derived stage', value: str(c.stage) || 'experiment' },
    { label: 'model', value: str(c.model_id) || '—' },
    { label: 'artifact uri', value: str(c.uri) || '(declared in manifest)' },
  ];
  if (str(c.run_id)) evidence.push({ label: 'training run', value: c.run_id });
  else evidence.push({ label: 'training run', value: 'none — imported/foreign checkpoint' });
  const evals = Array.isArray(extra.evals) ? extra.evals : [];
  for (const e of evals.slice(0, 6)) {
    evidence.push({ label: `eval ${str(e.eval_id) || '—'}`, value: `${str(e.benchmark) || '—'} pass_rate=${num(e.pass_rate) ?? '—'}${e.criticalRegressions > 0 ? ` · ${e.criticalRegressions} critical${e.acknowledged ? ' (acked)' : ' UNACKED'}` : ''}` });
  }
  return {
    kind: 'model-checkpoint',
    label: `${str(c.model_id) || 'model'} @ ${str(c.stage) || 'experiment'}`,
    id: str(c.checkpointKey) || '—',
    raw: c,
    evidence,
    related: evals.map((e) => ({ kind: 'eval', id: str(e.eval_id) || '—' })),
  };
}

// Inspector entity for an eval row. Exported for the fixture.
export function evalEntity(e) {
  const evidence = [
    { label: 'benchmark', value: str(e.benchmark) || '—' },
    { label: 'harness', value: str(e.harness_version) || 'UNPINNED (not reproducible as recorded)' },
    { label: 'pass rate', value: String(num(e.pass_rate) ?? '—') },
    { label: 'critical regressions', value: `${num(e.criticalRegressions) ?? 0}${e.criticalRegressions > 0 ? (e.acknowledged === true ? ' — acknowledged' : ' — UNACKNOWLEDGED (`maddu model regression ack`)') : ''}` },
  ];
  return {
    kind: 'model-eval',
    label: `eval ${str(e.eval_id) || '—'}`,
    id: str(e.eval_id) || '—',
    raw: e,
    evidence,
    related: str(e.checkpointKey) ? [{ kind: 'model-checkpoint', id: e.checkpointKey }] : [],
  };
}

export function renderModel(ctx) {
  const root = el('div', { class: 'view' }, [
    el('h2', {}, 'Model'),
    el('p', {}, ROUTE_META.model.description),
  ]);

  const mount = el('div', {}, loading('Deriving the factory registry from the spine…'));
  const body = ctx && ctx.panelFocus
    ? ctx.panelFocus('SLM-factory registry', 'GET /bridge/model · read-time projection, zero writes · promotion stays a CLI verb', mount,
        { id: 'model', keywords: 'model slm dataset training checkpoint eval regression promotion release rollback governance' })
    : panel('SLM-factory registry', 'GET /bridge/model · read-time projection, zero writes · promotion stays a CLI verb', mount);
  root.appendChild(body);

  (async () => {
    let data = null;
    try { const r = await fetch('/bridge/model', { cache: 'no-store' }); if (r.ok) data = await r.json(); } catch {}
    mount.textContent = '';

    if (!hasModelShape(data)) {
      mount.appendChild(placeholder('No model events on this spine',
        'This repo is not governing an SLM factory (a first-class state, not an error). Start with `maddu model dataset snapshot <manifest.json>`; the gate pack installs with `maddu model gates install`.'));
      return;
    }
    const s = data.stats;

    // ── Totals strip ──
    mount.appendChild(el('div', { style: 'display:flex;gap:26px;flex-wrap:wrap;margin-bottom:4px;' }, [
      stat('datasets', num(s.datasets) ?? 0),
      stat('runs', num(s.runs) ?? 0),
      stat('checkpoints', num(s.checkpoints) ?? 0),
      stat('evals', num(s.evals) ?? 0),
      stat('releases', num(s.releases) ?? 0),
    ]));
    if (num(s.unacknowledgedCriticalEvals)) {
      mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-danger);margin-top:6px;' },
        `${s.unacknowledgedCriticalEvals} eval(s) carry UNACKNOWLEDGED critical regressions — \`maddu model regression ack <eval-id> --reason\`.`));
    }

    // ── Checkpoints on the ladder ──
    const cps = data.checkpoints.filter((c) => c && typeof c === 'object');
    if (cps.length) {
      mount.appendChild(eyebrow(`Checkpoints (${cps.length})`));
      for (const c of cps.slice(0, 12)) {
        const evals = data.evals.filter((e) => e && e.checkpointKey === c.checkpointKey);
        const row = el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--m-line);border-radius:var(--m-radius-sm,6px);margin-bottom:6px;background:var(--m-bg-2);cursor:pointer;' }, [
          chip(str(c.stage) || 'experiment', stageColor(c.stage)),
          el('span', { style: 'font-family:var(--m-font-mono);font-size:12px;color:var(--m-fg-0);' }, shortKey(c.checkpointKey)),
          el('span', { style: 'font-size:12px;color:var(--m-fg-2);' }, str(c.model_id) || '—'),
          chip(`${evals.length} eval(s)`),
          str(c.run_id) ? chip(`run ${c.run_id}`) : chip('foreign', 'var(--m-warn)'),
        ]);
        if (ctx && typeof ctx.openInspector === 'function') {
          row.addEventListener('click', () => ctx.openInspector(checkpointEntity(c, { evals })));
        }
        mount.appendChild(row);
      }
    }

    // ── Pending proposals (the approvals ride, mid-flight) ──
    const pend = (Array.isArray(data.proposals) ? data.proposals : []).filter((p) => p && p.approved === false);
    if (pend.length) {
      mount.appendChild(eyebrow(`Pending promotion proposals (${pend.length})`));
      for (const p of pend.slice(0, 6)) {
        mount.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 10px;border:1px dashed var(--m-line);border-radius:var(--m-radius-sm,6px);margin-bottom:6px;' }, [
          chip(`${str(p.from_stage) || '—'} → ${str(p.to_stage) || '—'}`, stageColor(p.to_stage)),
          el('span', { style: 'font-family:var(--m-font-mono);font-size:11px;color:var(--m-fg-2);' }, shortKey(p.checkpointKey)),
          el('span', { style: 'font-size:11px;color:var(--m-fg-3);' }, 'decide + confirm via CLI — the cockpit never advances a stage'),
        ]));
      }
    }

    // ── Recent releases / rollbacks ──
    const rel = Array.isArray(data.releases) ? data.releases : [];
    const rb = Array.isArray(data.rollbacks) ? data.rollbacks : [];
    if (rel.length || rb.length) {
      mount.appendChild(eyebrow('Recent releases & rollbacks'));
      for (const r of rel.slice(-5)) {
        mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-fg-2);margin-bottom:3px;' },
          `▲ released ${shortKey(r.checkpointKey)} — rollback plan: ${str(r.rollback_plan) || '(none recorded)'}`));
      }
      for (const r of rb.slice(-5)) {
        mount.appendChild(el('div', { style: 'font-size:12px;color:var(--m-warn);margin-bottom:3px;' },
          `▼ rolled back ${shortKey(r.checkpointKey)} → ${str(r.reverted_to) || 'candidate'}`));
      }
    }
  })();

  return root;
}
