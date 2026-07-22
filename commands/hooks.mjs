// `maddu hooks <install|status|remove|fire>` — wire session discipline into
// Claude Code so a fresh maddu repo records session + spine activity every
// time an agent starts working, without relying on the agent following its
// brief by hand.
//
//   maddu hooks install     # merge SessionStart(auto-register) + SessionEnd(close)
//                           # into <repo>/.claude/settings.json (idempotent)
//   maddu hooks status      # show which Máddu hooks are installed
//   maddu hooks remove      # strip Máddu's hook entries (leaves yours intact)
//   maddu hooks fire <ev>   # runtime entrypoint the settings.json calls:
//                           #   session-start → register + remind to slice-stop
//                           #   session-end   → close the active session
//                           #   pre-compact   → COMPACTION_CHECKPOINT on the spine
//                           #                   (fails OPEN: never blocks compaction)
//
// install/remove touch a HOST-repo file (.claude/settings.json) outside
// .maddu/, so they run only on explicit invocation — never silently at init.

import { join, basename } from 'node:path';
import { mkdir, readFile, writeFile, rm, appendFile } from 'node:fs/promises';

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, resolveWorkAndStateRoots } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';
import registerCmd from './register.mjs';

// Ownership side-state for the permission guardrails: the exact rule strings
// THIS install added (a rule the user already had is not ours and must survive
// uninstall). Lives in .maddu/state/ — if the state dir is wiped (projections
// are rebuildable), uninstall falls back to the canonical current rule set,
// which degrades to exact-string matching (documented limit).
function guardrailStatePath(repoRoot) {
  return join(repoRoot, '.maddu', 'state', 'guardrails.json');
}
async function readGuardrailState(repoRoot) {
  try {
    const raw = await readFile(guardrailStatePath(repoRoot), 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.deny) && Array.isArray(j.ask)) {
      // An EMPTY record is treated as absent: "we own nothing" makes uninstall
      // a silent no-op that leaves every guardrail behind, which is strictly
      // worse than the documented exact-string fallback an absent record
      // triggers. Install never writes one; one on disk is stale state.
      if (j.deny.length + j.ask.length === 0) return null;
      // `created` marks which containers install brought into existence, so
      // strip only cleans up those (a user's pre-existing empty array stays).
      // Records from before this field default to the old delete-empties
      // behavior inside stripGuardrails.
      const created = j.created && typeof j.created === 'object' && !Array.isArray(j.created)
        ? j.created : undefined;
      return created ? { deny: j.deny, ask: j.ask, created } : { deny: j.deny, ask: j.ask };
    }
  } catch { /* absent / malformed → null */ }
  return null;
}
async function writeGuardrailState(repoRoot, recorded) {
  const p = guardrailStatePath(repoRoot);
  await mkdir(join(repoRoot, '.maddu', 'state'), { recursive: true });
  await writeFile(p, JSON.stringify({ v: 1, ...recorded }, null, 2) + '\n');
}
async function clearGuardrailState(repoRoot) {
  // Only "already absent" is ignorable. Any other failure means a STALE
  // ownership record survives the uninstall — a later install would re-record
  // against it and could claim (then delete) a rule the user authors in the
  // meantime. Say so instead of swallowing it.
  try { await rm(guardrailStatePath(repoRoot)); }
  catch (e) {
    if (e && e.code === 'ENOENT') return;
    console.error(`\x1b[33mwarning\x1b[0m  could not delete ${guardrailStatePath(repoRoot)} (${String((e && e.message) || e).slice(0, 80)})`);
    console.error(`  Delete it manually — a stale ownership record can mis-claim rules on a later install.`);
  }
}

