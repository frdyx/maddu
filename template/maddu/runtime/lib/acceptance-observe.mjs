// acceptance-observe — phase 2a of the acceptance proof: the two OBSERVATION
// PRIMITIVES, `withAcceptanceLock` (mutual exclusion between observations
// sharing one state root) and `runAcceptanceCommand` (settle-once execution
// with a bounded output fingerprint). These are the deliberate I/O exception
// in the acceptance family and the exact width of it is: ONE advisory lockfile
// under `<stateRoot>/.maddu/state/`, and ONE child process. Split out of
// acceptance.mjs (the single public entry; its header carries the full
// contract, which binds this module).

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

// The state directory that holds the observation lock. Imported rather than
// re-joined so the lock can never drift onto a second spelling of a path the
// rest of Máddu already owns one name for.
import { pathsFor } from './paths.mjs';

import { refuse, requireWorkRoot, isPlainRecord } from './acceptance-core.mjs';

// ── phase 2a · withAcceptanceLock ──────────────────────────────────────────
//
// Mutual exclusion between two acceptance OBSERVATIONS sharing one state root.
//
// WHAT IT BUYS, STATED AT ITS REAL WIDTH: two observations in one state root
// cannot interleave their own pre-hash → execute → post-hash windows. That is
// all. It closes the case where B's post-hash is taken while A's COMMAND is
// mid-flight mutating shared files. It closes NOTHING about a concurrent
// `iterate`: `runLoop` awaits `iterate` before `verify`, and an observation
// lock taken inside the verify callback cannot, by construction, cover a step
// that already finished. Widening the span to the iterate→verify unit was
// considered and REJECTED — an agent turn is minutes, the lock is global to the
// operator's checkout, and a lock-busy observation supersedes, so a routine
// `maddu orient` during any loop would drop the live proof to `indeterminate`.
// That teaches operators to mute the gate, which is the failure this feature
// exists to prevent. The residual is named in ACCEPTANCE_HONEST_LIMITS, in the
// same entry as "mutation from outside Máddu" — the two are one class.
//
// THE LOCK IS ANCHORED AT stateRoot, NEVER workRoot. Attached lane worktrees
// have distinct work roots and ONE shared state root (paths.mjs:43). A
// workRoot-derived lock would hand two lanes two different locks and reopen
// precisely the race this closes, while still looking locked.
//
// SIBLING OF append-lock.mjs, NOT A COPY. The protocol rules below are the same
// ones, each traceable to the same red-team findings, but four things differ
// deliberately and each difference is the reason this is not just a call to
// `withAppendLock`:
//   1. `maxWaitMs` is FINITE and DEFAULTS FINITE (5s), where the spine append
//      lock defaults to Infinity. A missed acceptance receipt is recoverable by
//      re-running; a `maddu orient` that blocks forever is not acceptable.
//      `Infinity` is REFUSED here (a TypeError) rather than honoured — a caller
//      passing it would reintroduce exactly the hang this default exists to
//      foreclose, and that is a caller bug, not operator input.
//   2. A timeout is a TYPED REFUSAL, never a silent unlocked proceed. There is
//      no best-effort fallback anywhere in this function: if the lock is not
//      held, `fn` does not run. A degrade here would make every sentence above
//      a lie while the receipt still rendered.
//   3. The owner record carries `workRoot`, for diagnostics only — so an
//      operator staring at a busy lock can see WHICH checkout holds it, given
//      that the lock itself is shared across all of them.
//   4. Release happens on EVERY exception path, and an `fn` that throws still
//      releases and still PROPAGATES — the throw is never swallowed into
//      `{ok:false}`, because "the observation refused" and "the observation
//      crashed" are different facts and only one of them is recordable.

const HOST = hostname();
const LOCK_POLL_MS = 25;
// Normative path component. The lock lives beside the state projections, not in
// the events dir: it guards an OBSERVATION, not an append.
const LOCK_BASENAME = 'acceptance-observe.lock';
const DEFAULT_LOCK_WAIT_MS = 5000;
// Windows transient (AV scan, a concurrent rename touching the parent dir):
// `open('wx')` can EPERM/EACCES briefly with no real permission problem. A
// bounded retry keeps the arbiter honest; a PERSISTENT denial still throws.
const LOCK_EPERM_RETRIES = 20;

