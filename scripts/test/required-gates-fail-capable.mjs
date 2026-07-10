// audit P4 — "required ⇒ fail-capable" invariant + the two promoted gates.
//
// `maddu ci pin` used to pin every non-failing gate, including warn-severity
// gates that can NEVER red `maddu ci` — so 19 of 66 "required" gates were a
// misnomer (green-because-wrong-scope at the CI level). The fix makes required
// mean fail-capable: `ci pin` drops warn gates, and `maddu ci` reds if a pinned
// id no longer resolves to a fail-capable gate. This guard pins that structural
// invariant so a warn gate can never be silently pinned again, and confirms the
// two gates promoted for P4 are genuinely fail-capable + fail-closed.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frameworkRoot = join(here, '..', '..');
const gatesDir = join(frameworkRoot, 'template', 'maddu', 'runtime', 'gates', 'builtin');
const ciJsonPath = join(frameworkRoot, '.maddu', 'config', 'ci.json');

let failures = 0;
const ok = (name, cond, extra = '') => { if (!cond) { failures++; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); } else { console.log(`  [ok] ${name}`); } };

async function severityById() {
  const map = new Map();
  for (const f of (await readdir(gatesDir)).filter((n) => n.endsWith('.mjs'))) {
    const src = await readFile(join(gatesDir, f), 'utf8');
    // Anchor on the exported gate object so a fixture `id:`/`severity:` inside the
    // run() body (e.g. sample state) cannot be mistaken for the gate's own.
    const obj = src.slice(src.indexOf('export default'));
    const id = (obj.match(/id:\s*['"]([^'"]+)['"]/) || [])[1];
    const sev = (obj.match(/severity:\s*['"]([a-z]+)['"]/) || [])[1];
    if (id) map.set(id, sev || 'warn');
  }
  return map;
}

async function main() {
  const sev = await severityById();
  const ci = JSON.parse(await readFile(ciJsonPath, 'utf8'));
  const required = Array.isArray(ci.requiredGates) ? ci.requiredGates : [];
  ok('ci.json pins a non-empty required set', required.length > 0);

  // 1 — the invariant: no required id is warn-severity, and every one resolves.
  const warnRequired = required.filter((id) => sev.get(id) === 'warn');
  ok('no required gate is warn-severity (required ⇒ fail-capable)', warnRequired.length === 0, warnRequired.join(', '));
  const unresolved = required.filter((id) => !sev.has(id) && !/^operator:/.test(id));
  // builtin ids only; an operator gate can be required without a builtin file.
  ok('every builtin required id resolves to a present gate', unresolved.length === 0, unresolved.join(', '));

  // 2 — the two P4 promotions are fail-capable.
  ok('maddu-state-untracked promoted to safety', sev.get('maddu-state-untracked') === 'safety');
  ok('dependency-freshness promoted to safety', sev.get('dependency-freshness') === 'safety');

  // 3 — maddu-state-untracked is FAIL-CLOSED: non-repo → ok (not applicable);
  //     a git error we cannot interpret as "not a repo" → FAIL (never a green skip).
  const gate = (await import(pathToFileURL(join(gatesDir, 'maddu-state-untracked.mjs')).href)).default;
  const nonRepo = await mkdtemp(join(tmpdir(), 'maddu-nogit-'));
  try {
    const r1 = await gate.run({ repoRoot: nonRepo });
    ok('non-git dir → ok (modeled non-applicable)', r1.ok === true && /not applicable/.test(r1.message));
    const r2 = await gate.run({ repoRoot: join(nonRepo, 'does-not-exist-xyz') });
    ok('unresolvable git error → FAIL (fail-closed, not a green skip)', r2.ok === false && /git error/.test(r2.message));
  } finally {
    await rm(nonRepo, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nrequired-gates-fail-capable: all checks passed' : `\nrequired-gates-fail-capable: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
