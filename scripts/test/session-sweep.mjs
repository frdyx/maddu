#!/usr/bin/env node
// Test — `reconcileStale` (the CLI-side stale janitor behind `maddu session sweep`
// and the SessionStart hook).
//
// Covers the two leaks it fixes:
//   1. Orphan claim: a lane claimed by an already-CLOSED session (LANE_CLAIMED
//      after SESSION_CLOSED in spine order). runJanitor structurally can't reach
//      it — only the claim-centric pass releases it.
//   2. Stale active session: an active session past the auto-close threshold is
//      closed and its claim released (driven via a future `nowMs`).
//
// Exit 0 = pass, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const LIB = join(ROOT, 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function makeRepo() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-sweep-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  return tmp;
}

async function main() {
  const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
  const projections = await import(pathToFileURL(join(LIB, 'projections.mjs')).href);
  const janitor = await import(pathToFileURL(join(LIB, 'janitor.mjs')).href);
  const T = spine.EVENT_TYPES;

  // ── Scenario 1: orphan claim from a CLOSED session ──
  {
    const repo = await makeRepo();
    const A = 'ses_20260101000000_aaaaaa';
    await spine.append(repo, { type: T.SESSION_AUTO_REGISTERED, actor: A, data: { sessionId: A, source: 'cli', label: 'A', role: 'implementer' } });
    await spine.append(repo, { type: T.SESSION_CLOSED, actor: A, data: {} });
    // Claim AFTER close (stale MADDU_SESSION_ID) — the close cascade never saw it.
    await spine.append(repo, { type: T.LANE_CLAIMED, actor: A, lane: 'orphan-lane', data: { focus: 'x' } });

    const before = await projections.project(repo);
    ok('orphan: claim present before sweep', (before.claims || []).some((c) => c.lane === 'orphan-lane'));

    const report = await janitor.reconcileStale(repo, projections);
    ok('orphan: reported 1 orphaned claim released', (report.orphanedClaimsReleased || []).some((c) => c.lane === 'orphan-lane'), JSON.stringify(report.orphanedClaimsReleased));

    const after = await projections.project(repo);
    ok('orphan: claim gone after sweep', !(after.claims || []).some((c) => c.lane === 'orphan-lane'));
    await rm(repo, { recursive: true, force: true });
  }

  // ── Scenario 2: stale ACTIVE session auto-closed + its claim released ──
  {
    const repo = await makeRepo();
    const B = 'ses_20260101000000_bbbbbb';
    await spine.append(repo, { type: T.SESSION_AUTO_REGISTERED, actor: B, data: { sessionId: B, source: 'cli', label: 'B', role: 'implementer' } });
    await spine.append(repo, { type: T.LANE_CLAIMED, actor: B, lane: 'b-lane', data: { focus: 'y' } });

    // Advance `now` 5h so B (just registered) is past the 4h auto-close default.
    const future = Date.now() + 5 * 60 * 60 * 1000;
    const report = await janitor.reconcileStale(repo, projections, future);
    ok('stale: session auto-closed', report.autoClosed === 1, `autoClosed=${report.autoClosed}`);

    const after = await projections.project(repo);
    ok('stale: session no longer active', !(after.activeSessions || []).some((s) => s.id === B && s.status === 'active'));
    ok('stale: its claim released (by close cascade)', !(after.claims || []).some((c) => c.lane === 'b-lane'));
    await rm(repo, { recursive: true, force: true });
  }

  // ── Scenario 3: healthy active session + claim is left ALONE ──
  {
    const repo = await makeRepo();
    const C = 'ses_20260101000000_cccccc';
    await spine.append(repo, { type: T.SESSION_AUTO_REGISTERED, actor: C, data: { sessionId: C, source: 'cli', label: 'C', role: 'implementer' } });
    await spine.append(repo, { type: T.LANE_CLAIMED, actor: C, lane: 'live-lane', data: { focus: 'z' } });

    const report = await janitor.reconcileStale(repo, projections); // now = real now → C is fresh
    ok('healthy: nothing auto-closed', report.autoClosed === 0);
    ok('healthy: no orphan released', (report.orphanedClaimsReleased || []).length === 0);
    const after = await projections.project(repo);
    ok('healthy: live claim retained', (after.claims || []).some((c) => c.lane === 'live-lane'));
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`\nsession-sweep: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
