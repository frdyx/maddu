// `maddu session <subcommand>` — register / start / heartbeat / close / list / active.
//
// Usage:
//   maddu session register --role implementer --label "Claude — slice 3" --focus "..."
//   maddu session start "<label>" [--role implementer] [--focus "..."] [--lane <id>] [--runtime <name>]
//   maddu session heartbeat [--session <id>] [--focus "..."] [--lane <id>]
//   maddu session close     [--session <id>] [--handoff "..."]
//   maddu session active
//   maddu session list
//
// Active session cache (v0.14+): `register` and `start` write the new id to
// .maddu/state/session.active.json. `heartbeat` and `close` default
// `--session` to that cached id; `close` clears it on success. The cache
// self-heals — if it points at a session already closed in the spine, the
// CLI clears it and asks the user to start a new one.

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

// Resolve --session, falling back to the cached active id. Self-heals
// stale cache entries (session already closed in the spine).
async function resolveSession(flags, repoRoot, sessionActive) {
  if (flags.session) return flags.session;
  if (!sessionActive) return null;
  const result = await sessionActive.readActiveSessionVerified(repoRoot);
  if (!result) return null;
  if (result.stale) {
    await sessionActive.clearActiveSession(repoRoot);
    console.error(`active session ${result.sessionId} is already closed (cache cleared).`);
    console.error(`Run 'maddu session start "<label>"' to register a new one.`);
    process.exit(3);
  }
  return result.sessionId;
}

async function doRegister(spine, sessionActive, repoRoot, { id, role, label, focus, runtime, lane, parentSessionId }) {
  const sessionId = id || spine.genSessionId();
  const ev = await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.SESSION_REGISTERED,
    actor: sessionId,
    lane: lane || null,
    data: {
      role: role || null,
      label: label || null,
      focus: focus || null,
      runtime: runtime || null,
      // v0.17 Phase 2: optional tree provenance. Old events without
      // parentSessionId remain valid (verify-spine treats absence as null).
      ...(parentSessionId ? { parentSessionId } : {})
    }
  });
  if (sessionActive) {
    await sessionActive.writeActiveSession(repoRoot, {
      sessionId,
      registeredAt: ev.ts,
      role: role || null,
      label: label || null,
      lane: lane || null
    });
  }
  return { sessionId, ev };
}

export default async function session(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections, sessionActive } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu session <register|start|heartbeat|close|active|list> [flags]');
    process.exit(2);
  }

  if (sub === 'register') {
    const { flags } = parseFlags(rest);
    const { sessionId, ev } = await doRegister(spine, sessionActive, repoRoot, {
      id: flags.id, role: flags.role, label: flags.label, focus: flags.focus,
      runtime: flags.runtime, lane: flags.lane,
      parentSessionId: flags.parent || process.env.MADDU_PARENT_SESSION_ID || null
    });
    console.log(sessionId);
    if (process.stdout.isTTY) {
      console.log(`  registered  ${fmtTime(ev.ts)}`);
      console.log(`  role:   ${flags.role || '—'}`);
      console.log(`  label:  ${flags.label || '—'}`);
      console.log(`  focus:  ${flags.focus || '—'}`);
      if (sessionActive) console.log(`  (active session cached — heartbeat / close default to this)`);
    }
    return;
  }

  // `session start "<label>"` — shorthand wrapper around register with
  // sane defaults. The positional label is required; everything else
  // optional. Cleanest one-line bootstrap for a fresh shell.
  if (sub === 'start') {
    const { flags, positional } = parseFlags(rest);
    const label = positional[0];
    if (!label) {
      console.error('Usage: maddu session start "<label>" [--role implementer] [--focus "..."] [--lane <id>] [--runtime <name>]');
      process.exit(2);
    }
    const { sessionId, ev } = await doRegister(spine, sessionActive, repoRoot, {
      id: flags.id,
      role: flags.role || 'implementer',
      label,
      focus: flags.focus || label,
      runtime: flags.runtime,
      lane: flags.lane,
      parentSessionId: flags.parent || process.env.MADDU_PARENT_SESSION_ID || null
    });
    console.log(sessionId);
    if (process.stdout.isTTY) {
      console.log(`  started  ${fmtTime(ev.ts)}  role=${flags.role || 'implementer'}  label="${label}"`);
      if (sessionActive) console.log(`  (active session cached — 'maddu session heartbeat' / 'close' default to this)`);
      else console.log(`  (session-active helper missing on this install — run 'maddu upgrade' to enable the cache)`);
    }
    return;
  }

  if (sub === 'heartbeat') {
    const { flags } = parseFlags(rest);
    const sessionId = await resolveSession(flags, repoRoot, sessionActive);
    if (!sessionId) {
      console.error('--session required (no active session cached for this repo)');
      console.error('  Run "maddu session start \\"<label>\\"" or pass --session <id>.');
      process.exit(2);
    }
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
    const sessionId = await resolveSession(flags, repoRoot, sessionActive);
    if (!sessionId) {
      console.error('--session required (no active session cached for this repo)');
      process.exit(2);
    }
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SESSION_CLOSED,
      actor: sessionId,
      lane: null,
      data: { handoff: flags.handoff || null }
    });
    if (sessionActive) await sessionActive.clearActiveSession(repoRoot);
    if (process.stdout.isTTY) console.log(`closed  ${sessionId}`);
    return;
  }

  if (sub === 'active') {
    if (!sessionActive) {
      console.error('(session-active helper missing — run "maddu upgrade" to enable the active-session cache)');
      process.exit(1);
    }
    const result = await sessionActive.readActiveSessionVerified(repoRoot);
    if (!result) {
      console.log('(no active session)');
      process.exit(1);
    }
    if (result.stale) {
      await sessionActive.clearActiveSession(repoRoot);
      console.log(`(no active session — stale cache for ${result.sessionId} cleared)`);
      process.exit(1);
    }
    console.log(`${result.sessionId}  ${result.role || '—'}  ${result.label ? `"${result.label}"` : ''}`);
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

  // v0.17 Phase 2 — `maddu session tree [--root <id>]`
  //
  // Prints an ASCII tree of sessions using sessionsTree projection slot.
  // --root filters to just that subtree (useful when a parent fans out
  // dozens of children and the operator only cares about one branch).
  if (sub === 'tree') {
    const { flags } = parseFlags(rest);
    const proj = await projections.project(repoRoot);
    const tree = proj.sessionsTree || {};
    const labelOf = (id) => {
      const s = proj.sessions.find((x) => x.id === id);
      const dim = (str) => process.stdout.isTTY ? `\x1b[2m${str}\x1b[0m` : str;
      const stale = tree[id]?.state === 'closed' ? dim(' [closed]') : '';
      return `${id}  ${s?.label || dim('—')}${stale}`;
    };
    const roots = flags.root
      ? (tree[flags.root] ? [flags.root] : [])
      : Object.keys(tree).filter((id) => !tree[id].parentSessionId).sort();
    if (roots.length === 0) {
      if (flags.root) console.error(`(no session ${flags.root} in tree)`);
      else console.log('(no sessions registered)');
      return;
    }
    const draw = (id, prefix, depth, isLast) => {
      const branch = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ');
      console.log(`${prefix}${branch}${labelOf(id)}`);
      const next = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
      const kids = (tree[id]?.childSessionIds || []).slice();
      kids.forEach((k, i) => draw(k, next, depth + 1, i === kids.length - 1));
    };
    for (const r of roots) draw(r, '', 0, true);
    return;
  }

  console.error(`maddu session: unknown subcommand "${sub}"`);
  process.exit(2);
}
