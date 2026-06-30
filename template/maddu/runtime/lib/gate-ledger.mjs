// gate-ledger.mjs (roadmap #9) — the legible last-gate-verdict surface.
//
// F-class #9: friction in the core loop quietly pushes operators to skip slices
// and gates. A big offender is that `maddu orient` showed goal progress and a
// timeline but NOT whether the last gate run was green — and when a gate failed,
// the operator got a raw stack trace, not "which gate, where's the record, how
// do I reproduce it". This turns the spine's GATE_RAN events into a one-glance
// verdict + a legible failure line: gate id, severity, the event id (find it in
// the spine), and the exact repro command. Never a stack trace.
//
// Pure over the event list orient already holds. `latestGateRuns` keeps the most
// recent run per gate (spine order = chronological); `summarizeGates` rolls them
// up; `formatFailure` renders one failing gate legibly; `reproForGate` is the
// single source of the re-run command.

// The exact verdict for one GATE_RAN event. Prefers the persisted `status`
// (v1.79.0+); older events fall back to the ok/severity mapping the runner uses.
export function runStatus(data) {
  if (!data) return 'ok';
  if (data.status === 'ok' || data.status === 'warn' || data.status === 'fail') return data.status;
  if (data.ok) return 'ok';
  return (data.severity === 'warn') ? 'warn' : 'fail';
}

// Latest run per gate id, chronological (spine) order assumed. Returns records
// { gateId, status, severity, ts, eventId, durationMs } sorted by gateId.
export function latestGateRuns(events) {
  const list = Array.isArray(events) ? events : [];
  const byGate = new Map(); // gateId -> record (last wins)
  for (const ev of list) {
    if (!ev || ev.type !== 'GATE_RAN') continue;
    const d = ev.data || {};
    const gateId = d.gateId || '(unknown)';
    byGate.set(gateId, {
      gateId,
      status: runStatus(d),
      severity: d.severity || 'warn',
      ts: ev.ts || null,
      eventId: ev.id || null,
      durationMs: d.durationMs ?? null,
    });
  }
  return [...byGate.values()].sort((a, b) => a.gateId.localeCompare(b.gateId));
}

// Roll the latest-per-gate verdicts into a one-glance summary.
//   { ran, total, ok, warn, fail, failing:[...], warning:[...], green, lastTs }
// green = ran > 0 and no hard fails. `failing` are hard fails (would block a
// land); `warning` are soft warns (advisory). lastTs is the newest run time.
export function summarizeGates(events) {
  const runs = latestGateRuns(events);
  const failing = runs.filter((r) => r.status === 'fail');
  const warning = runs.filter((r) => r.status === 'warn');
  const ok = runs.filter((r) => r.status === 'ok').length;
  let lastTs = null;
  for (const ev of (Array.isArray(events) ? events : [])) {
    if (ev && ev.type === 'GATE_RAN' && ev.ts) lastTs = ev.ts;
  }
  return {
    ran: runs.length > 0,
    total: runs.length,
    ok,
    warn: warning.length,
    fail: failing.length,
    failing,
    warning,
    green: runs.length > 0 && failing.length === 0,
    lastTs,
  };
}

// The single source of the re-run command for a gate. `maddu doctor --gate <id>`
// runs exactly one gate by id (commands/doctor.mjs --gate), so it's the precise,
// always-available repro — no stack trace, no full-suite noise.
export function reproForGate(gateId) {
  return `maddu doctor --gate ${gateId}`;
}

// One legible failure line: gate id, severity, the spine event id to inspect,
// and the repro. Caller adds color/marks. Deliberately carries NO message/stack
// — the record is the event id; the detail is one repro away.
export function formatFailure(rec) {
  if (!rec) return '';
  const sev = rec.severity && rec.severity !== 'warn' ? ` (${rec.severity})` : '';
  const evt = rec.eventId ? `  [${rec.eventId}]` : '';
  return `${rec.gateId}${sev}${evt}  ↻ ${reproForGate(rec.gateId)}`;
}
