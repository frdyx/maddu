#!/usr/bin/env node
// harness-doctor — SUPERVISOR-authored adversarial suite for the harness-parity
// PR1 doctor (side-effectful half: the shell-free probe arms, per-candidate
// config observation, the spine append, the locked projection materializer,
// and the `maddu runtime doctor` CLI). Written from .maddu/state/
// harness-parity-pr1-plan.md (r2/r3 binding) independently of the
// implementation, per the implementer-never-writes-its-own-suite rule.
//
// CONTROL FIRST WITH HARD EXIT: a fixture harness whose probe prints a version
// INSIDE its declared window must come back 'verified', with the event on the
// state-root spine and the projection materialized. If that happy path does
// not hold, every negative below ("...reads not-installed", "...is held back")
// is vacuous and the run aborts.
//
// Everything runs against throwaway mkdtemp roots under a hermetic env. The
// probes are driven through injected fixture manifests (opts.manifest), so no
// case depends on which real CLIs this machine happens to have — the ONE
// exception is the real-manifest CLI leg, which only asserts properties that
// hold whether or not a harness is installed (exit codes, event presence).
//
// exit 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hermeticEnv } from './_hermetic-env.mjs';

const LIB = (f) => pathToFileURL(join(process.cwd(), 'template', 'maddu', 'runtime', 'lib', f)).href;
const BIN = join(process.cwd(), 'bin', 'maddu.mjs');
const NODE = process.execPath;

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : `  ${detail}`}`);
  cond ? passed++ : failed++;
};

let D, H, spine, appendLock, paths;
try {
  D = await import(LIB('harness-doctor.mjs'));
  H = await import(LIB('harness-capabilities.mjs'));
  spine = await import(LIB('spine.mjs'));
  appendLock = await import(LIB('append-lock.mjs'));
  paths = await import(LIB('paths.mjs'));
} catch (err) {
  console.error(`[harness] import failed: ${err.message}`);
  process.exit(2);
}
for (const fn of ['runHarnessDoctor', 'runHarnessDoctorAll', 'observeHarness', 'observeConfigs', 'observationEventData', 'materializeHarnessCapabilities', 'readHarnessCapabilitiesProjection', 'resolveConfigCandidate', 'harnessCapabilitiesProjectionPath']) {
  if (typeof D[fn] !== 'function') {
    console.error(`[harness] ${fn} is not exported`);
    process.exit(2);
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'harness-doctor-'));
const fakeHome = join(scratch, 'home');
await mkdir(fakeHome, { recursive: true });

async function makeRoot(tag) {
  const root = await mkdtemp(join(scratch, tag + '-'));
  execFileSync('git', ['init', '-q', root]);
  await spine.ensureSpine(root);
  return root;
}

// A version-printing probe that needs no real CLI: `node -e`.
const printCmd = (text) => ({ command: 'node', args: ['-e', `console.log(${JSON.stringify(text)})`], versionPattern: '(?:^|[^0-9])v?(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)' });

const fxEntry = (over = {}) => ({
  name: 'fx',
  displayName: 'Fixture CLI',
  hooks: {
    pre_tool: { blocking: 'block', transport: 'stdin-json' },
    session_end: { blocking: 'observe', transport: 'stdin-json' },
  },
  configPaths: {
    win32: ['fx/hooks.json', '~/fxglobal/hooks.json'],
    darwin: ['fx/hooks.json', '~/fxglobal/hooks.json'],
    linux: ['fx/hooks.json', '~/fxglobal/hooks.json'],
  },
  sentinel: { marker: 'hooks fire', files: ['fx/hooks.json'] },
  detect: printCmd('fx 1.2.3'),
  enforcementCeiling: 'block',
  verifiedAgainst: {
    range: { min: '1.2.0', max: '1.3.0' },
    date: '2026-08-12',
    sources: ['independent-source-a', 'independent-source-b'],
  },
  volatile: null,
  ...over,
});
const manifestOf = (...entries) => Object.fromEntries(entries.map((e) => [e.name, e]));

// Shared opts for every library-level observation: never read a real runtime
// descriptor (forces the manifest shell-free arm), never read the real home.
const baseOpts = (manifest) => ({ manifest, descriptor: null, home: fakeHome, platform: process.platform });

const eventsOfType = async (root) =>
  (await spine.readAll(root)).filter((e) => e.type === 'HARNESS_CAPABILITY_OBSERVED');

// ── CONTROL (anti-vacuity, hard exit) ───────────────────────────────────────
const ctrlRoot = await makeRoot('ctl');
{
  // Repo-local config WITH the stanza marker; home-level config WITHOUT it
  // (and deliberately outside sentinel.files, so it may only ever read
  // present-no-stanza).
  await mkdir(join(ctrlRoot, 'fx'), { recursive: true });
  await writeFile(join(ctrlRoot, 'fx', 'hooks.json'), '{ "hooks": ["node maddu.mjs hooks fire pre_tool --harness fx"] }\n');
  await mkdir(join(fakeHome, 'fxglobal'), { recursive: true });
  await writeFile(join(fakeHome, 'fxglobal', 'hooks.json'), '{ "hooks": [] }\n');

  const manifest = manifestOf(fxEntry());
  const r = await D.runHarnessDoctor({ workRoot: ctrlRoot, stateRoot: ctrlRoot }, 'fx', baseOpts(manifest));
  const obs = r.observations[0];
  const evs = await eventsOfType(ctrlRoot);
  const projOnDisk = await D.readHarnessCapabilitiesProjection(ctrlRoot);
  const controlOk = obs && obs.status === 'verified' && obs.drift === null && obs.cliVersion === '1.2.3'
    && evs.length === 1 && evs[0].data.harness === 'fx'
    && r.projection && r.projection.ok === true
    && projOnDisk && projOnDisk.harnesses.fx && projOnDisk.harnesses.fx.status === 'verified';
  ok('CONTROL: in-window fixture probe reads verified, event on the spine, projection on disk', controlOk,
    JSON.stringify({ status: obs?.status, drift: obs?.drift, cliVersion: obs?.cliVersion, events: evs.length, proj: r.projection?.ok, disk: projOnDisk?.harnesses?.fx?.status }));
  if (!controlOk) {
    console.error('[harness] CONTROL FAILED — aborting; every negative below would be vacuous.');
    await rm(scratch, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed + 1} failed (control abort)`);
    process.exit(1);
  }

  // The event payload contract, exactly as the plan pinned it.
  const data = evs[0].data;
  const wantKeys = ['capabilities', 'cliVersion', 'configPath', 'configs', 'drift', 'enforcementCeiling', 'harness', 'manifestVersion', 'probeFailure', 'status', 'volatile', 'workRoot'];
  ok('event data carries exactly the pinned field set',
    JSON.stringify(Object.keys(data).sort()) === JSON.stringify(wantKeys), JSON.stringify(Object.keys(data).sort()));
  ok('event configs rows are exactly { path, status } — no resolved absolute path leaks into the record',
    data.configs.length === 2 && data.configs.every((c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(['path', 'status'])),
    JSON.stringify(data.configs));
  ok('repo-local stanza-bearing config reads stanza-present',
    data.configs.find((c) => c.path === 'fx/hooks.json')?.status === 'stanza-present', JSON.stringify(data.configs));
  ok('home-level config outside sentinel.files reads present-no-stanza (never scanned up)',
    data.configs.find((c) => c.path === '~/fxglobal/hooks.json')?.status === 'present-no-stanza', JSON.stringify(data.configs));
  ok('configPath is the FIRST non-absent candidate in manifest order', data.configPath === 'fx/hooks.json', data.configPath);
  ok('workRoot is stamped on the event (checkout-scoped reading)', data.workRoot === ctrlRoot, String(data.workRoot));
  ok('manifestVersion rides the event', data.manifestVersion === H.HARNESS_CAPABILITIES_VERSION);
}

