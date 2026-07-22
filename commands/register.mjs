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
// active — and (v1.111.0) the reuse RENEWS the session's heartbeat as one
// close-locked operation, so a stale-aged pinned continuation is never
// bound-then-janitor-closed, and it repairs an absent/unusable active
// pointer (never a live one). Stale/unprovable env falls through to a
// fresh registration.
//
// NOTE (v1.3.0 coherence): `maddu register` is NOT a thin alias of
// `maddu session register`, despite the surface resemblance. `session
// register` emits SESSION_REGISTERED via session.mjs#doRegister; this
// command emits a DISTINCT event type, SESSION_AUTO_REGISTERED (with
// source:'cli', env-based idempotency, and cwd-derived defaults). The two
// event types drive different projection arms, so delegating to doRegister
// would change observable behavior — they are deliberately kept separate.
//
// In-process return (v1.111.0): { sessionId, created } — the SessionStart
// hook keys create-only baseline capture on `created`. CLI stdout is
// unchanged (prints the id).

import { basename } from 'node:path';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function register(argv) {
  const { flags, positional } = parseFlags(argv);
  const { paths, spine, projections, sessionActive, sessionLifecycle } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  // 1. Idempotency: reuse an env-named session ONLY when it conforms to the
  //    reference grammar (a nonconforming inherited id is IGNORED — fall
  //    through to fresh registration) AND liveness can be proven-and-renewed
  //    atomically under the close lock. Anything else (not-active, lock
  //    busy, corrupt spine, or an older installed lib without the renewal
  //    primitive) falls through to fresh registration — never bind a closed
  //    or unprovable sid.
  const envId = process.env.MADDU_SESSION_ID;
  const isRefId = spine.isRefId || ((v) => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v));
  if (isRefId(envId) && sessionLifecycle && sessionLifecycle.renewSessionIfActive) {
    const renewal = await sessionLifecycle.renewSessionIfActive(repoRoot, {
      sessionId: envId,
      focus: 'continuation (env-idempotent register)',
    });
    if (renewal.status === 'renewed') {
      // Pointer repair: absent/unusable/verified-stale pointers are
      // replaceable; a pointer naming a different LIVE session is never
      // stolen by an idempotent re-register.
      if (sessionActive && sessionActive.writeActiveSessionIfAbsent) {
        await sessionActive.writeActiveSessionIfAbsent(repoRoot, {
          sessionId: envId,
          registeredAt: renewal.event ? renewal.event.ts : null,
          role: 'implementer',
          label: basename(repoRoot) || 'agent',
          lane: null,
        });
      }
      console.log(envId);
      if (process.stdout.isTTY) {
        console.log(`  (already registered — MADDU_SESSION_ID=${envId}, heartbeat renewed)`);
      }
      return { sessionId: envId, created: false };
    }
  } else if (isRefId(envId) && !sessionLifecycle) {
    // Legacy-lib fallback: the old projection-based idempotency check.
    const proj = await projections.project(repoRoot);
    const s = proj.sessions.find((x) => x.id === envId);
    if (s && s.status === 'active') {
      console.log(envId);
      if (process.stdout.isTTY) console.log(`  (already registered — MADDU_SESSION_ID=${envId})`);
      return { sessionId: envId, created: false };
    }
  }

  // 2. Resolve defaults. Positional[0] beats --label beats cwd-basename.
  const cwdLabel = basename(repoRoot) || 'agent';
  const label = positional[0] || flags.label || cwdLabel;
  const role = flags.role || 'implementer';
  // Parent forwarded VERBATIM as on main — parent validation + existence
  // checking are explicitly deferred to the PR-B id-validation campaign.
  const parentSessionId = flags.parent || process.env.MADDU_PARENT_SESSION_ID || null;

  // 3. Append SESSION_AUTO_REGISTERED through the uniqueness transaction.
  //    The session id IS the actor — same convention as SESSION_REGISTERED;
  //    the makeEvent factory receives the FINAL id (post-regeneration) so
  //    the schema-required data.sessionId duplicate is always correct.
  const makeEvent = (sessionId) => ({
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
  let sessionId, ev;
  if (sessionLifecycle && sessionLifecycle.registerSessionUnique) {
    const res = await sessionLifecycle.registerSessionUnique(repoRoot, { makeEvent });
    sessionId = res.sessionId; ev = res.event;
  } else {
    sessionId = spine.genSessionId();
    ev = await spine.append(repoRoot, makeEvent(sessionId));
  }

  // 4. Cache as the active session for this repo (locked write; a lock
  //    timeout skips — the pointer self-heals on the next register).
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
  // Return the id AND the created flag so the in-process caller (the
  // SessionStart hook) can key create-only baseline capture on it, and binds
  // THIS freshly-registered session rather than re-reading the repo-global
  // active pointer a concurrent register may have overwritten (Codex).
  return { sessionId, created: true };
}
