#!/usr/bin/env node
// flag-allowlists — A1 unknown-flag guard: scanner, artifact staleness, guard
// behavior, and the live dispatcher wiring.
//
// Why this exists: parseFlags accepts any --key and no verb validates the key
// set, so `session close --session-id` (a flag NO command read at the time)
// silently closed the ambient session at exit 0 — defect A2. The guard warns
// at dispatch; this suite proves the scanner sees what commands read, the
// committed artifact is current, and the wiring actually fires.
//
// exit 0 = all pass, 1 = failures, 2 = harness/control error.

import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPEN_VERBS, extractPreciseReads, extractBroadTokens,
  deriveFlagAllowlists, renderAllowlistArtifact,
} from './_flag-scan.mjs';
import { extractFlagKeys, checkUnknownFlags, levenshtein } from '../../commands/_flag-guard.mjs';
import { tmp, cleanupFixtures, events, childEnv } from './_pr1-fixtures.mjs';
import { repoFixture, sourceFixture, fixtureCli, fixtureEnv, sameSet, plain } from './_pr2-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  extra = extra.replace(/\s+/g, ' ').trim();
  if (cond) { passed++; console.log(`  [PASS] ${name} - ${extra || 'assertion holds'}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
};

// ── CONTROL FIRST (anti-vacuity, hard exit) ─────────────────────────────────
// If the scanner cannot find a trivially-present read, or the guard cannot
// flag a trivially-unknown key, every negative assertion below would pass for
// free. Hard-exit: a broken control means the suite proves nothing.
{
  const found = extractPreciseReads(`const x = flags.controlKey;`);
  const finding = checkUnknownFlags({
    verb: 'ctl', rest: ['--obviously-bogus'],
    allowlists: { open: [], verbs: { ctl: ['real'] } },
  });
  if (!found.has('controlKey') || finding.length !== 1) {
    console.error('CONTROL FAILED: scanner or guard is blind — suite is vacuous, aborting.');
    process.exit(2);
  }
  passed += 1;
  console.log('  [PASS] CONTROL - scanner sees a planted read AND guard flags a planted unknown');
}

// Existing A1 rows remain as controls for PR2 1.1, 1.4–1.9. Only the
// zero-flag expectation changes; CLI fixtures and reporting are made hermetic.
try {
// ── Extraction units ────────────────────────────────────────────────────────
{
  const t = extractPreciseReads(`
    const a = flags.json; if (flags?.lane) {}
    const b = flags['dry-run']; const c = flags?.['fail-on'];
    requireFlag(flags, 'objective');
    if (Object.hasOwn(flags, 'parent')) {}
  `);
  ok('dot read', t.has('json'));
  ok('optional-chain dot read', t.has('lane'));
  ok('bracket kebab read', t.has('dry-run'));
  ok('optional bracket read', t.has('fail-on'));
  ok('requireFlag read', t.has('objective'));
  ok('hasOwn literal read', t.has('parent'));
}
{
  // The exact alias shape shipped by the A2 fix (commands/session.mjs) — a
  // non-literal hasOwn key whose candidates are the string literals on the line.
  const t = extractPreciseReads(
    `  const explicitKeys = ['session', 'session-id'].filter((k) => Object.hasOwn(flags, k));`,
  );
  ok('hasOwn array-literal alias shape yields both keys', t.has('session') && t.has('session-id'));
}
{
  // THE A2 LESSON PIN: precise extraction must NOT collect flags out of prose.
  // A broad harvest on a parseFlags file would have allowlisted --session-id
  // from the very documentation that caused the defect.
  const t = extractPreciseReads(`
    // Close with: maddu session close --session-id <id>
    const { flags } = parseFlags(rest);
    const s = flags.session;
  `);
  ok('precise mode ignores flags mentioned only in prose/comments',
    t.has('session') && !t.has('session-id'), `got: ${[...t].join(',')}`);
}
{
  const t = extractBroadTokens(`if (argv.includes('--force-active')) {} // usage: [--port N]`);
  ok('broad harvest (hand-rolled verbs only) collects --tokens', t.has('force-active') && t.has('port'));
}

// ── Derivation vs the committed artifact (staleness) ────────────────────────
const derived = await deriveFlagAllowlists(join(REPO_ROOT, 'commands'));
let artifactText = null;
try { artifactText = await readFile(join(REPO_ROOT, 'commands', '_flag-allowlists.json'), 'utf8'); } catch {}
ok('committed artifact exists', artifactText !== null);
// CRLF-normalized on read (same discipline as the cockpit golden gate): the
// artifact is .gitattributes-pinned to LF, but an unpinned historical checkout
// under autocrlf must not red the staleness check for line endings alone.
ok('committed artifact is CURRENT (re-derived byte-equal) — else run scripts/generate-flag-allowlists.mjs',
  artifactText !== null && artifactText.replace(/\r\n/g, '\n') === renderAllowlistArtifact(derived));

const allowlists = artifactText ? JSON.parse(artifactText) : { open: [], verbs: {} };

// ── OPEN set pinned exactly ─────────────────────────────────────────────────
// These forward argv verbatim to git/npm/eslint/the project runner — their
// flags are not Máddu's to judge. Adding a verb here disables the guard for
// it: that must be a reviewed decision, never a drive-by.
ok('OPEN verbs pinned exactly',
  JSON.stringify([...allowlists.open].sort()) === JSON.stringify(['format', 'git', 'install', 'lint', 'test']),
  `got: ${allowlists.open.join(',')}`);
ok('OPEN_VERBS constant agrees with the artifact',
  JSON.stringify([...OPEN_VERBS].sort()) === JSON.stringify([...allowlists.open].sort()));

// ── Membership spot checks (regressions here re-open A2-class holes) ───────
const has = (verb, key) => Array.isArray(allowlists.verbs[verb]) && allowlists.verbs[verb].includes(key);
ok('session accepts --session AND the --session-id alias', has('session', 'session') && has('session', 'session-id'));
ok('lane accepts --lane', has('lane', 'lane'));
ok('orient accepts --no-verify', has('orient', 'no-verify'));
ok('self-test accepts --profile (parsed by its runner, harvested from usage)', has('self-test', 'profile'));
ok('goal accepts --objective', has('goal', 'objective'));
ok('loop accepts --verify', has('loop', 'verify'));

// ── Scanner-blindness tripwires ─────────────────────────────────────────────
// A verb that parses flags but derives an EMPTY allowlist means the scanner
// went blind for that file (e.g. `flags` renamed) — every valid call would
// warn. Zero-flag verbs must be exactly the ones that truly read none.
ok('1.8 zero-flag verbs are exactly the flag-less hand-rolled ones (bridges, focus, stop)',
  JSON.stringify(derived.zeroFlagVerbs) === JSON.stringify(['bridges', 'focus', 'stop']),
  `got: ${derived.zeroFlagVerbs.join(',')}`);
{
  // No command may rename the destructured `flags` binding — the scanner keys
  // on the name. (positional renames are fine.)
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(join(REPO_ROOT, 'commands'))).filter((n) => n.endsWith('.mjs'));
  const renamers = [];
  for (const n of names) {
    const src = await readFile(join(REPO_ROOT, 'commands', n), 'utf8');
    // Destructure-rename only ({ flags: f } = parseFlags…) — parseFlags itself
    // CONSTRUCTS `{ flags: out }` in its return, which is not a rename (the
    // first run of this tripwire flagged exactly that).
    if (/\{[^}]*\bflags\s*:\s*[A-Za-z][^}]*\}\s*=\s*parseFlags/.test(src)) renamers.push(n);
  }
  ok('no command renames the destructured `flags` binding (scanner would go blind)',
    renamers.length === 0, `renamers: ${renamers.join(',')}`);
}

