// Test the replica-untracked builtin gate (roadmap #12c phase 3). Run:
//   node scripts/test/gate-replica-untracked.mjs

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import gate from '../../template/maddu/runtime/gates/builtin/replica-untracked.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

async function gitRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-gate-ru-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
  return repo;
}

async function main() {
  console.log('gate-replica-untracked: sync identity must stay untracked');

  // 1. No replica.json → not in sync mode → PASS (n/a).
  {
    const repo = await gitRepo();
    const r = await gate.run({ repoRoot: repo });
    ok(r.ok && /not in team-sync/.test(r.message), 'no replica.json → PASS (n/a)');
    await rm(repo, { recursive: true, force: true });
  }

  // 2. replica.json present + untracked → PASS.
  {
    const repo = await gitRepo();
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'rep_ok01' }));
    await writeFile(join(repo, '.gitignore'), '.maddu/config/replica.json\n');
    const r = await gate.run({ repoRoot: repo });
    ok(r.ok && /untracked/.test(r.message), 'untracked replica.json → PASS');
    await rm(repo, { recursive: true, force: true });
  }

  // 3. replica.json TRACKED (force-added) → FAIL with remediation.
  {
    const repo = await gitRepo();
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'rep_bad01' }));
    execFileSync('git', ['add', '-f', '.maddu/config/replica.json'], { cwd: repo });
    const r = await gate.run({ repoRoot: repo });
    ok(!r.ok && /TRACKED/.test(r.message) && /git rm --cached/.test(r.message), 'tracked replica.json → FAIL with remediation');
    await rm(repo, { recursive: true, force: true });
  }

  // 4. Malformed replica.json → FAIL (a sync-config problem).
  {
    const repo = await gitRepo();
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), '{ not json');
    const r = await gate.run({ repoRoot: repo });
    ok(!r.ok && /malformed/.test(r.message), 'malformed replica.json → FAIL');
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`gate-replica-untracked: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
