// Framework-default lane catalog. Mirrors docs/lanes.md.

export const DEFAULT_LANE_CATALOG = {
  schemaVersion: 1,
  framework: 'maddu',
  lanes: [
    { id: 'architecture',         scope: 'High-level design, planning, architecture briefs.' },
    { id: 'cockpit-shell',        scope: 'Cockpit HTML, tokens, routes. Visual surface only.' },
    { id: 'bridge-server',        scope: 'runtime/server.js and harness wiring around it.' },
    { id: 'auth-providers',       scope: 'OAuth flows, token paths, provider authentication.' },
    { id: 'harness',              scope: 'Node-only scripts under .maddu/harness/.' },
    { id: 'wiki',                 scope: 'Framework-default wiki pages.' },
    { id: 'briefs',               scope: 'Framework-default briefs.' },
    { id: 'verification',         scope: 'Verification reports, focused gates, doctor checks.' },
    { id: 'guardrails',           scope: 'Approval ledger and policies. (Phase A1)' },
    { id: 'observability',        scope: 'Live event panel and search index. (Phase A2 + B6)' },
    { id: 'learning-patterns',    scope: 'Hindsight extraction, skill gallery, pattern library. (Phase A3 + B4)' },
    { id: 'coordination',         scope: 'Mailbox bus, dependency-aware task board. (Phase B2 + B3)' },
    { id: 'search-retrieval',     scope: 'File-backed spine search index. (Phase B6)' },
    { id: 'runtime-integration',  scope: 'Pluggable runtime-adapter contract. (Phase C1)' },
    { id: 'tools',                scope: 'MCP visual registry. (Phase C2)' },
    { id: 'ops-automation',       scope: 'NL→cron scheduler. (Phase C3)' },
    { id: 'git-integration',      scope: 'Checkpoint timeline via git worktrees. (Phase C4)' },
    { id: 'shell',                scope: '/workbench multi-pane shell. (Phase D1)' },
    { id: 'portability',          scope: 'Export/import surface. (Phase D2)' }
  ]
};