// Bodyless-lock grace, verbatim in spirit from append-lock.mjs. A legit holder
// writes its owner record in the VERY NEXT await after `open('wx')`, so a lock
// that stays bodyless for ~2s of consecutive polls means its creator DIED
// between the create and the record write. The window is deliberately long so a
// slow-but-alive holder is never reclaimed.
//
// RESIDUAL, ACCEPTED AND NAMED: on a saturated runner a LIVE holder can be
// descheduled past the grace, get reclaimed, and resume — two observers. Unlike
// the spine funnel, nothing downstream catches that here (an interleaved
// pre/post-hash window is exactly what leaves no recorded difference). Two
// mitigations, both deliberate: the grace is long, and the same RAISE-ONLY env
// knob append-lock ships is honoured under the SAME name, because it is the
// same hazard and an operator on a slow box should not need two. Raising is
// strictly more conservative — it only delays reclaiming a genuinely dead
// holder — so values at or below the default (and garbage) are ignored.
// The structurally sound alternative is worktree-lock.mjs's atomic-publish
// protocol (a published lock is never bodyless, so no age-reclaim is needed);
// adopting it here is a deliberate NON-goal of this phase, recorded rather than
// silently skipped.
const DEFAULT_BODYLESS_GRACE_MS = 80 * LOCK_POLL_MS;
function lockBodylessGraceMs() {
  const raw = Number(process.env.MADDU_LOCK_BODYLESS_GRACE_MS);
  return Number.isFinite(raw) && raw > DEFAULT_BODYLESS_GRACE_MS ? raw : DEFAULT_BODYLESS_GRACE_MS;
}
const LOCK_BODYLESS_GRACE_POLLS = Math.round(lockBodylessGraceMs() / LOCK_POLL_MS);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// true  = alive (or exists-but-not-owned: EPERM) — definitely do NOT steal.
// false = definitely dead (ESRCH) — safe to steal if same-host.
// null  = unknowable (bad pid) — treat as "do not steal", wait instead.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    if (e && e.code === 'EPERM') return true;
    return null;
  }
}

async function readLockRecord(lockPath) {
  try {
    const txt = await readFile(lockPath, 'utf8');
    if (!txt.trim()) return null; // created but body not yet written — retry
    return JSON.parse(txt);
  } catch {
    return null; // missing, or a torn mid-write read — the caller retries
  }
}

// Steal ONLY a same-host, PROVEN-dead holder, and only while the lock is still
// the exact record we read. Never age-steal a lock that HAS a body; never
// cross-host steal at all — a paused-but-live process on a shared or network
// checkout would otherwise be stolen from and legitimately run concurrently.
async function tryStealDeadObserver(lockPath, rec) {
  if (!rec || rec.host !== HOST) return false;
  if (pidAlive(rec.pid) !== false) return false;
  const cur = await readLockRecord(lockPath);
  if (!cur || cur.ownerId !== rec.ownerId) return false; // it changed under us
  try {
    await unlink(lockPath);
    return true;
  } catch {
    return false; // someone else won the unlink; loop and re-open('wx')
  }
}

// Release ONLY our own lock: unlink iff the on-disk `ownerId` still matches
// ours. Codex showed empirically (append-lock.mjs:35-37) that a process here
// CAN unlink a lockfile another process still holds open — so a stale ex-holder
// must never blindly delete what may already be a live replacement's lock.
// Swallows every I/O error by design: a failed release must not mask, or
// replace, whatever `fn` was doing when it ran.
async function releaseAcceptanceLock(lockPath, ownerId) {
  try {
    const cur = await readLockRecord(lockPath);
    if (cur && cur.ownerId === ownerId) {
      try { await unlink(lockPath); } catch { /* already gone */ }
    }
  } catch { /* nothing readable to release */ }
}

