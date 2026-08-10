#!/usr/bin/env node
// session-mint — the PreToolUse self-heal contract (B1/B2, session lifecycle).
//
// Supervisor-authored adversarial suite (the implementing actor never writes
// its own suite). Drives the REAL `maddu hooks fire` handlers against
// hermetic temp repos and pins the liveness-aware sid resolution:
//
//   • a DEAD env sid must not shadow the caller's own LIVE binding (B2)
//   • a caller whose identity resolves to no live session — bound-but-dead
//     (the B1 victim state: a worker's SessionEnd closed the parent's session
//     but the parent's own binding survives) or never-bound — gets a FRESH
//     minted session, bound to its claude id, provenance-marked on the spine
//     (`source: 'pretooluse-mint'`). Never an ADOPTED one (audit P2 F11).
//   • the mint is once-per-identity: the next call resolves the new binding,
//     it does not mint again
//   • an anonymous caller (no claude id) is never minted for — nothing to
//     bind — and still gets the session block with the recovery remedy
//   • a mint's bind refreshes boundAt, so an immediately-following SessionEnd
//     for the same claude id cannot close the just-minted session (<10s guard)
//
// DELIBERATELY NOT COVERED here (no silent caps — say what was dropped):
//   • the projection-unreadable branch (no mint on unobservable liveness):
//     faulting project() hermetically also breaks the spine append the mint
//     needs, so the negative would be vacuous at this layer
//   • version-skew guards (older installed runtime without
//     registerSessionUniqueIn) and the lock-busy → no-mint fallback: both are
//     code-level `return null` guards with no hermetic seam
//   • env-vs-binding precedence when BOTH are live (pre-existing behavior,
//     unchanged by this fix)
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hermeticEnv } from './_hermetic-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'bin', 'maddu.mjs');
const LIB = join(HERE, '..', '..', 'template', 'maddu', 'runtime', 'lib');

const disc = await import(pathToFileURL(join(LIB, 'discipline.mjs')).href);
const lifecycle = await import(pathToFileURL(join(LIB, 'session-lifecycle.mjs')).href);
const projections = await import(pathToFileURL(join(LIB, 'projections.mjs')).href);
const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// A grammar-valid sid that is never registered anywhere — the "dead inherited
// env" of the B2 report.
const DEAD_SID = 'ses_DEADDEADDEAD';

// ── harness ──────────────────────────────────────────────────────────────────

function fire(repo, event, payload, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = hermeticEnv(envOverrides);
    // session-start appends `export MADDU_SESSION_ID=...` to CLAUDE_ENV_FILE
    // when set — an inherited value would pollute the DEVELOPER'S live env
    // file from inside a fixture. Scrubbed here until _hermetic-env carries it.
    delete env.CLAUDE_ENV_FILE;
    const startedAt = Date.now();
    const child = spawn(process.execPath, [BIN, 'hooks', 'fire', event], { cwd: repo, env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err, ms: Date.now() - startedAt }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const EDIT = (repo, claudeId) => {
  const p = { tool_name: 'Edit', tool_input: { file_path: 'x.js' }, cwd: repo };
  if (claudeId) p.session_id = claudeId;
  return p;
};

async function freshRepo(prefix) {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(repo, '.maddu'), { recursive: true }); // marker → state root resolves here
  return repo;
}

async function activeIds(repo) {
  const proj = await projections.project(repo);
  return (Array.isArray(proj.activeSessions) ? proj.activeSessions : []).map((s) => s.id);
}

const bindingsPath = (repo) => join(repo, '.maddu', 'state', 'discipline', 'sessions.json');
async function bindings(repo) {
  try { return JSON.parse(await readFile(bindingsPath(repo), 'utf8')); } catch { return {}; }
}

async function spineEvents(repo) {
  const dir = join(repo, '.maddu', 'events');
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson')); } catch { return []; }
  const events = [];
  for (const f of files) {
    const raw = await readFile(join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* tolerate partial lines */ }
    }
  }
  return events;
}

function parseHook(out) {
  const t = out.trim();
  if (!t) return { deny: false, reason: '' };
  let json = null;
  try { json = JSON.parse(t); } catch { return { deny: false, reason: '' }; }
  const hso = json && json.hookSpecificOutput;
  return {
    deny: !!hso && hso.permissionDecision === 'deny',
    reason: String((hso && hso.permissionDecisionReason) || ''),
  };
}

