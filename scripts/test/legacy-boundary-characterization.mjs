#!/usr/bin/env node
// legacy-boundary-characterization — P1 companion to legacy-evidence-vectors.
//
// Pins two baseline behaviours the P0 audit confirmed
// (docs/rfc/2026-09-20-p0-baseline-audit.md, findings A7-001 / A3-005a and
// A3-001) so the fix PRs the audit proposes show up as INTENTIONAL diffs of
// these assertions rather than silent behaviour changes:
//
//   1. runGates(): when the GATE_RAN receipt append throws, the gate's verdict
//      is still returned, no receipt lands, and nothing on the returned result
//      says so (gates.mjs "gate-run reporting is best-effort"). A control run
//      with the real spine proves the same fixture does land a receipt.
//   2. POST /bridge/approvals/respond: appends APPROVAL_DECIDED for an
//      approvalId that was never requested, returns 200, and does so again for
//      the same id. `spine verify` flags the orphan afterwards
//      (orphan_approval_decided FAIL) — detection, not prevention. The CLI
//      `maddu approval respond` refuses both cases; the bridge route does not.
//
// These are CHARACTERIZATIONS of today's behaviour, not requirements. When a
// fix lands, flip the assertion in the same change. Exit codes: 0 = OK,
// 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}
async function newTmp() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-legacy-boundary-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(path.join(tmp, '.maddu', 'gates'), { recursive: true });
  return tmp;
}
async function eventLines(tmp) {
  const dir = path.join(tmp, '.maddu', 'events');
  const segs = (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort();
  const out = [];
  for (const s of segs) out.push(...(await readFile(path.join(dir, s), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  return out;
}
function mkRes() {
  const cap = { status: null, body: null, ended: false };
  return { cap, writeHead(s) { cap.status = s; }, end(b) { cap.body = b; cap.ended = true; } };
}
const jsonReq = (body) => ({ method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } });

async function main() {
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const verify = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);
  const gates = await import(pathToFileURL(path.join(LIB, 'gates.mjs')).href);
  const { routeApprovals } = await import(pathToFileURL(path.join(LIB, 'bridge-routes-approvals.mjs')).href);

  // ── 1. swallowed GATE_RAN receipt append (A7-001 / A3-005a) ──
  {
    const tmp = await newTmp();
    try {
      await writeFile(path.join(tmp, '.maddu', 'gates', 'char-pass.mjs'),
        "export default { id: 'char-pass', label: 'char pass', severity: 'safety', run: async () => ({ ok: true, message: 'fixture' }) };\n");

      // control: the real spine lands exactly one receipt for this fixture gate
      const control = await gates.runGates(tmp, { onlyId: 'char-pass', emitEvents: true, ctx: { spine, roots: { workRoot: tmp, stateRoot: tmp } } });
      const controlEvents = await eventLines(tmp);
      ok('control: fixture gate runs ok through runGates', control.runs.length === 1 && control.runs[0].gateId === 'char-pass' && control.runs[0].ok === true, JSON.stringify(control.runs[0]));
      ok('control: exactly one GATE_RAN receipt lands with the real spine', controlEvents.filter((e) => e.type === 'GATE_RAN' && e.data.gateId === 'char-pass').length === 1);

      // characterization: an append that throws
      await rm(path.join(tmp, '.maddu', 'events'), { recursive: true, force: true });
      await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
      let appendCalls = 0;
      const throwing = { EVENT_TYPES: spine.EVENT_TYPES, append: async () => { appendCalls++; throw new Error('disk full (fixture)'); } };
      const res = await gates.runGates(tmp, { onlyId: 'char-pass', emitEvents: true, ctx: { spine: throwing, roots: { workRoot: tmp, stateRoot: tmp } } });
      ok('receipt append was attempted and threw', appendCalls === 1, String(appendCalls));
      ok('CHARACTERIZATION (A7-001): the verdict is still returned as ok', res.runs.length === 1 && res.runs[0].ok === true && res.runs[0].gateId === 'char-pass');
      ok('CHARACTERIZATION (A7-001): no receipt landed', (await eventLines(tmp)).length === 0);
      const resultKeys = Object.keys(res).concat(Object.keys(res.runs[0]));
      ok('CHARACTERIZATION (A7-001): nothing on the result names the lost receipt (no error/receipt field)', resultKeys.every((k) => !/error|receipt|append|durab/i.test(k)), resultKeys.join(','));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── 2. /bridge/approvals/respond binds to a real, still-open request (A3-001) ──
  // FLIPPED in v1.145.0 (fix 5): at the baseline this route appended a decision
  // for ANY approvalId, twice over, and only `spine verify` noticed afterwards.
  // It now checks the projection like the CLI: unknown → 404, decided → 409,
  // open → one APPROVAL_DECIDED carrying the request's lane and tool.
  {
    const tmp = await newTmp();
    try {
      const unknownId = 'evt_20260920000000_000000';
      const r0 = mkRes();
      const h0 = await routeApprovals({ req: jsonReq({ approvalId: unknownId, decision: 'allow-once' }), res: r0, path: '/bridge/approvals/respond', repoRoot: tmp });
      ok('respond for a never-requested approvalId → 404 and no append', h0 === true && r0.cap.status === 404 && (await eventLines(tmp)).length === 0, String(r0.cap.status));

      const request = await spine.append(tmp, { type: 'APPROVAL_REQUESTED', actor: 'ses_fixture', lane: 'general', data: { tool: 'install', action: 'npm install left-pad', summary: null, payload: null } });
      const r1 = mkRes();
      const h1 = await routeApprovals({ req: jsonReq({ approvalId: request.id, decision: 'allow-once', lane: 'spoofed-lane', tool: 'spoofed-tool' }), res: r1, path: '/bridge/approvals/respond', repoRoot: tmp });
      ok('respond for an open request → 200 {ok, event}', h1 === true && r1.cap.status === 200, String(r1.cap.status));
      const decidedOnce = (await eventLines(tmp)).filter((e) => e.type === 'APPROVAL_DECIDED' && e.data.approvalId === request.id);
      ok('the decision carries the request\'s lane and tool, not the caller\'s body values', decidedOnce.length === 1 && decidedOnce[0].lane === 'general' && decidedOnce[0].data.tool === 'install', JSON.stringify(decidedOnce.map((d) => [d.lane, d.data.tool])));

      const r2 = mkRes();
      const h2 = await routeApprovals({ req: jsonReq({ approvalId: request.id, decision: 'deny' }), res: r2, path: '/bridge/approvals/respond', repoRoot: tmp });
      ok('a second, conflicting respond for the same id → 409 and no second row', h2 === true && r2.cap.status === 409 && (await eventLines(tmp)).filter((e) => e.type === 'APPROVAL_DECIDED').length === 1, String(r2.cap.status));
      const v = await verify.verifySpine(tmp);
      ok('spine verify sees no orphan or duplicate decision', !v.issues.some((i) => /approval/.test(i.kind)), JSON.stringify(v.issues.map((i) => `${i.kind}:${i.level}`)));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  console.log('');
  console.log(`legacy-boundary-characterization: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('legacy-boundary-characterization OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
