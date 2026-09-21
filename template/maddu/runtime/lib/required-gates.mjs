// required-gates.mjs — fail-closed RESOLUTION of a pinned required-gate set
// (v1.146.0, P0 audit A3-002 / A3-004; extracted from commands/ci.mjs audit P4).
//
// A consumer pins the gate ids it requires (maddu.json ci.requiredGates, or the
// source checkout's .maddu/config/ci.json). A required id that no longer
// resolves to exactly one runnable gate — its file deleted or renamed, an
// operator override that failed at import and left nothing runnable under
// that id, or a duplicate resolution — is itself a RED: otherwise a required
// guarantee can silently vanish and every verdict built on "no failing
// required gate" stays green. A required id that resolves to a warn-severity
// gate can never fail and is RED for the same reason.
//
// `maddu ci` has applied this since audit P4. `maddu goal done` and
// `maddu plan complete` (commands/_gates-before-done.mjs) claimed to mirror
// `ci` exactly and did not — a missing required gate produced no run, so it
// produced no failure, so completion proceeded. Both now call this one
// function over the same post-override `runs` (runGates already dedupes by
// id, operator wins), never raw definitions.
//
// Pure: no I/O, no clock. Stdlib-free so any caller can import it.

// runs: the array runGates() returns ({ gateId, severity, status, ... } each).
// requiredGates: the pinned id list (array) or null/undefined when unpinned.
// Returns [{ gateId, reason, message }] — empty when every required id
// resolves to exactly one fail-capable gate, or when nothing is pinned.
export function requiredGateIntegrity(runs, requiredGates) {
  if (!Array.isArray(requiredGates) || requiredGates.length === 0) return [];
  const list = Array.isArray(runs) ? runs : [];
  const countById = new Map();
  for (const r of list) if (r && r.gateId) countById.set(r.gateId, (countById.get(r.gateId) || 0) + 1);
  const out = [];
  for (const id of requiredGates) {
    const count = countById.get(id) || 0;
    const run = list.find((r) => r && r.gateId === id);
    if (count === 0) out.push({ gateId: id, reason: 'unresolved', message: `${id} (required but no runnable gate resolves)` });
    else if (count > 1) out.push({ gateId: id, reason: 'ambiguous', message: `${id} (required id resolves to ${count} gates)` });
    else if (run && run.severity === 'warn') out.push({ gateId: id, reason: 'warn-severity', message: `${id} (required but warn-severity — can never fail)` });
  }
  return out;
}
