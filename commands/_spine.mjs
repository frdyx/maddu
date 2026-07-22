// Helper for CLI commands that need the spine library. Walks up from cwd to
// find .maddu/, falls back to the framework's template/ in dev mode, and
// imports the library via file:// URLs (Windows-safe).

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { resolveLibDir, FRAMEWORK_ROOT } from './_libroot.mjs';

export async function loadSpineLib() {
  const dir = await resolveLibDir();
  const paths = await import(pathToFileURL(join(dir, 'paths.mjs')).href);
  const spine = await import(pathToFileURL(join(dir, 'spine.mjs')).href);
  const projections = await import(pathToFileURL(join(dir, 'projections.mjs')).href);
  const hindsight = await import(pathToFileURL(join(dir, 'hindsight.mjs')).href);
  const mailbox = await import(pathToFileURL(join(dir, 'mailbox.mjs')).href);
  const skills = await import(pathToFileURL(join(dir, 'skills.mjs')).href);
  const search = await import(pathToFileURL(join(dir, 'search.mjs')).href);
  const runtimes = await import(pathToFileURL(join(dir, 'runtimes.mjs')).href);
  const mcp = await import(pathToFileURL(join(dir, 'mcp.mjs')).href);
  const schedule = await import(pathToFileURL(join(dir, 'schedule.mjs')).href);
  const checkpoints = await import(pathToFileURL(join(dir, 'checkpoints.mjs')).href);
  const auth = await import(pathToFileURL(join(dir, 'auth.mjs')).href);
  const imports = await import(pathToFileURL(join(dir, 'imports.mjs')).href);
  // session-active.mjs landed in v0.14. Older installs don't have it —
  // make it optional so the new global CLI can still run subcommands
  // that don't need it (heartbeat/close still work via --session).
  let sessionActive = null;
  try { sessionActive = await import(pathToFileURL(join(dir, 'session-active.mjs')).href); } catch {}
  // approvals.mjs landed in v0.15 (spine-authoritative approval decisions).
  // Optional-load so a newer global CLI can run against older installs;
  // the request paths fall back to legacy behavior if it's missing.
  let approvals = null;
  try { approvals = await import(pathToFileURL(join(dir, 'approvals.mjs')).href); } catch {}
  // verify.mjs landed in v0.16 (spine integrity verifier). Optional-load
  // so a newer global CLI can still run subcommands against an older
  // install — `maddu spine verify` reports a clear error in that case.
  let verify = null;
  try { verify = await import(pathToFileURL(join(dir, 'verify.mjs')).href); } catch {}
  // spine-sync.mjs landed in v1.94.0 (#12c team-sync). Optional-load so a newer
  // global CLI can run other subcommands against an older install.
  let spineSync = null;
  try { spineSync = await import(pathToFileURL(join(dir, 'spine-sync.mjs')).href); } catch {}
  // bridge-builders.mjs (buildOversight) powers `maddu spine oversight`.
  // Optional-load so the readout degrades cleanly on an older install.
  let bridgeBuilders = null;
  try { bridgeBuilders = await import(pathToFileURL(join(dir, 'bridge-builders.mjs')).href); } catch {}
  // spine-anchor.mjs (witness track PR 4) powers `maddu spine anchor`.
  // Optional-load so a newer global CLI degrades cleanly on an older install.
  let spineAnchor = null;
  try { spineAnchor = await import(pathToFileURL(join(dir, 'spine-anchor.mjs')).href); } catch {}
  // verify-replay.mjs (witness track PR 5) powers `maddu spine verify --replay`.
  // Optional-load so a newer global CLI degrades cleanly on an older install.
  let verifyReplay = null;
  try { verifyReplay = await import(pathToFileURL(join(dir, 'verify-replay.mjs')).href); } catch {}
  // session-lifecycle.mjs (v1.111.0) — the serialized session-lifecycle
  // transactions. Optional-load so a newer global CLI degrades cleanly on an
  // older install (callers fall back to their legacy direct appends).
  let sessionLifecycle = null;
  try { sessionLifecycle = await import(pathToFileURL(join(dir, 'session-lifecycle.mjs')).href); } catch {}
  return { paths, spine, projections, hindsight, mailbox, skills, search, runtimes, mcp, schedule, checkpoints, auth, imports, sessionActive, approvals, verify, spineSync, bridgeBuilders, spineAnchor, verifyReplay, sessionLifecycle };
}

