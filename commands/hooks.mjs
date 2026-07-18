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

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';
import registerCmd from './register.mjs';
import sessionCmd from './session.mjs';

function printHelp() {
  console.log([
    'Usage: maddu hooks <install|status|remove|uninstall> [--statusline] [--dry-run]',
    '',
    '  install     Wire SessionStart (auto-register + stale-sweep) + SessionEnd',
    '              (close) + PreCompact (compaction checkpoint) + PreToolUse',
    '              (auto-claim a lane before editing) into',
    '              <repo>/.claude/settings.json so every Claude Code session in',
    '              this repo records to the spine. Idempotent; preserves your',
    '              own hooks.',
    '              With --statusline, also set the Claude Code statusLine to',
    '              `maddu status --line` (a one-line on-goal/drift segment). Opt-in;',
    '              never clobbers a statusLine you already set.',
    '  status      Show which Máddu hooks are installed.',
    '  remove      Remove only Máddu\'s hook entries (and its statusLine, if set).',
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
    if (latchKey && counterKey && disc?.readCounter && disc?.writeCounter) {
      const c = (await disc.readCounter(repoRoot, counterKey)) || {};
      c.skipLatch = { ...(c.skipLatch || {}), [latchKey]: true };
      await disc.writeCounter(repoRoot, counterKey, c);
    }
  } catch { /* witness is best-effort — never block the tool */ }
}

export default async function hooks(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return; }
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const lib = await loadLib('claude-hooks.mjs');

  // ── fire: the runtime entrypoint the installed hooks call ──
  if (sub === 'fire') {
    const event = rest[0];
    if (event === 'session-start') {
      // Bind the id register JUST created — never the repo-global active pointer,
      // which a concurrent SessionStart can overwrite, binding two Claude ids to
      // one Máddu session (Codex). register returns its id in both branches; if it
      // somehow yields nothing, leave sid null so the session stays honestly
      // unbound rather than mis-bound to a pointer we can't attribute to it.
      const sid = (await quietly(() => registerCmd([]))) || null;
      // Opportunistic stale-session sweep. The bridge janitor only runs when the
      // cockpit is open; on a CLI-first workstation stale sessions never
      // auto-close and the lane claims they leaked linger for days. Running the
      // same evaluation on every session start keeps the record self-cleaning.
      // Best-effort + silent — a sweep failure must never break session start,
      // and it must not write to stdout (parsed as SessionStart context).
      try {
        const { projections } = await loadSpineLib();
        const jan = await loadLib('janitor.mjs');
        if (jan && jan.reconcileStale) {
          await jan.reconcileStale(repoRoot, projections);
        }
      } catch { /* sweep is best-effort */ }
      // Bind this Claude session → the Máddu session and capture the dirty
      // baseline, so the discipline counter measures only THIS session's new
      // uncommitted work (Codex: per-session, no cross-session clobber).
      // Best-effort + fail-safe — never breaks session start or dirties stdout.
      let disciplineLine = '';
      try {
        const disc = await loadLib('discipline.mjs');
        if (disc && sid) {
          let claudeId = null;
          if (!process.stdin.isTTY) {
            let raw = '';
            try { for await (const chunk of process.stdin) raw += chunk; } catch {}
            try { claudeId = raw.trim() ? (JSON.parse(raw).session_id || null) : null; } catch {}
          }
          if (claudeId) await disc.bindClaudeSession(repoRoot, claudeId, sid);
          const dirty = await disc.dirtyFiles(repoRoot);
          const counter = await disc.readCounter(repoRoot, sid);
          counter.dirtyBaseline = dirty;
          await disc.writeCounter(repoRoot, sid, counter);
          const st = await disc.gatherRitualState(repoRoot, sid, Date.now(), counter);
          const gaps = [];
          if (!st.goalOrPlan?.active) gaps.push('no goal or open plan');
          if (!st.lane?.claimed) gaps.push('no lane claimed');
          if (gaps.length) disciplineLine = ` Máddu discipline: ${gaps.join('; ')} — declare/claim before editing (enforcement may block otherwise).`;
        }
      } catch { /* discipline context is best-effort */ }
      // SessionStart: emit additionalContext so the agent sees the session is
      // live and is reminded of the per-slice discipline the hook can't enforce.
      const note = (sid
        ? `Máddu session ${sid} auto-registered (recorded in the spine). Claim a lane before editing (\`maddu lane claim <lane>\`) and run \`maddu slice-stop\` at each slice boundary — no --session needed, it resolves the active session.`
        : 'Máddu session discipline active. Run `maddu register`, claim a lane, and `maddu slice-stop` at each slice boundary.') + disciplineLine;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note },
      }) + '\n');
      return;
    }
    if (event === 'session-end') {
      let focus = 'session ended (auto)';
      try {
        const disc = await loadLib('discipline.mjs');
        if (disc) { const n = (await disc.dirtyFiles(repoRoot)).length; if (n > 0) focus += ` — ${n} uncommitted file(s) at close`; }
      } catch { /* best-effort */ }
      await quietly(() => sessionCmd(['close', '--focus', focus]));
      return;
    }
    if (event === 'pre-tool-use') {
      // Enforce Máddu's session rituals before a mutating edit. First auto-claim
      // a lane (so agentic work is never un-laned), then evaluate discipline and
      // either allow, nudge (additionalContext), or block (permissionDecision:
      // deny). FAILS OPEN — any error exits 0 with no output, never blocking the
      // tool; only an explicit verdict:'block' emits a deny.
      // Context hoisted so BOTH the happy path and the outer catch can witness (F6).
      let tool = null, sid = null, counterKey = null, disc = null;
      try {
        if (process.stdin.isTTY) process.exit(0); // human at a terminal → no gate (not a bypass)
        // Load the discipline lib BEFORE reading/parsing stdin so a malformed-input
        // throw still lands in the catch with `disc` available to witness (F6).
        disc = await loadLib('discipline.mjs');
        let raw = '';
        for await (const chunk of process.stdin) raw += chunk;
        const payload = raw.trim() ? JSON.parse(raw) : {};
        tool = payload.tool_name || null;
        const ti = payload.tool_input || {};
        const filePath = ti.file_path || ti.notebook_path || null;
        const command = ti.command || null;
        const claudeSessionId = payload.session_id || null;

        // Classify for the early-exit. A read/remedy Bash (and any non-mutating tool)
        // has nothing to gate OR witness → exit. Everything else (edit/write/
        // self-disable/ambiguous) proceeds so it can be gated AND/OR witnessed.
        const kind = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) ? 'edit'
          : (tool === 'Bash' && disc?.classifyBashWrite ? disc.classifyBashWrite(command) : 'read');
        if (kind === 'read' || kind === 'remedy') process.exit(0);

        const { projections } = await loadSpineLib();

        // Resolve the CALLER's Máddu session: explicit env → the SessionStart
        // binding (Claude id → Máddu id). NO active-session-cache fallback (audit P2
        // F11): an unbound Claude caller must stay unbound rather than inherit the
        // cached active session, or it defeats the null-session gate + Claude counter.
        sid = process.env.MADDU_SESSION_ID || null;
        if (!sid && disc && claudeSessionId) { try { sid = await disc.resolveMadduSession(repoRoot, claudeSessionId); } catch { /* fall through */ } }
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
            nowMs: Date.now(), laneJustClaimed,
          });
        }
        counterKey = decision.counterKey || counterKey;

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
      try {
        // Claude Code pipes the hook payload on stdin ({trigger, session_id,
        // transcript_path, …}); a human running this from a terminal has a TTY
        // there, so skip reading to avoid blocking on interactive stdin.
        let payload = {};
        if (!process.stdin.isTTY) {
          let raw = '';
          try {
            for await (const chunk of process.stdin) raw += chunk;
            if (raw.trim()) payload = JSON.parse(raw);
          } catch { payload = {}; }
        }
        const { spine, projections } = await loadSpineLib();
        const proj = await projections.project(repoRoot);
        const stops = Array.isArray(proj.sliceStops) ? proj.sliceStops : [];
        const last = stops.length ? stops[stops.length - 1] : null;
        // Discipline snapshot (non-load-bearing open fields): don't compact over
        // undisciplined state silently. Best-effort; fail-safe to nulls.
        let uncommittedFiles = null, editsSinceSlice = null;
        try {
          const disc = await loadLib('discipline.mjs');
          if (disc) {
            uncommittedFiles = (await disc.dirtyFiles(repoRoot)).length;
            const sid2 = process.env.MADDU_SESSION_ID || (payload.session_id ? await disc.resolveMadduSession(repoRoot, payload.session_id) : null);
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
    const bin = lib.resolveHookBin ? await lib.resolveHookBin(repoRoot) : undefined;
    // On remove, also strip Máddu's statusLine (if present) — never leave a
    // dangling `status --line` pointing at removed wiring. On install, only wire
    // the statusLine when --statusline is passed (opt-in).
    let statusLineSkipped = false;
    let next;
    if (removing) {
      next = lib.stripMaddu(settings);
      if (lib.stripStatusLine) next = lib.stripStatusLine(next);
    } else {
      next = lib.mergeInstall(settings, { bin });
      if (flags.statusline && lib.mergeStatusLine) {
        const merged = lib.mergeStatusLine(next, { bin });
        next = merged.settings;
        statusLineSkipped = merged.skipped;
      }
    }
    const before = JSON.stringify(settings);
    const after = JSON.stringify(next);
    if (before === after) {
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
    if (removing) {
      console.log(`\x1b[32mremoved\x1b[0m Máddu hooks → ${lib.settingsPath(repoRoot)}`);
    } else {
      const { installed } = lib.summarize(next);
      console.log(`\x1b[32minstalled\x1b[0m Máddu hooks (${installed.join(', ')}) → ${lib.settingsPath(repoRoot)}`);
      console.log(`  Every Claude Code session now auto-registers, sweeps stale sessions + orphaned`);
      console.log(`  claims, auto-claims a lane before the first edit, and checkpoints before compaction.`);
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
