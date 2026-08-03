#!/usr/bin/env node
// Phase 2 (memory-recall track) — search relevance golden suite.
//
// Seeds a hermetic repo with 8 distinctive "topic" slice-stops, 30 newer
// generic filler stops, extracted memory facts, and 2 skills; then runs the
// ~25-query golden set (scripts/test/__fixtures__/search-golden-queries.json)
// and asserts:
//   • Recall@5 and MRR above the fixture thresholds (relevance actually ranks)
//   • order:'time' reproduces the legacy newest-first ordering — and fails to
//     surface a topic doc that relevance finds (the reason this phase exists)
//   • rows deriving from one source event collapse to one representative
//     carrying `also` siblings
//   • a generous p95 latency budget — the tripwire that would justify a
//     persistent .maddu/index/ if it ever trips
//   • CLI: --sort validation and end-to-end hit rendering

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

// Topic seeds: summary + learnings crafted so each query in the fixture has
// exactly one best document. Filler stops appended AFTER these are newer, so
// legacy time-ordering buries every topic.
const SEEDS = {
  deploy: {
    summary: 'SLICE STOP: deploy pipeline hardened — tar-over-ssh atomic swap replaces rsync',
    learnings: ['- rule: deploys use tar-over-ssh atomic swap, never rsync on local Git Bash'],
    lane: 'deploy'
  },
  tokenizer: {
    summary: 'SLICE STOP: search tokenizer keeps dotted tokens so hindsight.mjs matches exactly',
    learnings: ['- discovery: dotted filenames like hindsight.mjs need raw + split token extraction'],
    lane: 'search'
  },
  goldens: {
    summary: 'SLICE STOP: cockpit verified against byte-identical golden snapshots plus playwright',
    learnings: ['- rule: cockpit golden snapshots must stay byte-identical across routes'],
    lane: 'cockpit-shell'
  },
  sessions: {
    summary: 'SLICE STOP: session registration lock serializes concurrent register calls',
    learnings: ['- constraint: registration lock serializes concurrent register attempts'],
    lane: 'harness'
  },
  wiki: {
    summary: 'SLICE STOP: wiki drift detection compares page mtime against latest lane stop',
    learnings: ['- discovery: lane wiki pages are append-only digests; drift is mtime-based'],
    lane: 'learning'
  },
  redaction: {
    summary: 'SLICE STOP: secret redaction enforced at the write boundary via redactLeaves',
    learnings: ['- rule: the canonical redactor redactLeaves runs at every write boundary'],
    lane: 'harness'
  },
  lanes: {
    summary: 'SLICE STOP: lane claims recorded in catalog json with ownership enforcement',
    learnings: ['- rule: lane ownership means no two agents hold one lane concurrently'],
    lane: 'bridge-server'
  },
  bridge: {
    summary: 'SLICE STOP: bridge loopback capability token is a csrf boundary on port 4177',
    learnings: ['- constraint: the origin guard rejects non-loopback requests before routing'],
    lane: 'bridge-server'
  }
};