// v1.93.0 (roadmap #12a phase 1): commands bind STATE (spine, sessions,
// lanes) to the state root, which inside a lane worktree is redirected to the
// primary repo via the .maddu-state-root pointer / MADDU_STATE_ROOT env.
// `resolveRepoRoot` keeps its name and callers but now returns the STATE
// root, so every existing command automatically appends to the primary spine
// instead of a worktree's checkout copy. Older installed libs without
// `resolveRoots` fall back to the legacy walk (work == state).
export async function resolveRepoRoot(paths) {
  const roots = await resolveWorkAndStateRoots(paths);
  if (roots) return roots.stateRoot;
  // Dev fallback: framework's template/ acts as the .maddu/ host.
  return join(FRAMEWORK_ROOT, 'template');
}

// Full split for commands that need both (slice-stop scopes git diffs to the
// work root while appending to the state root). Returns
// { workRoot, stateRoot, redirected } or null when no root marker exists.
export async function resolveWorkAndStateRoots(paths) {
  if (typeof paths.resolveRoots === 'function') {
    return paths.resolveRoots(process.cwd());
  }
  const found = await paths.findRepoRoot(process.cwd());
  return found ? { workRoot: found, stateRoot: found, redirected: false } : null;
}

// Resolve the acting session id for a command. Precedence:
//   1. explicit --session <id> flag
//   2. $MADDU_SESSION_ID env var
//   3. the per-repo active-session cache (.maddu/state/session.active.json)
//      written by `maddu register` / `maddu session start`.
//
// The cache read is liveness-VERIFIED against the spine, so a closed or
// never-registered pointer never resolves — you get null and the caller
// errors (or auto-registers) as it would with no session at all. This is
// what lets a single `maddu register` flow into `lane claim` / `slice-stop`
// across fresh tool-call shells where the env var doesn't persist: the
// discipline stops being something an agent must thread by hand on every
// command, which is the friction that made it get skipped. `sessionActive`
// is the lib from loadSpineLib() (null on pre-v0.14 installs → cache step
// is simply skipped, env/flag still work). Returns a string id, or null.
// Load the id grammar (PR-B) from the resolved runtime lib. Returns
// { isRefId, InvalidExplicitId } or null on a PRE-PR-B lib — the null case is
// the fail-open signal (validate nothing, exactly today's behavior; a newer CLI
// must keep running against an older installed runtime). Fail open ONLY when
// the module/exports are absent — never swallow a validation THROW.
export async function loadIdGrammar() {
  try {
    const dir = await resolveLibDir();
    const m = await import(pathToFileURL(join(dir, 'id-grammar.mjs')).href);
    if (typeof m.isRefId === 'function' && typeof m.InvalidExplicitId === 'function') return m;
  } catch { /* pre-PR-B lib: no id-grammar.mjs → fail open */ }
  return null;
}

// CP1b: validate an explicit --session at a DIRECT reader (the commands that
// read `flags.session` without going through resolveSessionId). Owned-malformed
// throws InvalidExplicitId; absent → null. Historically these did
// `flags.session || null`, collapsing a bad explicit flag (or a bare boolean)
// to a null/true actor. Fail-open on a pre-PR-B lib: a string value passes, a
// bare/empty flag → null (no worse than main, strictly safer than a boolean).
export async function explicitSessionFlag(flags) {
  const g = await loadIdGrammar();
  if (flags && Object.hasOwn(flags, 'session')) {
    const v = flags.session;
    if (g) {
      if (g.isRefId(v)) return v;
      throw new g.InvalidExplicitId('session');
    }
    return (typeof v === 'string' && v.length > 0) ? v : null;
  }
  return null;
}

