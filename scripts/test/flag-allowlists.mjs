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
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPEN_VERBS, extractPreciseReads, extractBroadTokens,
  deriveFlagAllowlists, renderAllowlistArtifact,
} from './_flag-scan.mjs';
import { extractFlagKeys, checkUnknownFlags, levenshtein } from '../../commands/_flag-guard.mjs';
import { hermeticEnv } from './_hermetic-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
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
  console.log('  [PASS] CONTROL: scanner sees a planted read AND guard flags a planted unknown');
}

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
ok('zero-flag verbs are exactly the flag-less hand-rolled ones (bridges, stop)',
  JSON.stringify(derived.zeroFlagVerbs) === JSON.stringify(['bridges', 'stop']),
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
const run = (args, envOverrides = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: REPO_ROOT, encoding: 'utf8',
  env: hermeticEnv({ MADDU_STRICT_FLAGS: '', ...envOverrides }),
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

console.log('');
console.log(`flag-allowlists: ${passed} pass - ${failed} fail`);
process.exit(failed ? 1 : 0);