// Both roots are REQUIRED here, unlike `requireWorkRoot`, which tolerates an
// absent `stateRoot` because expansion never needs one. This function needs
// both for two different reasons and neither substitutes for the other:
// `stateRoot` decides WHERE the lock lives (and is the whole reason two lanes
// share one), `workRoot` rides the owner record as diagnostics.
function requireRootsPair(roots) {
  const workRoot = requireWorkRoot(roots);
  const { stateRoot } = roots;
  if (typeof stateRoot !== 'string' || !stateRoot.trim()) {
    throw new TypeError('withAcceptanceLock requires roots.stateRoot — attached lane worktrees have distinct work roots and ONE shared state root, so a workRoot-derived lock would give two lanes two different locks and reopen the race this lock exists to close');
  }
  return { workRoot, stateRoot };
}

// Run `fn` while holding the acceptance observation lock.
//
//   { ok:true,  value: <fn's result> }
//   { ok:false, reason:'lock-busy', … }   — `fn` did NOT run
//
// The refusal goes through this module's one `refuse()` shape so a caller never
// has to test which fields exist; `reason` is exactly `'lock-busy'`, which is
// the value a receipt records. The lock path is deliberately NOT echoed into
// the refusal: there is exactly one lock per state root, so naming it buys
// nothing and would put an absolute filesystem path on a recordable field.
export async function withAcceptanceLock(roots, fn, opts = {}) {
  const { workRoot, stateRoot } = requireRootsPair(roots);
  if (typeof fn !== 'function') {
    throw new TypeError('withAcceptanceLock takes the function to run under the lock as its second argument');
  }
  if (!isPlainRecord(opts)) throw new TypeError('withAcceptanceLock options must be a plain record');
  const { maxWaitMs = DEFAULT_LOCK_WAIT_MS } = opts;
  if (typeof maxWaitMs !== 'number' || !Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
    throw new TypeError('maxWaitMs must be a finite positive number of milliseconds — Infinity is refused rather than honoured here, because an observation that waits forever hangs `maddu orient`, and a missed acceptance receipt is recoverable by re-running while a wedged orient is not');
  }

  const stateDir = pathsFor(stateRoot).statePrjDir;
  const lockPath = join(stateDir, LOCK_BASENAME);
  // A missing state dir is created, not worked around: `open('wx')` would ENOENT
  // and that must never be mistaken for "no contention". If this throws, the
  // caller sees the failure — it never becomes an unlocked proceed.
  await mkdir(stateDir, { recursive: true });

  const ownerId = randomBytes(12).toString('hex');
  const body = JSON.stringify({
    ownerId,
    pid: process.pid,
    host: HOST,
    startedAt: new Date().toISOString(),
    // Diagnostics ONLY — never read back, never compared, never a steal input.
    // One lock is shared by every worktree on this state root, so the operator
    // needs to see which checkout is holding it.
    workRoot,
  });

  let waited = 0;
  let nullReads = 0;
  let epermRetries = 0;
  for (;;) {
    let fh = null;
    try {
      fh = await open(lockPath, 'wx'); // O_CREAT | O_EXCL — the atomic arbiter
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES') && ++epermRetries <= LOCK_EPERM_RETRIES) {
        await sleep(LOCK_POLL_MS);
        continue;
      }
      // Anything that is not contention is a real failure and THROWS. It must
      // not degrade into `lock-busy`: "someone else is observing" and "this
      // filesystem is broken" have different remedies, and only the first is
      // an honest thing to put on a receipt.
      if (!e || e.code !== 'EEXIST') throw e;

      const rec = await readLockRecord(lockPath);
      let reclaimed = false;
      if (rec === null) {
        if (++nullReads >= LOCK_BODYLESS_GRACE_POLLS) {
          try { await unlink(lockPath); } catch { /* someone else reclaimed it */ }
          nullReads = 0;
          reclaimed = true;
        }
      } else {
        nullReads = 0;
        reclaimed = await tryStealDeadObserver(lockPath, rec);
      }
      if (!reclaimed) {
        if (waited * LOCK_POLL_MS >= maxWaitMs) {
          return refuse('lock-busy', 'observation-refused', 'another acceptance observation holds the observation lock for this state root — refused rather than run unlocked, because two observations interleaving their pre/post-hash windows leave no recorded difference at all');
        }
        waited++;
        await sleep(LOCK_POLL_MS);
      }
      continue; // re-attempt the O_EXCL create (a single winner is guaranteed)
    }

    try {
      await fh.writeFile(body);
    } finally {
      await fh.close();
    }
    // No fd is held across the critical section — the lock is PRESENCE-based
    // (the file existing IS the lock), which sidesteps the cross-platform
    // "can you delete a file with an open handle" divergence entirely.
    // Ownership is the nonce, never the handle.
    try {
      const value = await fn();
      return { ok: true, value };
    } finally {
      // Every exit path: normal return, `fn` throwing, `fn` rejecting. A throw
      // from `fn` propagates unchanged — the release does not observe it and
      // cannot convert it into a refusal.
      await releaseAcceptanceLock(lockPath, ownerId);
    }
  }
}

