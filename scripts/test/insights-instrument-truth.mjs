// Tier-1 instrument-truth self-test (usage-audit roadmap, 2026-07-16).
// Run standalone:  node scripts/test/insights-instrument-truth.mjs
//
// Proves the four Tier-1 acceptance criteria:
//   1. VERSION SSOT — fleet.digestRepo and insights.harvestSpines resolve the
//      SAME version from the SAME repo (the audit found them disagreeing
//      1.15.0-vs-0.19.0 on every since-upgraded repo), honest 'unknown'
//      included, with the source labeled.
//   2. IMPORT SEGMENTATION, BOTH DIRECTIONS — an import-stamped event
//      (data.source='claude-code-transcript') is excluded from native
//      activity/recency by default and restored by includeImported; a native
//      event of the SAME type is never excluded (the false-exclusion trap the
//      Codex plan review round 1 caught).
//   3. TAXONOMY PARTITION — every defined EVENT_TYPES member lands in exactly
//      one of {fired, imported-only, dormant-by-design, plugin-owned, dead}
//      and the buckets sum to definedTotal (the audit left 19 unexplained).
//   4. ROLE DETECTION — self (framework source checkout, by file test),
//      fixture (registry role), consumer (default).

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIB = join(REPO, 'template', 'maddu', 'runtime', 'lib');

const { resolveInstalledVersion } = await import(new URL(`file:///${join(LIB, 'installed-version.mjs').replace(/\\/g, '/')}`));
const insights = await import(new URL(`file:///${join(LIB, 'insights.mjs').replace(/\\/g, '/')}`));
const fleetLib = await import(new URL(`file:///${join(LIB, 'fleet.mjs').replace(/\\/g, '/')}`));
const spineLib = await import(new URL(`file:///${join(LIB, 'spine.mjs').replace(/\\/g, '/')}`));
const { EVENT_DISPOSITIONS } = await import(new URL(`file:///${join(LIB, 'event-dispositions.mjs').replace(/\\/g, '/')}`));
const { saveSkill } = await import(new URL(`file:///${join(LIB, 'skills.mjs').replace(/\\/g, '/')}`));
const { safeImport } = await import(new URL(`file:///${join(LIB, 'imports.mjs').replace(/\\/g, '/')}`));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

