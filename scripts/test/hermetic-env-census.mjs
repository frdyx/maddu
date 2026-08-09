#!/usr/bin/env node
// hermetic-env-census — a RATCHET, not a pass/fail opinion about style.
//
// A fixture suite that spawns the real CLI with `env: { ...process.env, … }`
// hands the developer's live Máddu identity to a throwaway repo. That is not
// hypothetical: it is what made minimal-catalog-ritual and learn-slice-trigger
// look permanently red, and both were then written into the project handoff as
// "known pre-existing, do not chase" — so a genuine regression inside either
// would have been dismissed on sight. A permanently-red gate is worse than no
// gate, because it launders real failures into expected noise.
//
// Migrating all 33 remaining suites in one sweep would be a large, mostly blind
// change. So this census pins the CURRENT set instead, on the same principle as
// the sid-surface census: the number may only go DOWN. A new suite that spreads
// the ambient env fails here immediately; migrating an existing one requires
// deleting its line, which is a one-word diff.
//
// exit 0 = OK, 1 = ratchet breached, 2 = harness error.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Suites KNOWN to spread the ambient environment as of v1.120.0. Each is a
// latent instance of the defect above; none is currently observed failing.
// Remove a name when you migrate it to `hermeticEnv()`. Never add one.
const KNOWN = new Set([
  'advise-spawn.mjs', 'agents-register.mjs', 'auto-handoff.mjs', 'auto-review.mjs',
  'autonomy-cli.mjs', 'blueprint-distill.mjs', 'ci-command.mjs', 'cost-provenance.mjs',
  'discipline-honesty-guard.mjs', 'discipline-hook.mjs', 'event-schema-expect-flags.mjs',
  'hooks-guardrails-e2e.mjs', 'lane-release-idempotent.mjs', 'learn-e2e.mjs',
  'learn-fallback.mjs', 'learn-spawn.mjs', 'mutation-witness-cli.mjs',
  'reversible-briefings.mjs', 'session-lifecycle.mjs', 'skill-injection.mjs',
  'slice-scope-gitdiff.mjs', 'spine-anchor-assess.mjs', 'spine-anchor.mjs',
  'stress-harness.mjs', 'token-wrapper-emission.mjs', 'upgrade-matrix.mjs',
  'upgrade-prev-hash.mjs', 'verify-replay.mjs', 'wiki-materialize.mjs',
  'workspace-roles.mjs', 'ws-chain-splice.mjs', 'ws-sync-identity.mjs',
]);

// _hermetic-env.mjs itself documents the pattern in a comment; the runner
// legitimately forwards the environment to the suites it spawns.
const EXEMPT = new Set(['_hermetic-env.mjs', '_self-test-runner.mjs', 'hermetic-env-census.mjs']);

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
};

let names;
try {
  names = (await readdir(HERE)).filter((n) => n.endsWith('.mjs'));
} catch (err) {
  console.error(`harness error: ${err.message}`);
  process.exit(2);
}

const offenders = [];
for (const n of names) {
  if (EXEMPT.has(n)) continue;
  let src = '';
  try { src = await readFile(join(HERE, n), 'utf8'); } catch { continue; }
  // Comment lines are skipped. A whole-file match flags any suite that merely
  // DOCUMENTS the pattern: the first run of this census flagged the very
  // comment explaining a completed migration, which would have taught the next
  // reader to delete the explanation instead of the defect.
  const code = src.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  if (code.includes('...process.env')) offenders.push(n);
}

const fresh = offenders.filter((n) => !KNOWN.has(n));
const migrated = [...KNOWN].filter((n) => !offenders.includes(n));

ok('no NEW suite spreads the ambient environment into a fixture', fresh.length === 0,
  `new offenders: ${fresh.join(', ')} — use hermeticEnv() from ./_hermetic-env.mjs`);

ok('the census is not stale (migrated suites removed from KNOWN)', migrated.length === 0,
  `already migrated, delete from KNOWN: ${migrated.join(', ')}`);

console.log('');
console.log(`  ambient-env suites remaining: ${offenders.length} (ratchet: may only decrease)`);
console.log(`hermetic-env-census: ${passed} pass - ${failed} fail`);
process.exit(failed ? 1 : 0);
