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
import { loadLibOptional } from './_libroot.mjs';

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

// Resolve --session, falling back to MADDU_SESSION_ID env var, then to
// the cached active id. Self-heals stale cache entries (session already
// closed in the spine).
async function resolveSession(flags, repoRoot, sessionActive) {
  if (flags.session && flags.session !== true) return flags.session;
  // v0.19.1 PR-B1: env-var fallback (matches advise / team / pipeline).
  if (process.env.MADDU_SESSION_ID) return process.env.MADDU_SESSION_ID;
  if (!sessionActive) return null;
  const result = await sessionActive.readActiveSessionVerified(repoRoot);
  if (!result) return null;
  // v1.111.0 discriminated union. `unverified` resolves (lenient, never a
  // clear trigger); stale/invalid clear honestly — the message states
  // whether the clear actually happened (a racing rewrite can make the CAS
  // decline; the cache then self-heals on the next register).
  if (result.kind === 'active' || result.kind === 'unverified') return result.record.sessionId;
  if (result.kind === 'stale') {
    const cleared = await sessionActive.clearActiveSessionIf(repoRoot, result.sessionId);
    console.error(`active session ${result.sessionId} is already closed${cleared ? ' (cache cleared)' : ' (cache present but not cleared — self-heals on next register)'}.`);
    console.error(`Run 'maddu session start "<label>"' to register a new one.`);
    process.exit(3);
  }
  if (result.kind === 'invalid') {
    const cleared = await sessionActive.clearActiveSessionInvalid(repoRoot, result.raw);
    console.error(`active-session cache is unreadable${cleared ? ' (invalid cache cleared)' : ' (cache present but not cleared — self-heals on next register)'}.`);
    console.error(`Run 'maddu session start "<label>"' to register a new one.`);
    process.exit(3);
  }
  return null;
}