// ── Roots pair: configs from the WORK root, record on the STATE root ───────
{
  const work = await makeRoot('work');
  const state = await makeRoot('state');
  await mkdir(join(work, 'fx'), { recursive: true });
  await writeFile(join(work, 'fx', 'hooks.json'), 'x hooks fire x\n');
  const manifest = manifestOf(fxEntry());
  await D.runHarnessDoctor({ workRoot: work, stateRoot: state }, 'fx', baseOpts(manifest));
  const onState = await eventsOfType(state);
  const onWork = await eventsOfType(work);
  ok('event lands on the STATE root spine', onState.length === 1, `state=${onState.length}`);
  ok('nothing lands on the WORK root spine', onWork.length === 0, `work=${onWork.length}`);
  ok('the config half was read from the WORK root (stanza found there)',
    onState[0]?.data.configs.find((c) => c.path === 'fx/hooks.json')?.status === 'stanza-present');
  ok('the event names the work root it read from', onState[0]?.data.workRoot === work);
  ok('the projection lives under the STATE root',
    existsSync(D.harnessCapabilitiesProjectionPath(state)) && !existsSync(D.harnessCapabilitiesProjectionPath(work)));
}

// ── Probe arms and failure honesty ──────────────────────────────────────────
const armRoot = await makeRoot('arm');
{
  // Definitive absence: shell-free PATH resolution finds nothing.
  const absent = fxEntry({ name: 'gone', detect: { command: 'maddu-fixture-definitely-absent-xyz', args: ['--version'], versionPattern: '(\\d+\\.\\d+\\.\\d+)' } });
  const r1 = await D.runHarnessDoctor({ workRoot: armRoot, stateRoot: armRoot }, 'gone', baseOpts(manifestOf(absent)));
  ok("shell-free unresolved command -> 'not-installed'", r1.observations[0].status === 'not-installed',
    JSON.stringify({ status: r1.observations[0].status, drift: r1.observations[0].drift }));
  ok('not-installed carries NO probeFailure and NO drift',
    r1.observations[0].probeFailure === null && r1.observations[0].drift === null);
  ok('not-installed is a recorded observation, not a suppressed one',
    (await eventsOfType(armRoot)).some((e) => e.data.harness === 'gone' && e.data.status === 'not-installed'));

  // A probe that runs but exits nonzero proves nothing about absence.
  const failing = fxEntry({ name: 'fail', detect: { command: 'node', args: ['-e', 'process.exit(3)'], versionPattern: '(\\d+\\.\\d+\\.\\d+)' } });
  const r2 = await D.observeHarness({ workRoot: armRoot, stateRoot: armRoot }, 'fail', baseOpts(manifestOf(failing)));
  ok("nonzero probe exit -> 'assumed' + probeFailure 'nonzero-exit' (NEVER not-installed)",
    r2.status === 'assumed' && r2.drift === 'probe-failed' && r2.probeFailure === 'nonzero-exit',
    JSON.stringify({ status: r2.status, drift: r2.drift, probeFailure: r2.probeFailure }));

  // A hung probe times out into 'assumed', not into absence.
  const hung = fxEntry({ name: 'hung', detect: { command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], versionPattern: '(\\d+\\.\\d+\\.\\d+)' } });
  const r3 = await D.observeHarness({ workRoot: armRoot, stateRoot: armRoot }, 'hung', { ...baseOpts(manifestOf(hung)), timeoutMs: 400 });
  ok("probe timeout -> 'assumed'/probe-failed/'timeout'",
    r3.status === 'assumed' && r3.drift === 'probe-failed' && r3.probeFailure === 'timeout',
    JSON.stringify({ status: r3.status, drift: r3.drift, probeFailure: r3.probeFailure }));

  // Prerelease inside the window is still held back.
  const pre = fxEntry({ name: 'pre', detect: printCmd('fx 1.2.5-rc1') });
  const r4 = await D.observeHarness({ workRoot: armRoot, stateRoot: armRoot }, 'pre', baseOpts(manifestOf(pre)));
  ok("prerelease probe output -> 'assumed'/prerelease", r4.status === 'assumed' && r4.drift === 'prerelease',
    JSON.stringify({ status: r4.status, drift: r4.drift, cliVersion: r4.cliVersion }));

  // No verified window -> assumed even on a clean parsable probe.
  const noWin = fxEntry({ name: 'nowin', verifiedAgainst: { range: { min: null, max: null }, date: 'd', sources: ['a', 'b'] } });
  const r5 = await D.observeHarness({ workRoot: armRoot, stateRoot: armRoot }, 'nowin', baseOpts(manifestOf(noWin)));
  ok("window never established -> 'assumed'/no-verified-range", r5.status === 'assumed' && r5.drift === 'no-verified-range');

  // DESCRIPTOR ARM: a legacy descriptor command runs via shell, so absence is
  // no longer provable — a dead command must read assumed, never not-installed.
  const viaDesc = fxEntry({ name: 'desc' });
  const r6 = await D.observeHarness({ workRoot: armRoot, stateRoot: armRoot }, 'desc', {
    ...baseOpts(manifestOf(viaDesc)),
    descriptor: { detect: { command: 'maddu-fixture-definitely-absent-xyz --version', expectExit: 0 } },
  });
  ok("descriptor (shell) arm can NEVER prove absence -> 'assumed'/probe-failed",
    r6.status === 'assumed' && r6.drift === 'probe-failed' && r6.probeFailure !== null,
    JSON.stringify({ status: r6.status, drift: r6.drift, probeFailure: r6.probeFailure }));
  ok('observation names the descriptor probe arm', r6.probeSource === 'runtime-descriptor', r6.probeSource);
  ok('a working descriptor command still parses through the MANIFEST versionPattern', (await (async () => {
    const r = await D.observeHarness({ workRoot: armRoot, stateRoot: armRoot }, 'desc', {
      ...baseOpts(manifestOf(viaDesc)),
      descriptor: { detect: { command: `"${NODE}" -e "console.log('fx 1.2.3')"`, expectExit: 0 } },
    });
    return r.status === 'verified' && r.cliVersion === '1.2.3' && r.probeSource === 'runtime-descriptor';
  })()));

  // Unknown harness is a caller error, not an observation.
  let threw = null;
  try { await D.observeHarness({ workRoot: armRoot, stateRoot: armRoot }, 'cursor', baseOpts(manifestOf(fxEntry()))); }
  catch (e) { threw = e; }
  ok('unknown harness throws UnknownHarnessError with validNames', threw && threw.name === 'UnknownHarnessError' && Array.isArray(threw.validNames) && threw.validNames.includes('fx'),
    String(threw && threw.message));

  // Funnel r1 #1 — a registered descriptor that exists but cannot be parsed
  // must hold the reading at 'assumed', never silently fall back to the
  // manifest probe (which could verify the wrong binary). No opts.descriptor
  // here: the strict read path itself is under test.
  const corrupt = await makeRoot('corrupt');
  await mkdir(join(corrupt, '.maddu', 'runtimes'), { recursive: true });
  await writeFile(join(corrupt, '.maddu', 'runtimes', 'fx.json'), '{ this is not json');
  const rc = await D.observeHarness({ workRoot: corrupt, stateRoot: corrupt }, 'fx',
    { manifest: manifestOf(fxEntry()), home: fakeHome, platform: process.platform });
  ok("corrupt registered descriptor -> 'assumed'/'descriptor-unreadable', NEVER a silent manifest fallback",
    rc.status === 'assumed' && rc.drift === 'probe-failed' && rc.probeFailure === 'descriptor-unreadable' && rc.probeSource === 'runtime-descriptor',
    JSON.stringify({ status: rc.status, drift: rc.drift, probeFailure: rc.probeFailure, probeSource: rc.probeSource }));

  // Funnel r1 #2 end-to-end — a probe printing a CONTINUED version token must
  // come out unparsable, not truncated-and-verified.
  const cont = fxEntry({ name: 'cont', detect: printCmd('fx 1.2.3.4') });
  const rcont = await D.observeHarness({ workRoot: armRoot, stateRoot: armRoot }, 'cont', baseOpts(manifestOf(cont)));
  ok("probe output 'fx 1.2.3.4' -> 'assumed'/unparsable end-to-end (truncation hole closed)",
    rcont.status === 'assumed' && rcont.drift === 'unparsable' && rcont.cliVersion === null,
    JSON.stringify({ status: rcont.status, drift: rcont.drift, cliVersion: rcont.cliVersion }));

  // Funnel r1 #6 — a stanza BEYOND the old 512 KiB read bound must still be
  // found: coverage is unbounded, memory is not.
  const bigRoot = await makeRoot('big');
  await mkdir(join(bigRoot, 'fx'), { recursive: true });
  await writeFile(join(bigRoot, 'fx', 'hooks.json'), '/* pad */ '.repeat(80000) + '\n"node maddu.mjs hooks fire pre_tool"\n');
  const rbig = await D.observeHarness({ workRoot: bigRoot, stateRoot: bigRoot }, 'fx', baseOpts(manifestOf(fxEntry())));
  ok('a stanza past 512 KiB is still found (whole-file scan, bounded memory)',
    rbig.configs.find((c) => c.path === 'fx/hooks.json')?.status === 'stanza-present',
    JSON.stringify(rbig.configs));
}