// ── Guard units ─────────────────────────────────────────────────────────────
const AL = { open: ['git'], verbs: { session: ['session', 'session-id', 'json'], empty: [] } };
ok('known flags → no findings',
  checkUnknownFlags({ verb: 'session', rest: ['close', '--session', 'x', '--json'], allowlists: AL }).length === 0);
ok('unknown flag → finding with nearest suggestion',
  (() => { const f = checkUnknownFlags({ verb: 'session', rest: ['--sesion', 'x'], allowlists: AL }); return f.length === 1 && f[0].suggestion === 'session'; })());
ok('suggestion suppressed beyond distance 2',
  checkUnknownFlags({ verb: 'session', rest: ['--zzqqxx'], allowlists: AL })[0].suggestion === null);
ok('open verb → fail-open', checkUnknownFlags({ verb: 'git', rest: ['--amend'], allowlists: AL }).length === 0);
ok('unlisted verb → fail-open', checkUnknownFlags({ verb: 'nope', rest: ['--x'], allowlists: AL }).length === 0);
ok('malformed allowlists → fail-open', checkUnknownFlags({ verb: 'session', rest: ['--x'], allowlists: null }).length === 0);
ok('--help/-h tolerated even if a call path bypasses the dispatcher short-circuit',
  checkUnknownFlags({ verb: 'session', rest: ['--help'], allowlists: AL }).length === 0);