// ── phase 2a · runAcceptanceCommand ────────────────────────────────────────
//
// Execute one declared command exactly once and describe what happened, with a
// bounded, canonicalized fingerprint of its output. Settlement discipline is
// lifted from `runDeclared` (verify-replay.mjs:230-311): settles EXACTLY once,
// a universal kill deadline that starts at kill INITIATION, and `taskkill /T /F`
// on win32 so a shell's descendants die with it.
//
// This function NEVER rejects and NEVER hangs. Every outcome is a resolved
// result object. `settled:false` means the kill deadline expired with the child
// not proven dead — recorded honestly rather than waited on.
//
// It also never REFUSES: the return shape has no `ok` discriminant, because a
// process either ran or demonstrably did not, and both are describable. What it
// does do is THROW on a violated API contract, per this module's split. A blank
// command is the sharpest case: blank is a shell no-op that exits 0, so
// accepting one would manufacture `outcome_class:'process-pass'` for a verifier
// that verified nothing. Blankness is refused at DECLARATION by
// `refuseBlankCommand`; reaching this function with one is a caller bug, and
// caller bugs are loud.

const pExecFileAcceptance = promisify(execFile);

const ACCEPTANCE_KILL_SETTLE_MS = 10000;    // universal deadline, from KILL INITIATION
const ACCEPTANCE_TASKKILL_TIMEOUT_MS = 5000; // bound on the taskkill invocation itself
// After the shell exits, allow a short drain window (its own final output
// arrives inside it), then release our pipe ends so 'close' fires even when a
// background DESCENDANT kept them open.
const ACCEPTANCE_DRAIN_MS = 1500;

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
// A line longer than this is split at an exact character offset. Splitting at
// CHUNK boundaries instead would make the fingerprint depend on how the OS
// happened to deliver the pipe, which is not reproducible across two runs of
// the same failure — and a fingerprint that never matches itself silently
// disables the stuck detection it exists to feed.
const MAX_FINGERPRINT_LINE = 65536;
const FINGERPRINT_PREFIX = 'maddu.acceptance-output.sha256.v1\n';

// CSI sequences, OSC strings (bounded, so no unbounded backtracking on a long
// line) and the simple two-character escapes. Under-stripping is deliberate:
// an escape form this misses produces a false DIFFERENCE, which is the safe
// direction — a false MATCH would halt a loop that is still making progress.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]{0,4096}(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// Elapsed times, in the POSITIONS runners actually print them (funnel W1-r2
// #2, narrowed again in W1-r3 #1): a trailing parenthesized or in/took suffix
// (`ok 1 - name (45 ms)`, `failed in 123ms` — runners append elapsed time at
// END of line), a line-leading TAP `duration_ms` field (it gets its own line),
// or a jest summary `Time:` line. This is the ONE class of output that changes
// on every run of an unchanged failure, so collapsing it is what makes the
// fingerprint comparable at all — but a bare or mid-line match also hits
// duration-shaped TEST NAMES (`handles (100ms) timeout`), and collapsing two
// different names hands stuck detection a false MATCH — the unsafe direction.
// Position is the discriminator: runner timings are suffixes or whole fields;
// name text is mid-line.
//
// KNOWN LIMIT, irreducible for a heuristic: a test name that itself ENDS the
// line with a duration (`FAIL waits (100ms)` with no runner suffix after it)
// still collapses against its variant. Every form this misses instead produces
// a false DIFFERENCE, bounded by max-iter: safe.
const TIMING_RE = /(?:\(\s*\d+(?:[.,]\d+)?\s?(?:ms|s)\s*\)|\b(?:in|took)\s+\d+(?:[.,]\d+)?\s?(?:ms|s)\b)\s*$|^\s*duration_ms[:=\s]+\d+(?:[.,]\d+)?\b|^\s*Time:\s+\d+(?:[.,]\d+)?\s?(?:ms|s)\b/g;

function escapeRegExpLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strip the ONE absolute prefix we know is environment-dependent and whose
// remainder is exactly what must survive: `cwd`. `…/repo/test/a.test.js`
// becomes `test/a.test.js`.
//
// GENERIC absolute paths elsewhere in the output are deliberately LEFT INTACT.
// Stripping every absolute prefix would collapse `/a/x/t.js` and `/b/x/t.js`
// into one string, and telling two failures apart by filename is precisely the
// discrimination stuck detection needs. Leaving them is a false difference:
// safe. Case-insensitive on win32 only, where the same directory is routinely
// echoed with a different drive-letter case by different tools.
function cwdPrefixRegExp(cwd) {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const spellings = [...new Set([
    escapeRegExpLiteral(trimmed.split('\\').join('/')),
    escapeRegExpLiteral(trimmed.split('/').join('\\')),
  ])];
  return new RegExp(`(?:${spellings.join('|')})[\\\\/]?`, process.platform === 'win32' ? 'gi' : 'g');
}

function canonicalizeOutputLine(line, cwdRe) {
  let s = line.replace(ANSI_RE, '');
  if (cwdRe) s = s.replace(cwdRe, '');
  return s.replace(TIMING_RE, '<t>');
}

// A rolling, O(1)-memory hasher over one stream. Canonicalization is LINE-wise
// because the transforms are line-shaped: hashing raw chunks would let a chunk
// boundary bisect an ANSI escape or a timing token and change the result for
// output that did not change. `StringDecoder` keeps a multi-byte character from
// being bisected the same way. Nothing is buffered beyond one pending line.
function makeOutputHasher(streamTag, cwdRe) {
  const h = createHash('sha256');
  h.update(Buffer.from(`${FINGERPRINT_PREFIX}${streamTag}\n`, 'utf8'));
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = (line) => h.update(Buffer.from(`${canonicalizeOutputLine(line, cwdRe)}\n`, 'utf8'));
  const drain = () => {
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      emit(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
    while (pending.length >= MAX_FINGERPRINT_LINE) {
      emit(pending.slice(0, MAX_FINGERPRINT_LINE));
      pending = pending.slice(MAX_FINGERPRINT_LINE);
    }
  };
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      drain();
    },
    end() {
      pending += decoder.end();
      drain();
      if (pending.length) emit(pending);
      pending = '';
      return h.digest('hex');
    },
  };
}

// The two streams are hashed SEPARATELY and combined deterministically, rather
// than interleaved into one rolling hash.
//
// DELIBERATE DEVIATION FROM THE PLAN'S WORDING ("rolling sha256 over
// stderr+stdout"), and the reason is that the literal reading does not work:
// the ORDER in which two pipes deliver to one event loop is not reproducible,
// so two runs of an identical failure would fingerprint differently and the
// stuck detection this feeds would never fire. Per-stream hashing preserves
// order WITHIN each stream (which is meaningful) and drops order BETWEEN them
// (which is noise). Both stream digests are domain-tagged, so a stdout-only run
// and a stderr-only run with the same bytes cannot collide.
function combineFingerprints(stdoutDigest, stderrDigest) {
  return createHash('sha256')
    .update(Buffer.from(`${FINGERPRINT_PREFIX}combined\nstdout\n${stdoutDigest}\nstderr\n${stderrDigest}\n`, 'utf8'))
    .digest('hex');
}

