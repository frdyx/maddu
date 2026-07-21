// verify-replay.mjs — clean-checkout replay of a declared verification
// (verification-witness track PR 5): `maddu spine verify --replay <sha>`.
//
// WHAT A REPLAY IS: git clone --no-local of THIS repo at an exact commit id
// into a throwaway temp dir, then the commands the repo itself declares in
// `maddu.json → replay: {install?: string, verify: string}` — read FROM THE
// CLONE at that SHA, never from the worktree, so dirty or newer config can
// never choose the commands for an older subject. The outcome is appended to
// the SOURCE repo's spine as a VERIFICATION_RAN receipt with
// `profile: 'replayed'`, derived strictly from the in-process result (audit
// P3 — never a re-read report, never a best-effort append).
//
// HONEST SCOPE (stated wherever replay is documented and in every output):
//   - `--no-local` isolates git OBJECT COPYING only. Host environment,
//     credentials, caches, services, and absolute-path writes are NOT
//     isolated. Replay is clean-checkout reproducibility + dirty-worktree
//     contamination detection — nothing more.
//   - The declared command strings are TRUSTED operator config executed via
//     the host shell (`shell: true`). The clone provides no safety boundary.
//   - v1 accepts ONLY the declared commands. There is deliberately NO
//     lockfile/ecosystem inference and no fallback command anywhere in this
//     module: an undeclared project reports `unsupported` and can never gain
//     `replayed`.
//
// RECEIPT DISCIPLINE (strict, unlike the best-effort recordVerification):
//   - VERIFICATION_STARTED is appended AFTER clone + config validation and
//     BEFORE any declared command runs — a setup refusal (bad sha, clone
//     failure, unsupported/invalid config) emits NO spine events at all.
//   - A STARTED append failure is a pre-run refusal (`spine-unavailable`):
//     replay refuses to run unrecorded.
//   - A RAN append failure after the run exits nonzero and never claims
//     `replayed` — a swallowed append must not let exit 0 assert a receipt
//     that does not exist.
//
// MADDU_REPLAY_TIMEOUT_MS is an env TEST SEAM only (MADDU_OTS_BIN precedent):
// it exists so the kill path is exercisable in tests. The v1 maddu.json shape
// stays exactly {install?: string, verify: string} — no timeout config.

import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { redactLeaves, redactText } from './secret-scan.mjs';

const pExecFile = promisify(execFile);

export const REPLAY_TIMEOUT_MS_DEFAULT = 600000; // fixed per command (10 min)
const KILL_SETTLE_MS = 10000;   // universal settlement deadline, from KILL INITIATION
const TASKKILL_TIMEOUT_MS = 5000; // bound on the taskkill invocation itself

export const REPLAY_SCOPE_LINE =
  'clean-checkout replay: --no-local isolates git object copying only — host env, credentials, caches, services, and absolute-path writes are NOT isolated.';

// Every error detail this module returns is PRINTED (human + --json stdout)
// and some land in receipts — a spawn/clone error can echo the declared
// command string, so redact at the source, not just at the receipt boundary.
function shortErr(e) {
  const raw = String((e && e.message) || e).replace(/\s+/g, ' ').trim();
  return redactText(raw).text.slice(0, 300);
}

export function replayTimeoutMs() {
  const raw = process.env.MADDU_REPLAY_TIMEOUT_MS;
  const n = raw && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : REPLAY_TIMEOUT_MS_DEFAULT;
}

// ── subject sha (exact-id discipline) ────────────────────────────────────

