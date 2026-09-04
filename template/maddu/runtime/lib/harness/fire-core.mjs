// harness/fire-core.mjs — the hook-FIRING core, shared by every harness adapter.
//
// Extracted verbatim from commands/hooks.mjs in Track A PR2. The CLI file keeps
// what is Claude-specific operator surface (`hooks install|status|remove`, the
// guardrail ownership side-state, the help text); everything that RUNS when a
// harness fires a hook lives here, so the Codex / Hermes / OpenHands adapters
// (PR3-PR5) share one implementation instead of copying it.
//
// WHY A FACTORY WITH INJECTED DEPENDENCIES
// No module under runtime/lib/ may import from commands/. The two ship as
// siblings in a consumer install (maddu/commands/, maddu/runtime/lib/) but not
// in the framework source checkout, where commands/ sits at the repo root and
// this file lives under template/maddu/ — so any relative path back into
// commands/ resolves in exactly one of the two layouts. That is the defect
// scripts/test/command-import-layout.mjs exists for (`maddu sources` was dead in
// every install from v1.106.0 to v1.125.0), and .maddu/config/architecture.json
// encodes it as `{ from: "runtime-libs", allow: [] }`. The caller therefore
// hands in its own resolvers.
//
// WHAT THE CALLER MUST KNOW
// These handlers END THE PROCESS. Each arm is its own fail-open containment and
// exits 0 on every path — a hook may never fail the tool call, the compaction or
// the session boundary it observes. `fire()` does not return.
//
// Behavior is locked by scripts/test/harness-hook-core.mjs, which drives the
// installed CLI and knows nothing about this file — so the move was free to
// relocate any of it, and the lock still means the same thing.

import { join, basename } from 'node:path';
import { appendFile } from 'node:fs/promises';