// The NORMATIVE outcome table. Exactly three classes, and the order of the
// tests is what makes it fail-closed:
//
//   numeric exit 0                                  → process-pass
//   numeric nonzero exit (INCLUDING 127)            → process-fail
//   timeout / signal death / spawn error / null exit → infra-fail
//
// `timed_out` is tested BEFORE the exit code on purpose: killing a shell can
// still produce a numeric nonzero exit (taskkill does), and a timeout that read
// as `process-fail` would be a valid RED — an acceptance proof manufactured out
// of a hung machine.
//
// EXIT 127 CLASSIFYING AS process-fail IS CORRECT AND DELIBERATE, not an
// oversight to be special-cased later. An unresolvable interpreter yields a
// perfectly valid RED, indistinguishable from a real one. It is a documented
// hole in what a process-level proof can claim — see the first entry of
// ACCEPTANCE_HONEST_LIMITS — and it gets DOCUMENTED, never patched. A
// special case here would classify some genuine nonzero exits as infra and
// silently shrink what can be proven.
function classifyAcceptanceOutcome({ exit, signal, timed_out, spawn_error, settled }) {
  if (spawn_error) return 'infra-fail';
  if (timed_out || settled === false) return 'infra-fail';
  if (signal !== null) return 'infra-fail';
  if (!Number.isInteger(exit)) return 'infra-fail';
  return exit === 0 ? 'process-pass' : 'process-fail';
}