ok('--key=value extracts the key', JSON.stringify(extractFlagKeys(['--session=abc'])) === JSON.stringify(['session']));
ok('bare -- yields the empty key (parseFlags really parses it as one)',
  JSON.stringify(extractFlagKeys(['--', 'x'])) === JSON.stringify(['']));
ok('repeated unknown deduped',
  checkUnknownFlags({ verb: 'session', rest: ['--bogus', 'a', '--bogus', 'b'], allowlists: AL }).length === 1);
ok('values never scanned as keys (parseFlags values cannot start with --)',
  JSON.stringify(extractFlagKeys(['--session', 'ses_abc', 'positional'])) === JSON.stringify(['session']));
ok('levenshtein sanity', levenshtein('sesion', 'session') === 1 && levenshtein('', 'ab') === 2);
ok('zero-allowlist verb: every flag unknown, no suggestion invented',
  (() => { const f = checkUnknownFlags({ verb: 'empty', rest: ['--json'], allowlists: AL }); return f.length === 1 && f[0].suggestion === null; })());

// ── Live dispatcher integration (hermetic env — C1/C2 seam) ─────────────────
const BIN = join(REPO_ROOT, 'bin', 'maddu.mjs');
const dispatcherRoot = await repoFixture('maddu-pr2-flags-dispatch-');
const run = (args, envOverrides = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: dispatcherRoot, encoding: 'utf8', timeout: 60000,
  env: childEnv(fixtureEnv(dispatcherRoot, { MADDU_STRICT_FLAGS: '', ...envOverrides })),
});
{
  // STRICT BY DEFAULT (v1.122.0 flip, post-soak, operator-approved): an
  // unset/blank env refuses the unknown flag.
  const r = run(['session', 'list', '--bogus-zz-a1']);
  ok('CLI default: unknown flag exits 2 (strict by default)', r.status === 2, `exit=${r.status}`);
  ok('CLI default: unknown flag named on stderr', r.stderr.includes('unknown flag --bogus-zz-a1'), r.stderr.slice(0, 200));
  ok('CLI default: verb did NOT run', !r.stdout.includes('ACTIVE'), r.stdout.slice(0, 120));
  ok('CLI default: the refusal names the temporary opt-out',
    /MADDU_STRICT_FLAGS=0/.test(r.stderr), r.stderr.slice(0, 250));
}
{
  const r = run(['session', 'list', '--sesion', 'x']);
  ok('CLI: did-you-mean rendered', r.stderr.includes('did you mean --session?'), r.stderr.slice(0, 200));
}
{
  const r = run(['session', 'list', '--bogus-zz-a1'], { MADDU_STRICT_FLAGS: '1' });
  ok('CLI strict=1 (legacy spelling): exit 2', r.status === 2, `exit=${r.status}`);
}
{
  // The temporary opt-out: warn on stderr, verb still runs, and the warning
  // says the opt-out is temporary rather than implying a stable mode.
  const r = run(['session', 'list', '--bogus-zz-a1'], { MADDU_STRICT_FLAGS: '0' });
  ok('CLI opt-out=0: warns but verb still runs', r.status === 0 && r.stderr.includes('unknown flag --bogus-zz-a1'), `exit=${r.status} ${r.stderr.slice(0, 150)}`);
  ok('CLI opt-out=0: warning marks the opt-out as temporary', /temporary/.test(r.stderr), r.stderr.slice(0, 250));
}
{
  const r = run(['session', 'list']);
  ok('CLI control: clean call produces no unknown-flag noise', !r.stderr.includes('unknown flag'), r.stderr.slice(0, 200));
}
{
  // Flag names are caller-typed text — a pasted token must never be echoed
  // verbatim (the spine-anchor-assess and verify-replay suites caught the
  // first version of the guard doing exactly that).
  const token = 'ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
  const r = run(['session', 'list', `--${token}`]);
  ok('CLI: token-shaped unknown flag name is REDACTED, never echoed verbatim',
    r.stderr.includes('unknown flag') && !(r.stderr + r.stdout).includes(token), r.stderr.slice(0, 200));
}

