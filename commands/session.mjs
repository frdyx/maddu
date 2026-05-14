// `maddu session <subcommand>` — register / heartbeat / close / list.
//
// Usage:
//   maddu session register --role implementer --label "Claude — slice 3" --focus "..."
//   maddu session heartbeat --session <id> [--focus "..."] [--lane <id>]
//   maddu session close --session <id> [--handoff "..."]
//   maddu session list

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function session(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu session <register|heartbeat|close|list> [flags]');
    process.exit(2);
  }

  if (sub === 'register') {
    const { flags } = parseFlags(rest);
    const sessionId = flags.id || spine.genSessionId();
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SESSION_REGISTERED,
      actor: sessionId,
      lane: null,
      data: {
        role: flags.role || null,
        label: flags.label || null,
        focus: flags.focus || null,
        runtime: flags.runtime || null
      }
    });
    console.log(sessionId);
    if (process.stdout.isTTY) {
      console.log(`  registered  ${fmtTime(ev.ts)}`);
      console.log(`  role:   ${flags.role || '—'}`);
      console.log(`  label:  ${flags.label || '—'}`);
      console.log(`  focus:  ${flags.focus || '—'}`);
    }
    return;
  }

  if (sub === 'heartbeat') {
    const { flags } = parseFlags(rest);
    const sessionId = requireFlag(flags, 'session');
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SESSION_HEARTBEAT,
      actor: sessionId,
      lane: flags.lane || null,
      data: { focus: flags.focus || null }
    });
    if (process.stdout.isTTY) console.log(`heartbeat  ${sessionId}`);
    return;
  }

  if (sub === 'close') {
    const { flags } = parseFlags(rest);
    const sessionId = requireFlag(flags, 'session');
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SESSION_CLOSED,
      actor: sessionId,
      lane: null,
      data: { handoff: flags.handoff || null }
    });
    if (process.stdout.isTTY) console.log(`closed  ${sessionId}`);
    return;
  }

  if (sub === 'list') {
    const proj = await projections.project(repoRoot);
    console.log(`\x1b[1mACTIVE (${proj.activeSessions.length})\x1b[0m`);
    for (const s of proj.activeSessions) {
      console.log(`  ${s.id}  ${s.role || '—'}  ${s.label || ''}`);
    }
    const closed = proj.sessions.filter((s) => s.status === 'closed');
    console.log(`\n\x1b[1mCLOSED (${closed.length})\x1b[0m`);
    for (const s of closed.slice(-10)) {
      console.log(`  ${s.id}  ${s.role || '—'}  ${s.label || ''}`);
    }
    return;
  }

  console.error(`maddu session: unknown subcommand "${sub}"`);
  process.exit(2);
}
