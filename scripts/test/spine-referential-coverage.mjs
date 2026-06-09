#!/usr/bin/env node
// B2 (v1.13.0) — spine verify referential coverage for orchestration families.
//
// The verifier already checks TASK / WORKER / SCHEDULE / APPROVAL / LANE /
// SLICE referential pairs. B2 extends coverage to the orchestration-lifecycle
// families whose child events carry a parent id but were previously unchecked:
// teams, pipelines, plans, loops, coordinators, advisors. For each family this
// asserts three things:
//   1. well-formed (anchor then child)            → no orphan warning
//   2. orphan child (child with no prior anchor)   → orphan_* WARN fires
//   3. forward-compat (child with no id field)     → NOT flagged
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');

function fail(msg) { console.error(`SPINE-REFERENTIAL FAILED: ${msg}`); process.exit(1); }

async function newTmp() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-ref-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}

const FAMILIES = [
  { name: 'team',        anchor: 'TEAM_OPENED',         child: 'TEAM_MEMBER_JOINED',        idField: 'teamId',        kind: 'orphan_team_event',
    anchorData: (id) => ({ teamId: id }),                 childData: (id) => ({ teamId: id, lane: 'l', sessionId: 's' }) },
  { name: 'pipeline',    anchor: 'PIPELINE_STARTED',    child: 'PIPELINE_STAGE_ENTERED',    idField: 'pipelineRunId', kind: 'orphan_pipeline_event',
    anchorData: (id) => ({ pipelineRunId: id, name: 'p' }), childData: (id) => ({ pipelineRunId: id, stage: 'plan' }) },
  { name: 'plan',        anchor: 'PLAN_CREATED',        child: 'PLAN_PHASE_ADDED',          idField: 'planId',        kind: 'orphan_plan_event',
    anchorData: (id) => ({ planId: id, phases: [] }),     childData: (id) => ({ planId: id, name: '1', intent: 'x' }) },
  { name: 'loop',        anchor: 'LOOP_STARTED',        child: 'LOOP_ITERATION_STARTED',    idField: 'loopId',        kind: 'orphan_loop_event',
    anchorData: (id) => ({ loopId: id, kind: 'ralph' }),  childData: (id) => ({ loopId: id, iter: 1 }) },
  { name: 'coordinator', anchor: 'COORDINATOR_STARTED', child: 'COORDINATOR_PHASE_STARTED', idField: 'coordinatorId', kind: 'orphan_coordinator_event',
    anchorData: (id) => ({ coordinatorId: id }),          childData: (id) => ({ coordinatorId: id, phase: '1' }) },
  { name: 'advisor',     anchor: 'ADVISOR_INVOKED',     child: 'ADVISOR_ARTIFACT_WRITTEN',  idField: 'advisorId',     kind: 'orphan_advisor_event',
    anchorData: (id) => ({ advisorId: id, kind: 'advisor' }), childData: (id) => ({ advisorId: id, path: '/x' }) },
];

async function main() {
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const verify = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);
  const countKind = (res, kind) => res.issues.filter((i) => i.kind === kind).length;

  for (const f of FAMILIES) {
    // 1. Well-formed: anchor then child → no orphan of this kind.
    {
      const tmp = await newTmp();
      try {
        const id = `${f.name}_anchor_1`;
        await spine.append(tmp, { type: f.anchor, data: f.anchorData(id) });
        await spine.append(tmp, { type: f.child, data: f.childData(id) });
        const res = await verify.verifySpine(tmp);
        if (countKind(res, f.kind) !== 0) fail(`${f.name}: well-formed sequence produced ${f.kind}`);
      } finally { await rm(tmp, { recursive: true, force: true }); }
    }
    // 2. Orphan child: no anchor → exactly one orphan warning.
    {
      const tmp = await newTmp();
      try {
        await spine.append(tmp, { type: f.child, data: f.childData(`${f.name}_missing`) });
        const res = await verify.verifySpine(tmp);
        const n = countKind(res, f.kind);
        if (n !== 1) fail(`${f.name}: orphan child should produce 1 ${f.kind}, got ${n}`);
        const w = res.issues.find((i) => i.kind === f.kind);
        if (w.level !== 'WARN') fail(`${f.name}: ${f.kind} should be WARN, got ${w.level}`);
      } finally { await rm(tmp, { recursive: true, force: true }); }
    }
    // 3. Forward-compat: child with no id field → not flagged.
    {
      const tmp = await newTmp();
      try {
        await spine.append(tmp, { type: f.child, data: { note: 'no id field' } });
        const res = await verify.verifySpine(tmp);
        if (countKind(res, f.kind) !== 0) fail(`${f.name}: child missing ${f.idField} was wrongly flagged`);
      } finally { await rm(tmp, { recursive: true, force: true }); }
    }
  }

  console.log(`SPINE-REFERENTIAL OK (${FAMILIES.length} families: well-formed clean · orphan flagged WARN · forward-compat tolerant)`);
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
