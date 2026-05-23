// Generic default lane catalog shipped to every `maddu init` install.
//
// Lanes are the unit of mutually-exclusive work — pick or add ones that fit
// YOUR project, not Máddu's internal development. Operators are expected to
// edit `.maddu/lanes/catalog.json` to match the actual surfaces they edit
// (frontend / backend / infra / etc.). This seed is intentionally minimal
// and generic — opinions about what your project's lanes should be don't
// belong in the framework default.
//
// v1.0.4 — replaced the prior Máddu-internal catalog (lanes like
// `cockpit-shell`, `bridge-server`, `runtime-integration`, plus "Phase X"
// markers from the depth-upgrade slice plan) which was leaking framework
// development structure into every consumer install. Máddu's own
// contributors maintain their internal catalog locally in `.maddu/lanes/`
// (gitignored) — same as any other operator.

export const DEFAULT_LANE_CATALOG = {
  schemaVersion: 1,
  framework: 'maddu',
  lanes: [
    { id: 'architecture', scope: 'Design, planning, architectural briefs. Reads everything; writes plans and roadmaps.' },
    { id: 'frontend',     scope: 'User-facing UI — components, styles, client-side logic.' },
    { id: 'backend',      scope: 'Server-side code, APIs, data layer.' },
    { id: 'infra',        scope: 'Build, deploy, CI, ops, configuration.' },
    { id: 'tests',        scope: 'Test code, fixtures, harnesses.' },
    { id: 'docs',         scope: 'Project documentation, READMEs, contributor guides.' },
    { id: 'general',      scope: 'Catch-all for changes that do not fit another lane. Use sparingly — split into a real lane when patterns emerge.' }
  ]
};
