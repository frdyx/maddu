#!/usr/bin/env node
// architecture-extract (v1.18.0) — the architecture-drift engine.
//
// Builds a temp repo with a known layered structure + deliberate violations
// (two forbidden edges, one cycle, one undeclared area, one uncovered file) and
// asserts the contract→reality→drift pipeline, the driftScore, the mermaid
// output, and the failOn ladder over a baseline.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assessDrift, evaluateFailOn, extractImports, globToRegExp,
  renderMermaid, validateContract, violationList,
} from '../../template/maddu/runtime/lib/architecture.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') { console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`); cond ? passed++ : failed++; }

const CONTRACT = {
  schemaVersion: 1,
  modules: [
    { name: 'domain', paths: ['src/domain/**'] },
    { name: 'app', paths: ['src/app/**'] },
    { name: 'infra', paths: ['src/infra/**'] },
  ],
  rules: [
    { from: 'domain', allow: [] },
    { from: 'app', allow: ['domain'] },
    { from: 'infra', allow: ['domain', 'app'] },
  ],
  options: { failOn: 'none' },
};

async function w(root, rel, body) { const p = join(root, rel); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body); }

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'maddu-arch-'));
  await w(root, 'src/domain/user.ts', 'export const User = 1;\n');
  await w(root, 'src/domain/bad.ts', "import { db } from '../infra/db';\nexport const bad = db;\n");      // domain->infra FORBIDDEN
  await w(root, 'src/app/svc.ts', "import { db } from '../infra/db';\nexport const svc = db;\n");          // app->infra FORBIDDEN + cycle
  await w(root, 'src/infra/db.ts', "import { svc } from '../app/svc';\nimport { User } from '../domain/user';\nexport const db = [svc, User];\n"); // infra->app, infra->domain
  await w(root, 'scripts/tool.ts', "console.log('build');\n");   // undeclared area 'scripts'
  await w(root, 'src/loose.ts', 'export const x = 1;\n');        // uncovered (src declared, no module)
  return root;
}

async function main() {
  // Unit: glob + extract.
  ok('glob matches deep path', globToRegExp('src/domain/**').test('src/domain/a/b.ts'));
  ok('glob does not over-match sibling', !globToRegExp('src/domain/**').test('src/app/x.ts'));
  const imps = extractImports("import a from './x';\nconst b = require('./y');\nawait import('./z');\n", '.ts');
  ok('extracts import + require + dynamic', imps.map((i) => i.spec).sort().join(',') === './x,./y,./z', JSON.stringify(imps.map((i) => i.spec)));
  const py = extractImports('from ..domain import User\nimport os, sys\n', '.py');
  ok('extracts python from + import list', py.some((i) => i.spec === '..domain') && py.some((i) => i.spec === 'os') && py.some((i) => i.spec === 'sys'));

  // Contract validation rejects junk.
  let threw = false;
  try { validateContract({ schemaVersion: 2, modules: [] }); } catch { threw = true; }
  ok('invalid contract rejected', threw);

  const root = await makeRepo();
  try {
    const r = await assessDrift({ repoRoot: root, contract: CONTRACT });
    const fkeys = r.violations.forbidden.map((f) => f.key).sort();
    ok('two forbidden edges detected', r.violations.forbidden.length === 2, fkeys.join(', '));
    ok('forbidden includes domain->infra', fkeys.includes('forbidden:domain->infra'));
    ok('forbidden includes app->infra', fkeys.includes('forbidden:app->infra'));
    ok('forbidden carries file:line evidence', r.violations.forbidden[0].evidence[0].file && r.violations.forbidden[0].evidence[0].line > 0);

    ok('one cycle (SCC) detected', r.violations.cycles.length === 1, JSON.stringify(r.violations.cycles.map((c) => c.modules)));
    ok('cycle SCC is app+domain+infra', r.violations.cycles[0]?.modules.join('+') === 'app+domain+infra');

    ok('one undeclared area (scripts)', r.violations.undeclared.length === 1 && r.violations.undeclared[0].area === 'scripts', JSON.stringify(r.violations.undeclared));
    ok('uncovered file src/loose.ts', r.uncoveredFiles.includes('src/loose.ts'), JSON.stringify(r.uncoveredFiles));

    ok('drift score = 13.1', r.driftScore === 13.1, String(r.driftScore));
    ok('allowed edges not flagged (infra->app)', !r.violations.forbidden.some((f) => f.key === 'forbidden:infra->app'));

    const mmd = renderMermaid(r);
    ok('mermaid marks violations', /VIOLATION/.test(mmd) && /graph LR/.test(mmd));

    // failOn ladder.
    const allKeys = new Set(violationList(r).map((v) => v.key));
    const none = evaluateFailOn(r, new Set(), 'none');
    ok('failOn none never blocks', none.blocking === false && none.new === 4, JSON.stringify(none));
    ok('failOn new blocks with empty baseline', evaluateFailOn(r, new Set(), 'new').blocking === true);
    ok('failOn new passes when all baselined', evaluateFailOn(r, allKeys, 'new').blocking === false);
    ok('failOn any blocks on any violation', evaluateFailOn(r, new Set(), 'any').blocking === true);

    // Ratchet: baseline everything, introduce ONE new forbidden edge, only that fails.
    await w(root, 'src/domain/bad2.ts', "import { svc } from '../app/svc';\nexport const b2 = svc;\n"); // domain->app NEW forbidden
    const r2 = await assessDrift({ repoRoot: root, contract: CONTRACT });
    const ratchet = evaluateFailOn(r2, allKeys, 'new');
    ok('ratchet: only the new violation blocks', ratchet.blocking === true && ratchet.new === 1, JSON.stringify({ new: ratchet.new, keys: ratchet.freshViolations.map((v) => v.key) }));
    ok('ratchet: new violation is domain->app', ratchet.freshViolations[0]?.key === 'forbidden:domain->app');
  } finally { await rm(root, { recursive: true, force: true }); }

  console.log('');
  console.log(`architecture-extract: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('architecture-extract OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