// The subject must be the FULL commit id in the repo's own object format:
// a 40-hex string in a sha256 repo is an ABBREVIATION rev-parse would happily
// resolve, and an annotated-tag object id peels through `<sha>^{commit}` to a
// DIFFERENT object than subject_sha would record — both break exact-SHA
// discipline, so the object itself must exist and be a commit.
export async function resolveSubjectSha(workRoot, sha) {
  if (typeof sha !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    return { ok: false, reason: 'sha-invalid', detail: '--replay requires a full lowercase hex commit id (40 hex in sha1 repos, 64 in sha256 repos) — abbreviations, refs, and uppercase are refused' };
  }
  let format = null;
  try {
    const { stdout } = await pExecFile('git', ['rev-parse', '--show-object-format'], { cwd: workRoot });
    format = stdout.trim() || 'sha1';
  } catch (e) {
    return { ok: false, reason: 'clone-failed', detail: `not a usable git repository (rev-parse failed): ${shortErr(e)}` };
  }
  const want = format === 'sha256' ? 64 : 40;
  if (sha.length !== want) {
    return { ok: false, reason: 'sha-invalid', detail: `this repository's object format is ${format} — a ${sha.length}-hex id would be an abbreviation; supply the full ${want}-hex commit id` };
  }
  let type = null;
  try {
    const { stdout } = await pExecFile('git', ['cat-file', '-t', sha], { cwd: workRoot });
    type = stdout.trim();
  } catch {
    return { ok: false, reason: 'sha-not-found', detail: `object ${sha} does not exist in this repository` };
  }
  if (type !== 'commit') {
    return { ok: false, reason: 'sha-not-found', detail: `object ${sha} exists but is a ${type}, not a commit — tag/tree/blob ids are not replay subjects (an annotated tag would replay a different object than the receipt records)` };
  }
  return { ok: true, sha };
}

// ── clone + cleanup ──────────────────────────────────────────────────────

export async function cloneAtSha(workRoot, sha) {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'maddu-replay-'));
    await pExecFile('git', ['clone', '--no-local', '--no-checkout', '--quiet', workRoot, dir], { maxBuffer: 8 * 1024 * 1024 });
    await pExecFile('git', ['checkout', '--detach', '--quiet', sha], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, reason: 'clone-failed', detail: shortErr(e), dir };
  }
}

// Windows: git writes read-only pack files; fs.rm has no built-in chmod, so
// EPERM there is EXPECTED — one best-effort recursive chmod, then retry once.
// SYMLINKS ARE SKIPPED ENTIRELY: chmod follows links, so touching one would
// chmod its TARGET — possibly a host file outside the clone. (rm unlinks the
// link itself without needing its permission bits, so skipping loses nothing.)
async function chmodTree(dir) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      try { await chmod(p, 0o700); } catch {}
      await chmodTree(p);
    } else {
      try { await chmod(p, 0o600); } catch {}
    }
  }
}

// MADDU_REPLAY_TEST_CLEANUP_FAIL is a guarded no-op-in-production TEST seam:
// it forces cleanup to REPORT failure (without deleting) so the fail-closed
// reaction is provable. Direction-safe — it can only make a run FAIL harder,
// never pass.
export async function cleanupClone(dir) {
  if (!dir) return true;
  if (process.env.MADDU_REPLAY_TEST_CLEANUP_FAIL === '1') return false;
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return true;
  } catch {
    await chmodTree(dir);
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return true;
    } catch { return false; }
  }
}

// ── declared config (read FROM THE CLONE, fail-closed) ───────────────────

export async function readReplayConfig(cloneDir) {
  const p = join(cloneDir, 'maddu.json');
  let st = null;
  try {
    st = await lstat(p);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'unsupported', detail: 'no maddu.json at the replayed SHA — declare replay: {install?, verify} (it is read at the subject SHA, not from the worktree)' };
    return { status: 'config-invalid', detail: `maddu.json at the replayed SHA is unreadable: ${shortErr(e)}` };
  }
  // A committed symlink could resolve to host-mutable content OUTSIDE the
  // clone, defeating exact-SHA reproducibility — regular files only.
  if (!st.isFile() || st.isSymbolicLink()) {
    return { status: 'config-invalid', detail: 'maddu.json at the replayed SHA is not a regular file (symlinks are refused — they can resolve outside the clone)' };
  }
  let cfg = null;
  try {
    const raw = await readFile(p, 'utf8');
    cfg = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (e) {
    return { status: 'config-invalid', detail: `maddu.json at the replayed SHA did not parse: ${shortErr(e)}` };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { status: 'config-invalid', detail: 'maddu.json root at the replayed SHA is not an object' };
  }
  if (cfg.replay === undefined) {
    return { status: 'unsupported', detail: 'maddu.json at the replayed SHA declares no replay commands — add replay: {install?, verify} and commit it (config is read at the subject SHA)' };
  }
  const r = cfg.replay;
  if (r === null || typeof r !== 'object' || Array.isArray(r)) {
    return { status: 'config-invalid', detail: 'maddu.json replay must be an object of shape {install?: string, verify: string}' };
  }
  const KEYS = new Set(['install', 'verify']);
  const unknown = Object.keys(r).filter((k) => !KEYS.has(k));
  if (unknown.length) {
    return { status: 'config-invalid', detail: `maddu.json replay has unknown key(s): ${unknown.join(', ')} — the v1 shape is exactly {install?: string, verify: string}` };
  }
  if (typeof r.verify !== 'string' || !r.verify.trim()) {
    return { status: 'config-invalid', detail: 'maddu.json replay.verify must be a non-blank command string (a blank string would be a shell no-op manufacturing a passing receipt)' };
  }
  if (r.install !== undefined && (typeof r.install !== 'string' || !r.install.trim())) {
    return { status: 'config-invalid', detail: 'maddu.json replay.install, when present, must be a non-blank command string' };
  }
  return { status: 'ok', install: r.install !== undefined ? r.install : null, verify: r.verify };
}

