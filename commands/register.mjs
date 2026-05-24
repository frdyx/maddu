// `maddu register` — zero-keystroke session bootstrap for agents.
//
// The v0.16-era contract for getting an agent onto the spine was:
//   maddu session register --role implementer --label "…" --focus "…"
// That's six tokens to type and three to remember. v0.17's agent-native
// bootstrap (plan §0.4 + §4) reduces it to literally one:
//
//   maddu register
//
// Defaults are auto-derived from cwd-basename (label, focus). Role
// defaults to 'implementer'. The command is idempotent when
// MADDU_SESSION_ID is set in env AND the referenced session is still
// active in the projection — repeat invocations are a no-op with a
// `(already registered)` marker. Stale env (session closed) falls
// through to a fresh registration.
//
// NOTE (v1.3.0 coherence): `maddu register` is NOT a thin alias of
// `maddu session register`, despite the surface resemblance. `session
// register` emits SESSION_REGISTERED via session.mjs#doRegister; this
// command emits a DISTINCT event type, SESSION_AUTO_REGISTERED (with
// source:'cli', env-based idempotency, and cwd-derived defaults). The two
// event types drive different projection arms, so delegating to doRegister
// would change observable behavior — they are deliberately kept separate.
//
// Emits SESSION_AUTO_REGISTERED with source:'cli'. Phase 2 will extend
// the event data with parentSessionId when --parent (or
// MADDU_PARENT_SESSION_ID) is supplied; this Phase-1 cut already
// accepts the flag and forwards it, but the projection arm that
// builds the tree lands in Phase 2.

import { basename } from 'node:path';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

// Resolve the (sessionId, status) of the env-bound session if any. Returns
// { sessionId, status } where status is 'active' | 'closed' | 'missing'.
async function resolveEnvSession(projections, repoRoot) {
  const envId = process.env.MADDU_SESSION_ID;
  if (!envId) return null;
  const proj = await projections.project(repoRoot);
  const s = proj.sessions.find((x) => x.id === envId);
  if (!s) return { sessionId: envId, status: 'missing' };
  return { sessionId: envId, status: s.status };
}

export default async function register(argv) {
  const { flags, positional } = parseFlags(argv);
  const { paths, spine, projections, sessionActive } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  // 1. Idempotency: skip when env points at an active session.
  const env = await resolveEnvSession(projections, repoRoot);
  if (env && env.status === 'active') {
    console.log(env.sessionId);
    if (process.stdout.isTTY) {
      console.log(`  (already registered — MADDU_SESSION_ID=${env.sessionId})`);
    }
    return;
  }
  if (env && env.status === 'closed' && process.stdout.isTTY) {
    console.error(`(env MADDU_SESSION_ID=${env.sessionId} is closed — registering anew)`);
  }

  // 2. Resolve defaults. Positional[0] beats --label beats cwd-basename.
  const cwdLabel = basename(repoRoot) || 'agent';
  const label = positional[0] || flags.label || cwdLabel;
  const role = flags.role || 'implementer';
  const focus = flags.focus || label;
  const parentSessionId =
    flags.parent || process.env.MADDU_PARENT_SESSION_ID || null;

  // 3. Append SESSION_AUTO_REGISTERED. The session id IS the actor — same
  //    convention as SESSION_REGISTERED. parentSessionId rides in data so
  //    Phase 2's sessionsTree projection can pick it up without schema
  //    changes here.
  const sessionId = spine.genSessionId();
  const ev = await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.SESSION_AUTO_REGISTERED,
    actor: sessionId,
    lane: null,
    data: {
      sessionId,
      parentSessionId,
      source: 'cli',
      label,
      role
    }
  });

  // 4. Cache as the active session for this repo (same path as session
  //    register/start). Heartbeat / close pick this up automatically.
  if (sessionActive) {
    await sessionActive.writeActiveSession(repoRoot, {
      sessionId,
      registeredAt: ev.ts,
      role,
      label,
      lane: null
    });
  }

  // 5. Print id + export hint. Plain on non-TTY (script-friendly).
  console.log(sessionId);
  if (process.stdout.isTTY) {
    console.log(`  auto-registered  ${fmtTime(ev.ts)}  role=${role}  label="${label}"`);
    if (parentSessionId) console.log(`  parent: ${parentSessionId}`);
    console.log(`  export MADDU_SESSION_ID=${sessionId}    # paste into your shell for idempotent re-runs`);
  }
}

