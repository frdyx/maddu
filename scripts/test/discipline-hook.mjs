#!/usr/bin/env node
// discipline-hook — the PreToolUse hook CONTRACT (P3). Drives the real
// `maddu hooks fire pre-tool-use` handler against a hermetic temp `.maddu/`
// root and asserts the emitted Claude Code output shape:
//   • mutating Edit with no governing session → permissionDecision:'deny'
//   • read-only tool                          → no output (allow)
//   • Bash remedy (slice-stop / git commit)   → no output (never gated)
// Resolved outside writes are allowed silently without claims, spine events, or counter changes; inside/unknown writes remain gated.
//
// Hermetic: a fresh temp dir with an empty `.maddu/` marker makes the CLI
// resolve its state root THERE (never the framework template), and no
// MADDU_SESSION_ID is exported, so the handler writes nothing to the live spine.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/maddu.mjs', import.meta.url));

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// Fire the hook with `payload` on stdin, cwd=repo, MADDU_SESSION_ID stripped.
function fire(repo, payload) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.MADDU_SESSION_ID;
    delete env.MADDU_STATE_ROOT;
    const child = spawn(process.execPath, [BIN, 'hooks', 'fire', 'pre-tool-use'], { cwd: repo, env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

let repo;
try {
  repo = await mkdtemp(join(tmpdir(), 'maddu-disc-'));
  await mkdir(join(repo, '.maddu'), { recursive: true }); // marker → CLI resolves state root here

  // Target-aware gate: the second temp dir is a sibling, never under repo.
  // The hook only receives these command strings; it does not execute writes.
  {
    const outside = await mkdtemp(join(tmpdir(), 'maddu-disc-outside-'));
    try {
      const filePath = join(outside, 'scratch file.txt');
      const quote = (p) => `"${p.replaceAll('\\', '/')}"`;
      const allowed = (r) => r.code === 0 && r.out === '' && !/would have exited/.test(r.err || '');
      const denied = (r) => {
        let json = null; try { json = JSON.parse(r.out); } catch {}
        return r.code === 0 && json?.hookSpecificOutput?.hookEventName === 'PreToolUse'
          && json?.hookSpecificOutput?.permissionDecision === 'deny';
      };
      // Include directories and file bytes: checking claims.json alone misses
      // append-only LANE_CLAIMED events, session mints, and counter writes.
      const tree = async (dir) => {
        const rows = [];
        const walk = async (at, prefix = '') => {
          const entries = await readdir(at, { withFileTypes: true });
          entries.sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            const name = `${prefix}${entry.name}`;
            if (entry.isDirectory()) {
              rows.push([`${name}/`]);
              await walk(join(at, entry.name), `${name}/`);
            } else rows.push([name, (await readFile(join(at, entry.name))).toString('base64')]);
          }
        };
        await walk(dir);
        return JSON.stringify(rows);
      };
      // Receipts include workspace, so compare two fresh incarnations at the
      // SAME absolute path. Only ts/ms may be normalized; workspace stays exact.
      const readControl = async (dir) => {
        const absolute = resolve(dir);
        const knownRepo = absolute === resolve(repo) && dirname(absolute) === resolve(tmpdir());
        const knownSessionRepo = absolute === resolve(join(outside, 'session-repo'))
          && dirname(absolute) === resolve(outside);
        if (!knownRepo && !knownSessionRepo) throw new Error('read control escaped its owned fixture');
        const fresh = await tree(absolute);
        if (fresh !== JSON.stringify([['.maddu/']])) throw new Error('read control requires a fresh empty repo');
        const result = await fire(absolute, { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: absolute });
        const footprint = await tree(absolute);
        // The absolute deletion target was checked above; it is an owned temp
        // fixture, and the child has exited. Recreate precisely its fresh state.
        await rm(absolute, { recursive: true, force: true });
        await mkdir(join(absolute, '.maddu'), { recursive: true });
        if (await tree(absolute) !== fresh) throw new Error('read control did not restore the fresh fixture');
        return { result, footprint };
      };
      const compareFootprints = (writeSnapshot, readSnapshot) => {
        try {
          const normalize = (snapshot) => JSON.stringify(JSON.parse(snapshot).map((row) => {
            if (row[0] !== '.maddu/state/invocation-receipts.ndjson') return row;
            const lines = Buffer.from(row[1], 'base64').toString('utf8').split('\n').map((line) => {
              if (line === '') return line; // preserve blank lines and the final newline
              const receipt = JSON.parse(line);
              if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('invalid invocation receipt');
              delete receipt.ts;
              delete receipt.ms;
              return JSON.stringify(receipt);
            });
            return [row[0], Buffer.from(lines.join('\n')).toString('base64')];
          }));
          return { equal: normalize(writeSnapshot) === normalize(readSnapshot), error: '' };
        } catch (e) { return { equal: false, error: String(e?.message || e) }; }
      };
      // These prohibitions are independent of the read footprint: even a read
      // regression must not authorize claims, events, registration, or counters.
      const noGovernanceTrace = (snapshot) => {
        const files = new Map(JSON.parse(snapshot).filter((row) => row.length === 2));
        const forbidden = [...files.keys()].filter((name) =>
          (name.startsWith('events/') && Buffer.from(files.get(name), 'base64').toString('utf8').trim() !== '')
          || name.startsWith('sessions/')
          || (name.startsWith('state/discipline/') && name !== 'state/discipline/sessions.json')
          || name === 'state/session.active.json' || name === 'state/counters.json');
        let noClaims = true, noBindings = true;
        if (files.has('lanes/claims.json')) {
          try {
            const claims = JSON.parse(Buffer.from(files.get('lanes/claims.json'), 'base64').toString('utf8'));
            noClaims = Array.isArray(claims.claims) && claims.claims.length === 0;
          } catch { noClaims = false; }
        }
        if (files.has('state/discipline/sessions.json')) {
          try {
            const bindings = JSON.parse(Buffer.from(files.get('state/discipline/sessions.json'), 'base64').toString('utf8'));
            noBindings = !!bindings && typeof bindings === 'object' && !Array.isArray(bindings) && Object.keys(bindings).length === 0;
          } catch { noBindings = false; }
        }
        return { absent: noClaims && noBindings && forbidden.length === 0, noClaims, noBindings, forbidden };
      };
      const before = await tree(join(repo, '.maddu'));
      const outsideReadControl = await readControl(repo);
      const outsideWrite = await fire(repo, { tool_name: 'Write', tool_input: { file_path: filePath }, cwd: repo });
      ok('hook target: outside absolute Write allows with no stdout and exit 0',
        allowed(outsideWrite), `code=${outsideWrite.code} stdout=${JSON.stringify(outsideWrite.out)}`);
      const afterWrite = await tree(join(repo, '.maddu'));
      const outsideTrace = noGovernanceTrace(afterWrite);
      const outsideFootprints = compareFootprints(await tree(repo), outsideReadControl.footprint);
      // The base denial can match the read footprint. Require the external
      // allowance too, while retaining the unconditional governance prohibitions.
      ok('hook target: outside Write allows without lane claims or spine events',
        outsideTrace.absent && outsideFootprints.equal && allowed(outsideReadControl.result) && allowed(outsideWrite),
        `noGovernance=${outsideTrace.absent} footprintEqual=${outsideFootprints.equal} allow=${allowed(outsideWrite)} ${outsideFootprints.error}`);

      const redirect = `echo x > ${quote(filePath)}`;
      const outsideBash = await fire(repo, { tool_name: 'Bash', tool_input: { command: redirect }, cwd: repo });
      ok('hook target: outside absolute Bash redirect allows with no stdout and exit 0',
        allowed(outsideBash), `code=${outsideBash.code} stdout=${JSON.stringify(outsideBash.out)}`);
      const mixed = await fire(repo, {
        tool_name: 'Bash', tool_input: { command: `${redirect} && echo y > src/a.js` }, cwd: repo,
      });
      ok('hook target: outside Bash allows while a mixed repo redirect denies',
        allowed(outsideBash) && denied(mixed), `mixed=${mixed.out.trim()}`);
      const inside = await fire(repo, { tool_name: 'Edit', tool_input: { file_path: 'x.js' } });
      ok('hook target: outside Write allows while relative Edit without cwd still denies',
        allowed(outsideWrite) && denied(inside), `inside=${inside.out.trim()}`);

      // Child cwd remains repo in fire(); only PAYLOAD cwd changes. Falling
      // back to child cwd would gate these outside relative targets.
      const relativeEdit = await fire(repo, { tool_name: 'Edit', tool_input: { file_path: 'scratch.txt' }, cwd: outside });
      const relativeBash = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'echo x > scratch.txt' }, cwd: outside });
      const missingCwd = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'echo x > scratch.txt' } });
      ok('hook target: payload cwd exempts relative outside writes while missing cwd stays gated',
        allowed(relativeEdit) && allowed(relativeBash) && denied(missingCwd));

      // A real Claude id makes the old path mint a session BEFORE it gates.
      // Compare its footprint with the same anonymous read control, and reject
      // session/counter/claim/event writes even if a read ever starts making them.
      const sessionRepo = join(outside, 'session-repo');
      await mkdir(join(sessionRepo, '.maddu'), { recursive: true });
      const sessionBefore = await tree(join(sessionRepo, '.maddu'));
      const sessionReadControl = await readControl(sessionRepo);
      const sessionWrite = await fire(sessionRepo, {
        session_id: 'claude-outside-write-target', cwd: sessionRepo,
        tool_name: 'Write', tool_input: { file_path: filePath },
      });
      const sessionAfter = await tree(join(sessionRepo, '.maddu'));
      const sessionTrace = noGovernanceTrace(sessionAfter);
      const sessionFootprints = compareFootprints(await tree(sessionRepo), sessionReadControl.footprint);
      ok('hook target: identified outside Write creates no session, lane, event, or counter',
        sessionTrace.absent && sessionFootprints.equal && allowed(sessionReadControl.result) && allowed(sessionWrite),
        `noGovernance=${sessionTrace.absent} footprintEqual=${sessionFootprints.equal} allow=${allowed(sessionWrite)} forbidden=${sessionTrace.forbidden.join(',')} ${sessionFootprints.error}`);

      // Seed a counter under relaxed governance so the unfixed external call
      // is allowed with a nudge and really increments it (a denied edit never
      // bumps, which would make a no-bump-only test vacuous).
      const counterRepo = join(outside, 'counter-repo');
      await mkdir(join(counterRepo, '.maddu', 'config'), { recursive: true });
      await writeFile(join(counterRepo, '.maddu', 'config', 'governance.json'), JSON.stringify({ mode: 'relaxed' }));
      const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
      const sid = 'ses_outside_counter';
      await disc.writeCounter(counterRepo, sid, { editsSinceSlice: 4, goalplanAgeEdits: 2 });
      const counterBefore = await tree(join(counterRepo, '.maddu'));
      const result = await disc.enforcePreTool(counterRepo, {
        tool: 'Write', filePath, cwd: counterRepo, madduSessionId: sid, nowMs: 0,
      });
      const counterAfter = await disc.readCounter(counterRepo, sid);
      const counterTreeAfter = await tree(join(counterRepo, '.maddu'));
      ok('hook target: external allowance leaves a seeded session counter byte-for-byte unchanged',
        result.verdict === 'ok' && result.kind === 'external' && result.mutating === false
        && result.action === 'allow' && result.enforcement === 'n/a'
        && counterAfter.editsSinceSlice === 4 && counterAfter.goalplanAgeEdits === 2
        && counterTreeAfter === counterBefore,
        `kind=${result.kind} edits=${counterAfter.editsSinceSlice} goalEdits=${counterAfter.goalplanAgeEdits}`);

      // Accepted containment hole: a real outside link can address a governed
      // directory. Leave leaf x absent to exercise resolution of a new file
      // through its existing parent, not just realpath of an existing file.
      const { symlinkSync, lstatSync, realpathSync, unlinkSync } = await import('node:fs');
      const link = join(outside, 'link-into-root');
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      let linkCreated = false, linkError = '';
      try {
        symlinkSync(repo, link, linkType);
        linkCreated = true;
        if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(repo)) {
          throw new Error('outside link does not resolve to the governed root');
        }
      } catch (e) {
        linkError = String(e?.stack || e);
      }
      try {
        const linkedPath = join(link, 'x');
        const linkedCommand = `echo x > ${quote(linkedPath)}`;
        let editScope, editResult, editError = linkError;
        let bashScope, bashResult, bashError = linkError;
        // Setup or classifier errors become failed ok() rows with diagnostics;
        // neither missing link privileges nor a missing export skips a row.
        if (!linkError) {
          try {
            editScope = disc.classifyWriteTarget?.({ tool: 'Edit', filePath: linkedPath, cwd: repo, roots: [repo] });
            editResult = await fire(repo, { tool_name: 'Edit', tool_input: { file_path: linkedPath }, cwd: repo });
          } catch (e) { editError = String(e?.stack || e); }
          try {
            bashScope = disc.classifyWriteTarget?.({ tool: 'Bash', command: linkedCommand, cwd: repo, roots: [repo] });
            bashResult = await fire(repo, { tool_name: 'Bash', tool_input: { command: linkedCommand }, cwd: repo });
          } catch (e) { bashError = String(e?.stack || e); }
        }
        ok('hook target hole: outside directory link classifies Edit inside and denies',
          !editError && editScope === 'inside' && denied(editResult),
          editError || `link=${linkType} scope=${editScope} code=${editResult?.code}`);
        ok('hook target hole: outside directory link classifies Bash redirect inside and denies',
          !bashError && bashScope === 'inside' && denied(bashResult),
          bashError || `link=${linkType} scope=${bashScope} code=${bashResult?.code}`);
      } finally {
        // Remove only the link before the enclosing temp-tree cleanup; never
        // traverse it or recursively remove the governed directory it targets.
        if (linkCreated) unlinkSync(link);
      }
    } finally {
      // Validate the absolute cleanup target stays in the temp parent that
      // created it before recursively removing this fixture and its children.
      if (dirname(resolve(outside)) !== resolve(tmpdir())) throw new Error('outside fixture escaped temp parent');
      await rm(outside, { recursive: true, force: true });
    }
  }

  // Round-1 findings 2 and 9. Keep new state and link fixtures inside this
  // worktree; the outside directory is outside the fixture's governed root.
  {
    const { symlinkSync, lstatSync, realpathSync, unlinkSync } = await import('node:fs');
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const fixtureParent = resolve(process.cwd());
    const fixture = await mkdtemp(join(fixtureParent, '.hook-r1-'));
    const governed = join(fixture, 'work');
    const outside = join(fixture, 'outside');
    const quote = (p) => `"${p.replaceAll('\\', '/')}"`;
    const childLink = join(outside, 'dst', 'x');
    let linkCreated = false;
    try {
      await mkdir(join(governed, '.maddu'), { recursive: true });
      await mkdir(join(outside, 'src'), { recursive: true });
      await mkdir(join(outside, 'dst'));

      const uninstall = await disc.enforcePreTool(governed, {
        tool: 'Bash', command: `maddu hooks uninstall > ${quote(join(outside, 'log'))}`,
        cwd: governed, workRoot: governed, madduSessionId: 'invalid/session', nowMs: 0,
      });
      ok('round1 F2: enforcePreTool uninstall with outside stdout keeps self-disable/write kind',
        uninstall.kind === 'self-disable' || uninstall.kind === 'write',
        `expected=self-disable/write actual=${uninstall.kind} action=${uninstall.action}`);

      // Copying this actual file to an existing directory writes dst/x too.
      // On Windows a junction is the privilege-free directory-link equivalent;
      // on POSIX use the exact file-symlink reproduction from finding 9.
      await writeFile(join(outside, 'src', 'x'), 'source\n');
      const linkType = process.platform === 'win32' ? 'junction' : 'file';
      const linkTarget = join(governed, 'x');
      if (linkType === 'junction') await mkdir(linkTarget);
      else await writeFile(linkTarget, 'governed\n');
      let setupError = '';
      try {
        symlinkSync(linkTarget, childLink, linkType);
        linkCreated = true;
        if (!lstatSync(childLink).isSymbolicLink() || realpathSync(childLink) !== realpathSync(linkTarget)) {
          throw new Error('destination child link does not resolve into the governed root');
        }
      } catch (e) { setupError = String(e?.stack || e); }
      let scope, result, error = setupError;
      if (!error) {
        try {
          const command = `cp ${quote(join(outside, 'src', 'x'))} ${quote(join(outside, 'dst'))}`;
          scope = disc.classifyWriteTarget?.({ tool: 'Bash', command, cwd: governed, roots: [governed] });
          result = await fire(governed, { tool_name: 'Bash', tool_input: { command }, cwd: governed });
        } catch (e) { error = String(e?.stack || e); }
      }
      let decision;
      try { decision = JSON.parse(result?.out || '{}').hookSpecificOutput?.permissionDecision; } catch {}
      ok('round1 F9: cp into an existing outside directory follows its linked child and denies',
        !error && scope === 'inside' && result?.code === 0 && decision === 'deny'
          && !/would have exited/.test(result?.err || ''),
        error || `link=${linkType} expected=inside actual=${scope} code=${result?.code} decision=${decision}`);
    } finally {
      if (linkCreated) unlinkSync(childLink);
      if (dirname(resolve(fixture)) !== fixtureParent) throw new Error('round1 hook fixture escaped its parent');
      await rm(fixture, { recursive: true, force: true });
    }
  }

  // (a) mutating Edit, no session governs → deny with a remedy reason.
  // ANONYMOUS payload (no session_id) as of the B1/B2 fix: a claude-id-carrying
  // unbound caller now self-heals via the PreToolUse mint (see
  // session-mint.mjs) — the session block is reachable only when there is no
  // claude id to bind a fresh session to.
  {
    const { out } = await fire(repo, { tool_name: 'Edit', tool_input: { file_path: 'x.js' } });
    let json = null; try { json = JSON.parse(out.trim() || '{}'); } catch {}
    const hso = json && json.hookSpecificOutput;
    ok('Edit + no session → permissionDecision:deny', !!hso && hso.permissionDecision === 'deny', out.trim().slice(0, 80));
    const reason = String((hso && hso.permissionDecisionReason) || '');
    // CORRECTED 2026-08-09. This assertion previously pinned "restart this
    // session" and called it "the honest recovery ... the CLI cannot bind it".
    // That was FALSE, and pinning it made the falsehood self-defending: the
    // Claude session_id is persisted in .maddu/state/discipline/sessions.json
    // and `hooks fire session-start` takes it on STDIN, so an unbound running
    // session is recoverable without a restart (verified in the act). The old
    // wording cost several sessions a needless restart. What must be pinned is
    // that the message names a recovery the operator can actually perform, and
    // that it does NOT resurrect the restart-is-required claim.
    ok('deny reason names the stdin hook recovery', /hooks fire session-start/.test(reason), reason.slice(0, 120));
    ok('deny reason points at the sessions.json lookup', /sessions\.json/.test(reason), reason.slice(0, 120));
    ok('deny reason does NOT claim a restart is required', !/restart this session/i.test(reason), reason.slice(0, 120));
    ok('deny reason still names maddu register as the fallback', /maddu register/.test(reason));
    ok('deny reason event name is PreToolUse', !!hso && hso.hookEventName === 'PreToolUse');
  }

  // (b) read-only tool → no gate, no output
  {
    const { out } = await fire(repo, { tool_name: 'Read', tool_input: { file_path: 'x.js' } });
    ok('Read → no output (allow)', out.trim() === '');
  }

  // (c) Bash remedy commands → never gated, no output
  {
    const a = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'maddu slice-stop "x"' } });
    ok('Bash `maddu slice-stop` remedy → no output', a.out.trim() === '');
    const b = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
    ok('Bash `git commit` remedy → no output', b.out.trim() === '');
  }

  // (c2) Bash reads → not gated (P4: the handler classifies + exits before any
  // auto-claim, so a harmless read never triggers enforcement).
  {
    const r = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    ok('Bash read (ls) → no output (not gated)', r.out.trim() === '');
  }

  // (c3) Bash WRITE with no session → deny (P4: the classifier flags the write,
  // and enforcement blocks it exactly like an Edit).
  {
    const { out } = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'echo x > src/a.js' } });
    let json = null; try { json = JSON.parse(out.trim() || '{}'); } catch {}
    const hso = json && json.hookSpecificOutput;
    ok('Bash `echo x > f` + no session → permissionDecision:deny', !!hso && hso.permissionDecision === 'deny', out.trim().slice(0, 80));
  }
  // (c4) compound write riding a remedy token is still gated (Codex bypass closed)
  {
    const { out } = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'maddu register && echo x > src/a.js' } });
    let json = null; try { json = JSON.parse(out.trim() || '{}'); } catch {}
    ok('Bash `maddu register && echo > f` → deny (not a remedy)', !!(json && json.hookSpecificOutput && json.hookSpecificOutput.permissionDecision === 'deny'));
  }

  // (d) always exits 0 (fail-open contract: the hook never crashes the tool)
  {
    const { code, err, out } = await fire(repo, { tool_name: 'Edit', tool_input: { file_path: 'x.js' } });
    // THIS ASSERTION'S OWN PARENTHETICAL NAMES THE PRINCIPLE, so it is now
    // measured rather than described. `hooks fire` clamps its exit code to 0
    // unconditionally, which makes `code === 0` true by construction — the very
    // universality the parenthetical asserted, and the reason the check stopped
    // being able to fail. What it always meant is a conjunction of three things:
    // the refusal is IN the document, the code is 0, and that 0 is the hook's own
    // rather than one the floor substituted for a failure (which the clamp
    // announces on stderr).
    let json = null; try { json = JSON.parse(out.trim() || '{}'); } catch {}
    const denied = !!(json && json.hookSpecificOutput && json.hookSpecificOutput.permissionDecision === 'deny');
    ok('hook exits 0 even when it denies (deny is via JSON, not exit code)',
      denied && code === 0 && !/would have exited/.test(err || ''),
      `deny=${denied} code=${code} ${(err || '').split('\n')[0].slice(0, 60)}`);
  }

  // (e) per-session counter isolation — two concurrent sessions never cross-reset
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    await disc.writeCounter(repo, 'ses_AAA', { editsSinceSlice: 4, lastSliceStopId: 'A' });
    await disc.writeCounter(repo, 'ses_BBB', { editsSinceSlice: 9, lastSliceStopId: 'B' });
    const a = await disc.readCounter(repo, 'ses_AAA');
    const b = await disc.readCounter(repo, 'ses_BBB');
    ok('counters are per-session (no cross-clobber)', a.editsSinceSlice === 4 && b.editsSinceSlice === 9 && a.lastSliceStopId === 'A' && b.lastSliceStopId === 'B');
  }

  // (e2) bindClaudeSession is atomic under concurrency — no lost update. Two
  // concurrent binds alongside a pre-existing entry must ALL survive; an unlocked
  // read-modify-write would drop one (the load-bearing Codex round-2 finding).
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const repo2 = await mkdtemp(join(tmpdir(), 'maddu-bind-'));
    try {
      await mkdir(join(repo2, '.maddu'), { recursive: true });
      await disc.bindClaudeSession(repo2, 'claude-pre', 'ses_PRE');
      await Promise.all([
        disc.bindClaudeSession(repo2, 'claude-A', 'ses_A'),
        disc.bindClaudeSession(repo2, 'claude-B', 'ses_B'),
      ]);
      const a = await disc.resolveMadduSession(repo2, 'claude-A');
      const b = await disc.resolveMadduSession(repo2, 'claude-B');
      const pre = await disc.resolveMadduSession(repo2, 'claude-pre');
      ok('concurrent binds never lose an entry', a === 'ses_A' && b === 'ses_B' && pre === 'ses_PRE', `A=${a} B=${b} pre=${pre}`);
    } finally { try { await rm(repo2, { recursive: true, force: true }); } catch {} }
  }

  // (e3) first-ever bind in a fresh repo (no discipline/ dir yet) succeeds — the
  // lock's O_EXCL create would ENOENT without the mkdir-before-lock (Codex round-2).
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const repo3 = await mkdtemp(join(tmpdir(), 'maddu-bind0-'));
    try {
      await mkdir(join(repo3, '.maddu'), { recursive: true });
      const okBind = await disc.bindClaudeSession(repo3, 'claude-fresh', 'ses_FRESH');
      const got = await disc.resolveMadduSession(repo3, 'claude-fresh');
      ok('first bind in a fresh repo creates the dir + persists', okBind === true && got === 'ses_FRESH', `okBind=${okBind} got=${got}`);
    } finally { try { await rm(repo3, { recursive: true, force: true }); } catch {} }
  }

  // (e4) a rebind of the SAME claude id overwrites its own mapping (a restarted
  // session re-binding to its new Máddu id must replace the stale one, not dup).
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const repo4 = await mkdtemp(join(tmpdir(), 'maddu-rebind-'));
    try {
      await mkdir(join(repo4, '.maddu'), { recursive: true });
      await disc.bindClaudeSession(repo4, 'claude-X', 'ses_OLD');
      await disc.bindClaudeSession(repo4, 'claude-X', 'ses_NEW');
      const got = await disc.resolveMadduSession(repo4, 'claude-X');
      ok('rebind overwrites the same claude id', got === 'ses_NEW', `got=${got}`);
    } finally { try { await rm(repo4, { recursive: true, force: true }); } catch {} }
  }

  // (e5) a corrupt sessions.json is NEVER clobbered — bind returns false and the
  // bad file is left byte-for-byte intact (readSessionsMapStrict propagates a parse
  // error instead of silently starting from {} and dropping surviving bindings).
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const { pathsFor } = await import('../../template/maddu/runtime/lib/paths.mjs');
    const { writeFile, readFile } = await import('node:fs/promises');
    const repo5 = await mkdtemp(join(tmpdir(), 'maddu-corrupt-'));
    try {
      await mkdir(join(repo5, '.maddu'), { recursive: true });
      // A real bind creates sessions.json at the canonical path; then corrupt it.
      await disc.bindClaudeSession(repo5, 'claude-keep', 'ses_KEEP');
      const mapPath = join(pathsFor(repo5).statePrjDir, 'discipline', 'sessions.json');
      const garbage = '{ this is not json ';
      await writeFile(mapPath, garbage);
      const okBind = await disc.bindClaudeSession(repo5, 'claude-Z', 'ses_Z');
      const after = await readFile(mapPath, 'utf8');
      ok('corrupt map → bind returns false, file untouched', okBind === false && after === garbage, `okBind=${okBind}`);
      // Valid JSON of the WRONG shape (an array) must also be rejected — otherwise
      // map[claudeId]=… would be dropped on re-serialize and bind would falsely
      // report success (Codex P3).
      const wrongShape = '[]';
      await writeFile(mapPath, wrongShape);
      const okArr = await disc.bindClaudeSession(repo5, 'claude-Z', 'ses_Z');
      const afterArr = await readFile(mapPath, 'utf8');
      ok('wrong-shape map (array) → bind returns false, file untouched', okArr === false && afterArr === wrongShape, `okArr=${okArr}`);
    } finally { try { await rm(repo5, { recursive: true, force: true }); } catch {} }
  }

  // (e6) END-TO-END concurrent SessionStart: two starts with distinct Claude ids
  // must bind to DISTINCT Máddu sessions. Before the fix the handler re-read the
  // shared active pointer after register, so a concurrent start could bind both
  // Claude ids to one session (Codex). Drives the real `hooks fire session-start`.
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const repo6 = await mkdtemp(join(tmpdir(), 'maddu-start-'));
    try {
      await mkdir(join(repo6, '.maddu'), { recursive: true });
      const start = (claudeId) => new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.MADDU_SESSION_ID; delete env.MADDU_STATE_ROOT;
        const child = spawn(process.execPath, [BIN, 'hooks', 'fire', 'session-start'], { cwd: repo6, env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', reject);
        child.on('close', () => resolve(out));
        child.stdin.write(JSON.stringify({ session_id: claudeId }));
        child.stdin.end();
      });
      await Promise.all([start('claude-1'), start('claude-2')]);
      const s1 = await disc.resolveMadduSession(repo6, 'claude-1');
      const s2 = await disc.resolveMadduSession(repo6, 'claude-2');
      ok('concurrent SessionStarts bind to distinct sessions', !!s1 && !!s2 && s1 !== s2, `s1=${s1} s2=${s2}`);
    } finally { try { await rm(repo6, { recursive: true, force: true }); } catch {} }
  }
} catch (e) {
  console.error('discipline-hook harness error:', e && e.message);
  process.exit(2);
} finally {
  if (repo) { try { await rm(repo, { recursive: true, force: true }); } catch {} }
}

console.log('');
console.log(`discipline-hook: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('discipline-hook OK');
process.exit(0);
