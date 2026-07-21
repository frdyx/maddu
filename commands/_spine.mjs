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
  return { paths, spine, projections, hindsight, mailbox, skills, search, runtimes, mcp, schedule, checkpoints, auth, imports, sessionActive, approvals, verify, spineSync, bridgeBuilders, spineAnchor, verifyReplay };
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
export async function resolveSessionId(repoRoot, flags, sessionActive) {
  if (flags && typeof flags.session === 'string' && flags.session.length > 0) return flags.session;
  const env = process.env.MADDU_SESSION_ID;
  if (env && env.length > 0) return env;
  if (sessionActive && typeof sessionActive.readActiveSessionVerified === 'function') {
    const res = await sessionActive.readActiveSessionVerified(repoRoot);
    if (res && !res.stale && res.sessionId) return res.sessionId;
  }
  return null;
}
