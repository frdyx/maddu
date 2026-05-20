// Handoff markdown renderer (Governance Phase 1).
//
// Deterministic: same projection → same bytes. No `new Date()` calls;
// timestamps come from the spine.

const N_TRAIL = 3;

export function renderHandoff(projection) {
  const stops = Array.isArray(projection?.sliceStops) ? projection.sliceStops : [];
  const last = stops.at(-1) || null;

  const trail = stops.slice(-N_TRAIL).reverse();

  const headerTs = last?.ts || projection?.lastEventId || '—';
  const lines = [];
  lines.push(`# Handoff — ${headerTs}`);
  lines.push('');
  lines.push(`**Last slice:** ${last?.summary || '—'}`);
  lines.push('');
  lines.push(`**Next:** ${formatList(last?.next)}`);
  lines.push('');
  lines.push(`**Blockers:** ${last?.blockers ? formatList(last.blockers) : '—'}`);
  lines.push('');
  lines.push(`**Open items:** ${formatList(last?.openItems)}`);
  lines.push('');
  lines.push('**Reasoning trail (last 3 slice-stops):**');
  if (trail.length === 0) {
    lines.push('1. —');
  } else {
    trail.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.ts || '—'} — ${s.summary || '—'}`);
    });
  }
  lines.push('');
  return lines.join('\n');
}

function formatList(v) {
  if (!v) return '—';
  if (Array.isArray(v)) return v.length ? v.join('; ') : '—';
  return String(v);
}

export function buildOrientation(projection) {
  const stops = Array.isArray(projection?.sliceStops) ? projection.sliceStops : [];
  const lastSliceStop = stops.at(-1) || null;
  const activeSessions = Array.isArray(projection?.activeSessions) ? projection.activeSessions : [];
  const claims = Array.isArray(projection?.claims) ? projection.claims : [];
  const sessions = Array.isArray(projection?.sessions) ? projection.sessions : [];
  const approvalLedger = Array.isArray(projection?.approvals?.ledger) ? projection.approvals.ledger : [];

  return {
    schemaVersion: 1,
    // Deterministic anchor: most-recent spine event id. NEVER `new Date()`.
    lastEventId: projection?.lastEventId || null,
    goal: projection?.goal || null,
    phase: projection?.phase || null,
    activeSession: activeSessions[0] || null,
    activeClaims: claims,
    lastSliceStop,
    // Wired in later phases:
    lastCheckpoint: null,
    counters: {
      sessions: sessions.length,
      slices: stops.length,
      approvals: approvalLedger.length,
      failures: 0,           // Phase 2 wires GATE_RAN fails here
    },
    openFollowups: [],        // Phase 5 wires FOLLOWUP_OPENED here
  };
}
