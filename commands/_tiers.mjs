// Command tier manifest — Governance Phase 4.
//
// Keep in sync with bin/maddu.mjs COMMANDS. The command-tier-discipline gate
// fails when any top-level command is missing here.
//
//   tier:        'mutating' | 'read-only'
//   autoTrigger: 'allowed'  | 'forbidden'
//
// Schedule integration (`template/maddu/runtime/lib/schedule.mjs`) consults
// this manifest before firing: mutating + non-allowlisted → refused.

export default {
  approval:     { tier: 'mutating',  autoTrigger: 'forbidden' },
  auth:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  brief:        { tier: 'read-only', autoTrigger: 'allowed'   },
  checkpoint:   { tier: 'mutating',  autoTrigger: 'forbidden' },
  doctor:       { tier: 'read-only', autoTrigger: 'allowed'   },
  events:       { tier: 'read-only', autoTrigger: 'allowed'   },
  global:       { tier: 'mutating',  autoTrigger: 'forbidden' },
  goal:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  import:       { tier: 'mutating',  autoTrigger: 'forbidden' },
  init:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  lane:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  mailbox:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  mcp:          { tier: 'mutating',  autoTrigger: 'forbidden' },
  memory:       { tier: 'read-only', autoTrigger: 'allowed'   },
  phase:        { tier: 'mutating',  autoTrigger: 'forbidden' },
  register:     { tier: 'mutating',  autoTrigger: 'allowed'   },
  review:       { tier: 'mutating',  autoTrigger: 'forbidden' },
  runtime:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  schedule:     { tier: 'mutating',  autoTrigger: 'forbidden' },
  search:       { tier: 'read-only', autoTrigger: 'allowed'   },
  session:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  skill:        { tier: 'mutating',  autoTrigger: 'forbidden' },
  slice:        { tier: 'mutating',  autoTrigger: 'forbidden' },
  'slice-stop': { tier: 'mutating',  autoTrigger: 'forbidden' },
  sources:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  spine:        { tier: 'read-only', autoTrigger: 'allowed'   },
  start:        { tier: 'read-only', autoTrigger: 'allowed'   },
  status:       { tier: 'read-only', autoTrigger: 'allowed'   },
  task:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  upgrade:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  worker:       { tier: 'mutating',  autoTrigger: 'forbidden' },
  workspace:    { tier: 'mutating',  autoTrigger: 'forbidden' },
  // v0.18 — discovery surface (read-only).
  help:         { tier: 'read-only', autoTrigger: 'allowed'   },
  suggest:      { tier: 'read-only', autoTrigger: 'allowed'   },
  // v0.18 Phase 4 — architectural backbone.
  team:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  pipeline:     { tier: 'mutating',  autoTrigger: 'forbidden' },
  advise:       { tier: 'mutating',  autoTrigger: 'forbidden' },
  cost:         { tier: 'read-only', autoTrigger: 'allowed'   },
  // v0.19.1 — retroactive transcript import populates the ledger.
  usage:        { tier: 'mutating',  autoTrigger: 'forbidden' },
  // v1.1.0 Phase 1 — default tools. All mutating; auto-trigger forbidden
  // (the slash command path is the explicit-invocation surface).
  git:          { tier: 'mutating',  autoTrigger: 'forbidden' },
  test:         { tier: 'read-only', autoTrigger: 'allowed'   },
  format:       { tier: 'mutating',  autoTrigger: 'forbidden' },
  lint:         { tier: 'read-only', autoTrigger: 'allowed'   },
  install:      { tier: 'mutating',  autoTrigger: 'forbidden' },
};
