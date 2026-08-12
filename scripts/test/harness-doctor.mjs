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
}

// ── teardown ────────────────────────────────────────────────────────────────
await rm(scratch, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
