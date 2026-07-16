// Tier-4b minimal-default-catalog compat evidence (usage-audit roadmap).
// Run standalone:  node scripts/test/minimal-catalog-ritual.mjs
//
// PR 4b shrinks the init seed to a single `general` lane (the audit found
// the generic 7-lane seed 76% dead fleet-wide). The roadmap requires
// COMPAT EVIDENCE in-PR: the full ritual must pass on a minimal-catalog
// fixture, and if any flow hard-assumes a specific default lane id, 4b
// blocks. This test runs the REAL flows end-to-end through bin/maddu.mjs
// on a genuinely fresh install:
//   init → hooks install → register → lane claim general (catalog) →
//   slice-stop → lane release → lane claim <ad-hoc> → slice-stop
// plus the ensureSpine seeding path and the seed's shape itself.

import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIB = join(REPO, 'template', 'maddu', 'runtime', 'lib');
const toUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`);

const { DEFAULT_LANE_CATALOG } = await import(toUrl(join(LIB, 'defaults.mjs')));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

// ── The seed itself ──────────────────────────────────────────────────────────
ok(DEFAULT_LANE_CATALOG.lanes.length === 1 && DEFAULT_LANE_CATALOG.lanes[0].id === 'general',
  `default catalog is exactly [general] (got ${DEFAULT_LANE_CATALOG.lanes.map((l) => l.id).join(',')})`);
ok(/lane suggest/.test(DEFAULT_LANE_CATALOG.lanes[0].scope), 'the general scope points at the graduation path');

const tmp = await mkdtemp(join(tmpdir(), 'maddu-t4b-'));
try {
  const fixture = join(tmp, 'fresh-install');
  await mkdir(fixture, { recursive: true });
  const bin = join(REPO, 'bin', 'maddu.mjs');
  const run = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], {
    cwd: fixture, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, ...env },
  });
  const git = (args) => spawnSync('git', args, { cwd: fixture, encoding: 'utf8', timeout: 60000 });

  // ── Full ritual on a REAL fresh install ────────────────────────────────────
  git(['init', '-q']);
  const rInit = run(['init']);
  ok(rInit.status === 0, `maddu init exits 0 on a fresh repo (got ${rInit.status}: ${(rInit.stderr || '').slice(0, 300)})`);
  const cat = JSON.parse(await readFile(join(fixture, '.maddu', 'lanes', 'catalog.json'), 'utf8'));
  ok(cat.lanes.length === 1 && cat.lanes[0].id === 'general',
    `fresh install seeds the 1-lane catalog (got ${cat.lanes.map((l) => l.id).join(',')})`);

  const rHooks = run(['hooks', 'install']);
  ok(rHooks.status === 0, `hooks install exits 0 (got ${rHooks.status}: ${(rHooks.stderr || '').slice(0, 200)})`);
  const settings = await readFile(join(fixture, '.claude', 'settings.json'), 'utf8');
  ok(/hooks fire/.test(settings), 'hooks landed in .claude/settings.json');

  const rReg = run(['register']);
  ok(rReg.status === 0, `register exits 0 (got ${rReg.status}: ${(rReg.stderr || '').slice(0, 200)})`);

  // Catalog lane claim — the flow the audit's discipline path depends on.
  const rClaim = run(['lane', 'claim', 'general', '--focus', 'minimal-catalog compat']);
  ok(rClaim.status === 0 && /claimed\s+general/.test(rClaim.stdout), `catalog lane claim works (got ${rClaim.status}: ${(rClaim.stdout + rClaim.stderr).slice(0, 200)})`);

  const rStop1 = run(['slice-stop', 'SLICE STOP: t4b-catalog compat slice on the catalog lane. Action: fixture. Reason: test.']);
  ok(rStop1.status === 0, `slice-stop on the catalog lane exits 0 (got ${rStop1.status}: ${(rStop1.stderr || '').slice(0, 200)})`);

  const rRel = run(['lane', 'release', 'general']);
  ok(rRel.status === 0, `lane release exits 0 (got ${rRel.status})`);

  // Ad-hoc lane claim — 64% of real consumer claims; must need no catalog row.
  const rAdhoc = run(['lane', 'claim', 'payments-flow', '--focus', 'ad-hoc compat']);
  ok(rAdhoc.status === 0 && /claimed\s+payments-flow/.test(rAdhoc.stdout), `ad-hoc lane claim works (got ${rAdhoc.status}: ${(rAdhoc.stdout + rAdhoc.stderr).slice(0, 200)})`);
  const rStop2 = run(['slice-stop', 'SLICE STOP: t4b-adhoc compat slice on an ad-hoc lane. Action: fixture. Reason: test.']);
  ok(rStop2.status === 0, `slice-stop on the ad-hoc lane exits 0 (got ${rStop2.status})`);

  // lane list renders the minimal catalog without assuming other ids.
  const rList = run(['lane', 'list']);
  ok(rList.status === 0 && /general/.test(rList.stdout) && !/architecture|frontend|backend/.test(rList.stdout),
    'lane list renders the minimal catalog only');

  // ── ensureSpine seeding path (a repo with .maddu but no catalog) ───────────
  const spine = await import(toUrl(join(LIB, 'spine.mjs')));
  const rSeed = join(tmp, 'seed-path');
  await mkdir(join(rSeed, '.maddu'), { recursive: true });
  await spine.ensureSpine(rSeed);
  const seeded = JSON.parse(await readFile(join(rSeed, '.maddu', 'lanes', 'catalog.json'), 'utf8'));
  ok(seeded.lanes.length === 1 && seeded.lanes[0].id === 'general', 'ensureSpine seeds the same minimal catalog');

  // ── Existing installs untouched ────────────────────────────────────────────
  // (a) upgrade's managed-file manifest never includes catalog.json;
  const manifest = await import(toUrl(join(REPO, 'commands', '_manifest.mjs')));
  const files = await manifest.frameworkOwnedFiles();
  ok(files.length > 0 && !files.some((f) => String(f.relPath || f).includes('lanes/catalog.json')),
    'catalog.json is not a framework-managed file — upgrade can never rewrite an existing catalog');
  // (b) `init --force` re-installs FRAMEWORK files but must preserve a
  // customized catalog and live claims — the seed is first-install only
  // (Codex Tier-4b round 1: the old unconditional seed write was a real
  // data-loss path under --force).
  const { writeFile } = await import('node:fs/promises');
  const customCatalog = { schemaVersion: 1, framework: 'maddu', lanes: [{ id: 'general', scope: 'x' }, { id: 'my-custom-lane', scope: 'operator-authored' }] };
  await writeFile(join(fixture, '.maddu', 'lanes', 'catalog.json'), JSON.stringify(customCatalog, null, 2) + '\n');
  const claimsBefore = await readFile(join(fixture, '.maddu', 'lanes', 'claims.json'), 'utf8');
  const rForce = run(['init', '--force']);
  ok(rForce.status === 0, `init --force exits 0 on an existing install (got ${rForce.status}: ${(rForce.stderr || '').slice(0, 200)})`);
  const catAfterForce = JSON.parse(await readFile(join(fixture, '.maddu', 'lanes', 'catalog.json'), 'utf8'));
  ok(catAfterForce.lanes.length === 2 && catAfterForce.lanes.some((l) => l.id === 'my-custom-lane'),
    `init --force preserves a customized catalog (got ${catAfterForce.lanes.map((l) => l.id).join(',')})`);
  ok((await readFile(join(fixture, '.maddu', 'lanes', 'claims.json'), 'utf8')) === claimsBefore,
    'init --force preserves live claims.json');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`minimal-catalog-ritual: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
