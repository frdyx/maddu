// id-grammar.mjs — stdlib-only id/session grammar (PR-B).
//
// Dependency-free ON PURPOSE: spine.mjs RE-EXPORTS these so existing predicate
// importers are unaffected, AND standalone modules that must not pull in the
// full spine (the worker token-wrapper _wrapper-common.mjs, telemetry) import
// this tiny module directly. Keep it Node-builtin-free too (no cycle risk).
//
// Two-tier predicate model (unchanged from PR-A — this module only relocates
// the SSOT so more surfaces can share it):
//   isSid    — STRICT   creates / shell-interpolate
//   isRefId  — RELAXED  reference an existing id
//   isClaudeId —        claude:<id> counter key
// Each requires typeof === string BEFORE .test() (a naked regex coerces).

export const SID_RE = /^ses_[A-Za-z0-9_]{1,64}$/;
export const SID_REF_RE = /^[\w.-]{1,128}$/;
export const CLAUDE_ID_RE = /^[\w-]{1,64}$/;

export function isSid(v) { return typeof v === 'string' && SID_RE.test(v); }
export function isRefId(v) { return typeof v === 'string' && SID_REF_RE.test(v); }
export function isClaudeId(v) { return typeof v === 'string' && CLAUDE_ID_RE.test(v); }

// Lane REFERENCE grammar for claim/release (NOT LANE_SLUG_RE, which excludes
// slash and would reject the auto-claim namespace auto/<suffix> and existing
// ad-hoc claims). Any non-empty, bounded, control-free string: length 1-128,
// no C0 (0x00-0x1F), DEL (0x7F), or C1 (0x80-0x9F) controls. Spaces, Unicode,
// slash, and ad-hoc names are all admitted.
const LANE_CTRL_RE = /[\u0000-\u001F\u007F-\u009F]/;
export function isClaimLane(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 128 && !LANE_CTRL_RE.test(v);
}

// Typed error for a malformed EXPLICIT id flag (--session / --parent). A
// malformed explicit flag is a hard user error, NOT a silent fall-through to
// env/cache (which could resolve a DIFFERENT session than the user named). The
// central CLI catch (bin/maddu.mjs) renders err.message without a stack; the
// raw value is never retained or printed (no injection surface).
export class InvalidExplicitId extends Error {
  constructor(option) {
    super(`invalid --${option} id`);
    this.name = 'InvalidExplicitId';
    this.code = 'INVALID_EXPLICIT_ID';
    this.option = option; // 'session' | 'parent'
  }
}

// Resolve the ambient acting session id from the environment, grammar-gated. A
// malformed MADDU_SESSION_ID is AMBIENT (not an explicit request) -> treated as
// absent (null), never written raw into an event actor / persisted id. env is
// injectable so callers with an env seam (invocation-receipts) validate alike.
export function envActingSid(env = process.env) {
  const v = env && env.MADDU_SESSION_ID;
  return isRefId(v) ? v : null;
}

// Grammar-gate a parent id at a registration boundary. Malformed -> null (drop
// the bad edge rather than write a verify-FAILing dangling reference); the
// EXISTENCE check lives at the caller (against ever-registered proj.sessions).
export function normalizeParentId(v) {
  return isRefId(v) ? v : null;
}