function printHelp() {
  console.log([
    'Usage: maddu hooks <install|status|remove|uninstall> [--statusline] [--no-guardrails] [--dry-run]',
    '',
    '  install     Wire SessionStart (auto-register + stale-sweep) + SessionEnd',
    '              (close) + PreCompact (compaction checkpoint) + PreToolUse',
    '              (auto-claim a lane before editing) into',
    '              <repo>/.claude/settings.json so every Claude Code session in',
    '              this repo records to the spine. Idempotent; preserves your',
    '              own hooks.',
    '              Also installs permission guardrails by default: deny-rules on',
    '              the framework internals (maddu/runtime/**, .maddu/config/**,',
    '              .maddu/gates/**, the settings files) plus ask-rules for paths',
    '              the project declares in maddu.json → guardrails.ask[].',
    '              Edit-form only (Write() rules are inert in Claude Code',
    '              v2.1.210+). Bypassable harness friction covering the',
    '              built-in file tools, NOT a security boundary — Bash coverage',
    '              is version-dependent, subprocesses are never covered.',
    '              --no-guardrails skips them. --retire-inert-write-twins',
    '              retires redundant Write() rules (explicit, reported).',
    '              With --statusline, also set the Claude Code statusLine to',
    '              `maddu status --line` (a one-line on-goal/drift segment). Opt-in;',
    '              never clobbers a statusLine you already set.',
    '  status      Show which Máddu hooks + guardrails are installed.',
    '  remove      Remove only Máddu\'s hook entries, its guardrail rules (exact',
    '              strings), and its statusLine, if set.',
    '  uninstall   Alias for `remove` — the fast off-switch for the discipline hook.',
    '',
    'Once installed, a session auto-registers, the SessionStart sweep clears stale',
    'sessions + orphaned lane claims, and PreToolUse auto-claims a lane before the',
    'first edit — so agentic work is recorded and laned without the agent',
    'remembering. Slice boundaries stay agent-driven (`maddu slice-stop` at each).',
  ].join('\n'));
}

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

async function fireSessionStart() {
  let note = 'Máddu session discipline active. Run `maddu register`, claim a lane, and `maddu slice-stop` at each slice boundary.';
  try {
    seamThrow('bootstrap');
    const { paths, spine, projections, sessionActive, sessionLifecycle } = await loadSpineLib();
    const repoRoot = await resolveRepoRoot(paths);
    const disc = await loadLib('discipline.mjs');
    seamThrow('handler');
    // Payload FIRST — the claude id + cwd inform everything downstream.
    const payload = await readHookPayload();
    const claudeId = payload.session_id || null;
    const workRoot = await resolveWorkRootFrom(paths, payload.cwd, repoRoot);
    const isRefId = spine.isRefId || (() => false);
    const isSid = spine.isSid || (() => false);
    const label = basename(repoRoot) || 'agent';
    // Parent forwarded VERBATIM as on main — parent validation is PR-B's.
    const parentEnv = process.env.MADDU_PARENT_SESSION_ID || null;
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
  } catch { /* CONTAINMENT: any error → the fallback note, exit 0 */ }
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note },
    }) + '\n');
  } catch { /* stdout gone — still exit 0 */ }
  process.exit(0);
}

async function fireSessionEnd() {
  try {
    seamThrow('bootstrap');
    const { paths, spine, sessionLifecycle } = await loadSpineLib();
    const repoRoot = await resolveRepoRoot(paths);
    const disc = await loadLib('discipline.mjs');
    seamThrow('handler');
    const payload = await readHookPayload();
    const claudeId = payload.session_id || null;
    // No payload / no binding infra → close NOTHING (never close an
    // unattributed session; the janitor sweep is the leak backstop).
    if (!claudeId || !disc || !sessionLifecycle || !disc.withBindingTransaction) process.exit(0);
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
      // Unbind only on terminal statuses — a lock/spine-corrupt result leaves
      // an ACTIVE session; deleting its binding would orphan it.
      if (status === 'closed' || status === 'already-closed' || status === 'missing') {
        await disc.unbindClaudeSessionIn(repoRoot, claudeId, binding.madduId);
      }
    });
  } catch { /* CONTAINMENT: never block Claude's session end */ }
  process.exit(0);
}