async function doRegister(spine, sessionActive, repoRoot, { id, role, label, focus, runtime, lane, parentSessionId }, sessionLifecycle = null) {
  const makeEvent = (sessionId) => ({
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
  let sessionId, ev;
  if (sessionLifecycle && sessionLifecycle.registerSessionUnique) {
    // v1.111.0: ALL registration goes through the close-locked uniqueness
    // transaction. Explicit ids are strict-grammar validated and duplicate-
    // rejected (a same-id registration after a close must never resurrect
    // the closed session); generated ids are existence-checked with a
    // bounded regenerate.
    const res = await sessionLifecycle.registerSessionUnique(repoRoot, { id: id !== undefined && id !== true ? id : undefined, makeEvent });
    if (res.status === 'invalid-id') {
      console.error(`invalid session id (must match ses_[A-Za-z0-9_]{1,64}) — omit --id to generate one`);
      process.exit(2);
    }
    if (res.status === 'exists') {
      console.error(`session id already exists on the spine (${res.sessionId}) — omit --id to register a new session`);
      process.exit(2);
    }
    if (res.status === 'lock' || res.status === 'spine-corrupt') {
      console.error(res.status === 'lock'
        ? '(session lock busy — retry, or omit --id)'
        : '(spine has malformed lines — explicit-id registration refused; run maddu verify)');
      process.exit(1);
    }
    sessionId = res.sessionId; ev = res.event;
  } else {
    // Legacy fallback (older installed lib without session-lifecycle.mjs).
    sessionId = (id && id !== true) ? id : spine.genSessionId();
    ev = await spine.append(repoRoot, makeEvent(sessionId));
  }
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
  const { paths, spine, projections, sessionActive, sessionLifecycle } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu session <register|start|heartbeat|close|active|list|sweep> [flags]');
    process.exit(2);
  }

  // `session sweep` — CLI-side stale-session janitor. The projection janitor
  // only runs inside the bridge (on /bridge/projection GET), so CLI-first work
  // never auto-closes stale sessions or releases the lane claims they leaked.
  // This runs the same evaluation on demand: auto-close sessions past the
  // configured threshold (default 4h) and — via the projection's close cascade
  // — release every claim they held. Best-effort, idempotent, rule-#9 clean
  // (SESSION_AUTO_CLOSED carries the allowlisted `janitor:sessions` trigger).
  if (sub === 'sweep') {
    const { flags } = parseFlags(rest);
    const janitor = await loadLibOptional('janitor.mjs');
    if (!janitor || !janitor.reconcileStale) {
      console.error('janitor lib not present on this install — run "maddu upgrade".');
      process.exit(2);
    }
    const report = await janitor.reconcileStale(repoRoot, projections);
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return; }
    const released = report.orphanedClaimsReleased || [];
    console.log(`session sweep — ${report.autoClosed} session(s) auto-closed, ${report.staleDetected} newly stale, ${released.length} orphaned claim(s) released`);
    for (const c of released) console.log(`  released lane ${c.lane} (was held by closed session ${c.sessionId})`);
    if ((report.orphanedWorktrees || []).length) {
      console.log(`  \x1b[33m⚠ ${report.orphanedWorktrees.length} orphaned worktree(s)\x1b[0m — disposition with 'maddu lane release <lane> --worktree <merged|abandoned|keep>':`);
      for (const w of report.orphanedWorktrees) console.log(`    ${w.lane}  ${w.path}`);
    }
    return;
  }

  if (sub === 'register') {
    const { flags } = parseFlags(rest);
    const { sessionId, ev } = await doRegister(spine, sessionActive, repoRoot, {
      id: flags.id, role: flags.role, label: flags.label, focus: flags.focus,
      runtime: flags.runtime, lane: flags.lane,
      parentSessionId: flags.parent || process.env.MADDU_PARENT_SESSION_ID || null
    }, sessionLifecycle);
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
    }, sessionLifecycle);
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
    const hbEv = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SESSION_HEARTBEAT,
      actor: sessionId,
      lane: flags.lane || null,
      data: { focus: flags.focus || null }
    });
    if (process.stdout.isTTY) console.log(`heartbeat  ${sessionId}`);

    // Focus Director — the per-turn pulse. Tag the trajectory vs the declared
    // goal (deterministic, cheap — no LLM) and flag sustained drift. Rule-#9
    // gauntlet: gated on `heartbeat:focus-director`. Best-effort; a focus
    // failure must never break a heartbeat.
    try {
      const gauntlet = await loadLibOptional('gauntlet.mjs');
      if (gauntlet && await gauntlet.isAllowed(repoRoot, 'heartbeat:focus-director')) {
        const ft = await loadLibOptional('focus-trigger.mjs');
        if (ft) {
          const res = await ft.maybeTagFocus(repoRoot, hbEv, sessionId, { kind: 'heartbeat', id: 'focus-director', fired_at: hbEv.ts });
          if (res?.flagged && process.stdout.isTTY) {
            console.log(`  focus: DRIFT FLAGGED (${res.runs} turns off-axis) → \`maddu orient\``);
          }
        }
      }
    } catch { /* best-effort — never break a heartbeat */ }
    return;
  }

  if (sub === 'close') {
    const { flags } = parseFlags(rest);
    const sessionId = await resolveSession(flags, repoRoot, sessionActive);
    if (!sessionId) {
      console.error('--session required (no active session cached for this repo)');
      process.exit(2);
    }
    if (sessionLifecycle && sessionLifecycle.closeSessionIfActive) {
      // v1.111.0: conditional serialized close. Post-close effects (learn
      // detection below) run ONLY on a real close; every other status maps
      // to an explicit message + exit. `--handoff` strings are wrapped to
      // the schema's object shape by the helper's normalization.
      const res = await sessionLifecycle.closeSessionIfActive(repoRoot, {
        sessionId,
        eventType: spine.EVENT_TYPES.SESSION_CLOSED,
        data: { handoff: flags.handoff && flags.handoff !== true ? flags.handoff : null },
      });
      if (res.status === 'already-closed') { console.log(`(already closed)  ${sessionId}`); return; }
      if (res.status === 'missing') {
        console.error(`no such session on the spine: ${sessionId}`);
        process.exit(2);
      }
      if (res.status === 'lock') {
        console.error('(close lock busy — retry)');
        process.exit(1);
      }
      if (res.status === 'spine-corrupt') {
        console.error('(spine has malformed lines — close refused; run maddu verify)');
        process.exit(1);
      }
    } else {
      // Legacy fallback (older installed lib): direct append + unconditional
      // clear, exactly the pre-v1.111 behavior.
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.SESSION_CLOSED,
        actor: sessionId,
        lane: null,
        data: { handoff: flags.handoff && flags.handoff !== true ? { summary: flags.handoff } : null }
      });
      if (sessionActive) await sessionActive.clearActiveSession(repoRoot);
    }
    if (process.stdout.isTTY) console.log(`closed  ${sessionId}`);
    // Learn candidate detection at the session boundary (usage-audit Tier 5)
    // — same containment contract as the slice-stop hook-in (post-append,
    // try/catch isolated, bounded window, raced deadline, READ-ONLY preview;
    // see learn-slice-trigger.mjs). A close is often the last chance to
    // surface what this session's failures taught before the context is gone.
    try {
      const lt = await loadLibOptional('learn-slice-trigger.mjs');
      if (lt?.runDetectionPreview) {
        // Same MADDU_SELF_TEST-gated test hook as slice-stop, so the
        // isolation test exercises THIS call site too (Codex round 1).
        const hook = process.env.MADDU_SELF_TEST === '1' ? (process.env.MADDU_TEST_LEARN_DETECTOR || null) : null;
        const res = await lt.runDetectionPreview(repoRoot, {
          sessionId,
          _testThrow: hook === 'throw', _testDelayMs: hook === 'slow' ? 5000 : 0,
        });
        // Not TTY-gated (Codex round 2): agents pipe everything, and an
        // observable line is what lets the isolation test PROVE the
        // throwing path executed (throw → line absent; clean → present).
        if (!res.timedOut && res.candidates.length) {
          console.log(`  learn: ${res.candidates.length} candidate(s) from this session — review: maddu learn digest --spine · accept: maddu learn run --spine`);
        }
      }
    } catch { /* isolation contract: never affects the close */ }
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
    if (result.kind === 'stale') {
      const cleared = await sessionActive.clearActiveSessionIf(repoRoot, result.sessionId);
      console.log(`(no active session — stale cache for ${result.sessionId}${cleared ? ' cleared' : ' present but not cleared; self-heals on next register'})`);
      process.exit(1);
    }
    if (result.kind === 'invalid') {
      const cleared = await sessionActive.clearActiveSessionInvalid(repoRoot, result.raw);
      console.log(`(no active session — cache unreadable${cleared ? '; invalid cache cleared' : '; not cleared, self-heals on next register'})`);
      process.exit(1);
    }
    const rec = result.record;
    const note = result.kind === 'unverified' ? '  (unverified — spine unreadable)' : '';
    console.log(`${rec.sessionId}  ${rec.role || '—'}  ${rec.label ? `"${rec.label}"` : ''}${note}`);
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