// Run one declared command.
//
//   runAcceptanceCommand({ command, cwd, timeoutMs, maxOutputBytes? })
//     -> { exit, signal, timed_out, spawn_error, settled, duration_ms,
//          outcome_class, fingerprint, fingerprintTruncated }
//
// The snake_case keys are the RECEIPT's field names (`observationFrom` reads
// `d.timed_out`, `d.spawn_error`, `d.duration_ms`, `d.outcome_class`), so phase
// 2b can spread this result onto a receipt without a rename layer that could
// drop a field. `spawn_error` is therefore a BOOLEAN, not the error message:
// the receipt field is read as `d.spawn_error === true`, and a string spread
// onto it would read back as "no spawn error" — an honest infra failure
// rendered as a clean run. The message is dropped rather than mistyped.
//
// OUTPUT IS CAPTURED, NEVER FORWARDED. Nothing is written to this process's
// stdout or stderr. Whether an operator watching a loop should still SEE the
// command's output is a wiring decision, and wiring is phase 2b.
export function runAcceptanceCommand(args = {}) {
  if (!isPlainRecord(args)) throw new TypeError('runAcceptanceCommand takes a plain options record');
  const { command, cwd, timeoutMs, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = args;
  if (typeof command !== 'string' || !command.trim()) {
    throw new TypeError('command must be a non-blank string — a blank command is a shell no-op that exits 0, which would manufacture a process-pass for a verifier that verified nothing; blankness is refused at declaration by refuseBlankCommand, so reaching here with one is a caller bug');
  }
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new TypeError('cwd must be a non-blank path — an unset cwd would inherit this process\'s directory and run the declared command somewhere the declaration never named');
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a finite positive number of milliseconds — an absent or infinite execution deadline is how an observation hangs forever holding the observation lock');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError('maxOutputBytes must be a positive safe integer');
  }

  const cwdRe = cwdPrefixRegExp(cwd);

  return new Promise((resolvePromise) => {
    const startedAt = process.hrtime.bigint();
    const timers = [];
    let done = false;
    let child = null;

    const outHasher = makeOutputHasher('stdout', cwdRe);
    const errHasher = makeOutputHasher('stderr', cwdRe);
    let outputBytes = 0;
    let truncated = false;

    // BOTH STREAMS ARE DRAINED CONTINUOUSLY, CAP OR NO CAP. A child that fills
    // a pipe nobody reads blocks forever, and the execution timeout would then
    // be the only thing that ever ended the run. Past the cap we stop HASHING;
    // we never stop READING. Bytes are counted RAW, before canonicalization,
    // so the bound is on what the child actually produced.
    const feed = (hasher, chunk) => {
      if (done || truncated) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        truncated = true;
        return;
      }
      hasher.push(chunk);
    };

    // A background DESCENDANT can inherit the piped stdio and hold it open
    // after the shell itself exits — 'close' then never fires. Destroying our
    // read ends (and unref'ing) is what lets settlement actually settle.
    const releaseChild = () => {
      if (!child) return;
      try { if (child.stdout) child.stdout.destroy(); } catch {}
      try { if (child.stderr) child.stderr.destroy(); } catch {}
      try { child.unref(); } catch {}
    };

    const settle = (o) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      releaseChild();
      const stdoutDigest = outHasher.end();
      const stderrDigest = errHasher.end();
      resolvePromise({
        exit: o.exit,
        signal: o.signal,
        timed_out: o.timed_out,
        spawn_error: o.spawn_error,
        settled: o.settled,
        duration_ms: Number((process.hrtime.bigint() - startedAt) / 1000000n),
        outcome_class: classifyAcceptanceOutcome(o),
        // TRUNCATED ⇒ NULL, never a digest of the first megabyte. Two different
        // failures sharing a long identical prefix would hash identically, and
        // a false stuck-halt on a loop that is still making progress is worse
        // than no stuck detection at all. The caller disables the check.
        fingerprint: truncated ? null : combineFingerprints(stdoutDigest, stderrDigest),
        fingerprintTruncated: truncated,
      });
    };

    let timedOut = false;
    let exitCode;
    let exitSignal = null;
    let execTimer = null;

    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env: process.env,
        // stdin is IGNORED, never inherited: a declared command that blocks on
        // a prompt would otherwise hang until the deadline and record an
        // infra-fail for a question nobody was there to answer.
        stdio: ['ignore', 'pipe', 'pipe'],
        // A process group on POSIX so the timeout can kill the shell's whole
        // descendant tree, matching what `taskkill /T` does on win32.
        detached: process.platform !== 'win32',
      });
    } catch {
      settle({ exit: null, signal: null, timed_out: false, spawn_error: true, settled: true });
      return;
    }

    if (child.stdout) {
      child.stdout.on('data', (c) => feed(outHasher, c));
      child.stdout.on('error', () => { /* destroy() during settlement */ });
    }
    if (child.stderr) {
      child.stderr.on('data', (c) => feed(errHasher, c));
      child.stderr.on('error', () => { /* destroy() during settlement */ });
    }

    child.on('error', () => settle({ exit: null, signal: null, timed_out: timedOut, spawn_error: true, settled: true }));

    // 'exit' = the shell died (code known); 'close' additionally waits for
    // stdio to drain — which a lingering DESCENDANT can hold open forever.
    // 'close' stays the settle point, so late output is still fingerprinted.
    // The execution timeout DISARMS here: the shell has exited, so a drain
    // window straddling the deadline must not relabel a finished run as timed
    // out — that would turn a real RED or GREEN into an infra-fail.
    child.on('exit', (code, sig) => {
      exitCode = code;
      exitSignal = sig || null;
      if (execTimer) clearTimeout(execTimer);
      timers.push(setTimeout(releaseChild, ACCEPTANCE_DRAIN_MS));
    });
    child.on('close', (code, sig) => settle({
      exit: code ?? exitCode ?? null,
      signal: sig || exitSignal,
      timed_out: timedOut,
      spawn_error: false,
      settled: true,
    }));

    execTimer = setTimeout(() => {
      timedOut = true;
      // The universal settlement deadline starts AT KILL INITIATION — a stalled
      // taskkill (itself bounded below) can never postpone it.
      timers.push(setTimeout(() => settle({
        exit: null, signal: null, timed_out: true, spawn_error: false, settled: false,
      }), ACCEPTANCE_KILL_SETTLE_MS));
      (async () => {
        try {
          if (process.platform === 'win32') {
            await pExecFileAcceptance('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: ACCEPTANCE_TASKKILL_TIMEOUT_MS });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          // taskkill error/timeout (including the benign already-exited race) —
          // fall back to a direct kill; the deadline above still governs.
          try { child.kill('SIGKILL'); } catch {}
        }
      })();
    }, timeoutMs);
    timers.push(execTimer);
  });
}