// ── resolveConfigCandidate units ────────────────────────────────────────────
{
  ok("'~/a/b' resolves under home", D.resolveConfigCandidate('~/a/b', '/w', '/h')?.includes('a') === true
    && !D.resolveConfigCandidate('~/a/b', '/w', '/h').includes('w'));
  ok("'a/b' resolves under the work root", D.resolveConfigCandidate('a/b', armRoot, fakeHome)?.startsWith(armRoot) === true);
  ok('empty candidate -> null', D.resolveConfigCandidate('', armRoot, fakeHome) === null);
  ok('non-string candidate -> null', D.resolveConfigCandidate(null, armRoot, fakeHome) === null);
}

// ── Projection: latest wins, lock honesty, race fixture ─────────────────────
{
  const root = await makeRoot('proj');
  const manifest = manifestOf(fxEntry({ detect: printCmd('fx 1.2.3') }));
  const first = await D.runHarnessDoctor({ workRoot: root, stateRoot: root }, 'fx', baseOpts(manifest));
  // Second reading with a different (out-of-window) version: the projection
  // must move to the newer observation even though it is "worse".
  const manifest2 = manifestOf(fxEntry({ detect: printCmd('fx 9.9.9') }));
  const second = await D.runHarnessDoctor({ workRoot: root, stateRoot: root }, 'fx', baseOpts(manifest2));
  const proj = await D.readHarnessCapabilitiesProjection(root);
  ok('projection holds the LATEST observation per harness (newer assumed beats older verified)',
    proj.harnesses.fx.eventId === second.events[0].id && proj.harnesses.fx.status === 'assumed' && proj.harnesses.fx.drift === 'above-range',
    JSON.stringify({ got: proj.harnesses.fx.eventId, want: second.events[0].id, status: proj.harnesses.fx.status }));
  ok('first observation is still on the spine (append-only; projection is the cache)',
    (await eventsOfType(root)).some((e) => e.id === first.events[0].id));

  // r3 #4 race fixture: concurrent materializations must end byte-consistent
  // with a fresh reduce of the spine — no stale snapshot may win the rename.
  const results = await Promise.all([1, 2, 3, 4].map(() => D.materializeHarnessCapabilities(root)));
  ok('concurrent materializations settle without throwing (each ok or lock-busy)',
    results.every((r) => r && (r.ok === true || (r.ok === false && r.reason === 'lock-busy'))),
    JSON.stringify(results.map((r) => r && (r.ok ? 'ok' : r.reason))));
  const after = await D.readHarnessCapabilitiesProjection(root);
  const expected = H.reduceHarnessCapabilities(await spine.readAll(root));
  ok('after the race, the on-disk projection equals a fresh reduce of the spine',
    JSON.stringify(after) === JSON.stringify(expected));

  // A held lock degrades to a reported miss — never a throw, never a fake ok.
  const lockPath = join(paths.pathsFor(root).statePrjDir, 'harness-capabilities.lock');
  let busy;
  await appendLock.withAppendLock(lockPath, async () => {
    busy = await D.materializeHarnessCapabilities(root, { maxWaitMs: 120 });
  }, { maxWaitMs: 3000 });
  ok('a held projection lock reports { ok:false, reason:lock-busy } instead of throwing',
    busy && busy.ok === false && busy.reason === 'lock-busy', JSON.stringify(busy));
  ok('a lock-busy miss does not corrupt the projection on disk',
    JSON.stringify(await D.readHarnessCapabilitiesProjection(root)) === JSON.stringify(expected));

  ok('reading a never-materialized projection returns null',
    (await D.readHarnessCapabilitiesProjection(await makeRoot('empty'))) === null);

  // Funnel r1 #8 — a projection WRITE failure after the observation appended
  // must be reported, never thrown: the observation succeeded and the
  // projection is a rebuildable cache. A directory squatting on the target
  // path makes the rename fail deterministically on every platform.
  const wf = await makeRoot('wfail');
  const wfManifest = manifestOf(fxEntry({ detect: printCmd('fx 1.2.3') }));
  await mkdir(D.harnessCapabilitiesProjectionPath(wf), { recursive: true });
  let wfOut = null, wfThrew = null;
  try { wfOut = await D.runHarnessDoctor({ workRoot: wf, stateRoot: wf }, 'fx', baseOpts(wfManifest)); }
  catch (e) { wfThrew = e; }
  ok('a post-append projection write failure is REPORTED, not thrown',
    wfThrew === null && wfOut && wfOut.projection && wfOut.projection.ok === false && wfOut.projection.reason === 'projection-write-failed',
    wfThrew ? String(wfThrew) : JSON.stringify(wfOut && wfOut.projection));
  ok('the observation event still landed despite the projection failure',
    (await eventsOfType(wf)).length === 1);
  const prjDir = join(D.harnessCapabilitiesProjectionPath(wf), '..');
  const leftovers = (await (await import('node:fs/promises')).readdir(prjDir)).filter((f) => f.includes('.tmp'));
  ok('the failed writer removed its own tmp file', leftovers.length === 0, JSON.stringify(leftovers));
}

