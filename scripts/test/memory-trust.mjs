#!/usr/bin/env node
// Phase 3 (memory-recall track) — event-sourced fact trust states.
//
// Asserts: facts default to `asserted`; approve flips to `approved`; a later
// revoke wins by spine order; trust SURVIVES rebuildMemory (it lives on the
// spine, not in memory.ndjson); setFactTrust refuses unknown ids; and the CLI
// approve/revoke path works end-to-end including git-style prefix resolution
// and the superseded-fact guard.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'maddu.mjs');

async function loadLib(file) {
  const installed = path.join(process.cwd(), 'maddu', 'runtime', 'lib', file);
  const sourceLib = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib', file);
  for (const p of [installed, sourceLib]) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

function cli(repo, args, expectFail = false) {
  try {
    return { out: execFileSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }), code: 0 };
  } catch (e) {
    if (!expectFail) console.error(`  cli unexpected fail: maddu ${args.join(' ')} → ${e.status}\n${e.stderr}`);
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status };
  }
}

async function main() {
  const spine = await loadLib('spine.mjs');
  const h = await loadLib('hindsight.mjs');
  if (!spine || !h) { console.error('harness error: lib not found'); process.exit(2); }

  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-trust-'));
  try {
    // Seed one slice-stop → extracted facts (rule + summary).
    const ev = await spine.append(repo, {
      type: spine.EVENT_TYPES.SLICE_STOP,
      actor: 'ses_t', lane: 'harness',
      data: { summary: 'SLICE STOP: trust test slice', learnings: ['rule: always verify deploy previews'] }
    });
    await h.extractEvent(repo, ev);
    const facts = await h.readMemory(repo);
    const rule = facts.find((f) => f.kind === 'rule');
    const summary = facts.find((f) => f.kind === 'summary');
    ok('seeded rule + summary facts', !!rule && !!summary);

    // Default: everything asserted.
    let view = await h.factsWithTrust(repo);
    ok('all facts default to asserted', view.every((f) => f.trust === 'asserted'));

    // Approve → approved.
    await h.setFactTrust(repo, { factId: rule.id, approve: true, reason: 'operator reviewed' });
    view = await h.factsWithTrust(repo);
    ok('approve flips to approved', view.find((f) => f.id === rule.id)?.trust === 'approved');
    ok('other facts stay asserted', view.find((f) => f.id === summary.id)?.trust === 'asserted');

    // Later revoke wins by spine order.
    await h.setFactTrust(repo, { factId: rule.id, approve: false, reason: 'went stale' });
    view = await h.factsWithTrust(repo);
    ok('later revoke wins', view.find((f) => f.id === rule.id)?.trust === 'revoked');

    // Unknown id refused.
    let threw = false;
    try { await h.setFactTrust(repo, { factId: 'mem_nope', approve: true }); } catch { threw = true; }
    ok('unknown fact id refused', threw);

    // THE KEY PROPERTY: trust survives rebuildMemory.
    await h.rebuildMemory(repo);
    view = await h.factsWithTrust(repo);
    ok('trust survives rebuild', view.find((f) => f.id === rule.id)?.trust === 'revoked',
      JSON.stringify(view.map((f) => [f.id, f.trust])));

    // searchMemory carries trust.
    const sm = await h.searchMemory(repo, 'deploy previews');
    ok('searchMemory joins trust', sm.length > 0 && sm.every((f) => typeof f.trust === 'string'));

    // ── CLI end-to-end ───────────────────────────────────────────────────
    // Re-approve via CLI using a prefix (revoked → needs --force).
    const noForce = cli(repo, ['memory', 'approve', rule.id], true);
    ok('CLI re-approve of revoked fact refused without --force', noForce.code === 1, `code=${noForce.code}`);
    const forced = cli(repo, ['memory', 'approve', rule.id, '--force', '--reason', 're-reviewed']);
    ok('CLI approve --force succeeds', forced.code === 0 && forced.out.includes('approved'));
    // Prefix resolution: unique prefix works, ambiguous prefix refused.
    // Distinctive prefix: drop only the sha1 tail so it stays unique to `rule`
    // (facts from one event share the long timestamp prefix).
    const prefix = rule.id.slice(0, rule.id.length - 4);
    const viaPrefix = cli(repo, ['memory', 'revoke', prefix, '--reason', 'prefix test']);
    ok('CLI prefix resolution works', viaPrefix.code === 0 && viaPrefix.out.includes('revoked'));
    const ambiguous = cli(repo, ['memory', 'approve', 'mem_'], true);
    ok('CLI ambiguous prefix refused', ambiguous.code === 1 && /ambiguous/.test(ambiguous.out));
    // Revoke requires --reason.
    const noReason = cli(repo, ['memory', 'revoke', rule.id], true);
    ok('CLI revoke without --reason is usage error', noReason.code === 2);
    // List filter.
    const listed = cli(repo, ['memory', 'list', '--trust', 'revoked']);
    ok('CLI list --trust filters', listed.code === 0 && listed.out.includes(rule.id));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