// CP3 (PR-B): resolve the AMBIENT acting-session id from the environment,
// grammar-gated, for the many command sites that stamped an event actor from a
// raw `process.env.MADDU_SESSION_ID || null`. A malformed MADDU_SESSION_ID is
// ambient (not an explicit request) → treated as absent (null), never written
// raw into a persisted actor/id. Routed through the resolved runtime lib so a
// newer CLI FAILS OPEN against a pre-PR-B install (returns the raw env, exactly
// today's behavior) rather than dropping attribution. Returns a ref-id or null.
export async function envActingSid() {
  const v = process.env.MADDU_SESSION_ID;
  if (!v) return null;
  const g = await loadIdGrammar();
  if (g) return g.isRefId(v) ? v : null;
  return v; // pre-PR-B lib: today's behavior (raw env)
}

// CP5 (PR-B): resolve a parent session id for a registration. Grammar + an
// EXISTENCE check (verify.mjs FAILs a dangling parentSessionId post-append; this
// is the write-time fail-fast). Explicit --parent malformed → THROW; ambient
// MADDU_PARENT_SESSION_ID malformed → drop to null (+ note). Existence uses
// ever-registered proj.sessions (includes CLOSED — a registered-then-closed
// parent stays valid). Pass { spine, projections } to enable the existence
// check; omit for grammar-only. Fail-open on a pre-PR-B lib.
export async function resolveParentId(repoRoot, flags, { projections } = {}) {
  const g = await loadIdGrammar();
  let candidate = null;
  if (flags && Object.hasOwn(flags, 'parent')) {
    const v = flags.parent; // EXPLICIT — malformed is a hard error
    if (g) {
      if (g.isRefId(v)) candidate = v;
      else throw new g.InvalidExplicitId('parent');
    } else if (typeof v === 'string' && v.length > 0) candidate = v;
  } else {
    const env = process.env.MADDU_PARENT_SESSION_ID; // AMBIENT — malformed drops
    if (env) {
      if (g) { if (g.isRefId(env)) candidate = env; else process.stderr.write('[maddu] MADDU_PARENT_SESSION_ID malformed — parent link dropped\n'); }
      else if (env.length > 0) candidate = env;
    }
  }
  if (!candidate) return null;
  try {
    if (projections && typeof projections.project === 'function') {
      const proj = await projections.project(repoRoot);
      const known = new Set((proj.sessions || []).map((s) => s.id));
      if (!known.has(candidate)) {
        process.stderr.write('[maddu] parent session not found — parent link dropped\n');
        return null;
      }
    }
  } catch { /* projection read failed → keep candidate; verify is the backstop */ }
  return candidate;
}

export async function resolveSessionId(repoRoot, flags, sessionActive) {
  const g = await loadIdGrammar();
  // Explicit --session: an OWNED flag must be a valid reference id. A malformed
  // owned flag (bare `true`, empty '', repeated array, non-string, bad grammar)
  // is a HARD user error — never a silent fall-through to a DIFFERENT env/cache
  // session. `Object.hasOwn` (not truthiness) so `--session` / `--session=` are
  // caught, not collapsed to absence.
  if (flags && Object.hasOwn(flags, 'session')) {
    const v = flags.session;
    if (g) {
      if (g.isRefId(v)) return v;
      throw new g.InvalidExplicitId('session');
    }
    // Fail open (pre-PR-B lib can't validate): today's behavior.
    if (typeof v === 'string' && v.length > 0) return v;
  }
  // Ambient env: grammar-gate. A malformed MADDU_SESSION_ID is AMBIENT, not an
  // explicit request → treated as absent (fall through), never thrown.
  const env = process.env.MADDU_SESSION_ID;
  if (env) {
    if (g) { if (g.isRefId(env)) return env; }
    else if (env.length > 0) return env;
  }
  if (sessionActive && typeof sessionActive.readActiveSessionVerified === 'function') {
    const res = await sessionActive.readActiveSessionVerified(repoRoot);
    // v1.111.0 discriminated union: `active`/`unverified` resolve over a
    // SANITIZED (isRefId-gated) record; stale/invalid never resolve.
    if (res && (res.kind === 'active' || res.kind === 'unverified') && res.record) return res.record.sessionId;
    // Pre-v1.111 lib shape (a raw record) — grammar-gate it here (the sanitized
    // union already gates the current shape; the legacy raw arm did not).
    if (res && res.kind === undefined && !res.stale && res.sessionId) {
      if (!g || g.isRefId(res.sessionId)) return res.sessionId;
    }
  }
  return null;
}