// ── runHarnessDoctorAll over an injected manifest ───────────────────────────
{
  const root = await makeRoot('all');
  const manifest = manifestOf(
    fxEntry({ name: 'aa', detect: printCmd('fx 1.2.3') }),
    fxEntry({ name: 'bb', detect: { command: 'maddu-fixture-definitely-absent-xyz', args: [], versionPattern: '(\\d+\\.\\d+\\.\\d+)' } }),
  );
  const r = await D.runHarnessDoctorAll({ workRoot: root, stateRoot: root }, baseOpts(manifest));
  ok('--all observes every manifest entry, one event each',
    r.observations.length === 2 && r.events.length === 2 && (await eventsOfType(root)).length === 2);
  ok('--all projection carries both harnesses with their own statuses',
    r.projection.ok === true && r.projection.projection.harnesses.aa?.status === 'verified' && r.projection.projection.harnesses.bb?.status === 'not-installed',
    JSON.stringify(r.projection.projection?.harnesses && Object.fromEntries(Object.entries(r.projection.projection.harnesses).map(([k, v]) => [k, v.status]))));
}

// ── The CLI, on a throwaway repo (real manifest — only install-agnostic asserts) ──
{
  const root = await makeRoot('cli');
  const run = (args) => spawnSync(NODE, [BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 120000, env: hermeticEnv() });

  const bad = run(['runtime', 'doctor', 'nosuch-harness']);
  ok('CLI: unknown harness exits 2', bad.status === 2, `exit=${bad.status}`);
  ok('CLI: the refusal lists the valid names', /claude-code/.test(bad.stderr) && /openhands/.test(bad.stderr), bad.stderr.slice(0, 200));

  const none = run(['runtime', 'doctor']);
  ok('CLI: doctor with no name and no --all exits 2', none.status === 2, `exit=${none.status}`);

  // openhands is a real manifest entry; whatever this machine has, the doctor
  // must OBSERVE (exit 0) — an absent CLI is a valid observation, not an error.
  const oh = run(['runtime', 'doctor', 'openhands', '--json']);
  ok('CLI: observing a real harness exits 0 whether or not it is installed', oh.status === 0, `exit=${oh.status} ${oh.stderr.slice(0, 200)}`);
  let parsed = null;
  try { parsed = JSON.parse(oh.stdout); } catch {}
  ok('CLI: --json output parses', parsed !== null, oh.stdout.slice(0, 200));
  const evs = await eventsOfType(root);
  ok('CLI: the observation landed on this repo\'s spine', evs.length === 1 && evs[0].data.harness === 'openhands',
    JSON.stringify(evs.map((e) => e.data.harness)));
  ok('CLI: the projection file exists after doctor', existsSync(D.harnessCapabilitiesProjectionPath(root)));

  // The strict flag guard covers the new subcommand's flags.
  const flagged = run(['runtime', 'doctor', 'openhands', '--bogus-flag-zz']);
  ok('CLI: an unknown flag on doctor refuses (strict-by-default)', flagged.status === 2, `exit=${flagged.status}`);

  // Funnel r1 #7 — the doctor must never observe something other than what
  // was asked for: name + --all is ambiguous, extra positionals are refused.
  const both = run(['runtime', 'doctor', 'codex', '--all']);
  ok('CLI: a name AND --all together exit 2 (never silently observe everything)',
    both.status === 2 && /not both/.test(both.stderr), `exit=${both.status} ${both.stderr.slice(0, 150)}`);
  const extra = run(['runtime', 'doctor', 'openhands', 'straggler']);
  ok('CLI: an unexpected extra positional exits 2',
    extra.status === 2 && /unexpected argument/.test(extra.stderr), `exit=${extra.status} ${extra.stderr.slice(0, 150)}`);

  // Funnel r2 #1 — a positional swallowed AS a boolean flag's value is the
  // same mistake in a different coat: --all/--json are arity-zero.
  const swallowedByAll = run(['runtime', 'doctor', '--all', 'codex']);
  ok("CLI: 'doctor --all codex' exits 2 (--all takes no value)",
    swallowedByAll.status === 2 && /takes no value/.test(swallowedByAll.stderr),
    `exit=${swallowedByAll.status} ${swallowedByAll.stderr.slice(0, 150)}`);
  const swallowedByJson = run(['runtime', 'doctor', 'openhands', '--json', 'straggler']);
  ok("CLI: 'doctor <name> --json straggler' exits 2 (--json takes no value)",
    swallowedByJson.status === 2 && /takes no value/.test(swallowedByJson.stderr),
    `exit=${swallowedByJson.status} ${swallowedByJson.stderr.slice(0, 150)}`);

  ok('CLI: the refused invocations observed NOTHING (spine unchanged)',
    (await eventsOfType(root)).length === 1);

  // Funnel r2 #2 tripwire — the presenter must know all four config statuses;
  // an 'unreadable' reading must never render through an absent-shaped
  // fallback. Source tripwire, same style as the census suites.
  const presenterSrc = readFileSync(join(process.cwd(), 'commands', 'runtime.mjs'), 'utf8');
  ok("presenter handles 'unreadable' explicitly (never renders it as absent)",
    /unreadable/.test(presenterSrc) && /status === 'absent'/.test(presenterSrc),
    'configBadge lacks an explicit unreadable/absent split');
}

