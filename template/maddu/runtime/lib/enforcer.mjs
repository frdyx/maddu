// Máddu Enforcer — deterministic policy check.
//
// The Enforcer is the silent half of the BOSS/Enforcer duality. It does
// not propose, it does not converse. It reads canonical state and the
// proposed action, then returns one of:
//   { allow: true,  reasonCode, hint }                   — action is safe
//   { allow: false, reasonCode, citedRule, hint }        — action refused
//
// All rules cite a hard-rule slug from docs/hard-rules.md or a behavioral
// rule from the framework briefs. The Enforcer never appeals to taste — if
// it refuses, it points to a rule the operator can read.
//
// Recognized actions (kind):
//   • claim-lane         lane, sessionId
//   • release-lane       lane, sessionId
//   • slice-stop         sessionId
//   • request-handoff    lane
//   • approve            approvalId, decision
//   • run-focused-gate   gate (free-form)
//   • write-file         path
//
// Anything else returns { allow: true, reasonCode: 'unknown_kind' } — the
// Enforcer doesn't gate things it wasn't taught about. Future kinds can
// be added without affecting existing callers.

const HARD_RULES = {
  files_only:            'docs/hard-rules.md#files-only-state',
  no_sqlite:             'docs/hard-rules.md#no-sqlite',
  no_hosted:             'docs/hard-rules.md#no-hosted-backends',
  no_broad_deps:         'docs/hard-rules.md#no-broad-deps',
  no_provider_sdk:       'docs/hard-rules.md#no-provider-sdk-in-app-code',
  no_token_export:       'docs/hard-rules.md#no-token-export',
  brand_boundary:        'docs/hard-rules.md#three-layer-brand-boundary',
  lane_ownership:        'docs/hard-rules.md#lane-ownership',
  slice_stop_required:   'docs/concepts.md#slice-stop-ritual'
};

/**
 * Check a proposed action against current state.
 * @param {object} action     { kind, ...kind-specific fields }
 * @param {object} state      shape of project()
 * @returns {object}          allow/refuse decision
 */
export function check(action, state) {
  if (!action || typeof action !== 'object') {
    return refuse('invalid_action', 'no_lane_ownership', 'Action must be an object with a `kind` field.');
  }
  const kind = action.kind;

  switch (kind) {
    case 'claim-lane': return checkClaimLane(action, state);
    case 'release-lane': return checkReleaseLane(action, state);
    case 'slice-stop': return checkSliceStop(action, state);
    case 'request-handoff': return checkRequestHandoff(action, state);
    case 'approve': return checkApprove(action, state);
    case 'run-focused-gate': return allow('focused_gate_ok', 'No claim conflict detected.');
    case 'write-file': return checkWriteFile(action, state);
    default:
      return allow('unknown_kind', `Enforcer has no rule for kind "${kind}". Proceed with operator judgment.`);
  }
}

function checkClaimLane(a, state) {
  if (!a.lane) return refuse('lane_required', 'lane_ownership', '`lane` field is required to claim.');
  if (!a.sessionId) return refuse('session_required', 'lane_ownership', '`sessionId` field is required to claim.');
  const existing = (state.claims || []).find((c) => c.lane === a.lane);
  if (existing && existing.sessionId !== a.sessionId) {
    return refuse(
      'claim_conflict',
      'lane_ownership',
      `Lane "${a.lane}" is already claimed by ${existing.sessionId}. Request a handoff before re-claiming.`
    );
  }
  return allow('claim_ok', existing ? 'Re-claim of same session — idempotent.' : 'Lane free, claim is safe.');
}

function checkReleaseLane(a, state) {
  if (!a.lane) return refuse('lane_required', 'lane_ownership', '`lane` field is required to release.');
  const existing = (state.claims || []).find((c) => c.lane === a.lane);
  if (!existing) return allow('release_idempotent', 'No active claim on lane — release is a no-op.');
  if (a.sessionId && existing.sessionId !== a.sessionId) {
    return refuse(
      'release_not_holder',
      'lane_ownership',
      `Session ${a.sessionId} cannot release lane "${a.lane}" — held by ${existing.sessionId}.`
    );
  }
  return allow('release_ok', 'Holder releasing own claim.');
}

function checkSliceStop(a, state) {
  if (!a.sessionId) return refuse('session_required', 'slice_stop_required', '`sessionId` is required for slice-stop.');
  const session = (state.sessions || []).find((s) => s.id === a.sessionId);
  if (!session) return refuse('session_unknown', 'lane_ownership', `Session ${a.sessionId} not registered.`);
  if (session.status === 'closed') {
    return refuse('session_closed', 'lane_ownership', `Session ${a.sessionId} is already closed. Cannot slice-stop a closed session.`);
  }
  return allow('slice_stop_ok', 'Slice-stop is always allowed for an active session.');
}

function checkRequestHandoff(a, state) {
  if (!a.lane) return refuse('lane_required', 'lane_ownership', '`lane` field is required.');
  const existing = (state.claims || []).find((c) => c.lane === a.lane);
  if (!existing) return refuse('no_claim_to_handoff', 'lane_ownership', `Lane "${a.lane}" has no active claim — nothing to hand off.`);
  return allow('handoff_request_ok', `Holder ${existing.sessionId} will receive an inbox message.`);
}

function checkApprove(a, state) {
  if (!a.approvalId) return refuse('approval_required', 'lane_ownership', '`approvalId` is required.');
  const open = state.approvals && state.approvals.open ? state.approvals.open : [];
  const existing = open.find((x) => x.approvalId === a.approvalId);
  if (!existing) return refuse('approval_unknown', 'lane_ownership', `No open approval with id ${a.approvalId}.`);
  if (!['allow-once', 'allow-always', 'deny'].includes(a.decision)) {
    return refuse('decision_invalid', 'lane_ownership', 'Decision must be allow-once / allow-always / deny.');
  }
  return allow('approve_ok', 'Approval will be decided and ledgered.');
}

function checkWriteFile(a, state) {
  if (!a.path) return refuse('path_required', 'files_only', '`path` is required.');
  // Brand-boundary heuristic: writes that mix shell tokens into user-content
  // dirs (src/data/*-brand.js) or vice versa are flagged. This is a
  // conservative check — false positives are fine; the operator overrides.
  const p = String(a.path).replace(/\\/g, '/');
  if (/\.maddu\/auth\//.test(p)) {
    return refuse('write_to_auth_dir', 'no_token_export', 'Writes under .maddu/auth/ are forbidden — that path is OS-owned.');
  }
  if (/maddu\/cockpit\//.test(p) && /(app|content)-brand/.test(p)) {
    return refuse('brand_boundary_mix', 'brand_boundary', 'Cockpit shell directory must not contain app/content brand files.');
  }
  return allow('write_ok', 'No hard-rule conflict detected.');
}

function allow(reasonCode, hint) {
  return { allow: true, reasonCode, hint };
}

function refuse(reasonCode, rule, hint) {
  return { allow: false, reasonCode, citedRule: HARD_RULES[rule] || rule, hint };
}

export const ENFORCER_RULES = HARD_RULES;