async function main() {
  const spine = await loadLib('spine.mjs');
  const hindsight = await loadLib('hindsight.mjs');
  const skills = await loadLib('skills.mjs');
  const searchLib = await loadLib('search.mjs');
  if (!spine || !hindsight || !skills || !searchLib) { console.error('harness error: lib not found'); process.exit(2); }

  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, '__fixtures__', 'search-golden-queries.json'), 'utf8'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-search-golden-'));
  try {
    // ── seed ─────────────────────────────────────────────────────────────
    const seedIds = {};
    for (const [key, s] of Object.entries(SEEDS)) {
      const ev = await spine.append(repo, {
        type: spine.EVENT_TYPES.SLICE_STOP,
        actor: 'ses_golden', lane: s.lane,
        data: { summary: s.summary, learnings: s.learnings, targets: [], gates: [] }
      });
      seedIds[key] = ev.id;
      await hindsight.extractEvent(repo, ev); // memory facts share sourceEvent → collapse fodder
    }
    for (let i = 0; i < 30; i++) {
      await spine.append(repo, {
        type: spine.EVENT_TYPES.SLICE_STOP,
        actor: 'ses_filler', lane: 'harness',
        data: { summary: `SLICE STOP: routine maintenance tick ${i} completed without findings` }
      });
    }
    await skills.saveSkill(repo, {
      id: 'deploy-checklist', title: 'Deploy checklist',
      when: 'before any production deploy',
      tags: ['deploy', 'ops'],
      body: 'Steps: verify DRYRUN preview before swap, confirm remote disk space, then run the atomic swap script.'
    });
    await skills.saveSkill(repo, {
      id: 'bm25-tuning', title: 'BM25 tuning notes',
      when: 'adjusting search relevance',
      tags: ['search'],
      body: 'bm25 scoring parameters: k1 controls tf saturation, b controls length normalization.'
    });
    seedIds['skill-deploy'] = 'deploy-checklist';
    seedIds['skill-bm25'] = 'bm25-tuning';

    const hitsSeed = (row, expectId) =>
      row.id === expectId || row.sourceEvent === expectId ||
      (row.also || []).some((a) => a.id === expectId);

    // ── golden queries: Recall@5 + MRR ───────────────────────────────────
    let recallHits = 0, rrSum = 0;
    const timings = [];
    for (const gq of fixture.queries) {
      const t0 = process.hrtime.bigint();
      const out = await searchLib.search(repo, gq.query, { kinds: gq.kinds || null, limit: 10 });
      timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
      const expectId = seedIds[gq.expect];
      const rank = out.results.findIndex((r) => hitsSeed(r, expectId));
      if (rank >= 0 && rank < 5) recallHits++;
      else console.error(`  miss [${gq.name}] "${gq.query}" → expected ${gq.expect} (${expectId}), top5: ${out.results.slice(0, 5).map((r) => `${r.kind}:${(r.title || r.id).slice(0, 40)}`).join(' | ')}`);
      rrSum += rank >= 0 ? 1 / (rank + 1) : 0;
    }
    const recallAt5 = recallHits / fixture.queries.length;
    const mrr = rrSum / fixture.queries.length;
    ok(`Recall@5 >= ${fixture.thresholds.recallAt5}`, recallAt5 >= fixture.thresholds.recallAt5, `got ${recallAt5.toFixed(3)}`);
    ok(`MRR >= ${fixture.thresholds.mrr}`, mrr >= fixture.thresholds.mrr, `got ${mrr.toFixed(3)}`);

    // ── p95 latency tripwire ─────────────────────────────────────────────
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))];
    ok(`p95 query latency < ${fixture.thresholds.p95LatencyMs}ms`, p95 < fixture.thresholds.p95LatencyMs, `got ${p95.toFixed(0)}ms`);

    // ── legacy time ordering ─────────────────────────────────────────────
    {
      const out = await searchLib.search(repo, 'SLICE STOP', { order: 'time', limit: 50 });
      const ts = out.results.map((r) => r.ts || '');
      const sorted = [...ts].sort((a, b) => b.localeCompare(a));
      ok('order:time is newest-first', JSON.stringify(ts) === JSON.stringify(sorted));
      // Fillers are newest → with time ordering a broad query's top 5 is all filler.
      ok('time ordering buries topics under fillers', out.results.slice(0, 5).every((r) => (r.title || '').includes('routine maintenance')),
        out.results.slice(0, 5).map((r) => r.title).join(' | '));
      const rel = await searchLib.search(repo, 'atomic swap tar-over-ssh', { limit: 5 });
      ok('relevance surfaces what time ordering buried', rel.results.some((r) => hitsSeed(r, seedIds.deploy)));
    }

    // ── collapse by source event ─────────────────────────────────────────
    {
      const out = await searchLib.search(repo, 'tar-over-ssh atomic swap', { limit: 20 });
      const rowsForDeploy = out.results.filter((r) => hitsSeed(r, seedIds.deploy) || r.sourceEvent === seedIds.deploy);
      ok('one representative per source event', rowsForDeploy.length === 1, `got ${rowsForDeploy.length}`);
      ok('representative carries also siblings', rowsForDeploy.length === 1 && (rowsForDeploy[0].also || []).length >= 1,
        JSON.stringify(rowsForDeploy[0]?.also || []));
      ok('rows carry numeric score', out.results.every((r) => typeof r.score === 'number'));
    }

    // ── r3 major 5 / minor 7: limit clamps, also cap, trust labels ───────
    {
      const neg = await searchLib.search(repo, 'SLICE STOP', { limit: -1 });
      ok('negative limit clamps to 1 (never slice(0,-1))', neg.results.length === 1, `${neg.results.length}`);
      const huge = await searchLib.search(repo, 'SLICE STOP', { limit: 9999999 });
      ok('huge limit clamps to 500', huge.results.length <= 500);
      const all = await searchLib.search(repo, 'atomic swap', { limit: 20 });
      ok('also arrays capped at 10', all.results.every((r) => !r.also || r.also.length <= 10));
      const memRows = (await searchLib.search(repo, 'atomic swap', { kinds: ['memory'], limit: 10 })).results;
      ok('memory results carry trust labels', memRows.length > 0 && memRows.every((r) => typeof r.trust === 'string'), JSON.stringify(memRows.map((r) => r.trust)));
    }

    // ── CLI end-to-end ───────────────────────────────────────────────────
    {
      const outRel = execFileSync(process.execPath, [BIN, 'search', 'atomic', 'swap'], { cwd: repo, encoding: 'utf8' });
      ok('CLI relevance run hits deploy topic', outRel.includes('tar-over-ssh'));
      ok('CLI prints score', /score:\d/.test(outRel));
      const outTime = execFileSync(process.execPath, [BIN, 'search', 'atomic', 'swap', '--sort', 'time'], { cwd: repo, encoding: 'utf8' });
      ok('CLI --sort time runs clean without scores', !/score:\d/.test(outTime));
      let code = 0;
      try { execFileSync(process.execPath, [BIN, 'search', 'x', '--sort', 'bogus'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }); }
      catch (e) { code = e.status; }
      ok('CLI rejects bogus --sort with exit 2', code === 2);
    }

    console.log(`\nrecall@5=${recallAt5.toFixed(3)} mrr=${mrr.toFixed(3)} p95=${p95.toFixed(0)}ms`);
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