// ── Funnel r2 #3 (adjudicated) + #4 + #5 fixtures ───────────────────────────
{
  const root = await makeRoot('r2');
  // #3: a registered descriptor's INTEGER expectExit is honored — doctor and
  // `runtime detect` must not disagree about the same registration…
  const entry = fxEntry();
  const nonzeroOk = await D.observeHarness({ workRoot: root, stateRoot: root }, 'fx', {
    manifest: manifestOf(entry), home: fakeHome, platform: process.platform,
    descriptor: { detect: { command: `"${NODE}" -e "console.log('fx 1.2.3'); process.exit(3)"`, expectExit: 3 } },
  });
  ok('descriptor with integer expectExit=3 and matching exit reads verified (registration semantics honored)',
    nonzeroOk.status === 'verified' && nonzeroOk.cliVersion === '1.2.3',
    JSON.stringify({ status: nonzeroOk.status, drift: nonzeroOk.drift, probeFailure: nonzeroOk.probeFailure }));
  // …but a NON-integer expectExit is a truthy surprise, not a registration:
  // it falls back to 0 and the nonzero exit reads as a probe failure.
  const bogusExit = await D.observeHarness({ workRoot: root, stateRoot: root }, 'fx', {
    manifest: manifestOf(entry), home: fakeHome, platform: process.platform,
    descriptor: { detect: { command: `"${NODE}" -e "console.log('fx 1.2.3'); process.exit(3)"`, expectExit: '3' } },
  });
  ok("descriptor with a STRING expectExit falls back to 0 -> 'assumed'/probe-failed",
    bogusExit.status === 'assumed' && bogusExit.probeFailure === 'nonzero-exit',
    JSON.stringify({ status: bogusExit.status, probeFailure: bogusExit.probeFailure }));

  // #4 (win32 only): a .cmd shim under a SPACED directory must probe cleanly.
  if (process.platform === 'win32') {
    const spaced = join(scratch, 'space dir');
    await mkdir(spaced, { recursive: true });
    await writeFile(join(spaced, 'fxver.cmd'), '@echo fx 1.2.3\r\n');
    const cmdEntry = fxEntry({ name: 'shim', detect: { command: join(spaced, 'fxver.cmd'), args: [], versionPattern: entry.detect.versionPattern } });
    const rs = await D.observeHarness({ workRoot: root, stateRoot: root }, 'shim', baseOpts(manifestOf(cmdEntry)));
    ok('win32: a .cmd shim in a spaced path probes verified (quoted /s /c tail)',
      rs.status === 'verified' && rs.cliVersion === '1.2.3',
      JSON.stringify({ status: rs.status, drift: rs.drift, probeFailure: rs.probeFailure, raw: rs.probeCommand }));
    // A literal double quote in the shim path/args cannot be represented
    // safely inside a cmd string — refused as a probe failure, never spliced.
    const quoted = fxEntry({ name: 'quoted', detect: { command: join(spaced, 'fxver.cmd'), args: ['--tag="x"'], versionPattern: entry.detect.versionPattern } });
    const rq = await D.observeHarness({ workRoot: root, stateRoot: root }, 'quoted', baseOpts(manifestOf(quoted)));
    ok('win32: a double quote in probe args is refused as spawn-error:UNQUOTABLE, never interpolated',
      rq.status === 'assumed' && /UNQUOTABLE/.test(rq.probeFailure || ''),
      JSON.stringify({ status: rq.status, probeFailure: rq.probeFailure }));
  }

  // r3 #1 — a timed-out probe must kill the WHOLE tree and settle within its
  // deadline: a surviving grandchild used to hold the close event (and the
  // doctor) open indefinitely.
  const spawner = "require('child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'ignore'}); setInterval(()=>{},1000)";
  const treeEntry = fxEntry({ name: 'tree', detect: { command: 'node', args: ['-e', spawner], versionPattern: entry.detect.versionPattern } });
  const t0 = Date.now();
  const rt = await D.observeHarness({ workRoot: root, stateRoot: root }, 'tree', { ...baseOpts(manifestOf(treeEntry)), timeoutMs: 500 });
  const elapsed = Date.now() - t0;
  ok('a probe whose child spawns a survivor still times out honestly',
    rt.status === 'assumed' && rt.probeFailure === 'timeout',
    JSON.stringify({ status: rt.status, probeFailure: rt.probeFailure }));
  ok('the timed-out probe settles within its kill deadline (tree-kill, not wait-forever)',
    elapsed < 6000, `elapsed=${elapsed}ms`);

  // r3 #2 — expectExit normalization lives in probeRuntime, so doctor and
  // detectRuntime read the SAME registration the same way: a string '0' with
  // exit 0 verifies under doctor AND detects ok.
  const RT = await import(LIB('runtimes.mjs'));
  await mkdir(join(root, '.maddu', 'runtimes'), { recursive: true });
  await writeFile(join(root, '.maddu', 'runtimes', 'fx.json'), JSON.stringify({
    name: 'fx', detect: { command: `"${NODE}" -e "console.log('fx 1.2.3')"`, expectExit: '0' },
  }) + '\n');
  const viaDoctor = await D.observeHarness({ workRoot: root, stateRoot: root }, 'fx',
    { manifest: manifestOf(entry), home: fakeHome, platform: process.platform });
  const viaDetect = await RT.detectRuntime(root, 'fx');
  ok("a string expectExit '0' registration reads the SAME under doctor and detect (both ok)",
    viaDoctor.status === 'verified' && viaDetect.ok === true,
    JSON.stringify({ doctor: viaDoctor.status, detect: viaDetect.ok }));

  // #5: acquisition failures are reported, never thrown, and 'lock-busy' is
  // scoped to the timeout the arbiter actually raises. A directory squatting
  // on the lock path can ONLY surface as ELOCKTIMEOUT (EEXIST → bodyless
  // grace → unlink-fails → loop), so its honest surface IS lock-busy; the
  // 'lock-unavailable' class exists for errors that ESCAPE the arbiter
  // (persistent EPERM/EACCES after its bounded retry), which no portable
  // fixture can produce — that branch is pinned by the source tripwire below.
  const lockDir = join(paths.pathsFor(root).statePrjDir, 'harness-capabilities.lock');
  await mkdir(lockDir, { recursive: true });
  const misc = await D.materializeHarnessCapabilities(root, { maxWaitMs: 300 });
  ok('a squatting lock path is reported (never thrown), as lock-busy or lock-unavailable',
    misc && misc.ok === false && (misc.reason === 'lock-busy' || misc.reason === 'lock-unavailable'),
    JSON.stringify(misc));
  await rm(lockDir, { recursive: true, force: true });
  const doctorSrc = readFileSync(join(process.cwd(), 'template', 'maddu', 'runtime', 'lib', 'harness-doctor.mjs'), 'utf8');
  ok("classification tripwire: 'lock-busy' is scoped to ELOCKTIMEOUT; other acquisition errors report 'lock-unavailable'",
    /ELOCKTIMEOUT/.test(doctorSrc) && /lock-unavailable/.test(doctorSrc),
    'harness-doctor.mjs lost the ELOCKTIMEOUT/lock-unavailable classification');
}

// ── teardown ────────────────────────────────────────────────────────────────
await rm(scratch, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
