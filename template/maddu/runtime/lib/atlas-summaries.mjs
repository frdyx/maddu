// atlas-summaries — list-row summary projections (contract §4.3/§6: "list
// endpoints return SUMMARIES; only detail endpoints return full records" —
// diff review finding #8). Pure functions, no I/O, no repo imports — a plain
// lift out of atlas-view.mjs to keep that file under its 1500-line cap
// (Codex diff round 2, authorised by the team lead), no behaviour change.
//
// Measured live against the real corpus: `/flows?limit=50` shipped every row
// as a full FlowRecord (whole `primary.steps[]` plus the entire `variants[]`)
// and came back 371 KB, 49% over the 250 KB budget, purely from list rows
// nobody was going to render inline. Detail endpoints (getFlow, getEntity,
// etc., in atlas-view.mjs) are UNCHANGED — they still return the object
// straight from the `*ById` Map with everything on it; only the list
// functions in atlas-view.mjs map the PAGE (after filter/sort/paginate, so
// we never summarize records the response won't include) through one of
// these before returning.

export function entityToSummary(e) {
  const { locators, evidence, ...rest } = e;
  return { ...rest, locatorCount: locators.length, evidenceCount: evidence.length, derived: [...e.derived, 'locatorCount', 'evidenceCount'] };
}

// FlowSummary — the exact shape contract §4.3 pins, no `primary`, no
// `variants[]`, no `steps[]`, no `evidence[]`. `hasSimulationEntry` and
// `diagramPath` are computed once per flow during atlas-view's
// buildViewData and live directly on the FlowRecord (so getFlow's full
// detail carries them too, not just the summary).
export function flowToSummary(f) {
  return {
    id: f.id,
    name: f.primary.name,
    purpose: f.primary.purpose,
    domain: f.domain,
    domainBasis: f.domainBasis,
    actors: f.primary.actors,
    trigger: f.primary.trigger,
    stepCountCanonical: f.stepCountCanonical,
    stepCountAllVariants: f.stepCountAllVariants,
    variantCount: f.variants.length,
    schemaVariant: f.primary.schemaVariant,
    determinismClasses: f.determinismClasses,
    sideEffectClasses: f.sideEffectClasses,
    hasSimulationEntry: f.hasSimulationEntry,
    diagramPath: f.diagramPath,
    resolutionIssueCount: f.resolutionIssues.length,
    partial: f.partial,
    derived: [...f.derived, 'variantCount', 'hasSimulationEntry', 'diagramPath', 'resolutionIssueCount'],
  };
}

// StateMachineSummary — drops states[]/transitions[] (the two large arrays
// that made /state-machines 101 KB at limit=50), keeps everything else.
export function machineToSummary(m) {
  const { states, transitions, ...rest } = m;
  return { ...rest, stateCount: states.length, transitionCount: transitions.length, derived: [...m.derived, 'stateCount', 'transitionCount'] };
}

// FindingSummary — drops subjectsResolved[]/evidence[], keeps subjects[]
// (cheap strings) plus counts of what was dropped.
export function findingToSummary(f) {
  const { subjectsResolved, evidence, ...rest } = f;
  return {
    ...rest,
    subjectsResolvedCount: subjectsResolved.filter((s) => s.entityId !== null).length,
    evidenceCount: evidence.length,
    derived: [...f.derived, 'subjectsResolvedCount', 'evidenceCount'],
  };
}

// SurfaceSummary — drops the (per-family, sometimes bulky) `observations{}`
// object, keeps `reachabilityBasis`/`observationBasis` (already top-level).
export function surfaceToSummary(s) {
  const { observations, ...rest } = s;
  return rest;
}

// SimulationSummary — drops the trace-only `observed{}`/`oracle`/
// `counterevidence[]` fields, keeps `hasResult` (the closest existing field
// to the contract's "result"), `disposition`, `linkBasis`. Catalog-kind
// records (`flow-catalog`/`state-machine-catalog`) carry none of these
// fields to begin with — the destructure is a no-op for them.
export function simulationToSummary(r) {
  const { observed, oracle, counterevidence, ...rest } = r;
  return rest;
}
