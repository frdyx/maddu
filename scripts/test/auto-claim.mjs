#!/usr/bin/env node
// Test — auto-claim-trigger (the PreToolUse auto-claim behind the hook).
//
// Verifies the invariant "agentic work is never un-laned": maybeAutoClaim
// claims a lane when a session holds none, respects an existing claim, refuses
// to orphan (inactive session), honors the rule-#9 allowlist (fail-closed), and
// infers a lane from catalog `paths` globs when present (else session-scoped).
//
// Exit 0 = pass, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', '..', 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function makeRepo({ allow = true, lanes = [] } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-autoclaim-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'config'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'config', 'triggers.json'),
    JSON.stringify({ allowed: allow ? ['hook:auto-claim'] : [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'),
    JSON.stringify({ schemaVersion: 1, lanes }) + '\n');
  return tmp;
}

async function main() {
  const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
  const projections = await import(pathToFileURL(join(LIB, 'projections.mjs')).href);
  const auto = await import(pathToFileURL(join(LIB, 'auto-claim-trigger.mjs')).href);
  const T = spine.EVENT_TYPES;
  const SID = 'ses_20260101000000_zzzzzz';

  const register = (repo) => spine.append(repo, { type: T.SESSION_AUTO_REGISTERED, actor: SID, data: { sessionId: SID, source: 'cli', label: 'z', role: 'implementer', focus: 'work' } });

  // 1. Active session, no claim, allowed → claims a (fallback) lane.
  {
    const repo = await makeRepo();
    await register(repo);
    const proj = await projections.project(repo);
    const r = await auto.maybeAutoClaim(repo, { sid: SID, filePath: null, proj });
    ok('claims when un-laned', r.claimed === true, JSON.stringify(r));
    ok('  fallback lane is session-scoped', /^auto\//.test(r.lane), r.lane);
    const after = await projections.project(repo);
    ok('  claim is on the spine', (after.claims || []).some((c) => c.lane === r.lane && c.sessionId === SID));
    ok('  TRIGGER_FIRED recorded', (await spine.readAll(repo)).some((e) => e.type === 'TRIGGER_FIRED' && e.data?.triggerId === 'hook:auto-claim'));
    await rm(repo, { recursive: true, force: true });
  }

  // 2. Already holds a claim → no-op.
  {
    const repo = await makeRepo();
    await register(repo);
    await spine.append(repo, { type: T.LANE_CLAIMED, actor: SID, lane: 'mine', data: { focus: 'x' } });
    const proj = await projections.project(repo);
    const r = await auto.maybeAutoClaim(repo, { sid: SID, filePath: null, proj });
    ok('no-op when already claimed', r.claimed === false && r.reason === 'already-claimed', JSON.stringify(r));
    await rm(repo, { recursive: true, force: true });
  }

  // 3. Trigger not allowlisted → fail-closed (no claim).
  {
    const repo = await makeRepo({ allow: false });
    await register(repo);
    const proj = await projections.project(repo);
    const r = await auto.maybeAutoClaim(repo, { sid: SID, filePath: null, proj });
    ok('fail-closed when trigger not allowed', r.claimed === false && r.reason === 'trigger-not-allowed', JSON.stringify(r));
    await rm(repo, { recursive: true, force: true });
  }

  // 4. Closed session → never orphan.
  {
    const repo = await makeRepo();
    await register(repo);
    await spine.append(repo, { type: T.SESSION_CLOSED, actor: SID, data: {} });
    const proj = await projections.project(repo);
    const r = await auto.maybeAutoClaim(repo, { sid: SID, filePath: null, proj });
    ok('refuses on a closed session', r.claimed === false && r.reason === 'session-not-active', JSON.stringify(r));
    await rm(repo, { recursive: true, force: true });
  }

  // 5. Path inference from catalog `paths` globs.
  {
    const repo = await makeRepo({ lanes: [{ id: 'cockpit-shell', paths: ['template/maddu/cockpit/**'] }, { id: 'docs-lane', paths: ['docs/**'] }] });
    await register(repo);
    const proj = await projections.project(repo);
    const r = await auto.maybeAutoClaim(repo, { sid: SID, filePath: join(repo, 'template', 'maddu', 'cockpit', 'cockpit.js'), proj });
    ok('infers lane from catalog paths glob', r.claimed === true && r.lane === 'cockpit-shell', JSON.stringify(r));
    await rm(repo, { recursive: true, force: true });
  }

  // 6. inferLane fallback for an unmatched path.
  {
    const repo = await makeRepo({ lanes: [{ id: 'docs-lane', paths: ['docs/**'] }] });
    const lane = await auto.inferLane(repo, join(repo, 'src', 'x.js'), SID);
    ok('unmatched path → session-scoped fallback', /^auto\//.test(lane), lane);
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`\nauto-claim: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
