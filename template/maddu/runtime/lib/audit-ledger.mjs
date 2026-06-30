// audit-ledger.mjs (roadmap #2) — the self-verifying audit circuit.
//
// The 2026-06-30 cross-project audit was manual; nothing made it recurring or
// self-proving, which is the audit→fix→forget→re-discover cycle the system goal
// forbids. This validates the machine-readable ledger (docs/audit/LEDGER.json)
// so a finding can't drift out of discipline:
//
//   * every finding has an id + a status in the known vocabulary;
//   * a finding marked `fixed` must name the GUARDRAIL that enforces the fix
//     (its `gates: []`), encoding the audit's own principle — fix a class with
//     structure, not a one-off;
//   * every named gate must be a REGISTERED gate id, so a guardrail can't be
//     renamed or deleted while the ledger still claims the class is handled
//     (the backref goes dangling → FAIL).
//
// Pure: `validateLedger(findings, registeredGateIds)` takes plain data so the
// gate and the fixture share one implementation.

export const LEDGER_STATUSES = new Set(['open', 'in-progress', 'fixed', 'accepted', 'wontfix', 'noted']);

export function validateLedger(findings, registeredGateIds = []) {
  const gateSet = new Set(registeredGateIds);
  const list = Array.isArray(findings) ? findings : [];
  const noId = [];
  const badStatus = [];
  const fixedWithoutGate = [];
  const danglingGate = []; // { id, gate }

  const seen = new Set();
  const dupId = [];
  for (const f of list) {
    const id = f && typeof f.id === 'string' ? f.id : null;
    if (!id) { noId.push(JSON.stringify(f)); continue; }
    if (seen.has(id)) dupId.push(id); else seen.add(id);
    if (!LEDGER_STATUSES.has(f.status)) badStatus.push(id);
    const gates = Array.isArray(f.gates) ? f.gates : [];
    if (f.status === 'fixed' && gates.length === 0) fixedWithoutGate.push(id);
    for (const g of gates) {
      if (!gateSet.has(g)) danglingGate.push({ id, gate: g });
    }
  }
  const ok = !noId.length && !badStatus.length && !fixedWithoutGate.length && !danglingGate.length && !dupId.length;
  return { ok, count: list.length, noId, dupId, badStatus, fixedWithoutGate, danglingGate };
}

// One-line human summary of a validation result (for gate messages).
export function summarizeLedger(res) {
  if (res.ok) return `${res.count} finding(s) coherent`;
  const parts = [];
  if (res.noId.length) parts.push(`${res.noId.length} finding(s) with no id`);
  if (res.dupId.length) parts.push(`duplicate id(s): ${res.dupId.join(', ')}`);
  if (res.badStatus.length) parts.push(`invalid status: ${res.badStatus.join(', ')}`);
  if (res.fixedWithoutGate.length) parts.push(`fixed without a guardrail backref: ${res.fixedWithoutGate.join(', ')}`);
  if (res.danglingGate.length) parts.push(`dangling gate ref(s): ${res.danglingGate.map((d) => `${d.id}→${d.gate}`).join(', ')}`);
  return parts.join('; ');
}