// ── PR2 1.1 / 1.2: exact identities, for BOTH derivation and loaded artifact.
// The pre-existing OPEN passthrough verbs remain outside the guarded universe.
const SESSION_VERBS = ['advise', 'approval', 'lane', 'mailbox', 'model', 'pipeline', 'runtime',
  'session', 'skill', 'slice', 'slice-stop', 'spine', 'team', 'usage', 'worker'];
const PARENT_VERBS = ['register', 'session'];
for (const [clause, key, expected] of [['1.1', 'session', SESSION_VERBS], ['1.2', 'parent', PARENT_VERBS]]) {
  for (const [label, artifact] of [['derived', derived], ['committed', allowlists]]) {
    const actual = Object.keys(artifact.verbs).filter((v) => artifact.verbs[v].includes(key));
    ok(`${clause} ${label} --${key} owners`, sameSet(actual, expected),
      `missing=${expected.filter((v) => !actual.includes(v)).join(',') || 'none'}; extra=${actual.filter((v) => !expected.includes(v)).join(',') || 'none'}`);
  }
  // Exercise the guard against EVERY guarded identity, without running e.g.
  // init/worker/upgrade just to see whether dispatch would reject a flag.
  const mismatches = Object.keys(allowlists.verbs).filter((verb) => {
    const findings = checkUnknownFlags({ verb, rest: [`--${key}`, 'ses_pr2'], allowlists });
    return expected.includes(verb) ? findings.length !== 0 : !findings.some((f) => f.key === key);
  });
  ok(`${clause} guard accepts owners and rejects every other guarded verb`, mismatches.length === 0,
    `mismatched verbs=${mismatches.join(',') || 'none'}`);
}
for (const args of [['goal', 'show'], ['plan', 'list'], ['status'], ['register'], ['orient', '--no-verify'],
  ['handoff', 'show'], ['ci'], ['trust', 'list'], ['events', 'list']]) {
  const r = fixtureCli(dispatcherRoot, [...args, '--session', 'ses_x']);
  ok(`1.1 CLI ${args[0]} rejects --session`, r.status === 2 && r.stderr.includes('unknown flag --session'),
    `exit=${r.status}; ${plain(r.stderr).trim().slice(0, 180) || 'no flag diagnostic'}`);
}
for (const args of [['goal', 'show'], ['team', 'status'], ['pipeline', 'list']]) {
  const r = fixtureCli(dispatcherRoot, [...args, '--parent', 'ses_pr2']);
  ok(`1.2 CLI ${args[0]} rejects --parent`, r.status === 2 && r.stderr.includes('unknown flag --parent'),
    `exit=${r.status}; ${plain(r.stderr).trim().slice(0, 180) || 'no flag diagnostic'}`);
}

