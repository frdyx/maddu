// Máddu cockpit — event-row + approval-decision helpers (leaves).
//
// Extracted from cockpit.js (v1.41.0). These render the append-only spine's
// events into rows (Events + Workbench streams) and build the approval
// decision buttons (Approvals + Workbench + BOSS proposal cards). They depend
// on NOTHING in the cockpit module scope — only their arguments, the `el` leaf
// builder, the global fetch, and injected callbacks — so they import cleanly
// as a browser ES module. The route render functions that subscribe to the
// live `stream` bus stay in cockpit.js and import these back.

import { el } from './cockpit-util.js';

// Reason-code → tone/label display palettes. Shared by the shell's Inspector
// (cockpit.js) and the Conductor + BOSS views (cockpit-views-live.js) — the
// derived "why this is the safe next action / lane state" codes the bridge
// emits. Pure data; live here as the common leaf both sides import.
export const REASON_CODE_TONE = {
  approvals_pending: 'warn',
  workers_stuck:     'danger',
  task_ready:        'accent',
  task_blocked:      'warn',
  slice_stale:       'warn',
  slice_never:       'blue',
  all_clear:         'ok',
  lane_active:       'accent',
  lane_unclaimed:    'warn',
  lane_idle:         'ok',
  lane_empty:        'neutral'
};
export const REASON_CODE_LABEL = {
  approvals_pending: 'approvals pending',
  workers_stuck:     'workers stuck',
  task_ready:        'task ready',
  task_blocked:      'task blocked',
  slice_stale:       'slice stale',
  slice_never:       'first slice',
  all_clear:         'all clear',
  lane_active:       'active',
  lane_unclaimed:    'unclaimed',
  lane_idle:         'idle',
  lane_empty:        'empty'
};

// classifyEvent(type) — map a spine event type to its colour-family CSS class.
export function classifyEvent(type) {
  // SINGLE-EVENT specials first
  if (type === 'SLICE_STOP')              return 't-slice';
  if (type === 'DOCTOR_REPORT')           return 't-doctor';
  if (type === 'INBOX_MESSAGE')           return 't-inbox';

  // Lifecycle & versioning ops — lavender (framework family)
  if (type.startsWith('FRAMEWORK_'))      return 't-framework';
  if (type.startsWith('CHECKPOINT_'))     return 't-framework';
  if (type === 'COMPACTION_CHECKPOINT')   return 't-framework';
  if (type.startsWith('PHASE_'))          return 't-framework';

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
  if (type === 'VENDOR_MEMORY_IMPORTED')  return 't-slice';

  return '';
}

// summarize(ev) — a one-line human summary for an event row (private; only
// eventRow consumes it).
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
    case 'COMPACTION_CHECKPOINT': return `context compacted (${d.trigger || '?'})${d.lastSliceStop?.summary ? ` · anchor: ${d.lastSliceStop.summary}` : ''}`;
    case 'VENDOR_MEMORY_IMPORTED': return `${d.file || d.factId || ''}`;
    case 'PHASE_DECLARED':      return `${d.name || ''}${d.tier ? `  · tier: ${d.tier}` : ''}`;
    case 'PHASE_CLEARED':       return d.name ? `${d.name} exited` : '';
    default: return '';
  }
}

// eventRow(ev, fresh) — one row of the spine stream.
export function eventRow(ev, fresh = false) {
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

// prepend(parent, child) — insert a node at the head of its parent.
export function prepend(parent, child) {
  if (parent.firstChild) parent.insertBefore(child, parent.firstChild);
  else parent.appendChild(child);
}

// postApprovalDecision — POST an approval decision, pinning the write to the
// row's origin workspace when supplied (private; only makeDecisionButton uses it).
async function postApprovalDecision(approvalId, decision, reason, workspaceId) {
  const headers = { 'content-type': 'application/json' };
  // In "all workspaces" mode the row carries its origin workspace id; pin
  // the write to that spine so the decision lands in the right repo and
  // not in the currently-active one.
  if (workspaceId) headers['X-Maddu-Workspace'] = workspaceId;
  const r = await fetch('/bridge/approvals/respond', {
    method: 'POST',
    headers,
    body: JSON.stringify({ approvalId, decision, reason })
  });
  return r.json();
}

// makeDecisionButton — an approval decision button wired to postApprovalDecision;
// `onDone` is the caller-supplied refresh callback run after a successful write.
export function makeDecisionButton(decision, label, klass, approvalId, onDone, workspaceId) {
  const btn = el('button', { class: klass }, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await postApprovalDecision(approvalId, decision, null, workspaceId);
      onDone();
    } catch (err) {
      btn.textContent = 'error';
      console.error(err);
    }
  });
  return btn;
}