// ── declared-command execution (never rejects, never hangs) ──────────────

// Every outcome settles exactly once into {exit, timedOut, spawnError,
// settled}. `settled:false` means the kill deadline expired with the child
// not proven dead — recorded honestly; cleanup will then likely fail and the
// caller's fail-closed path takes over.
export function runDeclared(command, { cwd, timeoutMs, json = false } = {}) {
  return new Promise((resolvePromise) => {
    const timers = [];
    let done = false;
    let child = null;
    // A background DESCENDANT can inherit the piped stdio and hold it open
    // after the shell itself exits — 'close' then never fires. Destroying our
    // read ends (and unref'ing) is what lets settlement actually settle.
    const releaseChild = () => {
      if (!child) return;
      try { if (child.stdout) child.stdout.destroy(); } catch {}
      try { if (child.stderr) child.stderr.destroy(); } catch {}
      try { child.unref(); } catch {}
    };
    const settle = (out) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      releaseChild();
      resolvePromise(out);
    };
    let timedOut = false;
    let exitCode;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env: process.env,
        // --json reserves OUR stdout for exactly one JSON document: both
        // child streams are forwarded to stderr instead (still live, still
        // uncaptured — nothing ever lands in an event).
        stdio: json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      settle({ exit: null, timedOut: false, spawnError: shortErr(e), settled: true });
      return;
    }
    if (json) {
      if (child.stdout) child.stdout.pipe(process.stderr);
      if (child.stderr) child.stderr.pipe(process.stderr);
    }
    child.on('error', (e) => settle({ exit: null, timedOut, spawnError: shortErr(e), settled: true }));
    // 'exit' = the shell died (code known); 'close' additionally waits for
    // stdio to drain — which a lingering DESCENDANT can hold open forever.
    // After exit, allow a short drain window (the shell's own final output
    // arrives within it), then release our pipe ends so 'close' fires even
    // when a descendant kept them open. 'close' stays the settle point.
    child.on('exit', (code) => {
      exitCode = code;
      timers.push(setTimeout(releaseChild, 1500));
    });
    child.on('close', (code) => settle({ exit: code ?? exitCode ?? null, timedOut, spawnError: null, settled: true }));
    timers.push(setTimeout(() => {
      timedOut = true;
      // Universal settlement deadline starts AT KILL INITIATION — a stalled
      // taskkill (itself bounded below) can never postpone it.
      timers.push(setTimeout(() => settle({ exit: null, timedOut: true, spawnError: null, settled: false }), KILL_SETTLE_MS));
      (async () => {
        try {
          if (process.platform === 'win32') {
            await pExecFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: TASKKILL_TIMEOUT_MS });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          // taskkill error/timeout (incl. the benign already-exited race) —
          // fall back to a direct kill; the deadline above still governs.
          try { child.kill('SIGKILL'); } catch {}
        }
      })();
    }, timeoutMs));
  });
}

// ── orchestrator ─────────────────────────────────────────────────────────

