#!/usr/bin/env node
// harness-capabilities — SUPERVISOR-authored adversarial suite for the
// harness-parity PR1 capability manifest (pure half: manifest data, shape
// validation incl. the two-source rule, the compareObserved decision table,
// and the projection reducer). Written from .maddu/state/harness-parity-pr1-
// plan.md (r2/r3 sections are binding) independently of the implementation,
// per the implementer-never-writes-its-own-suite rule.
//
// CONTROL FIRST WITH HARD EXIT: if the shipped manifest does not validate and
// a version inside a real entry's window does not read 'verified', every
// planted-offender assert below ("...is REJECTED", "...is held back to
// 'assumed'") passes vacuously. The control aborts the run rather than let
// that happen.
//
// exit 0 = OK, 1 = assertion failed, 2 = harness error.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LIB = (f) => pathToFileURL(join(process.cwd(), 'template', 'maddu', 'runtime', 'lib', f)).href;

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : `  ${detail}`}`);
  cond ? passed++ : failed++;
};

let H;
try {
  H = await import(LIB('harness-capabilities.mjs'));
} catch (err) {
  console.error(`[harness] import failed: ${err.message}`);
  process.exit(2);
}
for (const fn of ['compareObserved', 'validateHarnessEntry', 'validateHarnessManifest', 'reduceHarnessCapabilities', 'parseVersionTriple', 'extractVersion', 'configCandidatesFor', 'listHarnessNames', 'getHarnessEntry']) {
  if (typeof H[fn] !== 'function') {
    console.error(`[harness] ${fn} is not exported`);
    process.exit(2);
  }
}

// A fully-valid standalone entry the offender cases mutate ONE field at a
// time. Built from the plan's shape, not copied from the shipped manifest, so
// a manifest drift cannot silently reshape the offenders.
const validEntry = (over = {}) => ({
  name: 'fx',
  displayName: 'Fixture CLI',
  hooks: {
    pre_tool: { blocking: 'block', transport: 'stdin-json' },
    session_start: { blocking: 'observe', transport: 'stdin-json' },
  },
  configPaths: {
    win32: ['fx/hooks.json', '~/fx/hooks.json'],
    darwin: ['fx/hooks.json', '~/fx/hooks.json'],
    linux: ['fx/hooks.json', '~/fx/hooks.json'],
  },
  sentinel: { marker: 'hooks fire', files: ['fx/hooks.json'] },
  detect: { command: 'fx', args: ['--version'], versionPattern: '(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)' },
  enforcementCeiling: 'block',
  verifiedAgainst: {
    range: { min: '1.2.0', max: '1.3.0' },
    date: '2026-08-12',
    sources: ['independent-source-a', 'independent-source-b'],
  },
  volatile: null,
  ...over,
});

// ── CONTROL (anti-vacuity, hard exit) ───────────────────────────────────────
{
  const v = H.validateHarnessManifest();
  const codex = H.getHarnessEntry('codex');
  const inWindow = codex && H.compareObserved(codex, { installed: true, version: '0.144.0', probeFailure: null });
  const fxValid = H.validateHarnessEntry('fx', validEntry());
  const controlOk = v.ok === true
    && inWindow && inWindow.status === 'verified' && inWindow.drift === null
    && Array.isArray(fxValid) && fxValid.length === 0;
  ok('CONTROL: shipped manifest validates, in-window codex reads verified, fixture entry is valid', controlOk,
    `manifest.ok=${v && v.ok} errors=${(v && v.errors || []).slice(0, 3).join(' | ')} inWindow=${JSON.stringify(inWindow && { status: inWindow.status, drift: inWindow.drift })} fxErrs=${(fxValid || []).slice(0, 3).join(' | ')}`);
  if (!controlOk) {
    console.error('[harness] CONTROL FAILED — every negative below would be vacuous. Aborting.');
    console.log(`\n${passed} passed, ${failed + 1} failed (control abort)`);
    process.exit(1);
  }
}

// ── Planted offenders — the validator must REJECT each one ─────────────────
// Each offender is a single mutation of a known-valid entry, so a rejection
// can only come from the rule under test.
{
  const cases = [
    ['zero-source block ceiling', validEntry({ verifiedAgainst: { range: { min: '1.2.0', max: '1.3.0' }, date: 'd', sources: [] } }), /sources/i],
    ['one-source block ceiling', validEntry({ verifiedAgainst: { range: { min: '1.2.0', max: '1.3.0' }, date: 'd', sources: ['only-one'] } }), /2 DISTINCT/i],
    ['two IDENTICAL sources (post-trim) block ceiling', validEntry({ verifiedAgainst: { range: { min: '1.2.0', max: '1.3.0' }, date: 'd', sources: ['same', ' same '] } }), /2 DISTINCT/i],
    ['one-source blocking HOOK even under an observe ceiling is caught (ceiling-consistency)', validEntry({ enforcementCeiling: 'observe' }), /strongest claim/i],
    ['half-open range (min set, max null)', validEntry({ verifiedAgainst: { range: { min: '1.2.0', max: null }, date: 'd', sources: ['a', 'b'] } }), /BOTH bounds or NEITHER/i],
    ['inverted range (min > max)', validEntry({ verifiedAgainst: { range: { min: '2.0.0', max: '1.0.0' }, date: 'd', sources: ['a', 'b'] } }), /min > max/i],
    ['sentinel file that is not a declared configPaths candidate', validEntry({ sentinel: { marker: 'hooks fire', files: ['elsewhere/hooks.json'] } }), /not a declared configPaths candidate/i],
    ['detect.command carrying shell metacharacters', validEntry({ detect: { command: 'fx --version | tee /tmp/x', args: [], versionPattern: '(\\d+\\.\\d+\\.\\d+)' } }), /shell metacharacters|shell-free/i],
    ['empty hooks object', validEntry({ hooks: {} }), /non-empty object/i],
    ['unknown blocking kind', validEntry({ hooks: { pre_tool: { blocking: 'enforce', transport: 'stdin-json' } } }), /blocking/i],
    ['volatile without a reason', validEntry({ volatile: {} }), /volatile\.reason/i],
    ['manifest-key / entry-name mismatch', validEntry({ name: 'not-fx' }), /must equal its manifest key/i],
    ['invalid versionPattern RegExp', validEntry({ detect: { command: 'fx', args: [], versionPattern: '([' } }), /not a valid RegExp/i],
    ['non-semver range bound', validEntry({ verifiedAgainst: { range: { min: 'one.two', max: '1.3.0' }, date: 'd', sources: ['a', 'b'] } }), /not a numeric semver triple/i],
  ];
  for (const [label, entry, msgRe] of cases) {
    const errs = H.validateHarnessEntry('fx', entry);
    ok(`offender REJECTED: ${label}`, errs.length > 0 && errs.some((e) => msgRe.test(e)),
      `errs=${errs.slice(0, 3).join(' | ') || '(validated clean — offender got through)'}`);
  }
  // An observe-only entry with a single source is FINE — the two-source bar is
  // for block claims only. Guards against the rule over-firing.
  const observeOneSource = validEntry({
    enforcementCeiling: 'observe',
    hooks: { session_start: { blocking: 'observe', transport: 'stdin-json' } },
    verifiedAgainst: { range: { min: null, max: null }, date: 'd', sources: ['only-one'] },
  });
  ok('observe-only entry with ONE source is accepted (two-source bar is for block claims)',
    H.validateHarnessEntry('fx', observeOneSource).length === 0,
    H.validateHarnessEntry('fx', observeOneSource).slice(0, 3).join(' | '));
  // Null-null range is a legitimate "no window established" declaration.
  const nullRange = validEntry({ verifiedAgainst: { range: { min: null, max: null }, date: 'd', sources: ['a', 'b'] } });
  ok('null/null range is accepted (window deliberately unestablished)',
    H.validateHarnessEntry('fx', nullRange).length === 0,
    H.validateHarnessEntry('fx', nullRange).slice(0, 3).join(' | '));
}

// ── The shipped manifest, entry by entry ────────────────────────────────────
{
  const names = H.listHarnessNames();
  ok('shipped manifest carries exactly the five planned harnesses (sorted)',
    JSON.stringify(names) === JSON.stringify(['claude-code', 'codex', 'gemini', 'hermes', 'openhands']),
    JSON.stringify(names));
  for (const name of names) {
    const errs = H.validateHarnessEntry(name, H.getHarnessEntry(name));
    ok(`shipped entry '${name}' is shape-valid`, errs.length === 0, errs.slice(0, 3).join(' | '));
  }
  // The honesty pins the plan bought: gemini may not claim blocking (one
  // source), and the never-observed harnesses carry no invented window.
  ok("gemini ceiling is 'observe' (single-source blocking is unclaimable)",
    H.getHarnessEntry('gemini').enforcementCeiling === 'observe');
  ok('gemini claims no blocking hook either',
    Object.values(H.getHarnessEntry('gemini').hooks).every((h) => h.blocking !== 'block'));
  for (const name of ['hermes', 'openhands', 'gemini']) {
    const r = H.getHarnessEntry(name).verifiedAgainst.range;
    ok(`'${name}' declares NO version window (never observed installed) rather than inventing one`,
      r.min === null && r.max === null, JSON.stringify(r));
  }
  ok('hermes is marked volatile for the serve gap',
    H.getHarnessEntry('hermes').volatile && H.getHarnessEntry('hermes').volatile.serveGap === true);
  ok('gemini is marked volatile for the antigravity migration',
    /antigravity/.test(H.getHarnessEntry('gemini').volatile?.reason || ''));
  ok('every block-claiming shipped entry carries >=2 distinct sources',
    names.every((n) => {
      const e = H.getHarnessEntry(n);
      const claimsBlock = e.enforcementCeiling === 'block' || Object.values(e.hooks).some((h) => h.blocking === 'block');
      return !claimsBlock || new Set(e.verifiedAgainst.sources.map((s) => s.trim())).size >= 2;
    }));
}

// ── compareObserved — the r3 #2/#3 decision table, case by case ─────────────
{
  const codex = H.getHarnessEntry('codex'); // window {0.144.0, 0.144.0}
  const cases = [
    ['inside window -> verified', { installed: true, version: '0.144.0' }, 'verified', null],
    ['below window -> assumed/below-range', { installed: true, version: '0.143.9' }, 'assumed', 'below-range'],
    ['above window -> assumed/above-range', { installed: true, version: '0.145.0' }, 'assumed', 'above-range'],
    ['unparsable -> assumed/unparsable', { installed: true, version: 'banana' }, 'assumed', 'unparsable'],
    ['missing version -> assumed/unparsable', { installed: true, version: null }, 'assumed', 'unparsable'],
    ['prerelease INSIDE window -> still assumed/prerelease (never upgraded)', { installed: true, version: '0.144.0-rc1' }, 'assumed', 'prerelease'],
    ['not installed -> not-installed, drift null', { installed: false, version: null }, 'not-installed', null],
    ['probe failure -> assumed/probe-failed', { installed: true, version: null, probeFailure: 'timeout' }, 'assumed', 'probe-failed'],
    ['probe failure BEATS a parsable version (a failed probe proves nothing)', { installed: true, version: '0.144.0', probeFailure: 'nonzero-exit' }, 'assumed', 'probe-failed'],
  ];
  for (const [label, detected, wantStatus, wantDrift] of cases) {
    const r = H.compareObserved(codex, detected);
    ok(`decision table: ${label}`, r.status === wantStatus && r.drift === wantDrift,
      `got status=${r.status} drift=${r.drift}`);
  }
  const hermes = H.getHarnessEntry('hermes'); // null/null window
  const r = H.compareObserved(hermes, { installed: true, version: '9.9.9' });
  ok('no window established -> assumed/no-verified-range (never verified)',
    r.status === 'assumed' && r.drift === 'no-verified-range', `got ${r.status}/${r.drift}`);
  // leading-v tolerance rides parseVersionTriple, so a `v`-prefixed CLI answer
  // still lands in the window.
  const rv = H.compareObserved(codex, { installed: true, version: 'v0.144.0' });
  ok("'v0.144.0' parses and verifies", rv.status === 'verified', `got ${rv.status}/${rv.drift}`);
  // Per-capability rows mirror the overall status and are sorted by event.
  const caps = H.compareObserved(codex, { installed: true, version: '0.144.0' }).capabilities;
  ok('capabilities rows are sorted by event name',
    JSON.stringify(caps.map((c) => c.event)) === JSON.stringify([...caps.map((c) => c.event)].sort()));
  ok('every capability row carries the overall status', caps.every((c) => c.status === 'verified'));
  ok('capability rows carry blocking + transport from the manifest',
    caps.every((c) => ['block', 'observe'].includes(c.blocking) && typeof c.transport === 'string'));
  ok('enforcementCeiling is passed through', H.compareObserved(codex, { installed: false }).enforcementCeiling === 'block');
}

// ── Version grammar units ───────────────────────────────────────────────────
{
  ok('parseVersionTriple: plain triple', JSON.stringify(H.parseVersionTriple('2.1.226')) === JSON.stringify({ triple: [2, 1, 226], prerelease: false }));
  ok('parseVersionTriple: v-prefixed', H.parseVersionTriple('v1.2.3')?.triple.join('.') === '1.2.3');
  ok('parseVersionTriple: prerelease flagged', H.parseVersionTriple('1.2.3-rc1')?.prerelease === true);
  ok('parseVersionTriple: build metadata flagged as prerelease-class', H.parseVersionTriple('1.2.3+build5')?.prerelease === true);
  ok('parseVersionTriple: two-component is null', H.parseVersionTriple('1.2') === null);
  ok('parseVersionTriple: non-string is null', H.parseVersionTriple(123) === null);
  ok('compareTriples orders numerically not lexically', H.compareTriples([0, 9, 0], [0, 10, 0]) === -1);
  const codex = H.getHarnessEntry('codex');
  ok("extractVersion pulls '0.144.0' out of 'codex-cli 0.144.0 (build abc)'",
    H.extractVersion(codex, 'codex-cli 0.144.0 (build abc)') === '0.144.0');
  ok('extractVersion returns null on versionless output', H.extractVersion(codex, 'no numbers here') === null);
  ok('extractVersion returns null on empty output', H.extractVersion(codex, '') === null);
  // Funnel r1 #2 — the trailing-boundary hole: a four-component or
  // letter-continued version must NOT truncate to a verifiable triple.
  ok("extractVersion REFUSES to truncate '0.144.0.1' to a verifiable token",
    H.extractVersion(codex, 'codex-cli 0.144.0.1') === null, JSON.stringify(H.extractVersion(codex, 'codex-cli 0.144.0.1')));
  ok("extractVersion REFUSES '0.144.0beta' (no [-+] separator is not a prerelease)",
    H.extractVersion(codex, '0.144.0beta') === null, JSON.stringify(H.extractVersion(codex, '0.144.0beta')));
  ok("extractVersion still accepts a real prerelease '0.144.0-rc1.5'",
    H.extractVersion(codex, 'codex 0.144.0-rc1.5 ready') === '0.144.0-rc1.5');
  ok("extractVersion still accepts 'v0.144.0' and a following parenthetical",
    H.extractVersion(codex, 'v0.144.0 (stable)') === '0.144.0');
  ok('the truncation hole is closed END-TO-END: a continued version reads assumed/unparsable, never verified',
    (() => { const r = H.compareObserved(codex, { installed: true, version: H.extractVersion(codex, '0.144.0.1') }); return r.status === 'assumed' && r.drift === 'unparsable'; })());
}

// ── configCandidatesFor ─────────────────────────────────────────────────────
{
  const e = validEntry({
    configPaths: { win32: ['w.json'], darwin: ['d.json'], linux: ['l.json'] },
    sentinel: { marker: 'hooks fire', files: ['w.json'] },
  });
  ok('platform list is returned for a known platform', JSON.stringify(H.configCandidatesFor(e, 'win32')) === JSON.stringify(['w.json']));
  ok('unknown platform falls back to the linux list', JSON.stringify(H.configCandidatesFor(e, 'freebsd')) === JSON.stringify(['l.json']));
  ok('missing configPaths yields an empty list', JSON.stringify(H.configCandidatesFor({}, 'linux')) === JSON.stringify([]));
  const got = H.configCandidatesFor(e, 'win32');
  got.push('mutated');
  ok('returned list is a copy (caller mutation cannot poison the manifest)',
    JSON.stringify(H.configCandidatesFor(e, 'win32')) === JSON.stringify(['w.json']));
}

// ── getHarnessEntry hardening ───────────────────────────────────────────────
{
  ok('unknown name -> null', H.getHarnessEntry('cursor') === null);
  ok('empty name -> null', H.getHarnessEntry('') === null);
  ok("prototype key '__proto__' -> null (own-property gate)", H.getHarnessEntry('__proto__') === null);
  ok("prototype key 'toString' -> null", H.getHarnessEntry('toString') === null);
}

// ── reduceHarnessCapabilities — latest-per-harness, order-tolerant ─────────
{
  const ev = (id, ts, harness, over = {}) => ({
    id, ts, type: 'HARNESS_CAPABILITY_OBSERVED',
    data: {
      harness, status: 'assumed', cliVersion: null, manifestVersion: '1.0.0',
      capabilities: [], enforcementCeiling: 'observe', drift: 'no-verified-range',
      probeFailure: null, volatile: null, configPath: null, configs: [], workRoot: '/w',
      ...over,
    },
  });
  // Deliberately OUT OF ORDER: the newest codex reading arrives first.
  const events = [
    ev('evt_3', '2026-08-12T10:00:03.000Z', 'codex', { status: 'verified', cliVersion: '0.144.0', drift: null }),
    { id: 'evt_x', ts: '2026-08-12T10:00:09.000Z', type: 'SLICE_STOP', data: { harness: 'codex' } },
    ev('evt_1', '2026-08-12T10:00:01.000Z', 'codex', { status: 'not-installed' }),
    ev('evt_2', '2026-08-12T10:00:02.000Z', 'hermes'),
    { id: 'evt_y', ts: '2026-08-12T10:00:08.000Z', type: 'HARNESS_CAPABILITY_OBSERVED', data: { harness: '' } },
  ];
  const p = H.reduceHarnessCapabilities(events);
  ok('reducer: latest-per-harness wins under out-of-order input',
    p.harnesses.codex?.status === 'verified' && p.harnesses.codex?.eventId === 'evt_3',
    JSON.stringify(p.harnesses.codex && { status: p.harnesses.codex.status, eventId: p.harnesses.codex.eventId }));
  ok('reducer: other harnesses keep their own latest', p.harnesses.hermes?.eventId === 'evt_2');
  ok('reducer: foreign event types are ignored', !('undefined' in p.harnesses) && Object.keys(p.harnesses).length === 2);
  ok('reducer: an observation with an empty harness name is ignored', !('' in p.harnesses));
  ok('reducer: updatedAt is the newest OBSERVED ts', p.updatedAt === '2026-08-12T10:00:03.000Z', p.updatedAt);
  ok('reducer: manifestVersion carried through', p.manifestVersion === '1.0.0');
  ok('reducer: schemaVersion stamped', p.schemaVersion === H.HARNESS_PROJECTION_SCHEMA_VERSION && p.schemaVersion === 1);

  // ts tie -> the caller's INPUT order decides (canonical spine order for a
  // readAll input). Random event ids carry no ordering information, so an id
  // that sorts EARLIER but arrives LATER must still win (funnel r1 #5).
  const tie = H.reduceHarnessCapabilities([
    ev('evt_b', '2026-08-12T10:00:01.000Z', 'codex', { status: 'verified' }),
    ev('evt_a', '2026-08-12T10:00:01.000Z', 'codex', { status: 'not-installed' }),
  ]);
  ok('reducer: ts tie keeps input (canonical) order — the LAST appended wins, not the larger id',
    tie.harnesses.codex.eventId === 'evt_a', tie.harnesses.codex.eventId);

  ok('reducer: non-array input yields an empty projection',
    Object.keys(H.reduceHarnessCapabilities(null).harnesses).length === 0);
  ok('reducer: empty input has null updatedAt/manifestVersion', (() => {
    const e = H.reduceHarnessCapabilities([]);
    return e.updatedAt === null && e.manifestVersion === null;
  })());
}

// ── Constants the doctor and presenters key on ──────────────────────────────
{
  ok('DRIFT_REASONS is exactly the seven-state enum minus null',
    JSON.stringify([...H.DRIFT_REASONS].sort()) === JSON.stringify(['above-range', 'below-range', 'no-verified-range', 'prerelease', 'probe-failed', 'unparsable'].sort()),
    JSON.stringify(H.DRIFT_REASONS));
  ok('OBSERVED_STATUSES is verified|assumed|not-installed',
    JSON.stringify([...H.OBSERVED_STATUSES].sort()) === JSON.stringify(['assumed', 'not-installed', 'verified'].sort()));
  ok('CONFIG_STATUSES is absent|present-no-stanza|stanza-present|unreadable (funnel r1 #6)',
    JSON.stringify([...H.CONFIG_STATUSES].sort()) === JSON.stringify(['absent', 'present-no-stanza', 'stanza-present', 'unreadable'].sort()));
  ok('manifest version constant is a semver string', /^\d+\.\d+\.\d+$/.test(H.HARNESS_CAPABILITIES_VERSION));
}

// ── House tripwire: no NUL bytes in the new lib files ───────────────────────
for (const f of ['harness-capabilities.mjs', 'harness-doctor.mjs']) {
  const raw = readFileSync(join(process.cwd(), 'template', 'maddu', 'runtime', 'lib', f));
  let nulCount = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 0) nulCount++;
  ok(`${f} contains no literal NUL byte`, nulCount === 0, `found ${nulCount}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