// ── PR2 1.3: the explicit value reaches validation, before any business action.
// A stub advisor is an existing, non-spawning CLI mode. No real advisor binary
// or auth store is consulted, even while the malformed flag is ignored at base.
const malformed = [
  ['bare', ['--session']], ['empty', ['--session=']],
  ['repeated', ['--session', 'ses_pr2_raw_first', '--session', 'ses_pr2_raw_second']],
];
for (const verb of ['advise', 'team', 'pipeline']) {
  for (const [shape, flags] of malformed) {
    const root = await repoFixture(`maddu-pr2-${verb}-${shape}-`);
    await mkdir(join(root, '.maddu/config/pipelines'), { recursive: true });
    await writeFile(join(root, '.maddu/config/pipelines/pr2.json'), JSON.stringify({ name: 'pr2', stages: [{ name: 'record' }] }));
    const args = verb === 'advise' ? ['advise', 'pr2-advisor', 'fixture prompt', '--stub-only']
      : verb === 'team' ? ['team', 'open', '--members', '1', '--lanes', 'pr2']
      : ['pipeline', 'run', 'pr2', 'fixture goal'];
    const r = fixtureCli(root, [...args, ...flags]);
    const text = plain(r.stdout + r.stderr);
    const type = { advise: 'ADVISOR_INVOKED', team: 'TEAM_OPENED', pipeline: 'PIPELINE_STARTED' }[verb];
    const emitted = await events(root, type);
    ok(`1.3 ${verb} ${shape} --session is a message-only hard error`,
      r.status === 2 && r.stdout.trim() === '' && /invalid --session id/i.test(r.stderr)
      && !/\n\s+at\s/.test(text) && !text.includes('ses_pr2_raw_first') && !text.includes('ses_pr2_raw_second')
      && emitted.length === 0,
      `exit=${r.status}; ${type}=${emitted.length}; ${plain(r.stderr).trim().slice(0, 160) || 'no invalid-session diagnostic'}`);
  }
}
for (const verb of ['team', 'pipeline']) {
  const root = await repoFixture(`maddu-pr2-${verb}-actor-`);
  const register = (label) => {
    const r = fixtureCli(root, ['session', 'register', '--role', 'implementer', '--label', label]);
    if (r.status !== 0) throw new Error(`register fixture failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const explicit = register('explicit');
  const ambient = register('ambient');
  await mkdir(join(root, '.maddu/config/pipelines'), { recursive: true });
  await writeFile(join(root, '.maddu/config/pipelines/pr2.json'), JSON.stringify({ name: 'pr2', stages: [{ name: 'record' }] }));
  const args = verb === 'team' ? ['team', 'open', '--members', '1', '--lanes', 'pr2'] : ['pipeline', 'run', 'pr2', 'fixture goal'];
  const type = verb === 'team' ? 'TEAM_OPENED' : 'PIPELINE_STARTED';
  const control = fixtureCli(root, args, { MADDU_SESSION_ID: ambient });
  const before = await events(root, type);
  ok(`1.3 ${verb} ambient actor control`, control.status === 0 && before.some((e) => e.actor === ambient),
    `exit=${control.status}; expected ambient=${ambient}; actors=${before.map((e) => e.actor).join(',')}`);
  const r = fixtureCli(root, [...args, '--session', explicit], { MADDU_SESSION_ID: ambient });
  const priorIds = new Set(before.map((e) => e.id));
  const added = (await events(root, type)).filter((e) => !priorIds.has(e.id));
  ok(`1.3 ${verb} explicit actor overrides a different live ambient session`,
    r.status === 0 && added.some((e) => e.actor === explicit) && added.every((e) => e.actor === explicit),
    `exit=${r.status}; expected=${explicit}; actors=${added.map((e) => e.actor).join(',')}`);
}

// ── PR2 1.4–1.7: source fixtures separate reads from comments/prose/imports.
const scanRoot = await tmp('maddu-pr2-flag-scan-');
const commandsDir = join(scanRoot, 'commands');
await mkdir(commandsDir);
await mkdir(join(scanRoot, 'scripts/test'), { recursive: true });
const fixtures = {
  '_args.mjs': `export function parseFlags(args) { return { flags: {}, positional: args }; }`,
  '_helpers.mjs': `export function used(flags) { return flags.routed; }
export function unrelated(flags) { return flags.unrelated; }
export function identity(value) { return value; }`,
  'comment.mjs': `import { parseFlags } from './_args.mjs';
export default function command(rest) { const { flags } = parseFlags(rest); return flags.control; }
// flags.someInventedKey is not a read.
/* flags.blockInventedKey is not a read either. */`,
  'prose.mjs': `export default function command(argv) {
const usage = 'maddu prose --usage-only'; return argv.includes('--control'); }`,
  'routed.mjs': `import { parseFlags } from './_args.mjs'; import { used } from './_helpers.mjs';
export default function command(rest) { const { flags } = parseFlags(rest); return used(flags); }`,
  'unrouted.mjs': `import { parseFlags } from './_args.mjs'; import { identity } from './_helpers.mjs';
export default function command(rest) { const { flags } = parseFlags(rest); return identity(flags.control); }`,
  'membership.mjs': `import { parseFlags } from './_args.mjs';
export default function command(argv) {
const { flags } = parseFlags(argv); const args = argv;
return flags.control || argv.some(arg => arg === '--equal-read') || argv.includes('--includes-read')
  || args.indexOf('--index-read') >= 0 || argv.some(a => a.startsWith('--prefix-read=')); }`,
  'forwarded.mjs': `import { parse } from '../scripts/test/parser.mjs';
export default function command(argv) { return parse(argv); }`,
};
for (const [name, body] of Object.entries(fixtures)) await writeFile(join(commandsDir, name), body + '\n');
await writeFile(join(scanRoot, 'scripts/test/parser.mjs'), `export function parse(args) { return args.includes('--outside-read'); }\n`);
const scanned = await deriveFlagAllowlists(commandsDir);
for (const [id, verb, expected] of [
  ['1.4 comment-only keys are excluded', 'comment', ['control']],
  ['1.5 usage-string-only keys are excluded', 'prose', ['control']],
  ['1.1 helper receives own flags, only the called function contributes', 'routed', ['routed']],
  ['1.1 importing a helper does not confer its unread keys', 'unrouted', ['control']],
  ['1.6 raw membership reads survive beside parseFlags', 'membership', ['control', 'equal-read', 'includes-read', 'index-read', 'prefix-read']],
  ['1.7 raw argv reaches a parser outside commands', 'forwarded', ['outside-read']],
]) ok(id, sameSet(scanned.verbs[verb] || [], expected), `derived=${(scanned.verbs[verb] || []).join(',')}; expected=${expected.join(',')}`);
const force = fixtureCli(dispatcherRoot, ['sources', '--force']);
ok('1.4 CLI sources rejects comment-only --force', force.status === 2 && force.stderr.includes('unknown flag --force'),
  `exit=${force.status}; ${plain(force.stderr).trim().slice(0, 180)}`);
const aliasRoot = await repoFixture('maddu-pr2-session-alias-');
const aliasRegistration = fixtureCli(aliasRoot, ['session', 'register', '--role', 'implementer']);
if (aliasRegistration.status !== 0) throw new Error(`alias fixture registration failed: ${aliasRegistration.stderr}`);
const aliasId = aliasRegistration.stdout.trim();
const alias = fixtureCli(aliasRoot, ['session', 'close', '--session-id', aliasId]);
ok('1.5 CLI --session-id remains accepted', alias.status === 0
  && (await events(aliasRoot, 'SESSION_CLOSED')).some((e) => e.actor === aliasId),
  `exit=${alias.status}; alias closes the named fixture session`);
const loop = fixtureCli(dispatcherRoot, ['loop', 'status', '--loop', 'pr2-absent']);
ok('1.6 CLI loop status accepts --loop', loop.status !== 2 && !loop.stderr.includes('unknown flag --loop'),
  `exit=${loop.status}; ${plain(loop.stderr).trim().slice(0, 180)}`);
const selfFlags = ['profile', 'only', 'skip', 'bail', 'json', 'no-report', 'fail-on-skip', 'list'];
ok('1.7 self-test keeps every parser-owned flag', selfFlags.every((key) => has('self-test', key)),
  `missing=${selfFlags.filter((key) => !has('self-test', key)).join(',') || 'none'}`);
const selfRoot = await sourceFixture('maddu-pr2-self-list-');
await mkdir(join(selfRoot, 'scripts/test'), { recursive: true });
await copyFile(join(REPO_ROOT, 'scripts/test/_self-test-runner.mjs'), join(selfRoot, 'scripts/test/_self-test-runner.mjs'));
await writeFile(join(selfRoot, 'scripts/test/pr2-control.mjs'), 'console.log("fixture");\n');
for (const args of [['--profile', 'quick', '--list'], ['--list', '--json']]) {
  const r = fixtureCli(selfRoot, ['self-test', ...args], {}, join(selfRoot, 'bin/maddu.mjs'));
  ok(`1.7 self-test ${args.join(' ')} reaches the runner`, r.status === 0 && !r.stderr.includes('unknown flag'),
    `exit=${r.status}; ${plain(r.stderr).trim().slice(0, 160) || 'list succeeded'}`);
}
const nope = fixtureCli(selfRoot, ['self-test', '--nope'], {}, join(selfRoot, 'bin/maddu.mjs'));
ok('1.7 self-test rejects --nope control', nope.status !== 0 && /unknown flag.*--nope/.test(nope.stderr), `exit=${nope.status}`);
// 1.10: execute the shipped census, never duplicate its parsing/ratchet logic.
const census = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/test/doc-flag-census.mjs')], {
  cwd: dispatcherRoot, env: childEnv(fixtureEnv(dispatcherRoot)), encoding: 'utf8', timeout: 60000,
});
ok('1.10 documented flags stay derivable', census.status === 0,
  plain(census.stdout + census.stderr).trim().split('\n').at(-1) || `exit=${census.status}`);
} catch (err) {
  ok('PR2 harness', false, err.stack || err.message);
} finally {
  await cleanupFixtures();
}
console.log('');
console.log(`flag-allowlists: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