// Returns a plain result object; never calls process.exit. Refusals:
// { ok:false, reason, detail } with reason one of sha-invalid | sha-not-found
// | clone-failed | unsupported | config-invalid | spine-unavailable — no
// spine events were emitted. Runs: { ok:true, ... } with result/complete
// derived from the in-process outcome (see receipt semantics below).
export async function runReplay({ workRoot, stateRoot, sha, spine, actor = null, lane = null, json = false }) {
  const subj = await resolveSubjectSha(workRoot, sha);
  if (!subj.ok) return { ok: false, reason: subj.reason, detail: subj.detail };

  const cloned = await cloneAtSha(workRoot, sha);
  if (!cloned.ok) {
    const deleted = await cleanupClone(cloned.dir);
    return { ok: false, reason: 'clone-failed', detail: cloned.detail, cloneDir: deleted ? null : cloned.dir };
  }
  const dir = cloned.dir;

  const cfg = await readReplayConfig(dir);
  if (cfg.status !== 'ok') {
    const deleted = await cleanupClone(dir);
    return { ok: false, reason: cfg.status, detail: cfg.detail, cloneDir: deleted ? null : dir };
  }

  const T = (spine && spine.EVENT_TYPES) || {};
  let startedId = null;
  try {
    const ev = await spine.append(stateRoot, {
      type: T.VERIFICATION_STARTED || 'VERIFICATION_STARTED',
      actor, lane,
      data: { kind: 'replay', profile: 'replayed' },
    });
    startedId = (ev && ev.id) || null;
    if (!startedId) throw new Error('spine.append returned no event id');
  } catch (e) {
    const deleted = await cleanupClone(dir);
    return { ok: false, reason: 'spine-unavailable', detail: `could not append VERIFICATION_STARTED — replay refuses to run unrecorded: ${shortErr(e)}`, cloneDir: deleted ? null : dir };
  }

  const timeoutMs = replayTimeoutMs();
  const t0 = Date.now();
  let installRes = null;
  let verifyRes = null;
  if (cfg.install) installRes = await runDeclared(cfg.install, { cwd: dir, timeoutMs, json });
  const installOk = !cfg.install
    || (installRes.settled && !installRes.timedOut && !installRes.spawnError && installRes.exit === 0);
  if (installOk) verifyRes = await runDeclared(cfg.verify, { cwd: dir, timeoutMs, json });
  const durationMs = Date.now() - t0;

  // Cleanup BEFORE the receipt — clone_deleted must be a fact, not a hope.
  const cloneDeleted = await cleanupClone(dir);

  // Receipt semantics: verify exit 0 + full protocol (incl. cleanup) → pass.
  // Verify nonzero → fail, complete:true (the protocol completed; the
  // commands failed). Install failure / timeout / spawn error / unsettled
  // kill → fail, complete:false (the declared verify never ran or was
  // killed). Cleanup failure → fail, complete:false even when verify passed
  // (an incompletely-executed replay protocol never reads as a successful
  // replayed run) — verify_exit stays visible so the truth is auditable.
  const verifyRan = !!verifyRes;
  const verifyClean = verifyRan && verifyRes.settled && !verifyRes.timedOut && !verifyRes.spawnError;
  const protocolComplete = installOk && verifyClean;
  const verifyPassed = verifyClean && verifyRes.exit === 0;
  const result = verifyPassed && cloneDeleted ? 'pass' : 'fail';
  const complete = protocolComplete && cloneDeleted;
  const timedOut = !!((installRes && installRes.timedOut) || (verifyRes && verifyRes.timedOut));
  const spawnError = (installRes && installRes.spawnError) || (verifyRes && verifyRes.spawnError) || null;
  const unsettled = !!((installRes && installRes.settled === false) || (verifyRes && verifyRes.settled === false));

  const data = redactLeaves({
    kind: 'replay',
    startedId,
    profile: 'replayed',
    complete,
    result,
    counts: null,
    subject_sha: sha,
    commands: { install: cfg.install, verify: cfg.verify },
    install_exit: installRes ? installRes.exit : null,
    verify_exit: verifyRes ? verifyRes.exit : null,
    timed_out: timedOut,
    spawn_error: spawnError,
    settled: !unsettled,
    duration_ms: durationMs,
    clone_deleted: cloneDeleted,
  });

  let receiptAppended = false;
  let appendError = null;
  try {
    await spine.append(stateRoot, { type: T.VERIFICATION_RAN || 'VERIFICATION_RAN', actor, lane, data });
    receiptAppended = true;
  } catch (e) {
    appendError = shortErr(e);
  }

  return {
    ok: true,
    sha,
    result,
    complete,
    installDeclared: !!cfg.install,
    installExit: installRes ? installRes.exit : null,
    verifyExit: verifyRes ? verifyRes.exit : null,
    timedOut,
    spawnError,
    settled: !unsettled,
    durationMs,
    cloneDeleted,
    cloneDir: cloneDeleted ? null : dir,
    receiptAppended,
    appendError,
    startedId,
    scope: REPLAY_SCOPE_LINE,
  };
}
