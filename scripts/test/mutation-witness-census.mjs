#!/usr/bin/env node
// mutation-witness-census — the command-tier-discipline extension that keeps
// the S1 guard un-bypassable statically.
//
//   (A) live tree: the full gate runs GREEN (census included).
//   (B) dispatcher arity: a doctored bin with an extra unguarded dispatch, a
//       missing guard, or lost --help pins reds.
//   (C) readShapes honesty: a fabricated stale shape token reds; flag tokens
//       are matched in their parsed form (flags['no-emit'] / flags.status).
//   (D) pinned exceptions: removing init's witnessRaw annotations or fleet's
//       delegated declaration reds.
//   (E) bridge wiring: a server source without the wrap/export/exemption
//       table reds; a stale exemption path reds.
//   (F) spool backstop: an undrained breach row reds the gate for that repo.
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import gate, {
  censusDispatcherArity, censusReadShapes, censusPinnedExceptions, censusBridge,
} from '../../template/maddu/runtime/gates/builtin/command-tier-discipline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

try {
  // ── (A) live tree green ─────────────────────────────────────────────────
  {
    const r = await gate.run({ repoRoot });
    ok('gate GREEN on the real tree (census included)', r.ok === true, r.message);
    ok('message names the census', /mutation-witness census green/.test(r.message));
  }

  // ── (B) dispatcher arity ────────────────────────────────────────────────
  {
    const binSrc = await readFile(join(repoRoot, 'bin', 'maddu.mjs'), 'utf8');
    ok('real bin passes arity', censusDispatcherArity(binSrc).length === 0);
    const extra = binSrc + '\nasync function sneak(mod, rest) { await mod.default(rest); }\n';
    ok('an extra unguarded dispatch site reds', censusDispatcherArity(extra).length > 0);
    const unguarded = binSrc.replace(/runWithWitness/g, 'runPlain');
    ok('a bin without the guarded site reds', censusDispatcherArity(unguarded).length > 0);
    const unpinned = binSrc.replace('census-pinned --help site 1', 'whatever');
    ok('a lost --help pin reds', censusDispatcherArity(unpinned).length > 0);
  }

  // ── (C) readShapes honesty ──────────────────────────────────────────────
  {
    const tiers = { fake: { tier: 'mutating', readShapes: ['list', 'nonexistent-subverb'] } };
    const sources = new Map([['fake', "if (sub === 'list') { return; } // no other subverbs"]]);
    const { stale } = censusReadShapes(['fake'], tiers, sources);
    ok('a stale shape token reds', stale.length === 1 && /nonexistent-subverb/.test(stale[0]));
    const flagTiers = { f2: { tier: 'mutating', readShapes: [{ tokens: [], requiredFlags: ['--no-emit'] }] } };
    const flagSrc = new Map([['f2', "if (flags['no-emit'] !== true) { emit(); }"]]);
    ok('a flag token matches its parsed form', censusReadShapes(['f2'], flagTiers, flagSrc).stale.length === 0);
    const dotSrc = new Map([['f3', 'if (flags.status) { render(); }']]);
    ok('a flag token matches dot-access form',
      censusReadShapes(['f3'], { f3: { tier: 'mutating', readShapes: [{ tokens: [], requiredFlags: ['--status'] }] } }, dotSrc).stale.length === 0);
    ok('unreadable source reds (never silently passes)',
      censusReadShapes(['gone'], { gone: { tier: 'mutating', readShapes: ['x'] } }, new Map([['gone', null]])).stale.length === 1);
  }

  // ── (D) pinned exceptions ───────────────────────────────────────────────
  {
    const initSrc = await readFile(join(repoRoot, 'commands', 'init.mjs'), 'utf8');
    const fleetSrc = await readFile(join(repoRoot, 'commands', 'fleet.mjs'), 'utf8');
    ok('real init+fleet pass', censusPinnedExceptions(initSrc, fleetSrc).length === 0);
    ok('a stripped init annotation reds', censusPinnedExceptions(initSrc.replace(/witnessRaw\('init-genesis'\)/, 'noop()'), fleetSrc).length > 0);
    ok('a stripped fleet declaration reds', censusPinnedExceptions(initSrc, fleetSrc.replace(/witnessDelegatedRun\(/g, 'nothing(')).length > 0);
  }

  // ── (E) bridge wiring ───────────────────────────────────────────────────
  {
    const serverSrc = await readFile(join(repoRoot, 'template', 'maddu', 'runtime', 'server.js'), 'utf8');
    const routeSources = [];
    for (const f of ['bridge-routes-capabilities.mjs']) {
      routeSources.push(await readFile(join(repoRoot, 'template', 'maddu', 'runtime', 'lib', f), 'utf8'));
    }
    ok('real server passes', censusBridge(serverSrc, routeSources).length === 0);
    ok('a server without the wrap reds', censusBridge(serverSrc.replace(/withMutationWitness/g, 'plainCall'), routeSources).length > 0);
    ok('a server without the classifier export reds', censusBridge(serverSrc.replace('export function bridgeRequestIsMutating', 'function bridgeRequestIsMutating'), routeSources).length > 0);
    const staleExempt = serverSrc.replace("'/bridge/enforcer/check',", "'/bridge/enforcer/check',\n  '/bridge/never-existed/route',");
    ok('a stale exemption path reds', censusBridge(staleExempt, routeSources).some((p) => /never-existed/.test(p)));
  }

  // ── (F) spool backstop ──────────────────────────────────────────────────
  {
    // A fixture repo with ONLY a breach row: the gate must red on it even
    // though it has no bin (presence checks skip; the backstop still runs).
    // Use the real tree as the source-resolution root but a fixture repoRoot:
    // gate resolves bin via repoRoot/maddu or the gate file's own tree, so
    // the census sections run against the REAL source while the spool check
    // targets the fixture repoRoot — exactly the doctor-in-a-breached-repo
    // shape.
    const fix = await mkdtemp(join(tmpdir(), 'mw-census-'));
    await mkdir(join(fix, '.maddu', 'state', 'mutation-breaches'), { recursive: true });
    await writeFile(join(fix, '.maddu', 'state', 'mutation-breaches', 'br_test.json'), JSON.stringify({ v: 1, breachId: 'br_test' }));
    const r = await gate.run({ repoRoot: fix });
    ok('an undrained spool row reds the gate', r.ok === false && /undrained mutation-breach/.test(JSON.stringify(r.evidence?.failures ?? r.message)));
    await rm(fix, { recursive: true, force: true });
  }

  console.log(`\nmutation-witness-census: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
