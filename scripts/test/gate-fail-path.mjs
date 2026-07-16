// Tier-2 gate fail-path proof (usage-audit roadmap, 2026-07-16).
// Run standalone:  node scripts/test/gate-fail-path.mjs
//
// The 2026-07-16 fleet audit saw 10,229 GATE_RAN pass / 0 fail across every
// registered spine — execution proven, DISCRIMINATION not: "all green" was
// indistinguishable from "the fail path never writes". This test forces
// failing gates in a fixture and asserts the non-pass GATE_RAN events land
// on the spine with the exact ok/status/severity the runner resolved:
//   1. ok:false on a critical gate   → status 'fail' event emitted
//   2. ok:false on a warn gate       → status 'warn' event emitted
//   3. explicit result.status='warn' → soft-pass 'warn' event (ok stays true)
//   4. a THROWING gate               → caught, ok:false + status 'fail' emitted
// Plus the read-side mapping (insights.gateStatusOf): explicit status wins,
// legacy ok×severity derivation, pre-schema events → 'other'.

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIB = join(REPO, 'template', 'maddu', 'runtime', 'lib');
const toUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`);

const gates = await import(toUrl(join(LIB, 'gates.mjs')));
const insights = await import(toUrl(join(LIB, 'insights.mjs')));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

const tmp = await mkdtemp(join(tmpdir(), 'maddu-gatefail-'));
try {
  const fixture = join(tmp, 'repo');
  await mkdir(join(fixture, '.maddu', 'events'), { recursive: true });
  await mkdir(join(fixture, '.maddu', 'gates'), { recursive: true });
  const gate = (id, severity, body) => writeFile(join(fixture, '.maddu', 'gates', `${id}.mjs`),
    `export default { id: '${id}', severity: '${severity}', description: 'fixture', run: ${body} };\n`);
  await gate('t2-forced-fail', 'critical', `async () => ({ ok: false, message: 'forced fail' })`);
  await gate('t2-forced-warnsev', 'warn', `async () => ({ ok: false, message: 'forced warn-severity fail' })`);
  await gate('t2-soft-warn', 'critical', `async () => ({ ok: true, status: 'warn', message: 'soft pass' })`);
  await gate('t2-throws', 'critical', `async () => { throw new Error('fixture explosion'); }`);

  const results = {};
  for (const id of ['t2-forced-fail', 't2-forced-warnsev', 't2-soft-warn', 't2-throws']) {
    const res = await gates.runGates(fixture, { onlyId: id });
    ok(res.runs.length === 1, `${id}: exactly one run (got ${res.runs.length})`);
    results[id] = res.runs[0];
  }
  ok(results['t2-forced-fail'].ok === false && results['t2-forced-fail'].status === 'fail', 'critical ok:false resolves status fail');
  ok(results['t2-forced-warnsev'].ok === false && results['t2-forced-warnsev'].status === 'warn', 'warn-severity ok:false resolves status warn');
  ok(results['t2-soft-warn'].ok === true && results['t2-soft-warn'].status === 'warn', 'explicit result.status=warn soft pass');
  ok(results['t2-throws'].ok === false && results['t2-throws'].status === 'fail' && /gate threw/.test(results['t2-throws'].message),
    'throwing gate caught → ok:false status fail');

  // The proof: the non-pass events actually LANDED ON THE SPINE.
  const evDir = join(fixture, '.maddu', 'events');
  let spineText = '';
  for (const f of (await readdir(evDir)).filter((f) => f.endsWith('.ndjson'))) {
    spineText += await readFile(join(evDir, f), 'utf8');
  }
  const gateEvents = spineText.split('\n').filter((l) => l.includes('GATE_RAN')).map((l) => JSON.parse(l));
  const byId = new Map(gateEvents.map((e) => [e.data.gateId, e]));
  ok(gateEvents.length === 4, `all four gate runs emitted GATE_RAN to the spine (got ${gateEvents.length})`);
  const ef = byId.get('t2-forced-fail');
  ok(ef && ef.data.ok === false && ef.data.status === 'fail' && ef.data.severity === 'critical',
    `fail-path event carries ok:false/status:fail/severity:critical (got ${JSON.stringify(ef?.data)})`);
  const ew = byId.get('t2-forced-warnsev');
  ok(ew && ew.data.ok === false && ew.data.status === 'warn' && ew.data.severity === 'warn', 'warn-path event carries ok:false/status:warn');
  const es = byId.get('t2-soft-warn');
  ok(es && es.data.ok === true && es.data.status === 'warn', 'soft-warn event carries ok:true/status:warn');
  const et = byId.get('t2-throws');
  ok(et && et.data.ok === false && et.data.status === 'fail', 'thrown-gate event still lands with ok:false/status:fail');

  // Read-side outcome mapping matches what landed (insights harvest tally).
  const [h] = await insights.harvestSpines([{ id: 'fx', label: 'fx', path: fixture }]);
  ok(h.gateOutcomes.ok === 0 && h.gateOutcomes.warn === 2 && h.gateOutcomes.fail === 2 && h.gateOutcomes.other === 0,
    `harvest tallies outcomes 0 ok / 2 warn / 2 fail (got ${JSON.stringify(h.gateOutcomes)})`);
  ok(insights.gateStatusOf({ status: 'warn', ok: false, severity: 'critical' }) === 'warn', 'explicit status wins over ok×severity');
  ok(insights.gateStatusOf({ ok: false, severity: 'critical' }) === 'fail', 'legacy no-status critical fail derives fail');
  ok(insights.gateStatusOf({ ok: false, severity: 'warn' }) === 'warn', 'legacy no-status warn-severity derives warn');
  ok(insights.gateStatusOf({ ok: true, severity: 'warn' }) === 'ok', 'legacy ok derives ok');
  ok(insights.gateStatusOf({}) === 'other' && insights.gateStatusOf(null) === 'other', 'pre-schema events count apart as other, never guessed');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`gate-fail-path: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
