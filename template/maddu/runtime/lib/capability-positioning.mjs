// capability-positioning.mjs (roadmap #12 / F4) — the honest opt-in frame.
//
// F4: across 13 installs the value consumers extract is the disciplined session
// substrate (session / lane / slice / gate), NOT multi-agent orchestration,
// which fires in only 2–5 of 13. That's a real signal — orchestration is an
// OPT-IN advanced layer — not a defect. But "orchestration events ≈ 0" reads as
// "dead domain" to a naive audit, so every re-audit risks re-raising it as a
// false alarm.
//
// This turns the `layer` tags in commands/_tiers.mjs (core vs orchestration)
// plus the spine into an honest verdict: core is the always-on substrate;
// orchestration is opt-in, reported as a fire-rate ("reached here: yes/no"),
// never as dead. Pure over plain data so the audit check and a fixture share it.

export const LAYERS = Object.freeze(['core', 'orchestration']);

// Orchestration verb → the event-type prefixes that mark it actually firing.
// Used to answer "did this install reach for orchestration at all?" from the
// spine without coupling to a specific event-name spelling.
export const ORCHESTRATION_SIGNATURES = Object.freeze({
  coordinator: ['COORDINATOR_'],
  loop: ['LOOP_'],
  pipeline: ['PIPELINE_'],
  team: ['TEAM_'],
});

// Split the _tiers manifest into { core:[verb…], orchestration:[verb…], unclassified:[verb…] }.
export function classifyLayers(tiers) {
  const out = { core: [], orchestration: [], unclassified: [] };
  for (const [verb, spec] of Object.entries(tiers || {})) {
    const layer = spec && spec.layer;
    if (layer === 'core' || layer === 'orchestration') out[layer].push(verb);
    else out.unclassified.push(verb);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

// Did any orchestration signature event fire in this spine? Returns
//   { reached:Set<verb>, firedAny:bool, total, rate }  (rate over known sigs)
export function orchestrationReach(events, signatures = ORCHESTRATION_SIGNATURES) {
  const types = new Set();
  for (const ev of (Array.isArray(events) ? events : [])) {
    if (ev && typeof ev.type === 'string') types.add(ev.type);
  }
  const reached = new Set();
  for (const [verb, prefixes] of Object.entries(signatures)) {
    if (prefixes.some((p) => [...types].some((t) => t.startsWith(p)))) reached.add(verb);
  }
  const total = Object.keys(signatures).length;
  return { reached, firedAny: reached.size > 0, total, rate: total ? reached.size / total : 0 };
}

// The honest positioning verdict. Always advisory — there is no failure mode
// here (an install that never orchestrates is healthy, not broken).
//   { ok:true, core, orchestration, reached:[…], firedAny, message }
export function positioningVerdict({ tiers, events } = {}) {
  const layers = classifyLayers(tiers);
  const reach = orchestrationReach(events);
  const reached = [...reach.reached].sort();
  const frame = reach.firedAny
    ? `reached here (${reached.join(', ')})`
    : 'opt-in, not reached in this install (expected — advanced layer)';
  return {
    ok: true,
    core: layers.core.length,
    orchestration: layers.orchestration.length,
    orchestrationVerbs: layers.orchestration,
    reached,
    firedAny: reach.firedAny,
    unclassified: layers.unclassified,
    message: `core substrate: ${layers.core.length} capability(ies) (always-on) · orchestration: ${layers.orchestration.length} (opt-in) — ${frame}`,
  };
}
