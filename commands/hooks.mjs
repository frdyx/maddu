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
    'Usage: maddu hooks <install|status|remove> [--statusline] [--dry-run]',
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
      await quietly(() => registerCmd([]));
      const { sessionActive } = await loadSpineLib();
      let sid = null;
      if (sessionActive && sessionActive.readActiveSession) {
        const a = await sessionActive.readActiveSession(repoRoot);
        sid = a && a.sessionId;
      }
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
      try {
        if (process.stdin.isTTY) process.exit(0); // human at a terminal → no gate
        let raw = '';
        for await (const chunk of process.stdin) raw += chunk;
        const payload = raw.trim() ? JSON.parse(raw) : {};
        const tool = payload.tool_name || null;
        const ti = payload.tool_input || {};
        const filePath = ti.file_path || ti.notebook_path || null;
        const command = ti.command || null;
        const claudeSessionId = payload.session_id || null;

        const disc = await loadLib('discipline.mjs');
        const { projections, sessionActive } = await loadSpineLib();

        // Resolve the CALLER's Máddu session: explicit env → the SessionStart
        // binding (Claude id → Máddu id) → the active-session cache. The binding
        // is what keeps concurrent Claude sessions from cross-resetting counters.
        let sid = process.env.MADDU_SESSION_ID || null;
        if (!sid && disc && claudeSessionId) { try { sid = await disc.resolveMadduSession(repoRoot, claudeSessionId); } catch { /* fall through */ } }
        if (!sid && sessionActive?.readActiveSession) {
          const a = await sessionActive.readActiveSession(repoRoot);
          sid = a && a.sessionId;
        }

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
        // per-session counter). Any internal error → verdict 'ok' (fail-open).
        let decision = { verdict: 'ok' };
        if (disc && disc.enforcePreTool) {
          decision = await disc.enforcePreTool(repoRoot, {
            madduSessionId: sid, claudeSessionId, tool, filePath, command,
            nowMs: Date.now(), laneJustClaimed,
          });
        }

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
        // 'warn' (graduated: the pre-block reminder) and 'nudge' (relaxed) both
        // surface as non-blocking context — without this the graduated "warn then
        // block" ramp would be invisible until the block landed (Codex).
        if (decision.verdict === 'nudge' || decision.verdict === 'warn') {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: `Máddu discipline — ${decision.reason}. Consider: ${decision.remedy}`,
            },
          }) + '\n');
          process.exit(0);
        }
      } catch { /* fail open */ }
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
  if (sub === 'install' || sub === 'remove') {
    const { flags } = parseFlags(rest);
    const removing = sub === 'remove';
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