export default async function hooks(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return; }
  const sub = argv[0];
  const rest = argv.slice(1);

  // ── fire: the runtime entrypoint the installed hooks call ──
  // Handled BEFORE the shared bootstrap: each event bootstraps inside its own
  // fail-open containment (a bootstrap failure must never block a tool call,
  // a compaction, or a session boundary).
  if (sub === 'fire') {
    const event = rest[0];
    if (event === 'session-start') {
      return fireSessionStart();
    }
    if (event === 'session-end') {
      return fireSessionEnd();
    }
    if (event === 'pre-tool-use') {
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
        const { paths, projections, spine } = await loadSpineLib();
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

        // CENTRALIZED acting-sid resolution (v1.111.0): validated ONCE, then
        // every consumer — auto-claim, enforcement, the witness path — uses
        // the SAME result, so an invalid env value or legacy nonconforming
        // binding can never produce a lane claim or witness event upstream of
        // the check. Precedence: env → SessionStart binding. NO active-
        // session-cache fallback (audit P2 F11): an unbound Claude caller
        // must stay unbound rather than inherit the cached active session.
        const refOk = spine.isRefId || ((v) => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v));
        const envSid = process.env.MADDU_SESSION_ID;
        sid = refOk(envSid) ? envSid : null;
        if (!sid && disc && claudeSessionId) {
          try {
            const bound = await disc.resolveMadduSession(repoRoot, claudeSessionId);
            if (refOk(bound)) sid = bound;
          } catch { /* fall through */ }
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
    if (event === 'pre-compact') {
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
            const refOk2 = spine.isRefId || ((v) => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v));
            let sid2 = refOk2(process.env.MADDU_SESSION_ID) ? process.env.MADDU_SESSION_ID : null;
            if (!sid2 && payload.session_id) {
              const b = await disc.resolveMadduSession(repoRoot, payload.session_id);
              if (refOk2(b)) sid2 = b;
            }
            if (sid2) editsSinceSlice = (await disc.readCounter(repoRoot, sid2)).editsSinceSlice || 0;
            if (uncommittedFiles > 0) process.stderr.write(`[maddu] compacting with ${uncommittedFiles} uncommitted file(s) — consider committing/slice-stopping first.\n`);
          }
        } catch { /* discipline snapshot best-effort */ }
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.COMPACTION_CHECKPOINT,
          actor: process.env.MADDU_SESSION_ID || null,
          data: {
            trigger: payload.trigger || null,             // 'manual' | 'auto'
            claudeSessionId: payload.session_id || null,
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
    console.error(`maddu hooks fire: unknown event "${event}". One of: session-start, session-end, pre-compact, pre-tool-use.`);
    process.exit(2);
  }

  // Shared bootstrap for the NON-fire subcommands (install/status/remove).
  // These are interactive operator commands — a bootstrap failure may error
  // normally here; only the fire handlers carry the fail-open containment.
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const lib = await loadLib('claude-hooks.mjs');

  // ── status ──
  if (!sub || sub === 'status' || sub === 'list') {
    const { settings, existed } = await lib.loadSettings(repoRoot);
    if (settings === null) {
      console.log(`\x1b[33m.claude/settings.json exists but is not valid JSON — refusing to read it.\x1b[0m`);
      console.log(`  ${lib.settingsPath(repoRoot)}`);
      return;
    }
    const { installed, allInstalled } = lib.summarize(settings);
    console.log(`\x1b[1mMáddu Claude Code hooks\x1b[0m  ${lib.settingsPath(repoRoot)}${existed ? '' : '  \x1b[2m(no settings file yet)\x1b[0m'}`);
    for (const { event } of lib.MADDU_HOOKS) {
      const on = installed.includes(event);
      console.log(`  ${on ? '\x1b[32m●\x1b[0m installed ' : '\x1b[2m○ not set  \x1b[0m'} ${event}`);
    }
    if (lib.resolveGuardrailRules && lib.summarizeGuardrails) {
      const rules = await lib.resolveGuardrailRules(repoRoot);
      const g = lib.summarizeGuardrails(settings, rules);
      console.log(`\x1b[1mPermission guardrails\x1b[0m (${rules.layout} layout — harness friction, not a security boundary)`);
      for (const r of g.present) console.log(`  \x1b[32m●\x1b[0m installed  ${r}`);
      for (const r of g.missing) console.log(`  \x1b[2m○ not set   ${r}\x1b[0m`);
    }
    if (!allInstalled) console.log(`\nRun \x1b[1mmaddu hooks install\x1b[0m to wire session discipline into this repo.`);
    return;
  }

  // ── install / remove ──
  if (sub === 'install' || sub === 'remove' || sub === 'uninstall') {
    const { flags } = parseFlags(rest);
    // `uninstall` is an alias for `remove` — it's the off-switch operators reach
    // for when the discipline hook needs to come out fast, so both names work.
    const removing = sub === 'remove' || sub === 'uninstall';
    const { settings, existed, raw } = await lib.loadSettings(repoRoot);
    if (settings === null) {
      console.error(`\x1b[31mrefusing to touch ${lib.settingsPath(repoRoot)} — it exists but is not valid JSON. Fix or remove it first.\x1b[0m`);
      process.exit(1);
    }
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      // Valid JSON but not an object root ([], "x", 42, true): properties
      // attached to an array/primitive vanish at serialize time, so a merge
      // would "succeed" while installing nothing (and still record ownership).
      console.error(`\x1b[31mrefusing to touch ${lib.settingsPath(repoRoot)} — its root is not a JSON object. Fix or remove it first.\x1b[0m`);
      process.exit(1);
    }
    const bin = lib.resolveHookBin ? await lib.resolveHookBin(repoRoot) : undefined;
    // On remove, also strip Máddu's statusLine (if present) — never leave a
    // dangling `status --line` pointing at removed wiring. On install, only wire
    // the statusLine when --statusline is passed (opt-in).
    let statusLineSkipped = false;
    // Permission guardrails ride install/remove by default (the point is that a
    // consumer install ships them without a second command); --no-guardrails
    // opts out. Rules are layout-aware + generated from maddu.json
    // `guardrails.ask[]` — see claude-hooks.mjs for the honest-strength notes.
    // OWNERSHIP: the exact strings each install adds are recorded in
    // .maddu/state/guardrails.json; uninstall strips exactly those, so a rule
    // the user had authored before install survives. Install first strips the
    // previously-recorded set, so a changed guardrails.ask[] declaration
    // retires its old generated rules instead of leaving them behind.
    const wantGuardrails = !flags['no-guardrails'] && lib.resolveGuardrailRules && lib.mergeGuardrails;
    const gRules = wantGuardrails ? await lib.resolveGuardrailRules(repoRoot) : null;
    if (gRules && gRules.warnings && gRules.warnings.length) {
      for (const w of gRules.warnings) console.error(`\x1b[33mwarning\x1b[0m  ${w}`);
    }
    const gPrev = wantGuardrails ? await readGuardrailState(repoRoot) : null;
    let gAdded = null, gRetired = null, gRecorded = null, gStripFallback = false;
    let next;
    if (removing) {
      next = lib.stripMaddu(settings);
      if (lib.stripStatusLine) next = lib.stripStatusLine(next);
      if (wantGuardrails && lib.stripGuardrails) {
        // Prefer the recorded ownership set; fall back to the canonical current
        // rules only when no record exists (pre-side-state installs) — the
        // fallback can remove a user-authored identical rule (documented).
        gStripFallback = !gPrev;
        next = lib.stripGuardrails(next, gPrev || gRules);
      }
    } else {
      next = lib.mergeInstall(settings, { bin });
      if (flags.statusline && lib.mergeStatusLine) {
        const merged = lib.mergeStatusLine(next, { bin });
        next = merged.settings;
        statusLineSkipped = merged.skipped;
      }
      if (wantGuardrails) {
        if (gPrev && lib.stripGuardrails) next = lib.stripGuardrails(next, gPrev);
        const g = lib.mergeGuardrails(next, gRules);
        if (g.malformed && g.malformed.length) {
          // Merging into these shapes would either lose the rules at
          // JSON-serialize time (properties on an array) or clobber user data
          // (non-array deny/ask) — refuse before anything is written, same as
          // the invalid-JSON refusal above.
          console.error(`\x1b[31mrefusing to install guardrails\x1b[0m — ${lib.settingsPath(repoRoot)} has a malformed shape at: ${g.malformed.join(', ')}.`);
          console.error(`  Fix it (permissions must be an object; deny/ask must be arrays), or re-run with --no-guardrails.`);
          process.exit(1);
        }
        next = g.settings;
        gAdded = g.added;
        // Recorded ownership = exactly what this merge introduced (after the
        // prev-owned strip, re-added canonical rules land in `added`; a rule
        // the user authored independently never does). An all-empty record is
        // NEVER written — it reads back as absent anyway, and persisting one
        // was the round-2 bug that neutered uninstall.
        gRecorded = (g.added.deny.length + g.added.ask.length)
          ? { deny: g.added.deny, ask: g.added.ask, created: g.created } : null;
        if (!gPrev) {
          const preexisting = (gRules.deny.length + gRules.ask.length)
            - (g.added.deny.length + g.added.ask.length);
          if (preexisting > 0 && g.added.deny.length + g.added.ask.length === 0) {
            // EVERY canonical rule was already present with no ownership
            // record — the signature of a pre-record install (or lost state),
            // not of a user hand-authoring the complete set. Recording an
            // empty set here would make a later uninstall a silent no-op that
            // leaves all guardrails behind; leave NO record instead so
            // uninstall keeps its exact-string fallback, and say so.
            gRecorded = null;
            console.error(`\x1b[33mwarning\x1b[0m  all ${preexisting} canonical guardrail rule(s) were already present with no ownership record`);
            console.error(`  (pre-1.107 install or lost .maddu/state/guardrails.json). No record written — uninstall will`);
            console.error(`  strip the canonical set by exact string; if you hand-authored an identical rule, re-add it after.`);
          } else if (preexisting > 0) {
            // Partial overlap: the pre-existing matches are treated as YOURS
            // (they survive uninstall) — that is the protection for a rule
            // you authored before install, but it also means a rule left by a
            // recordless earlier install stays behind. Be loud about it.
            console.error(`\x1b[33mwarning\x1b[0m  ${preexisting} canonical guardrail rule(s) were already present with no ownership record —`);
            console.error(`  treated as user-authored (they will survive uninstall). If they came from an earlier Máddu`);
            console.error(`  install, run \x1b[1mmaddu hooks remove\x1b[0m first, then re-install, to reset ownership.`);
          }
        }
      }
      // Inert Write() twin retirement is an EXPLICIT operator action, never a
      // side effect of install — it edits user-visible rules (behavior-neutral
      // under documented Claude Code semantics, but the operator pulls the
      // trigger and gets a report).
      if (flags['retire-inert-write-twins'] && lib.retireInertWriteTwins) {
        const r = lib.retireInertWriteTwins(next);
        next = r.settings;
        gRetired = r.retired;
      }
    }
    const before = JSON.stringify(settings);
    const after = JSON.stringify(next);
    if (before === after) {
      // Settings text unchanged — still reconcile the ownership side-state
      // (never on dry-run): an idempotent re-install re-records the same set;
      // a no-op remove clears any stale record.
      if (!flags['dry-run'] && wantGuardrails) {
        if (removing) await clearGuardrailState(repoRoot);
        else if (gRecorded) await writeGuardrailState(repoRoot, gRecorded);
        else await clearGuardrailState(repoRoot); // never leave a stale/empty record behind
      }
      if (!removing && flags.statusline && statusLineSkipped) {
        console.log('\x1b[33mstatusLine already set to your own command\x1b[0m — left untouched. Remove it first to use Máddu\'s.');
        return;
      }
      console.log(removing ? 'no Máddu hooks present — nothing to remove.' : '\x1b[32mMáddu hooks already installed\x1b[0m — no changes.');
      return;
    }
    if (flags['dry-run']) {
      const what = removing
        ? 'remove Máddu hooks from'
        : `install Máddu hooks${flags.statusline && !statusLineSkipped ? ' + statusLine' : ''} into`;
      console.log(`(dry-run) would ${what}:`);
      console.log(`  ${lib.settingsPath(repoRoot)}`);
      if (!removing && flags.statusline && statusLineSkipped) {
        console.log(`  ${'\x1b[33m'}(statusLine left untouched — you already set your own)${'\x1b[0m'}`);
      }
      return;
    }
    // audit P2 (C6c): uninstalling the PreToolUse hook disables Máddu's own
    // discipline enforcement. Record it WRITE-AHEAD — append the witness BEFORE
    // stripping the settings so a disable is never silent; abort on append failure
    // (a disable that can't be recorded must not proceed) unless --force, which
    // still records first and only downgrades the abort to a loud warning.
    if (removing && lib.summarize(settings).installed.includes('PreToolUse')) {
      // NEVER remove the enforcement hook unless the disable is recorded first —
      // a disable that can't be witnessed must not proceed (no --force bypass of the
      // write-ahead; the operator can hand-edit .claude/settings.json if the spine
      // is genuinely broken, which is itself the problem to fix).
      try {
        const { spine } = await loadSpineLib();
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.DISCIPLINE_SKIPPED,
          actor: process.env.MADDU_SESSION_ID || null,
          data: {
            reason: 'enforcement-hook-uninstalled',
            tool: null, sessionId: process.env.MADDU_SESSION_ID || null, enforcement: null,
          },
        });
      } catch (e) {
        console.error(`\x1b[31mrefusing to uninstall\x1b[0m — could not record the disable on the spine (${String((e && e.message) || e).slice(0, 80)}).`);
        console.error(`  Disabling enforcement must leave a witness. Fix the spine first (a broken spine is the real problem).`);
        process.exit(1);
      }
    }
    const eol = existed && raw && raw.includes('\r\n') ? '\r\n' : '\n';
    await lib.saveSettings(repoRoot, next, { eol });
    if (wantGuardrails) {
      if (removing) await clearGuardrailState(repoRoot);
      else if (gRecorded) await writeGuardrailState(repoRoot, gRecorded);
      else await clearGuardrailState(repoRoot); // never leave a stale/empty record behind
    }
    if (removing) {
      console.log(`\x1b[32mremoved\x1b[0m Máddu hooks${wantGuardrails ? ' + permission guardrails' : ''} → ${lib.settingsPath(repoRoot)}`);
      if (gStripFallback && wantGuardrails) {
        console.log(`  \x1b[33mno ownership record found\x1b[0m — stripped the canonical rule set by exact string;`);
        console.log(`  \x1b[2mif you had hand-authored an identical rule before install, re-add it.\x1b[0m`);
      }
    } else {
      const { installed } = lib.summarize(next);
      console.log(`\x1b[32minstalled\x1b[0m Máddu hooks (${installed.join(', ')}) → ${lib.settingsPath(repoRoot)}`);
      console.log(`  Every Claude Code session now auto-registers, sweeps stale sessions + orphaned`);
      console.log(`  claims, auto-claims a lane before the first edit, and checkpoints before compaction.`);
      if (gAdded && (gAdded.deny.length || gAdded.ask.length)) {
        console.log(`  Permission guardrails (${gRules.layout} layout): ${gAdded.deny.length} deny + ${gAdded.ask.length} ask rule(s) added.`);
        console.log(`  \x1b[2mHarness friction inside Claude Code, not a security boundary — the rules cover`);
        console.log(`  Claude Code's built-in file tools; coverage of Bash file commands is`);
        console.log(`  version-dependent and NOT guaranteed, and subprocesses that open files`);
        console.log(`  themselves are never covered (docs/34-threat-model.md).\x1b[0m`);
        if (!gRules.ask.length) console.log(`  \x1b[2mDeclare project paths to guard as ask-rules in maddu.json → guardrails.ask[].\x1b[0m`);
      }
      if (gRetired && gRetired.length) {
        console.log(`  Retired ${gRetired.length} inert Write() twin rule(s) (Write rules are never`);
        console.log(`  matched by file checks in Claude Code v2.1.210+; the Edit twin covers each):`);
        for (const r of gRetired) console.log(`    \x1b[2m- ${r.list}: ${r.rule}\x1b[0m`);
      }
      if (flags.statusline && lib.statusLineInstalled && lib.statusLineInstalled(next)) {
        console.log(`  statusLine set to \x1b[1mmaddu status --line\x1b[0m (on-goal / drift, one glance).`);
      } else if (flags.statusline && statusLineSkipped) {
        console.log(`  \x1b[33mstatusLine left untouched\x1b[0m — you already set your own.`);
      }
      console.log(`  Remove with \x1b[1mmaddu hooks remove\x1b[0m.`);
    }
    return;
  }

  console.error(`maddu hooks: unknown subcommand "${sub}". One of: install, status, remove.`);
  process.exit(2);
}