const SESSION_DENY_RE = /no active Máddu session/;

// Register a live bound session the way production does: the SessionStart hook.
async function startSession(repo, claudeId, envOverrides = {}) {
  await fire(repo, 'session-start', { session_id: claudeId, cwd: repo }, envOverrides);
  const b = await bindings(repo);
  return b[claudeId] ? b[claudeId].madduId : null;
}

async function closeSession(repo, sid) {
  return lifecycle.closeSessionIfActive(repo, {
    sessionId: sid,
    eventType: spine.EVENT_TYPES.SESSION_CLOSED,
    data: { handoff: { summary: 'suite close', auto: true } },
  });
}

const repos = [];
// process.exit skips finally blocks — main() RETURNS the exit code so the
// temp-repo cleanup below always runs, including on the control hard-exits.
async function main() {
  // ── CONTROL A (anti-vacuity, hard exit) ────────────────────────────────────
  // The suite's negative cases assert "NOT a session-deny". If deny detection
  // is broken (hook crash, output shape drift), every negative passes for
  // free — so first prove a deny is still observable at all.
  {
    const repo = await freshRepo('maddu-mint-ctlA-'); repos.push(repo);
    const { deny, reason } = parseHook((await fire(repo, 'pre-tool-use', EDIT(repo, null))).out);
    const good = deny && SESSION_DENY_RE.test(reason);
    ok('CONTROL A: anonymous Edit still session-denies (deny detection works)', good, reason.slice(0, 80));
    if (!good) {
      console.error('control A failed — the harness cannot observe denies; every later negative would be vacuous. Hard exit.');
      return 1;
    }
  }

  // ── CONTROL B (detector control, hard exit) ────────────────────────────────
  // The mint detectors are the projection (activeSessions) and the bindings
  // map. Prove both can SEE a session appear, by planting one via the real
  // SessionStart path.
  {
    const repo = await freshRepo('maddu-mint-ctlB-'); repos.push(repo);
    const before = (await activeIds(repo)).length;
    const sid = await startSession(repo, 'claude-ctrl');
    const after = await activeIds(repo);
    const good = before === 0 && !!sid && after.length === 1 && after[0] === sid;
    ok('CONTROL B: session-start mint is visible to both detectors', good, JSON.stringify({ before, sid, after }));
    if (!good) {
      console.error('control B failed — the mint detectors cannot see sessions; every mint assertion would be vacuous. Hard exit.');
      return 1;
    }
  }

  // ── 1. bound-but-dead → FRESH mint (the B1 victim state) ──────────────────
  {
    const repo = await freshRepo('maddu-mint-dead-'); repos.push(repo);
    const sidA = await startSession(repo, 'claude-A');
    await closeSession(repo, sidA);
    ok('setup: closed session is no longer live', !(await activeIds(repo)).includes(sidA));

    const res = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-A'));
    const { deny, reason } = parseHook(res.out);
    ok('bound-but-dead: not blocked on session', !(deny && SESSION_DENY_RE.test(reason)), reason.slice(0, 100));

    const live = await activeIds(repo);
    const sidM = live.find((id) => id !== sidA) || null;
    ok('bound-but-dead: exactly one FRESH live session minted', live.length === 1 && !!sidM && sidM !== sidA, JSON.stringify(live));
    const b = await bindings(repo);
    ok('bound-but-dead: claude id rebound to the minted session', !!b['claude-A'] && b['claude-A'].madduId === sidM, JSON.stringify(b['claude-A']));
    const evs = await spineEvents(repo);
    const mintEv = evs.find((e) => e.type === 'SESSION_AUTO_REGISTERED' && e.data && e.data.source === 'pretooluse-mint');
    ok('bound-but-dead: mint is provenance-marked on the spine', !!mintEv && mintEv.data.sessionId === sidM, JSON.stringify(mintEv && mintEv.data));

    // Idempotence: the next call resolves the new binding — no second mint.
    await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-A'));
    const live2 = await activeIds(repo);
    const b2 = await bindings(repo);
    ok('bound-but-dead: second call does NOT mint again', live2.length === 1 && live2[0] === sidM && b2['claude-A'].madduId === sidM, JSON.stringify(live2));

    // ── 8. freshness interplay: an immediate SessionEnd cannot close the mint
    // (the mint's bind refreshed boundAt; the <10s guard skips the close).
    await fire(repo, 'session-end', { session_id: 'claude-A', cwd: repo });
    ok('mint survives an immediately-following SessionEnd (<10s bind guard)', (await activeIds(repo)).includes(sidM));
    // Codex r1 F5: prove it was the GUARD that preserved the mint, not a
    // broken-into-no-op SessionEnd — age the binding past the guard and the
    // same fire must close.
    const b8 = await bindings(repo);
    if (b8['claude-A']) {
      b8['claude-A'].at = Date.now() - 60_000;
      await writeFile(bindingsPath(repo), JSON.stringify(b8, null, 2) + '\n');
    }
    await fire(repo, 'session-end', { session_id: 'claude-A', cwd: repo });
    ok('aged binding: the SAME SessionEnd closes (guard proven live, not a no-op)', !(await activeIds(repo)).includes(sidM));
  }

  // ── 2. dead env + dead binding → mint (env dead does not poison the heal) ──
  {
    const repo = await freshRepo('maddu-mint-denv-'); repos.push(repo);
    const sidB = await startSession(repo, 'claude-B');
    await closeSession(repo, sidB);
    const res = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-B'), { MADDU_SESSION_ID: DEAD_SID });
    const { deny, reason } = parseHook(res.out);
    ok('dead env + dead binding: not blocked on session', !(deny && SESSION_DENY_RE.test(reason)), reason.slice(0, 100));
    const live = await activeIds(repo);
    const sidM = live.find((id) => id !== sidB) || null;
    const b = await bindings(repo);
    ok('dead env + dead binding: fresh mint, rebound', live.length === 1 && !!sidM && b['claude-B'] && b['claude-B'].madduId === sidM, JSON.stringify({ live, bound: b['claude-B'] }));
  }

  // ── 3. dead env + LIVE binding → the binding wins, NO mint (B2 core) ──────
  {
    const repo = await freshRepo('maddu-mint-b2-'); repos.push(repo);
    const sidC = await startSession(repo, 'claude-C');
    const res = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-C'), { MADDU_SESSION_ID: DEAD_SID });
    const { deny, reason } = parseHook(res.out);
    ok('dead env + live binding: not blocked on session (binding wins)', !(deny && SESSION_DENY_RE.test(reason)), reason.slice(0, 100));
    // Codex r1 F5: absence-of-session-deny alone can't tell "binding won" from
    // "the gate crashed into fail-open before deciding". The lane deny proves
    // the pipeline COMPLETED under a governing session (lane is the very next
    // ordered blocker in this bare fixture).
    ok('dead env + live binding: gate pipeline completed (lane deny)', deny && /lane/.test(reason), reason.slice(0, 100));
    const live = await activeIds(repo);
    ok('dead env + live binding: NO mint (live set unchanged)', live.length === 1 && live[0] === sidC, JSON.stringify(live));
    const b = await bindings(repo);
    ok('dead env + live binding: binding untouched', !!b['claude-C'] && b['claude-C'].madduId === sidC);
  }

  // ── 4. live env → no mint (healthy pinned case unchanged) ─────────────────
  {
    const repo = await freshRepo('maddu-mint-lenv-'); repos.push(repo);
    const sidD = await startSession(repo, 'claude-D');
    const res = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-D'), { MADDU_SESSION_ID: sidD });
    const { deny, reason } = parseHook(res.out);
    ok('live env: not blocked on session', !(deny && SESSION_DENY_RE.test(reason)), reason.slice(0, 100));
    ok('live env: gate pipeline completed (lane deny)', deny && /lane/.test(reason), reason.slice(0, 100));
    ok('live env: NO mint', (await activeIds(repo)).length === 1);
  }

  // ── 5. never-bound + claude id → mint (a failed SessionStart self-heals) ──
  {
    const repo = await freshRepo('maddu-mint-unbound-'); repos.push(repo);
    const res = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-E'));
    const { deny, reason } = parseHook(res.out);
    ok('never-bound: not blocked on session', !(deny && SESSION_DENY_RE.test(reason)), reason.slice(0, 100));
    const live = await activeIds(repo);
    const b = await bindings(repo);
    ok('never-bound: fresh mint, bound', live.length === 1 && !!b['claude-E'] && b['claude-E'].madduId === live[0], JSON.stringify({ live, bound: b['claude-E'] }));
  }

  // ── 6. anonymous (no claude id) → NEVER mint, session deny stands ─────────
  // Nothing to bind: a mint here would be an unattributable session that
  // re-mints on every call. The recovery remedy still points at the stdin
  // session-start re-fire.
  {
    const repo = await freshRepo('maddu-mint-anon-'); repos.push(repo);
    const res = await fire(repo, 'pre-tool-use', EDIT(repo, null), { MADDU_SESSION_ID: DEAD_SID });
    const { deny, reason } = parseHook(res.out);
    ok('anonymous + dead env: session deny stands', deny && SESSION_DENY_RE.test(reason), reason.slice(0, 80));
    ok('anonymous + dead env: NO mint', (await activeIds(repo)).length === 0);
  }

  // ── 7. a mint seeds the discipline baseline (pre-existing dirt is not
  // "new dirty" for the fresh session — the commit gate must not block the
  // very call the mint just unblocked) ──────────────────────────────────────
  {
    const repo = await freshRepo('maddu-mint-base-'); repos.push(repo);
    const git = (args) => new Promise((resolve) => {
      const c = spawn('git', args, { cwd: repo, env: hermeticEnv() });
      c.on('error', () => resolve(1));
      c.on('close', (code) => resolve(code));
    });
    const initCode = await git(['init', '-q']);
    if (initCode !== 0) {
      ok('baseline: git init unavailable — case skipped (reported, not silent)', false, 'git init failed');
    } else {
      await writeFile(join(repo, 'dirt.txt'), 'pre-existing dirt\n');
      const sidF = await startSession(repo, 'claude-F');
      await closeSession(repo, sidF);
      await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-F'));
      const live = await activeIds(repo);
      const sidM = live.find((id) => id !== sidF) || null;
      const counter = sidM ? await disc.readCounter(repo, sidM) : null;
      ok('mint seeds baselineInit', !!counter && counter.baselineInit === true, JSON.stringify(counter && { baselineInit: counter.baselineInit }));
      ok('mint baseline contains the pre-existing dirt', !!counter && Array.isArray(counter.dirtyBaseline) && counter.dirtyBaseline.some((p) => /dirt\.txt$/.test(p)), JSON.stringify(counter && counter.dirtyBaseline));
    }
  }

  // ── 10. concurrent mint race (Codex r1 F1, rendezvous per r2): two
  // simultaneous PreToolUse calls for the SAME bound-but-dead identity must
  // converge on exactly ONE fresh session — the loser revalidates under the
  // binding lock and reuses the winner's mint instead of double-minting and
  // orphaning it. The MADDU_TEST_MINT_HOLD_MS seam holds each caller between
  // its no-live decision and the transaction, so BOTH provably decide to
  // mint before either takes the lock — without it the first child can
  // finish before the second decides, and the case would pass against a
  // TOCTOU-broken build (Codex r2). ─────────────────────────────────────────
  {
    // A fixed sleep alone is not a rendezvous (Codex r3), and wall-clock from
    // spawn cannot prove one either — it includes scheduling delay, so a
    // CPU-starved child that never raced still reports a long runtime (Codex
    // r4). The proof comes from INSIDE the seam: each child that decides to
    // mint on observed-dead state appends a line to
    // .maddu/state/test-mint-hold.ndjson BEFORE holding. TWO lines ⇒ both
    // children provably reached the mint decision ⇒ the under-lock
    // revalidation is the only thing preventing a double-mint, regardless of
    // scheduling. Fewer ⇒ no true race ⇒ retry with a fresh identity; a
    // never-achieved rendezvous is a loud red, not a silent pass.
    const HOLD_MS = 2500;
    const ATTEMPTS = 3;
    let raced = null;
    for (let attempt = 1; attempt <= ATTEMPTS && !raced; attempt++) {
      const repo = await freshRepo('maddu-mint-race-'); repos.push(repo);
      const cid = `claude-G${attempt}`;
      const sidG = await startSession(repo, cid);
      await closeSession(repo, sidG);
      const HOLD = { MADDU_TEST_MINT_HOLD_MS: String(HOLD_MS), MADDU_SELF_TEST: '1' };
      const [r1, r2] = await Promise.all([
        fire(repo, 'pre-tool-use', EDIT(repo, cid), HOLD),
        fire(repo, 'pre-tool-use', EDIT(repo, cid), HOLD),
      ]);
      let holders = 0;
      try {
        const raw = await readFile(join(repo, '.maddu', 'state', 'test-mint-hold.ndjson'), 'utf8');
        holders = raw.split('\n').filter((l) => l.trim()).length;
      } catch { holders = 0; }
      if (holders >= 2) raced = { repo, cid, sidG, r1, r2 };
      else console.log(`  [....] race attempt ${attempt}: rendezvous not achieved (${holders} holder(s), ${r1.ms}ms / ${r2.ms}ms) — retrying`);
    }
    ok('concurrent mint: a PROVEN rendezvous was achieved (both racers held)', !!raced, `${ATTEMPTS} attempts max`);
    if (raced) {
      // Codex r5: exit code + lane deny REQUIRED per child — a child killed or
      // crashed after writing its marker must not read as "not blocked"; only
      // a child that completed the whole gate pipeline counts as a racer.
      for (const [i, rr] of [[1, raced.r1], [2, raced.r2]]) {
        const r = parseHook(rr.out);
        ok(`concurrent mint: call ${i} completed the gate (exit 0 + lane deny, not session)`,
          rr.code === 0 && r.deny && /lane/.test(r.reason) && !SESSION_DENY_RE.test(r.reason),
          `code=${rr.code} ${r.reason.slice(0, 80)}`);
      }
      const live = await activeIds(raced.repo);
      const b = await bindings(raced.repo);
      ok('concurrent mint: exactly ONE fresh session (no double-mint, no orphan)', live.length === 1 && live[0] !== raced.sidG, JSON.stringify(live));
      ok('concurrent mint: binding points at the single survivor', !!b[raced.cid] && b[raced.cid].madduId === live[0], JSON.stringify(b[raced.cid]));
    } else {
      failed += 4; // the four race assertions could not run — red, not silently skipped
    }
  }

  // ── 11. corrupt bindings map → the mint must refuse BEFORE any side effect
  // (Codex r5): a lenient read sees a corrupt map as empty, so without the
  // health probe every edit would register a session, fail the strict-read
  // bind, roll back — and permanently append a register+close pair to the
  // append-only spine, per call, until the map is repaired. ─────────────────
  {
    const repo = await freshRepo('maddu-mint-corrupt-'); repos.push(repo);
    await mkdir(dirname(bindingsPath(repo)), { recursive: true });
    await writeFile(bindingsPath(repo), '{not json');
    const before = (await spineEvents(repo)).length;
    const res1 = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-H'));
    const res2 = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-H'));
    const after = await spineEvents(repo);
    ok('corrupt map: ZERO spine appends across two edits (no register/close storm)',
      after.length === before, `before=${before} after=${after.length} types=${JSON.stringify(after.map((e) => e.type))}`);
    const d1 = parseHook(res1.out), d2 = parseHook(res2.out);
    ok('corrupt map: the session deny stands (legacy remedy leads to the repair)',
      d1.deny && SESSION_DENY_RE.test(d1.reason) && d2.deny && SESSION_DENY_RE.test(d2.reason), d1.reason.slice(0, 80));
    ok('corrupt map: the corrupt file is left untouched (never clobbered)',
      (await readFile(bindingsPath(repo), 'utf8')) === '{not json');
  }

  // ── 12. UNWRITABLE-but-readable bindings map → still zero spine appends
  // (Codex r6): a valid map that cannot be REwritten passed the health probe,
  // and the old register-then-bind order appended a register+close pair per
  // edit. The bind-before-register order spends the risky file mutation
  // first, so every unwritable mode is append-free by construction.
  // Platform-aware: a read-only FILE blocks Windows' rename-over; a
  // read-only DIRECTORY blocks POSIX temp-file creation.
  {
    const repo = await freshRepo('maddu-mint-rofile-'); repos.push(repo);
    const dir = dirname(bindingsPath(repo));
    await mkdir(dir, { recursive: true });
    await writeFile(bindingsPath(repo), '{}\n');
    const win = process.platform === 'win32';
    if (win) await chmod(bindingsPath(repo), 0o444);
    else await chmod(dir, 0o555);
    try {
      const before = (await spineEvents(repo)).length;
      const res1 = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-J'));
      const res2 = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-J'));
      const after = await spineEvents(repo);
      ok(`unwritable map (${win ? 'read-only file' : 'read-only dir'}): ZERO spine appends across two edits`,
        after.length === before, `before=${before} after=${after.length} types=${JSON.stringify(after.map((e) => e.type))}`);
      const d1 = parseHook(res1.out), d2 = parseHook(res2.out);
      ok('unwritable map: the session deny stands', d1.deny && SESSION_DENY_RE.test(d1.reason) && d2.deny && SESSION_DENY_RE.test(d2.reason), d1.reason.slice(0, 80));
      // Codex r7: a failed bind must not LEAK its temp file — otherwise the
      // spine-append storm is merely traded for an unbounded tmp-file leak,
      // one per edit, in the same discipline dir.
      // 'v2' is the counters dir — legitimate. Anything else beside the map
      // itself (in particular writeJson's unique temp names) is a leak.
      const leftovers = (await readdir(dir)).filter((f) => f !== 'sessions.json' && f !== 'v2');
      ok('unwritable map: no temp-file leak in the discipline dir', leftovers.length === 0, JSON.stringify(leftovers));
    } finally {
      // Restore permissions or the temp-dir cleanup below fails.
      try { if (win) await chmod(bindingsPath(repo), 0o644); else await chmod(dir, 0o755); } catch { /* best-effort */ }
    }
  }

  // ── 9. the B1 story end-to-end: worker inherits env → SessionEnd closes the
  // parent's session (defect at source, unchanged) → the parent's next edit
  // self-heals via the mint, no restart ─────────────────────────────────────
  {
    const repo = await freshRepo('maddu-mint-b1-'); repos.push(repo);
    const sidP = await startSession(repo, 'claude-P');
    // Worker start with the parent's env sid inherited: SessionStart renews
    // sidP and binds the WORKER'S claude id to it — the armed bite.
    await startSession(repo, 'claude-W', { MADDU_SESSION_ID: sidP });
    let b = await bindings(repo);
    ok('B1 setup: worker claude id bound to the INHERITED session', !!b['claude-W'] && b['claude-W'].madduId === sidP, JSON.stringify(b['claude-W']));
    // Age the worker binding past the <10s freshness guard (a real worker
    // runs longer than 10s before its SessionEnd).
    b['claude-W'].at = Date.now() - 60_000;
    await writeFile(bindingsPath(repo), JSON.stringify(b, null, 2) + '\n');
    await fire(repo, 'session-end', { session_id: 'claude-W', cwd: repo });
    ok('B1 defect at source (documented): worker SessionEnd closed the parent session', !(await activeIds(repo)).includes(sidP));
    // The parent's next edit: bound-but-dead → mint, rebound, unblocked.
    const res = await fire(repo, 'pre-tool-use', EDIT(repo, 'claude-P'));
    const { deny, reason } = parseHook(res.out);
    ok('B1 recovery: parent not blocked on session after the bite', !(deny && SESSION_DENY_RE.test(reason)), reason.slice(0, 100));
    const live = await activeIds(repo);
    b = await bindings(repo);
    ok('B1 recovery: parent rebound to a fresh minted session', live.length === 1 && live[0] !== sidP && !!b['claude-P'] && b['claude-P'].madduId === live[0], JSON.stringify({ live, bound: b['claude-P'] }));
  }

  console.log('');
  console.log(`session-mint: ${passed} pass - ${failed} fail`);
  if (failed > 0) return 1;
  console.log('session-mint OK');
  return 0;
}

let code = 2;
try {
  code = await main();
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  code = 2;
} finally {
  for (const r of repos) { try { await rm(r, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
process.exit(code);
