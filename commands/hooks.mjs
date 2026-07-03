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
    'Usage: maddu hooks <install|status|remove> [--dry-run]',
    '',
    '  install     Wire SessionStart (auto-register) + SessionEnd (close) +',
    '              PreCompact (compaction checkpoint) into',
    '              <repo>/.claude/settings.json so every Claude Code session in',
    '              this repo records to the spine. Idempotent; preserves your',
    '              own hooks.',
    '  status      Show which Máddu hooks are installed.',
    '  remove      Remove only Máddu\'s hook entries.',
    '',
    'Once installed, a single auto-registered session flows into `lane claim`',
    'and `slice-stop` with no --session/$MADDU_SESSION_ID. Slice boundaries stay',
    'agent-driven (run `maddu slice-stop` at each); the SessionStart hook nudges.',
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
      // SessionStart: emit additionalContext so the agent sees the session is
      // live and is reminded of the per-slice discipline the hook can't enforce.
      const note = sid
        ? `Máddu session ${sid} auto-registered (recorded in the spine). Claim a lane before editing (\`maddu lane claim <lane>\`) and run \`maddu slice-stop\` at each slice boundary — no --session needed, it resolves the active session.`
        : 'Máddu session discipline active. Run `maddu register`, claim a lane, and `maddu slice-stop` at each slice boundary.';
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note },
      }) + '\n');
      return;
    }
    if (event === 'session-end') {
      await quietly(() => sessionCmd(['close', '--focus', 'session ended (auto)']));
      return;
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
          },
        });
      } catch {}
      process.exit(0);
    }
    console.error(`maddu hooks fire: unknown event "${event}". One of: session-start, session-end, pre-compact.`);
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
    const next = removing ? lib.stripMaddu(settings) : lib.mergeInstall(settings, { bin });
    const before = JSON.stringify(settings);
    const after = JSON.stringify(next);
    if (before === after) {
      console.log(removing ? 'no Máddu hooks present — nothing to remove.' : '\x1b[32mMáddu hooks already installed\x1b[0m — no changes.');
      return;
    }
    if (flags['dry-run']) {
      console.log(`(dry-run) would ${removing ? 'remove Máddu hooks from' : 'install Máddu hooks into'}:`);
      console.log(`  ${lib.settingsPath(repoRoot)}`);
      return;
    }
    const eol = existed && raw && raw.includes('\r\n') ? '\r\n' : '\n';
    await lib.saveSettings(repoRoot, next, { eol });
    if (removing) {
      console.log(`\x1b[32mremoved\x1b[0m Máddu hooks → ${lib.settingsPath(repoRoot)}`);
    } else {
      const { installed } = lib.summarize(next);
      console.log(`\x1b[32minstalled\x1b[0m Máddu hooks (${installed.join(', ')}) → ${lib.settingsPath(repoRoot)}`);
      console.log(`  Every Claude Code session in this repo now auto-registers, records to the spine,`);
      console.log(`  and writes a governance checkpoint before every context compaction.`);
      console.log(`  Remove with \x1b[1mmaddu hooks remove\x1b[0m.`);
    }
    return;
  }

  console.error(`maddu hooks: unknown subcommand "${sub}". One of: install, status, remove.`);
  process.exit(2);
}
