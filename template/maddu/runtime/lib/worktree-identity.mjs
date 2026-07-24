// worktree-identity.mjs — the per-worktree PHYSICAL identity token (PR-D §3.1).
//
// WHY
// ───
// `attachmentId` names a spine LIFECYCLE, not the directory currently at the lane
// path. A manual remove+recreate, or a team-sync-imported foreign replica's
// intent, could otherwise make recovery delete the WRONG checkout. So every
// attach mints a random `worktreeInstanceId` and writes it into the checkout's
// PRIVATE per-worktree git admin dir. Finalize/recover then remove a present
// checkout ONLY when its on-disk token still equals the token recorded on the
// intent — a mismatch (a different checkout now sits at the path) fails closed.
//
// HOME = `git -C <path> rev-parse --absolute-git-dir` / `maddu-instance`.
// This is the per-worktree private dir (…/.git/worktrees/<name>), NOT `info/`,
// which resolves through $GIT_COMMON_DIR and is SHARED across all linked
// worktrees — the `info/exclude` idiom in worktrees.mjs is correct for a shared
// exclude but would make every worktree overwrite ONE identity token. The token
// survives `git worktree repair` (it rewrites the link files in place, leaving
// the private dir intact). A token MISSING after a prune/repair is treated as
// UNVERIFIABLE (operator-required) — never as evidence the checkout was removed.

import { writeFile, readFile, rename, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gitRun } from './git-exec.mjs';

const INSTANCE_FILE = 'maddu-instance';

// Resolve the per-worktree private git dir for the checkout at `path`.
// Returns { ok:true, dir } or { ok:false, error } (never throws — a checkout that
// has vanished makes rev-parse fail, and callers must treat that as unverifiable
// rather than crash).
export async function worktreeInstanceDir(stateRoot, path) {
  const r = await gitRun(['-C', path, 'rev-parse', '--absolute-git-dir'], stateRoot, 5000);
  if (r.code !== 0) {
    return { ok: false, error: `git rev-parse --absolute-git-dir failed for "${path}": ${(r.stderr || r.error || '').trim()}` };
  }
  const dir = r.stdout.trim();
  if (!dir || !isAbsolute(dir)) return { ok: false, error: `git returned a non-absolute git dir "${dir}" for "${path}"` };
  return { ok: true, dir, file: join(dir, INSTANCE_FILE) };
}

// Mint + durably write a new token for the checkout at `path`, LOAD-BEARING:
// atomic write (tmp + rename) followed by an EXACT read-back. Any failure throws
// — the attach caller must then roll back the git provisioning and append NO
// WORKTREE_ATTACHED (an attachment whose physical identity did not persist is
// worse than no attachment: recovery could never verify it).
export async function mintWorktreeInstance(stateRoot, path) {
  const loc = await worktreeInstanceDir(stateRoot, path);
  if (!loc.ok) throw new Error(`cannot mint worktree instance token: ${loc.error}`);
  const token = randomBytes(16).toString('hex');
  const tmp = `${loc.file}.tmp.${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, token);
    await rename(tmp, loc.file);
  } catch (e) {
    try { await rm(tmp, { force: true }); } catch {}
    throw new Error(`failed to write worktree instance token at ${loc.file}: ${e.message}`);
  }
  const readBack = (await readFile(loc.file, 'utf8')).trim();
  if (readBack !== token) {
    throw new Error(`worktree instance token read-back mismatch at ${loc.file} (wrote ${token.slice(0, 8)}…, read ${readBack.slice(0, 8)}…)`);
  }
  return token;
}

// Read the token for the checkout at `path`. Returns a discriminated result so
// callers can tell the three states apart (§3.1 fails closed on the last two):
//   { state:'present', token }   — the checkout is here and carries a token
//   { state:'absent' }           — git dir resolves but no token file (legacy,
//                                  or pruned/repaired-away → unverifiable)
//   { state:'unresolvable', error } — rev-parse failed (checkout gone / git error)
export async function readWorktreeInstance(stateRoot, path) {
  const loc = await worktreeInstanceDir(stateRoot, path);
  if (!loc.ok) return { state: 'unresolvable', error: loc.error };
  try {
    const token = (await readFile(loc.file, 'utf8')).trim();
    if (!token) return { state: 'absent' };
    return { state: 'present', token };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unresolvable', error: `failed to read ${loc.file}: ${e.message}` };
  }
}