// deps: { loadSpineLib, resolveRepoRoot, resolveParentId, loadLib,
//         loadLibOptional, registerCmd } — supplied by commands/hooks.mjs.
export function createHookFireCore(deps) {
  const {
    loadSpineLib, resolveRepoRoot, resolveParentId, loadLib, loadLibOptional, registerCmd,
  } = deps || {};

  // Run another command's default export while swallowing its stdout, so a hook's
  // own stdout stays clean (Claude Code parses SessionStart stdout as context).
  async function quietly(fn) {
    const realLog = console.log;
    console.log = () => {};
    try { return await fn(); }
    finally { console.log = realLog; }
  }

  // audit P2 (C6b) — witness a discipline bypass / fail-open on the spine. This is
  // the SEAM that keeps `discipline.mjs` a spine-less leaf: the leaf classifies and
  // decides, and emitting the witness lives HERE where `loadSpineLib` is in scope.
  // Best-effort — a witness failure NEVER blocks the tool. Latched reasons
  // (enforcement-off / err:<sig>) emit ~once per session-episode and re-emit after a
  // healthy eval clears the latch (discipline.enforcePreTool); a self-disable ATTEMPT
  // is NEVER latched (each is a distinct incident). The latch is set ONLY after a
  // successful append, so an append failure retries next time (F6).
  async function witnessDiscipline(repoRoot, disc, { decision, tool, sid, counterKey }) {
    try {
      const enf = decision.enforcement, kind = decision.kind, action = decision.action;
      let type = null, data = null, latchKey = null;
      // A self-disable ATTEMPT is checked FIRST (a per-incident witness, never latched)
      // so it isn't swallowed by the latched enforcement-off branch when both hold.
      if (kind === 'self-disable' && (action === 'witness-allow' || action === 'block')) {
        type = 'DISCIPLINE_SKIPPED';
        data = { reason: 'self-disable-attempt', tool: tool || null, sessionId: sid || null, enforcement: enf || null, blocked: action === 'block' };
      } else if (enf === 'error') {
        const sig = decision.errorSig || 'unknown';
        type = 'ENFORCEMENT_ERROR'; latchKey = `err:${sig}`;
        data = { reason: sig, tool: tool || null, sessionId: sid || null };
      } else if (enf === 'off' && decision.mutating) {
        type = 'DISCIPLINE_SKIPPED'; latchKey = 'enforcement-off';
        data = { reason: 'enforcement-off', tool: tool || null, sessionId: sid || null, enforcement: 'off' };
      } else return; // nothing to witness

      if (latchKey && counterKey && disc?.readCounter) {
        const c = await disc.readCounter(repoRoot, counterKey);
        if (c?.skipLatch?.[latchKey]) return; // already witnessed this episode
      }
      const { spine } = await loadSpineLib();
      await spine.append(repoRoot, { type: spine.EVENT_TYPES[type], actor: data.sessionId, data });
      // Set the latch ONLY after a successful append (an append failure retries).
      // Routed through the LOCKED mutator (v1.111.0) so a parallel gate's RMW
      // can't be clobbered; a witness-created counter carries no baselineInit
      // marker, so baseline initialization still fires at the first gate call.
      if (latchKey && counterKey && disc?.mutateCounter) {
        await disc.mutateCounter(repoRoot, counterKey, (c) => {
          c.skipLatch = { ...(c.skipLatch || {}), [latchKey]: true };
          return c;
        });
      } else if (latchKey && counterKey && disc?.readCounter && disc?.writeCounter) {
        const c = (await disc.readCounter(repoRoot, counterKey)) || {};
        c.skipLatch = { ...(c.skipLatch || {}), [latchKey]: true };
        await disc.writeCounter(repoRoot, counterKey, c);
      }
    } catch { /* witness is best-effort — never block the tool */ }
  }

  // ── The hook-fire handlers (v1.111.0) ───────────────────────────────────────
  // EVERY fire event performs its OWN bootstrap inside its OWN fail-open
  // containment — the shared bootstrap used to run before dispatch, so a
  // bootstrap failure could exit nonzero and block an edit or compaction.
  // Any error → exit 0 with the event's legal output (or nothing).
  //
  // Test seam: MADDU_HOOK_TEST_THROW=bootstrap|handler throws at the named
  // stage — PRODUCTION-GATED on MADDU_SELF_TEST === '1' (an inherited env
  // value must never silently disable enforcement via the fail-open path).
  function seamThrow(stage) {
    if (process.env.MADDU_SELF_TEST === '1' && process.env.MADDU_HOOK_TEST_THROW === stage) {
      throw new Error(`hook test seam: ${stage}`);
    }
  }

  async function readHookPayload() {
    // Claude Code pipes the hook payload on stdin; a human at a terminal has a
    // TTY there — skip reading to avoid blocking on interactive stdin.
    if (process.stdin.isTTY) return {};
    let raw = '';
    try { for await (const chunk of process.stdin) raw += chunk; } catch { return {}; }
    try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; }
  }

  // The WORK root for dirty observation: the hook payload's cwd (falling back
  // to process.cwd()) resolved through the worktree-aware root resolver — an
  // attached lane worktree must be observed as ITSELF, not as the primary
  // checkout the state root names. FAILURE DIRECTION: an unresolvable work
  // root returns NULL, which downstream reads as observed:false (unknown, no
  // commit pressure) — falling back to the primary checkout could baseline or
  // gate a worktree session against the WRONG repo's dirt.
  async function resolveWorkRootFrom(paths, payloadCwd, repoRoot) {
    if (!paths || typeof paths.resolveRoots !== 'function') return null;
    const { resolve } = await import('node:path');
    const norm = (p) => {
      const r = resolve(String(p));
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    for (const cwd of [payloadCwd, process.cwd()]) {
      if (typeof cwd !== 'string' || !cwd) continue;
      // Per-candidate containment: a throwing payload-cwd resolution must not
      // abort the process.cwd() attempt.
      try {
        const roots = await paths.resolveRoots(cwd);
        if (!roots || !roots.workRoot) continue;
        // The candidate must belong to THIS repo's state root — a cwd inside
        // ANOTHER Máddu repo would measure that repo's dirt while mutating
        // this repo's counters (and could reset a baseline via domainChanged).
        // A foreign candidate falls through; no in-repo candidate → null
        // (observed:false), never a cross-repo measurement.
        if (roots.stateRoot && norm(roots.stateRoot) !== norm(repoRoot)) continue;
        return roots.workRoot;
      } catch { /* try the next candidate */ }
    }
    return null;
  }

  // Declared-excuse helper for fire arms' append-free exits (containment,
  // graceful skips). Fail-open: never blocks a hook.
  async function hookFireNoop(reason) {
    try {
      (await loadLibOptional('mutation-witness.mjs'))?.witnessNoop?.(reason);
    } catch {}
  }

  // PreToolUse recovery mint (B1/B2). The caller carries a validated Claude
  // session id but has NO live Máddu session: its SessionStart binding points at
  // a session someone else's SessionEnd already closed, or the sid it inherited
  // through the environment is dead. The only sound recovery is to MINT a fresh
  // session bound to this claude id — ADOPTING an existing one (the active-session
  // cache, the newest live session) was rejected as unsound (audit P2 F11),
  // because it lets an unbound caller record its work under another agent's
  // identity.
  //
  // FAIL-SOFT in every direction: a helper missing from an older installed
  // runtime, a busy lock, or any throw returns null and the caller degrades to
  // the pre-fix resolution. A mint must never be why a tool call is blocked.
  async function mintFreshBoundSession(repoRoot, {
    claudeId, workRoot, disc, spine, projections, sessionLifecycle, sessionActive,
  }) {
    try {
      // Version skew: without the FULL register+bind transaction, a mint would
      // be unbound or unrecorded — both worse than no mint — so refuse outright
      // rather than half-perform it.
      if (!claudeId || !disc || !spine || !sessionLifecycle) return null;
      if (typeof disc.withBindingTransaction !== 'function') return null;
      if (typeof disc.bindClaudeSessionIn !== 'function') return null;
      if (typeof sessionLifecycle.registerSessionUniqueIn !== 'function') return null;
      if (typeof sessionLifecycle.withCloseLock !== 'function') return null;
      if (typeof sessionLifecycle.isLockFailed !== 'function') return null;
      if (!spine.EVENT_TYPES || !spine.EVENT_TYPES.SESSION_AUTO_REGISTERED) return null;
      // The under-lock revalidation below needs BOTH of these; without them the
      // no-live decision could never be rechecked and concurrent callers would
      // double-mint (r1 F1).
      if (typeof disc.resolveMadduSession !== 'function') return null;
      if (!projections || typeof projections.project !== 'function') return null;
      // Bind-before-register (r6 F1) mints the id HERE rather than letting the
      // registrar generate one, so the same generator must be reachable.
      if (typeof spine.genSessionId !== 'function') return null;

      const refOk = spine.isRefId || ((v) => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v));
      const label = basename(repoRoot) || 'agent';
      // CP5 (PR-B) applies here as at SessionStart: an ambient parent is
      // grammar-gated + existence-checked, and an unusable one drops the LINK,
      // never the mint.
      let parentEnv = null;
      try { parentEnv = await resolveParentId(repoRoot, null, { projections }); }
      catch { parentEnv = null; }
      const makeEvent = (sessionId) => ({
        type: spine.EVENT_TYPES.SESSION_AUTO_REGISTERED,
        actor: sessionId,
        lane: null,
        data: {
          sessionId,
          parentSessionId: parentEnv,
          // Provenance marker (SessionStart writes 'cli'): a recovery mint stays
          // distinguishable on the spine, so a RUN of them reads as the
          // lifecycle defect it compensates for and not as normal traffic.
          source: 'pretooluse-mint',
          label,
          role: 'implementer',
        },
      });

      // Observe the dirty tree BEFORE the transaction (r1 F4). Captured after
      // the mint, the baseline would swallow an edit made by a parallel caller
      // that resolved the new binding in the meantime — silently erasing that
      // edit's commit pressure. A pre-transaction snapshot fails the other way:
      // a racing edit lands OUTSIDE the baseline and counts as new dirt, which
      // is the safe direction. Best-effort; a failed observation leaves the
      // counter unwritten and the first gate call seeds baselineInit fail-open.
      let baseObs = null;
      try {
        if (disc.mutateCounter && disc.dirtyFilesDetailed && workRoot) {
          const obs = await disc.dirtyFilesDetailed(workRoot);
          if (obs && obs.ok) baseObs = obs;
        }
      } catch { baseObs = null; }

      // Test seam (session-mint.mjs concurrency case): hold between the no-live
      // decision and the transaction so a racing second caller provably reaches
      // the same decision before either takes the lock — the under-lock
      // revalidation is then the ONLY thing standing between this race and a
      // double-mint. PRODUCTION-GATED on MADDU_SELF_TEST === '1', exactly like
      // seamThrow: a test-injection switch must be DOUBLY opted in so an ambient
      // value can never alter production behavior — an inherited
      // MADDU_TEST_MINT_HOLD_MS would otherwise delay every real recovery mint
      // by up to the cap, on top of whatever the locks already cost. The cap is
      // the second bound, not the first.
      //
      // The marker line is the seam's EVIDENCE. Child wall-clock cannot prove a
      // rendezvous happened — a CPU-starved child that never raced still reports
      // a long runtime — so each racer records that it entered the hold from
      // INSIDE the hold, which is reachable only after deciding to mint on
      // observed-dead state. Counting markers is how the suite knows both
      // callers made that decision before either took the lock; a missing marker
      // means rendezvous-not-achieved, not a passing test.
      if (process.env.MADDU_SELF_TEST === '1') {
        const holdMs = Number(process.env.MADDU_TEST_MINT_HOLD_MS || 0);
        if (Number.isFinite(holdMs) && holdMs > 0) {
          try {
            await appendFile(
              join(repoRoot, '.maddu', 'state', 'test-mint-hold.ndjson'),
              JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n');
          } catch { /* evidence must never break the mint it observes */ }
          await new Promise((r) => setTimeout(r, Math.min(holdMs, 5000)));
        }
      }

      // OPTIMIZATION only (r5 F1, demoted by r6 F1): skip the lock churn when
      // the map is already visibly corrupt. The append-free GUARANTEE comes from
      // the bind-before-register order inside the transaction, not from here —
      // this probe proves the map is READABLE and can say nothing about whether
      // it is writable, so a valid-but-read-only map sails through it. Nothing
      // downstream may rely on it having run: an older installed lib without the
      // probe takes the same path, just after paying for the locks.
      if (typeof disc.bindingMapHealthy === 'function' && !(await disc.bindingMapHealthy(repoRoot))) {
        return null;
      }

      // Prove-writable + register + bind as ONE transaction, holding the same
      // two locks fireSessionStart does: the bind commits while the close lock
      // still protects the liveness proof, so no interleaved close can kill the
      // sid in the gap.
      const bt = await disc.withBindingTransaction(repoRoot, async () =>
        sessionLifecycle.withCloseLock(repoRoot, async () => {
          // Revalidate the no-live decision UNDER the lock (r1 F1). The caller
          // decided to mint before taking either lock, so two concurrent
          // PreToolUse calls for the same claude id would both register and the
          // second bind would overwrite the first — orphaning a live session.
          // Re-reading OUR OWN binding is not adoption (F11 still holds): if a
          // concurrent mint or a SessionStart already healed this claude id, the
          // sid we find is the one this caller is entitled to. A throw here
          // (unreadable bindings map or projection) propagates to the outer
          // catch → null, matching the rule that an unobservable state never
          // mints.
          // The live set is read ONCE and answers two questions: is our own
          // binding already healed, and is a candidate id free. Both locks are
          // held and every registration path takes the close lock, so no session
          // can become active between this read and the register below.
          const now = await projections.project(repoRoot);
          const live = Array.isArray(now.activeSessions) ? now.activeSessions : [];
          const prior = await disc.resolveMadduSession(repoRoot, claudeId);
          if (refOk(prior) && live.some((s) => s && s.id === prior)) {
            return { sid: prior, created: false };
          }
          // ORDER: prove writable → register → bind (r8). Three invariants, in
          // priority order:
          //   1. NEVER publish a binding to a session that does not exist. The
          //      binding is visible to lock-free resolvers the instant it lands,
          //      and pre-compact resolves bindings WITHOUT a liveness check — a
          //      binding to a never-registered session makes it append a
          //      checkpoint attributed to a session that never existed, false
          //      forever on an append-only spine. So the bind goes LAST.
          //   2. NEVER append before the map has proven writable. The append
          //      cannot be taken back; the bind that follows it can still fail.
          //      Readability says nothing about this, so the proof performs a
          //      real write of the map's own content, publishing nothing.
          //   3. The single bind IS the completion stamp, and it is the LAST
          //      mutating act in the transaction, so boundAt dates as close to
          //      release as this design can get — which is what the SessionEnd
          //      <10s freshness guard needs. No re-stamp, nothing to fail
          //      silently.
          // Crash windows are now benign in one direction only: dying before the
          // bind leaves a registered-but-unbound session, which is truthful on
          // the spine and sweepable by the janitor.
          // Skew: the self-heal REFUSES to run on a runtime that does not ship
          // the proof. Falling through would resurrect the storm this whole
          // ordering exists to prevent — on an unwritable-but-valid map every
          // call would register and roll back, permanently, one pair at a time.
          // An older install therefore keeps exactly today's behavior (session
          // deny plus its recovery remedy — no regression, no storm), and
          // `maddu upgrade` restores the mint.
          if (typeof disc.bindingMapWritableIn !== 'function') return null;
          if (!(await disc.bindingMapWritableIn(repoRoot, claudeId))) return null;
          // Draw until an id is free. The cheap pre-check skips ids that clash
          // with a LIVE session; the registrar checks against ALL history, so a
          // same-second collision with a CLOSED session comes back as 'exists'
          // and must be redrawn rather than abandoned (r8 F3). Nothing has been
          // published at this point, so a retry costs nothing. Bounded at three
          // draws — a persistent clash means something is wrong, not busy.
          let sid = null, reg = null;
          for (let attempt = 0; attempt < 3 && !sid; attempt++) {
            const cand = spine.genSessionId();
            if (live.some((s) => s && s.id === cand)) continue;
            const r = await sessionLifecycle.registerSessionUniqueIn(repoRoot, { id: cand, makeEvent });
            if (r.status === 'registered') { sid = cand; reg = r; break; }
            if (r.status === 'exists') continue;   // historical collision → redraw
            return null;                           // invalid-id / spine-corrupt / unknown
          }
          if (!sid) return null;
          // Cache the active session BEFORE the bind (r9 F3) so the bind is the
          // transaction's last mutating act and boundAt is not aged by whatever
          // follows it. A cache entry for a registered-but-not-yet-bound session
          // is harmless: nothing resolves IDENTITY from this file — the
          // no-cache-fallback rule (audit P2 F11) is exactly what makes ordering
          // it first safe.
          if (sessionActive && sessionActive.writeActiveSession) {
            await sessionActive.writeActiveSession(repoRoot, {
              sessionId: sid,
              registeredAt: reg.event ? reg.event.ts : null,
              role: 'implementer',
              label,
              lane: null,
            });
          }
          // The completion stamp. A false here means the map turned unwritable
          // between the proof and now — rare, and bounded to ONE rollback pair
          // because the NEXT call fails at the proof above and appends nothing.
          // Roll the registration back so the spine does not carry a session no
          // caller can reach (In-variant: both locks are still held).
          // Accepted residual: a stall INSIDE this single-file write still ages
          // boundAt. That is within the SessionEnd guard's documented
          // deliberately-fail-open heuristic — I/O pathological enough to stall
          // this write would stall the guard's own read of the same file.
          const bound = await disc.bindClaudeSessionIn(repoRoot, claudeId, sid);
          if (bound === false) {
            try {
              if (typeof sessionLifecycle.closeSessionIfActiveIn === 'function'
                  && spine.EVENT_TYPES.SESSION_CLOSED) {
                await sessionLifecycle.closeSessionIfActiveIn(repoRoot, {
                  sessionId: sid,
                  eventType: spine.EVENT_TYPES.SESSION_CLOSED,
                  data: { handoff: { summary: 'recovery mint rolled back: binding became unwritable after the write proof', auto: true } },
                });
              }
            } catch { /* rollback is best-effort — the janitor sweeps the leak */ }
            return null;
          }
          return { sid, created: true };
        }));
      // Either lock busy → null. Deliberately NOT fireSessionStart's
      // register-WITHOUT-binding fallback: an unbound mint leaves the caller
      // still unbound, so the next tool call mints again — a session storm, one
      // per call, for as long as the lock stays hot. Letting legacy behavior
      // stand for this single call is the far cheaper failure.
      if (sessionLifecycle.isLockFailed(bt)) return null;
      if (disc.isBindingLockFailed && disc.isBindingLockFailed(bt)) return null;
      if (!bt || typeof bt.sid !== 'string' || !bt.sid) return null;

      // Seed the discipline baseline exactly as fireSessionStart's CREATED path
      // does — and only on a created mint: a reused sid already carries its own
      // accumulated history, and re-baselining would erase its commit pressure.
      // Without this a fresh sid inherits the whole pre-existing dirty tree as
      // its OWN new dirt, and the commit gate could block the very call this
      // mint just unblocked.
      try {
        if (bt.created && baseObs && disc.mutateCounter) {
          await disc.mutateCounter(repoRoot, bt.sid, (c) => {
            c.dirtyBaseline = baseObs.paths.slice();
            c.dirtyFirstSeen = [];
            c.firstDirtyTs = null;
            c.baselineInit = true;
            c.workRoot = workRoot;
            c.dirtyV = 2;
            return c;
          });
        }
      } catch { /* baseline capture is best-effort */ }
      return bt.sid;
    } catch { return null; /* never throw into the gate */ }
  }

  async function fireSessionStart() {
    let note = 'Máddu session discipline active. Run `maddu register`, claim a lane, and `maddu slice-stop` at each slice boundary.';
    // Hoisted so the post-containment verdict below can see whether a session
    // append actually happened on this run.
    let sidOut = null;
    try {
      seamThrow('bootstrap');
      const { paths, spine, projections, sessionActive, sessionLifecycle } = await loadSpineLib();
      const repoRoot = await resolveRepoRoot(paths);
      const disc = await loadLib('discipline.mjs');
      seamThrow('handler');
      // Payload FIRST — the claude id + cwd inform everything downstream.
      const payload = await readHookPayload();
      const isRefId = spine.isRefId || (() => false);
      const isSid = spine.isSid || (() => false);
      const isClaudeId = spine.isClaudeId || (() => false);
      // CP2 (PR-B): gate the claude session id at the boundary — a malformed id
      // never reaches a binding-map key (the map helpers also self-guard).
      // Malformed → null → the register-without-binding path.
      const claudeId = isClaudeId(payload.session_id) ? payload.session_id : null;
      const workRoot = await resolveWorkRootFrom(paths, payload.cwd, repoRoot);
      const label = basename(repoRoot) || 'agent';
      // Parent forwarded VERBATIM as on main — parent validation is PR-B's.
      // CP5 (PR-B): ambient MADDU_PARENT_SESSION_ID — grammar-gated + existence
      // checked (malformed / nonexistent → dropped to null; verify is the backstop).
      const parentEnv = await resolveParentId(repoRoot, null, { projections });
      const makeEvent = (sessionId) => ({
        type: spine.EVENT_TYPES.SESSION_AUTO_REGISTERED,
        actor: sessionId,
        lane: null,
        data: {
          sessionId,
          parentSessionId: parentEnv,
          source: 'cli',
          label,
          role: 'implementer',
        },
      });

      // Register + idempotency validation + bind as ONE transaction:
      // withBindingTransaction { withCloseLock { renewIn-or-registerIn +
      // bindIn } }. The bind commits while the close lock still protects the
      // liveness proof, so a close-lock-only caller can never close the sid in
      // the gap. Fallbacks: binding lock busy → register WITHOUT binding
      // (main's best-effort shape; restart heals the binding); close lock busy
      // → registerSessionUnique's own unlocked-generated fallback (a fresh id
      // cannot be the target of a racing close). A SessionStart is never lost
      // to a busy lock.
      let sid = null, created = false;
      if (disc && sessionLifecycle && disc.withBindingTransaction) {
        const envId = process.env.MADDU_SESSION_ID;
        const registerAndBindUnlockedClose = async () => {
          const reg = await sessionLifecycle.registerSessionUnique(repoRoot, { makeEvent });
          if (reg.status !== 'registered') return { sid: null, created: false };
          if (claudeId) await disc.bindClaudeSessionIn(repoRoot, claudeId, reg.sessionId);
          if (sessionActive) await sessionActive.writeActiveSession(repoRoot, { sessionId: reg.sessionId, registeredAt: reg.event ? reg.event.ts : null, role: 'implementer', label, lane: null });
          return { sid: reg.sessionId, created: true };
        };
        const bt = await disc.withBindingTransaction(repoRoot, async () => {
          const inner = await sessionLifecycle.withCloseLock(repoRoot, async () => {
            if (isRefId(envId)) {
              const renewal = await sessionLifecycle.renewSessionIfActiveIn(repoRoot, { sessionId: envId, focus: 'continuation (SessionStart)' });
              if (renewal.status === 'renewed') {
                if (claudeId) await disc.bindClaudeSessionIn(repoRoot, claudeId, envId);
                if (sessionActive && sessionActive.writeActiveSessionIfAbsent) {
                  await sessionActive.writeActiveSessionIfAbsent(repoRoot, { sessionId: envId, registeredAt: renewal.event ? renewal.event.ts : null, role: 'implementer', label, lane: null });
                }
                return { sid: envId, created: false };
              }
              // not-active / spine-corrupt → fresh registration below.
            }
            const reg = await sessionLifecycle.registerSessionUniqueIn(repoRoot, { makeEvent });
            if (reg.status !== 'registered') return { sid: null, created: false };
            if (claudeId) await disc.bindClaudeSessionIn(repoRoot, claudeId, reg.sessionId);
            if (sessionActive) await sessionActive.writeActiveSession(repoRoot, { sessionId: reg.sessionId, registeredAt: reg.event ? reg.event.ts : null, role: 'implementer', label, lane: null });
            return { sid: reg.sessionId, created: true };
          });
          if (sessionLifecycle.isLockFailed(inner)) return registerAndBindUnlockedClose();
          return inner;
        });
        if (disc.isBindingLockFailed && disc.isBindingLockFailed(bt)) {
          // Binding lock busy: register close-locked WITHOUT binding.
          const reg = await sessionLifecycle.registerSessionUnique(repoRoot, { makeEvent });
          if (reg.status === 'registered') {
            sid = reg.sessionId; created = true;
            if (sessionActive) await sessionActive.writeActiveSession(repoRoot, { sessionId: sid, registeredAt: reg.event ? reg.event.ts : null, role: 'implementer', label, lane: null });
          }
        } else if (bt && bt.sid) { sid = bt.sid; created = bt.created; }
      } else {
        // Legacy fallback: the register command (returns {sessionId, created}
        // as of v1.111.0; tolerate the old bare-string shape too).
        const r = await quietly(() => registerCmd([]));
        sid = (r && typeof r === 'object') ? r.sessionId : (typeof r === 'string' ? r : null);
        created = !!(r && typeof r === 'object' && r.created);
        if (claudeId && disc && sid) await disc.bindClaudeSession(repoRoot, claudeId, sid);
      }

      // Opportunistic stale-session sweep. The bridge janitor only runs when
      // the cockpit is open; on a CLI-first workstation stale sessions never
      // auto-close. Best-effort + silent (stdout is parsed as context).
      try {
        const jan = await loadLib('janitor.mjs');
        if (jan && jan.reconcileStale) await jan.reconcileStale(repoRoot, projections);
      } catch { /* sweep is best-effort */ }

      // Baseline capture is CREATE-ONLY (a continuation reusing a pinned sid
      // must not re-baseline its accumulated history away), via the locked
      // mutator, observing the WORK root; a failed observation skips (the
      // baselineInit marker rule seeds fail-open at the first gate call).
      let disciplineLine = '';
      try {
        if (disc && sid) {
          if (created && disc.mutateCounter && disc.dirtyFilesDetailed) {
            const obs = await disc.dirtyFilesDetailed(workRoot);
            if (obs.ok) {
              await disc.mutateCounter(repoRoot, sid, (c) => {
                c.dirtyBaseline = obs.paths.slice();
                c.dirtyFirstSeen = [];
                c.firstDirtyTs = null;
                c.baselineInit = true;
                c.workRoot = workRoot;
                c.dirtyV = 2;
                return c;
              });
            }
          }
          const counter = await disc.readCounter(repoRoot, sid);
          const st = await disc.gatherRitualState(repoRoot, sid, Date.now(), counter, { workRoot });
          const gaps = [];
          if (!st.goalOrPlan?.active) gaps.push('no goal or open plan');
          if (!st.lane?.claimed) gaps.push('no lane claimed');
          if (gaps.length) disciplineLine = ` Máddu discipline: ${gaps.join('; ')} — declare/claim before editing (enforcement may block otherwise).`;
        }
      } catch { /* discipline context is best-effort */ }

      // Opportunistic env pinning (best-effort, never load-bearing — Claude
      // Code's CLAUDE_ENV_FILE injection is documented-but-unreliable). The
      // export line is written ONLY for strict-grammar sids: session ids can
      // be caller input, and a quote/newline inside single quotes yields
      // malformed or injectable shell. Non-conforming → skip, no escaping.
      const sidShellSafe = isSid(sid);
      try {
        if (sid && sidShellSafe && typeof process.env.CLAUDE_ENV_FILE === 'string' && process.env.CLAUDE_ENV_FILE) {
          await appendFile(process.env.CLAUDE_ENV_FILE, `export MADDU_SESSION_ID='${sid}'\n`);
        }
      } catch { /* pinning is best-effort */ }

      // Concurrent-session clause: with two live sessions, `--session`-less CLI
      // verbs attribute to the last-started one — tell the agent how to pin.
      // The export RECOMMENDATION is grammar-gated like the env-file write.
      let concurrentClause = '';
      try {
        const proj = await projections.project(repoRoot);
        const others = (proj.activeSessions || []).filter((s) => s.id !== sid);
        if (sid && others.length > 0) {
          concurrentClause = sidShellSafe
            ? ` Another session is active — export MADDU_SESSION_ID=${sid} in Bash calls to pin attribution.`
            : ` Another session is active — this session's id could not be safely quoted; run \`maddu session list\` to identify it.`;
        }
      } catch { /* clause is best-effort */ }

      note = (sid
        ? `Máddu session ${sid} auto-registered (recorded in the spine). Claim a lane before editing (\`maddu lane claim <lane>\`) and run \`maddu slice-stop\` at each slice boundary — no --session needed, it resolves the active session.${concurrentClause}`
        : 'Máddu session discipline active. Run `maddu register`, claim a lane, and `maddu slice-stop` at each slice boundary.') + disciplineLine;
      sidOut = sid;
    } catch { /* CONTAINMENT: any error → the fallback note, exit 0 */ }
    // Witness (r2 F2): a run that registered/renewed a session appended and is
    // credited; ONLY the append-free outcomes (containment, failed
    // registration) declare an excuse — deleting the happy-path append would
    // now breach, exactly as it should.
    if (!sidOut) await hookFireNoop('hook-fire:session-start-containment-or-unregistered');
    try {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note },
      }) + '\n');
    } catch { /* stdout gone — still exit 0 */ }
    process.exit(0);
  }

  async function fireSessionEnd() {
    // Hoisted close-outcome flag: only append-free outcomes declare an excuse
    // (r2 F2) — a real close appends SESSION_CLOSED and is credited.
    let closedHappened = false;
    try {
      seamThrow('bootstrap');
      const { paths, spine, sessionLifecycle } = await loadSpineLib();
      const repoRoot = await resolveRepoRoot(paths);
      const disc = await loadLib('discipline.mjs');
      seamThrow('handler');
      const payload = await readHookPayload();
      // CP2 (PR-B): gate the claude id at the boundary (resolve/unbind self-guard
      // too); fail-open to today's behavior on a pre-PR-B lib without isClaudeId.
      const claudeId = spine.isClaudeId
        ? (spine.isClaudeId(payload.session_id) ? payload.session_id : null)
        : (payload.session_id || null);
      // No payload / no binding infra → close NOTHING (never close an
      // unattributed session; the janitor sweep is the leak backstop).
      if (!claudeId || !disc || !sessionLifecycle || !disc.withBindingTransaction) {
        await hookFireNoop('hook-fire:session-end-nothing-to-close');
        process.exit(0);
      }
      const workRoot = await resolveWorkRootFrom(paths, payload.cwd, repoRoot);
      let uncommitted = 0;
      try {
        const obs = await disc.dirtyFilesDetailed(workRoot);
        if (obs.ok) uncommitted = obs.paths.length;
      } catch { /* count is informational */ }
      // The whole sequence holds the BINDING lock (close lock nests inside per
      // the global order): read binding → rebind-freshness guard → conditional
      // close → status-scoped unbind. A rebind either blocks until this
      // completes or landed first and makes the guard skip — no interleaving
      // closes a live pinned continuation. The SessionEnd payload carries
      // nothing that distinguishes same-claude-id generations, so the <10s
      // freshness guard is deliberately fail-open (a skipped close is a
      // janitor-reaped leak; a wrong close kills a live session).
      await disc.withBindingTransaction(repoRoot, async () => {
        const binding = await disc.resolveClaudeBindingIn(repoRoot, claudeId);
        if (!binding) return;
        if (Number.isFinite(binding.boundAt) && (Date.now() - binding.boundAt) < 10_000) return;
        const res = await sessionLifecycle.withCloseLock(repoRoot, () =>
          sessionLifecycle.closeSessionIfActiveIn(repoRoot, {
            sessionId: binding.madduId,
            eventType: spine.EVENT_TYPES.SESSION_CLOSED,
            data: {
              handoff: {
                summary: `session ended (auto)${uncommitted > 0 ? ` — ${uncommitted} uncommitted file(s) at close` : ''}`,
                uncommittedFiles: uncommitted,
                auto: true,
              },
            },
          }));
        const status = sessionLifecycle.isLockFailed(res) ? 'lock' : res.status;
        if (status === 'closed') closedHappened = true;
        // Unbind only on terminal statuses — a lock/spine-corrupt result leaves
        // an ACTIVE session; deleting its binding would orphan it.
        if (status === 'closed' || status === 'already-closed' || status === 'missing') {
          await disc.unbindClaudeSessionIn(repoRoot, claudeId, binding.madduId);
        }
      });
    } catch { /* CONTAINMENT: never block Claude's session end */ }
    // Witness (r2 F2): a real close appended (credited); everything else —
    // no binding, freshness skip, already-closed, containment — is a graceful
    // append-free outcome and declares itself.
    if (!closedHappened) await hookFireNoop('hook-fire:session-end-graceful-or-containment');
    process.exit(0);
  }

  async function firePreToolUse() {
    // Mutation-witness declared no-op (per-tool gate): the REQUIRED record
    // for an allow verdict is nothing; auto-claim / DISCIPLINE_SKIPPED
    // appends are conditional side-records that also credit when they fire
    // (same conditional-append posture as /bridge/projection's janitor).
    await hookFireNoop('hook-fire:pre-tool-use-gate (conditional append)');
    // Enforce Máddu's session rituals before a mutating edit. First auto-claim
    // a lane (so agentic work is never un-laned), then evaluate discipline and
    // either allow, nudge (additionalContext), or block (permissionDecision:
    // deny). FAILS OPEN — any error exits 0 with no output, never blocking the
    // tool; only an explicit verdict:'block' emits a deny. The bootstrap runs
    // INSIDE this containment (a bootstrap failure must never block a tool).
    // Context hoisted so BOTH the happy path and the outer catch can witness (F6).
    let tool = null, sid = null, counterKey = null, disc = null, repoRoot = null;
    try {
      seamThrow('bootstrap');
      if (process.stdin.isTTY) process.exit(0); // human at a terminal → no gate (not a bypass)
      // Load the discipline lib BEFORE reading/parsing stdin so a malformed-input
      // throw still lands in the catch with `disc` available to witness (F6).
      disc = await loadLib('discipline.mjs');
      const { paths, projections, spine, sessionLifecycle, sessionActive } = await loadSpineLib();
      repoRoot = await resolveRepoRoot(paths);
      seamThrow('handler');
      let raw = '';
      for await (const chunk of process.stdin) raw += chunk;
      const payload = raw.trim() ? JSON.parse(raw) : {};
      tool = payload.tool_name || null;
      const ti = payload.tool_input || {};
      const filePath = ti.file_path || ti.notebook_path || null;
      const command = ti.command || null;
      // Grammar-gated AT THE SOURCE (v1.111.0): everything downstream —
      // binding resolution, the counter-key fallback, and enforcePreTool
      // (which against an OLDER installed discipline lib builds
      // `claude:<id>` counter filenames itself) — sees a validated-or-null
      // claude id, never raw payload input.
      const claudeOk = spine.isClaudeId || ((v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v));
      const claudeSessionId = claudeOk(payload.session_id) ? payload.session_id : null;
      const workRoot = await resolveWorkRootFrom(paths, payload.cwd, repoRoot);

      // Classify for the early-exit. A read/remedy Bash (and any non-mutating tool)
      // has nothing to gate OR witness → exit. Everything else (edit/write/
      // self-disable/ambiguous) proceeds so it can be gated AND/OR witnessed.
      const kind = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) ? 'edit'
        : (tool === 'Bash' && disc?.classifyBashWrite ? disc.classifyBashWrite(command) : 'read');
      if (kind === 'read' || kind === 'remedy') process.exit(0);

      // CENTRALIZED acting-sid resolution (v1.111.0), LIVENESS-AWARE since
      // B1/B2: validated ONCE, then every consumer — auto-claim, enforcement,
      // the witness path — uses the SAME result, so an invalid env value or
      // legacy nonconforming binding can never produce a lane claim or
      // witness event upstream of the check. Precedence is by LIVENESS
      // first, source second: a grammar-valid but DEAD env sid (inherited
      // from a parent process, or closed underneath us) must lose to the
      // caller's own live SessionStart binding, and a binding pointing at a
      // session that another agent's SessionEnd already closed must lose to
      // a freshly minted one. Still NO active-session-cache fallback and no
      // adoption of any existing session (audit P2 F11) — an unbound Claude
      // caller mints ITS OWN session rather than inheriting someone else's.
      const refOk = spine.isRefId || ((v) => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v));
      const envSid = process.env.MADDU_SESSION_ID;
      const envCand = refOk(envSid) ? envSid : null;
      let boundSid = null;
      if (disc && claudeSessionId) {
        try {
          const bound = await disc.resolveMadduSession(repoRoot, claudeSessionId);
          if (refOk(bound)) boundSid = bound;
        } catch { /* unresolvable binding reads as absent */ }
      }
      // ONE projection read decides liveness. An UNREADABLE projection is
      // unobservable, NOT evidence of death (E1): it softens the resolution
      // back to the legacy env→binding precedence and never hardens it into
      // a mint — minting against a projection we cannot read would spawn a
      // session per tool call for as long as the read keeps failing.
      let liveProj = null;
      try { liveProj = await projections.project(repoRoot); } catch { liveProj = null; }
      const isLive = (id) => !!id && !!liveProj && Array.isArray(liveProj.activeSessions)
        && liveProj.activeSessions.some((s) => s && s.id === id);
      if (liveProj) {
        sid = isLive(envCand) ? envCand : (isLive(boundSid) ? boundSid : null);
        if (!sid && claudeSessionId) {
          sid = await mintFreshBoundSession(repoRoot, {
            claudeId: claudeSessionId, workRoot, disc, spine, projections,
            sessionLifecycle, sessionActive,
          });
        }
        // A refused or failed mint degrades to EXACTLY the pre-fix result,
        // not to no session at all.
        //
        // ADJUDICATED (r1 F3), against the objection that falling back to a
        // sid we just observed to be DEAD — and thereby denying the edit —
        // breaks fail-open. It is held deliberately. The deny is the
        // discipline VERDICT on an observed dead identity, not an internal
        // error; genuine internal errors still fail open inside
        // enforcePreTool. Allowing the edit whenever the mint loses a lock
        // would make enforcement bypassable by hammering the binding lock,
        // which is a far worse property than one blocked call. And the state
        // is self-healing rather than terminal: the next tool call re-reads
        // the projection and re-attempts the mint.
        if (!sid) sid = envCand || boundSid;
      } else {
        sid = envCand || boundSid;
      }
      // claudeSessionId is already validated-or-null (gated at the source
      // above), so the fallback key is filename-safe by construction.
      counterKey = sid || (claudeSessionId ? `claude:${claudeSessionId}` : null);

      // Auto-claim a lane before the first edit (rule-#9 clean via the trigger
      // gauntlet); note if we just claimed so the eval doesn't race the spine.
      let laneJustClaimed = false;
      try {
        const auto = await loadLib('auto-claim-trigger.mjs');
        if (auto && auto.maybeAutoClaim && sid) {
          const proj = await projections.project(repoRoot);
          const res = await auto.maybeAutoClaim(repoRoot, { sid, filePath, proj });
          laneJustClaimed = !!(res && res.claimed);
        }
      } catch { /* auto-claim best-effort */ }

      // Evaluate discipline (re-projects fresh inside; maintains + persists the
      // per-session counter; resolves ONE action). Any internal error → the
      // returned decision carries enforcement:'error' (fail-open + witnessable).
      let decision = { verdict: 'ok' };
      if (disc && disc.enforcePreTool) {
        decision = await disc.enforcePreTool(repoRoot, {
          madduSessionId: sid, claudeSessionId, tool, filePath, command,
          nowMs: Date.now(), laneJustClaimed, workRoot,
        });
      }
      // Adopt the decision's counter key only when it is shape-safe (a sid
      // per the reference grammar, or a claude:-prefixed gated id) — an
      // older installed lib could hand back a key built from raw input.
      const keyOk = (k) => typeof k === 'string'
        && (k.startsWith('claude:') ? claudeOk(k.slice(7)) : refOk(k));
      counterKey = keyOk(decision.counterKey) ? decision.counterKey : counterKey;

      // Witness a bypass / fail-open BEFORE acting on the verdict (best-effort).
      await witnessDiscipline(repoRoot, disc, { decision, tool, sid, counterKey });

      if (decision.verdict === 'block') {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: disc.denyReason(decision),
          },
        }) + '\n');
        process.exit(0);
      }
      // 'warn' (graduated: the pre-block reminder) and 'nudge' (relaxed / an
      // ambiguous opaque command under standard) both surface as non-blocking
      // context — without this the graduated ramp would be invisible until block.
      if (decision.verdict === 'nudge' || decision.verdict === 'warn') {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: `Máddu discipline — ${decision.reason}. Consider: ${decision.remedy}`,
          },
        }) + '\n');
        process.exit(0);
      }
    } catch (e) {
      // The handler itself threw (stdin parse, spine load, …) — fail open, but
      // leave a witness so a persistent handler bug can't hide (F6). Emit even if
      // `disc` never loaded (a bare append, no latch/counter) so a malformed-input
      // failure is never silent.
      try {
        const errorSig = disc?.normErrorSig ? disc.normErrorSig(e) : String((e && e.message) || e).split('\n')[0].slice(0, 120);
        await witnessDiscipline(repoRoot, disc, {
          decision: { enforcement: 'error', errorSig }, tool, sid, counterKey,
        });
      } catch { /* witness best-effort */ }
    }
    process.exit(0);
  }

  async function firePreCompact() {
    // Mutation-witness declared no-op (per-compaction): the checkpoint
    // append is conditional (and credits when it fires); containment exits
    // are append-free by design.
    await hookFireNoop('hook-fire:pre-compact (conditional append)');
    // FAILS OPEN by design: whatever goes wrong, exit 0 so compaction is
    // never blocked (exit 2 would block it) and the session never breaks.
    // Bootstrap runs INSIDE the containment.
    try {
      seamThrow('bootstrap');
      const payload = await readHookPayload();
      const { paths, spine, projections } = await loadSpineLib();
      const repoRoot = await resolveRepoRoot(paths);
      seamThrow('handler');
      const workRoot = await resolveWorkRootFrom(paths, payload.cwd, repoRoot);
      const proj = await projections.project(repoRoot);
      const stops = Array.isArray(proj.sliceStops) ? proj.sliceStops : [];
      const last = stops.length ? stops[stops.length - 1] : null;
      // Discipline snapshot (non-load-bearing open fields): don't compact over
      // undisciplined state silently. Best-effort; fail-safe to nulls.
      let uncommittedFiles = null, editsSinceSlice = null;
      // CP3 hoist (PR-B): resolve the checkpoint actor + claude id ONCE, above
      // the best-effort discipline snapshot, so the append records a
      // grammar-clean actor even when the snapshot (which further refines sid2
      // via the stored binding) is skipped or throws.
      const refOk2 = spine.isRefId || ((v) => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v));
      const isClaudeId2 = spine.isClaudeId || ((v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v));
      const claudeSessionId = isClaudeId2(payload.session_id) ? payload.session_id : null;
      let sid2 = refOk2(process.env.MADDU_SESSION_ID) ? process.env.MADDU_SESSION_ID : null;
      try {
        const disc = await loadLib('discipline.mjs');
        if (disc) {
          // Observe the WORK root (an attached worktree's own dirt, not the
          // primary checkout's); a failed observation stays null-honest.
          if (disc.dirtyFilesDetailed) {
            const obs = await disc.dirtyFilesDetailed(workRoot);
            uncommittedFiles = obs.ok ? obs.paths.length : null;
          } else {
            uncommittedFiles = (await disc.dirtyFiles(workRoot)).length;
          }
          if (!sid2 && claudeSessionId) {
            const b = await disc.resolveMadduSession(repoRoot, claudeSessionId);
            if (refOk2(b)) sid2 = b;
          }
          if (sid2) editsSinceSlice = (await disc.readCounter(repoRoot, sid2)).editsSinceSlice || 0;
          if (uncommittedFiles > 0) process.stderr.write(`[maddu] compacting with ${uncommittedFiles} uncommitted file(s) — consider committing/slice-stopping first.\n`);
        }
      } catch { /* discipline snapshot best-effort */ }
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.COMPACTION_CHECKPOINT,
        actor: sid2,
        data: {
          trigger: payload.trigger || null,             // 'manual' | 'auto'
          claudeSessionId,
          lastSliceStop: last ? { id: last.id, ts: last.ts, summary: String(last.summary || '').slice(0, 200) } : null,
          handoffSetAt: proj.handoff?.setAt || null,
          openApprovals: Array.isArray(proj.approvals) ? proj.approvals.filter((a) => a.status === 'requested' || a.status === 'pending').length : 0,
          activeClaims: Array.isArray(proj.claims) ? proj.claims.length : 0,
          uncommittedFiles,     // discipline: open field, non-load-bearing
          editsSinceSlice,      // discipline: open field, non-load-bearing
        },
      });
    } catch {}
    process.exit(0);
  }

  // ── the dispatch ────────────────────────────────────────────────────────
  // The caller validates the event name (it owns the CLI's usage message), so
  // an unknown one reaching here is a programming error, not operator input.
  async function fire(event) {
    if (event === 'session-start') return fireSessionStart();
    if (event === 'session-end') return fireSessionEnd();
    if (event === 'pre-tool-use') return firePreToolUse();
    if (event === 'pre-compact') return firePreCompact();
    throw new Error(`fire-core: unknown event "${event}"`);
  }

  return {
    fire,
    noop: hookFireNoop,
    // Exposed for the harness adapters and for focused tests. Internals, not a
    // contract: PR3 is the first caller that can say what this seam needs.
    quietly, witnessDiscipline, seamThrow, readHookPayload, resolveWorkRootFrom,
    mintFreshBoundSession, fireSessionStart, fireSessionEnd, firePreToolUse,
    firePreCompact,
  };
}