function evLine(type, data = {}, ts = '2026-07-16T08:00:00.000Z') {
  return JSON.stringify({ v: 1, id: `evt_20260716080000_${Math.abs(hash(type + JSON.stringify(data))).toString(16).slice(0, 6).padEnd(6, '0')}`, ts, type, actor: null, lane: null, data }) + '\n';
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

async function makeRepo(root, { version, spineLines = [], legacyMadduJsonOnly = false } = {}) {
  await mkdir(join(root, '.maddu', 'events'), { recursive: true });
  if (spineLines.length) await writeFile(join(root, '.maddu', 'events', '000000000001.ndjson'), spineLines.join(''));
  if (version && !legacyMadduJsonOnly) {
    await mkdir(join(root, 'maddu'), { recursive: true });
    await writeFile(join(root, 'maddu', 'version.json'), JSON.stringify({ version, released: '2026-07-10' }));
  }
  if (version) {
    await writeFile(join(root, 'maddu.json'), JSON.stringify({ framework: 'maddu', framework_version: version }));
  }
}

const tmp = await mkdtemp(join(tmpdir(), 'maddu-t1-'));
try {
  // ── 1. Version SSOT ────────────────────────────────────────────────────────
  const rInstalled = join(tmp, 'installed');
  await makeRepo(rInstalled, { version: '1.42.0', spineLines: [evLine('FRAMEWORK_INSTALLED', { version: '0.19.0' })] });
  const rLegacy = join(tmp, 'legacy');
  await makeRepo(rLegacy, { version: '1.7.0', legacyMadduJsonOnly: true, spineLines: [evLine('FRAMEWORK_BOOTED')] });
  const rBare = join(tmp, 'bare');
  await makeRepo(rBare, { spineLines: [evLine('FRAMEWORK_BOOTED')] });

  const v1 = await resolveInstalledVersion(rInstalled);
  ok(v1.version === '1.42.0' && v1.source === 'maddu/version.json', `resolver prefers maddu/version.json (got ${v1.version} from ${v1.source})`);
  const v2 = await resolveInstalledVersion(rLegacy);
  ok(v2.version === '1.7.0' && v2.source === 'maddu.json', `resolver falls back to maddu.json (got ${v2.version} from ${v2.source})`);
  const v3 = await resolveInstalledVersion(rBare);
  ok(v3.version === null && v3.source === 'unknown', `resolver reports unknown honestly, never guesses (got ${v3.version}/${v3.source})`);

  // Codex diff-review round 1 (HIGH): a consumer app's OWN root version.json
  // must never be misread as Máddu's version — root version.json is only
  // consulted on the framework source checkout (bin/maddu.mjs + template/maddu).
  const rApp = join(tmp, 'app-with-own-versionjson');
  await makeRepo(rApp, { spineLines: [evLine('FRAMEWORK_BOOTED')] });
  await writeFile(join(rApp, 'version.json'), JSON.stringify({ version: '3.2.1' }));
  const vApp = await resolveInstalledVersion(rApp);
  ok(vApp.version === null && vApp.source === 'unknown', `consumer app version.json is never misread as Máddu's (got ${vApp.version}/${vApp.source})`);
  const rAppLegacy = join(tmp, 'app-legacy');
  await makeRepo(rAppLegacy, { version: '1.7.0', legacyMadduJsonOnly: true });
  await writeFile(join(rAppLegacy, 'version.json'), JSON.stringify({ version: '3.2.1' }));
  const vAppLegacy = await resolveInstalledVersion(rAppLegacy);
  ok(vAppLegacy.version === '1.7.0' && vAppLegacy.source === 'maddu.json', `maddu.json beats an app's root version.json (got ${vAppLegacy.version}/${vAppLegacy.source})`);

  // Both surfaces agree on every fixture — including that the spine's stale
  // FRAMEWORK_INSTALLED version (0.19.0) no longer leaks into insights.
  for (const [label, root] of [['installed', rInstalled], ['legacy', rLegacy], ['bare', rBare]]) {
    const digest = await fleetLib.digestRepo({ id: label, path: root }, Date.parse('2026-07-16T09:00:00Z'));
    const [harvest] = await insights.harvestSpines([{ id: label, path: root }]);
    ok(digest.version === harvest.installedVersion && digest.versionSource === harvest.versionSource,
      `fleet and insights agree on ${label} (fleet ${digest.version}/${digest.versionSource} vs insights ${harvest.installedVersion}/${harvest.versionSource})`);
  }
  const [hInstalled] = await insights.harvestSpines([{ id: 'installed', path: rInstalled }]);
  ok(hInstalled.installedVersion === '1.42.0', `insights reads disk truth, not install-time spine event (got ${hInstalled.installedVersion})`);

  // ── 2. Import segmentation, both directions ────────────────────────────────
  const rMix = join(tmp, 'mix');
  await makeRepo(rMix, {
    version: '1.99.0',
    spineLines: [
      evLine('TOKEN_USAGE_REPORTED', { source: 'claude-code-transcript', importHash: 'abc', inputTokens: 10 }, '2026-07-15T00:00:00.000Z'),
      evLine('TOKEN_USAGE_REPORTED', { runtime: 'claude-code', inputTokens: 5 }, '2026-07-10T00:00:00.000Z'), // native — no source field
      evLine('SLICE_STOP', { summary: 'x' }, '2026-07-11T00:00:00.000Z'),
    ],
  });
  const [mixDefault] = await insights.harvestSpines([{ id: 'mix', path: rMix }]);
  ok(mixDefault.total === 2 && mixDefault.importedTotal === 1, `default harvest excludes imported rows from totals (native ${mixDefault.total}, imported ${mixDefault.importedTotal})`);
  ok(mixDefault.counts.get('TOKEN_USAGE_REPORTED') === 1, `native event of an import-carrying type is NOT excluded (got ${mixDefault.counts.get('TOKEN_USAGE_REPORTED')})`);
  ok(mixDefault.importedCounts.get('TOKEN_USAGE_REPORTED') === 1, 'imported row tallied apart');
  ok(mixDefault.lastTs === '2026-07-11T00:00:00.000Z', `recency ignores imported rows (lastTs ${mixDefault.lastTs})`);
  const [mixAll] = await insights.harvestSpines([{ id: 'mix', path: rMix }], { includeImported: true });
  ok(mixAll.total === 3, `--include-imported restores merged totals (total ${mixAll.total})`);
  ok(mixAll.importedTotal === 1, `importedTotal stays honest under includeImported, never falsely zero (got ${mixAll.importedTotal})`);
  ok(mixAll.counts.get('TOKEN_USAGE_REPORTED') === 2, 'merged count includes both rows');

  // imported-only classification: a repo whose ONLY row of a type is imported
  // must not put that type in deadDefined.
  const definedSet = await insights.definedEventTypes(spineLib);
  const rImpOnly = join(tmp, 'imponly');
  await makeRepo(rImpOnly, { version: '1.99.0', spineLines: [evLine('TOKEN_USAGE_REPORTED', { source: 'claude-code-transcript', importHash: 'x' })] });
  const impProjects = await insights.harvestSpines([{ id: 'imponly', path: rImpOnly }]);
  const impMatrix = insights.buildMatrix(impProjects, definedSet);
  const impRow = impMatrix.rows.find((r) => r.type === 'TOKEN_USAGE_REPORTED');
  ok(impRow.cls === 'imported-only' && impRow.count === 0 && impRow.importedCount === 1, `backfill-only type classifies imported-only, not dead (cls ${impRow.cls})`);
  ok(!impMatrix.deadDefined.includes('TOKEN_USAGE_REPORTED'), 'imported-only type is kept out of deadDefined');

  // ── 3. Taxonomy partition: exhaustive + disjoint over real EVENT_TYPES ─────
  const pluginOwners = new Map(Object.entries(EVENT_DISPOSITIONS).filter(([, d]) => d.disp === 'plugin').map(([t, d]) => [t, d.reason]));
  const matrix = insights.buildMatrix(impProjects, definedSet, pluginOwners);
  const part = matrix.partition;
  ok(part && part.complete, `partition covers all defined types (${part?.sum}/${definedSet.size})`);
  const seenOnce = new Set();
  let dup = null;
  for (const types of Object.values(part.buckets)) for (const t of types) { if (seenOnce.has(t)) dup = t; seenOnce.add(t); }
  ok(dup === null, `partition buckets are disjoint (duplicate: ${dup})`);
  ok(part.buckets['plugin-owned'].length > 0, 'plugin-owned types are named, not folded into dormant (the 19-unexplained fix)');
  ok(part.buckets['dormant-by-design'].includes('SKILL_INJECTION_REFUSED'), 'SKILL_INJECTION_REFUSED reclassified dormant-by-design (Tier-1 decision)');

  // Precedence coherence (Codex round 1): a DORMANT-annotated type whose only
  // rows are imported must read imported-only in BOTH the row cls and the
  // partition — one precedence, no contradictory classifications.
  const rDormImp = join(tmp, 'dormimp');
  await makeRepo(rDormImp, { version: '1.99.0', spineLines: [evLine('INBOX_MESSAGE', { message: 'x', kind: 'imported', source: 'import-submit' })] });
  const dormImpProjects = await insights.harvestSpines([{ id: 'dormimp', path: rDormImp }]);
  const dormImpMatrix = insights.buildMatrix(dormImpProjects, definedSet);
  const dormImpRow = dormImpMatrix.rows.find((r) => r.type === 'INBOX_MESSAGE');
  ok(dormImpRow.cls === 'imported-only', `dormant-annotated + imported-only type: row cls agrees with partition (got ${dormImpRow.cls})`);
  ok(dormImpMatrix.partition.buckets['imported-only'].includes('INBOX_MESSAGE'), 'partition places it imported-only too');

  // Undeclared drift is counted apart, never silently folded into the partition.
  const rUndecl = join(tmp, 'undecl');
  await makeRepo(rUndecl, { version: '1.99.0', spineLines: [evLine('TOTALLY_UNKNOWN_TYPE', { x: 1 })] });
  const undeclMatrix = insights.buildMatrix(await insights.harvestSpines([{ id: 'undecl', path: rUndecl }]), definedSet);
  ok(undeclMatrix.undeclaredCount === 1 && undeclMatrix.partition.complete, `undeclared type counted apart while partition stays complete (${undeclMatrix.undeclaredCount}, ${undeclMatrix.partition.complete})`);

  // Skill-import stamping is spoof-proof (Codex rounds 2+3): the import path
  // stamps SKILL_* lifecycle events via trusted-caller opts; a caller-supplied
  // `source` INSIDE the skill object (the bridge-JSON shape) is ignored.
  const rSkills = join(tmp, 'skills');
  await makeRepo(rSkills, { version: '1.99.0', spineLines: [evLine('FRAMEWORK_BOOTED')] });
  await safeImport(rSkills, { kind: 'skill', payload: { title: 'imported recipe', body: 'do the thing' }, by: 'ses_t' });
  await saveSkill(rSkills, { title: 'native recipe', body: 'native thing', by: 'ses_t', source: 'import-submit' }); // spoof attempt
  const spineTxt = await readFile(join(rSkills, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
  const skillEvents = spineTxt.split('\n').filter((l) => l.includes('SKILL_CREATED')).map((l) => JSON.parse(l));
  const imported = skillEvents.find((e) => e.data.title === 'imported recipe');
  const spoofed = skillEvents.find((e) => e.data.title === 'native recipe');
  ok(imported?.data.source === 'import-submit' && insights.isImportedEvent(imported), 'import-submit skill stamps its SKILL_CREATED as imported');
  ok(spoofed && spoofed.data.source === undefined && !insights.isImportedEvent(spoofed), `caller-supplied source inside the skill object is ignored (got ${spoofed?.data.source})`);
  const [skillsHarvest] = await insights.harvestSpines([{ id: 'skills', path: rSkills }]);
  ok(skillsHarvest.counts.get('SKILL_CREATED') === 1 && skillsHarvest.importedCounts.get('SKILL_CREATED') === 1, 'harvest splits native vs imported skill lifecycle events');

  // ── 4. Role detection ──────────────────────────────────────────────────────
  ok(await insights.workspaceRole({ path: REPO, role: 'project' }) === 'self', 'framework source checkout detects as self');
  ok(await insights.workspaceRole({ path: REPO, role: 'fixture' }) === 'self', 'self file-test beats a fixture registry label (Codex round 1)');
  ok(await insights.workspaceRole({ path: rMix, role: 'fixture' }) === 'fixture', 'registry fixture role wins for non-source repos');
  ok(await insights.workspaceRole({ path: rMix, role: 'project' }) === 'consumer', 'plain project detects as consumer');
  ok(insights.transcriptDirName('C:\\Users\\X\\My_Proj.v2') === 'c--users-x-my-proj-v2', `transcript dir encoding (got ${insights.transcriptDirName('C:\\Users\\X\\My_Proj.v2')})`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`insights-instrument-truth: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
