// bridge-body-id.mjs — CP4 (PR-B): validate the sessionId carried in a bridge
// request body at the HTTP boundary, so a malformed id from a loopback client
// never becomes an event actor / persisted id. Grammar = the RELAXED reference
// tier (isRefId), matching the CLI's ambient-actor validation.
//
// Two modes:
//   required:true  — the route's action is meaningless without an actor
//     (slice-stop; lane claim/release validate inline). absent / null /
//     non-string / malformed → { ok:false, status:400, error }.
//   required:false — the actor is optional attribution (inbox, approvals,
//     worker lifecycle, runtime spawn, skill apply). The cockpit legitimately
//     posts sessionId:null, so absent/null → { ok:true, sessionId:null };
//     a PRESENT malformed value is a client bug → { ok:false, status:400 }.
//
// Object.hasOwn distinguishes "absent" from "present-but-null" WITHOUT a
// prototype-chain read. A non-object or array body carries no sessionId.

import { isRefId } from './id-grammar.mjs';

export function readBodySessionId(body, { required = false } = {}) {
  const present = body && typeof body === 'object' && !Array.isArray(body)
    && Object.hasOwn(body, 'sessionId');
  const v = present ? body.sessionId : undefined;
  // Absent or explicitly null → required rejects, optional resolves to null.
  if (!present || v === null || v === undefined) {
    if (required) return { ok: false, status: 400, error: 'sessionId required' };
    return { ok: true, sessionId: null };
  }
  // Present and non-null → must be a valid reference id in BOTH modes.
  if (isRefId(v)) return { ok: true, sessionId: v };
  return { ok: false, status: 400, error: 'invalid sessionId (string, [\\w.-]{1,128})' };
}
