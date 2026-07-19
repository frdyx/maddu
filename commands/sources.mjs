// `maddu sources <rebuild|status>` — the oracle pin.
//
// rebuild: expand .maddu/config/tracked-sources.json (literals + globs), hash
//          each file, append SOURCE_HASH_RECOMPUTED with the snapshot.
// status:  show current drift relative to the recorded snapshot.
//
// WHY REBUILD DEMANDS A REASON
// Re-pinning is the escape hatch for every check built on these hashes: it makes
// whatever is on disk right now the new truth. That is legitimate (tests get
// merged, gates get refactored) but it must never be a reflex. `--reason` is
// recorded on the spine alongside the snapshot, so a re-baseline is always an
// explicit, attributable act rather than a silent one. This mirrors the
// discipline off-switch ladder in commands/governance.mjs.
//
// This does NOT make weakening impossible — an actor can always rebuild with a
// plausible reason. It makes it visible. See docs/34-threat-model.md.

import path from 'node:path';

import {
  computeDrift,
  expandPins,
  hashFile,
  pinPatterns,
  readPinConfig,
} from '../template/maddu/runtime/lib/content-pins.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const CONFIG_HINT = [
  'No tracked sources configured. Create .maddu/config/tracked-sources.json:',
  '  {',
  '    "schemaVersion": 1,',
  '    "paths": ["scripts/test/", "template/maddu/runtime/gates/builtin/", ".maddu/config/ci.json"]',
  '  }',
  'Entries may be literal paths or globs (`**` crosses directories).',
].join('\n');

// A flag-shaped value is not a reason: `--reason --force` must never be read as
// the literal reason "--force".
//
// It must ALSO not silently degrade into a forced, reasonless re-pin. Someone
// typing `--reason --force` was trying to give a reason and got the quoting
// wrong; treating that as "no reason supplied, but --force is present, so
// proceed" would re-baseline the oracle on a typo. Distinguish the two cases:
//   absent    — no --reason at all (refusable, waivable by --force)
//   malformed — --reason present with a flag-shaped or empty value (hard error)
function readReason(argv) {
  const i = argv.indexOf('--reason');
  if (i < 0) return { state: 'absent', value: null };
  const raw = argv[i + 1];
  if (!raw || String(raw).startsWith('--')) return { state: 'malformed', value: null };
  return { state: 'ok', value: raw };
}

const LABEL = {
  missing: 'MISSING',
  unpinned: 'UNPINNED',
  changed: 'DRIFTED',
  removed: 'REMOVED',
};

export default async function command(argv) {
  const sub = argv[0];
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'rebuild') {
    const parsed = readReason(argv);
    const force = argv.includes('--force');

    // Malformed beats forced: a mis-quoted reason is a mistake, not consent.
    if (parsed.state === 'malformed') {
      console.error('error  --reason needs a value: maddu sources rebuild --reason "why these files legitimately changed"');
      process.exit(2);
    }
    const reason = parsed.value;

    const config = await readPinConfig(repoRoot);
    const patterns = pinPatterns(config);
    if (!patterns.length) {
      console.error(CONFIG_HINT);
      process.exit(2);
    }

    // Refuse an unexplained re-baseline. `--force` waives THIS refusal only —
    // it never waives recording (below), because an unrecordable re-pin must
    // not happen at all.
    if (!reason && !force) {
      console.error('refused  re-pinning the oracle needs a reason.');
      console.error('         maddu sources rebuild --reason "why these files legitimately changed"');
      process.exit(3);
    }

    const declared = await expandPins(repoRoot, patterns);
    if (!declared.length) {
      console.error(`refused  ${patterns.length} pattern(s) matched 0 files — check .maddu/config/tracked-sources.json`);
      process.exit(2);
    }

    const out = [];
    const missing = [];
    for (const rel of declared) {
      try { out.push({ path: rel, hash: await hashFile(path.join(repoRoot, rel)) }); }
      catch { missing.push(rel); }
    }
    if (missing.length) {
      console.error(`refused  declared file(s) missing — not re-pinning a partial set: ${missing.join(', ')}`);
      process.exit(1);
    }

    const sessionId = process.env.MADDU_SESSION_ID || null;
    let ev;
    try {
      ev = await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.SOURCE_HASH_RECOMPUTED,
        actor: sessionId,
        lane: process.env.MADDU_LANE || null,
        data: {
          count: out.length,
          paths: out,
          reason: reason || null,
          by: sessionId,
        },
      });
    } catch (e) {
      // The append IS the pin. If it cannot be recorded there is no re-baseline
      // to speak of — fail loudly rather than leave the caller believing the
      // oracle moved. No --force bypass.
      console.error(`refused  could not record the re-pin on the spine (${e?.message || e}).`);
      console.error('         Fix the spine first — a re-baseline must leave a witness.');
      process.exit(1);
    }

    console.log(`sources rebuilt: ${out.length} file(s)`);
    for (const p of out.slice(0, 20)) console.log(`  ${p.hash.slice(0, 12)}…  ${p.path}`);
    if (out.length > 20) console.log(`  … and ${out.length - 20} more`);
    if (reason) console.log(`reason: ${reason}`);
    else console.log('reason: (none — forced)');
    console.log(`event: ${ev.id}`);
    return;
  }

  if (sub === 'status' || sub === undefined) {
    const config = await readPinConfig(repoRoot);
    const patterns = pinPatterns(config);
    if (!patterns.length) {
      console.log('tracked sources: 0');
      console.log('  (configure .maddu/config/tracked-sources.json)');
      return;
    }

    const declared = await expandPins(repoRoot, patterns);
    const proj = await projections.project(repoRoot);
    const recorded = proj.sourceHashes?.paths || {};
    const drifted = await computeDrift(repoRoot, declared, recorded);
    const driftedPaths = new Set(drifted.map((d) => d.path));

    console.log(`tracked sources: ${declared.length} file(s) from ${patterns.length} pattern(s)`);
    for (const d of drifted) {
      const extra = d.reason === 'changed'
        ? `  (recorded ${d.recorded.slice(0, 12)}… current ${d.current.slice(0, 12)}…)`
        : '';
      console.log(`  ${(LABEL[d.reason] || d.reason).padEnd(12)}  ${d.path}${extra}`);
    }
    const clean = declared.filter((p) => !driftedPaths.has(p)).length;
    const counts = drifted.reduce((m, d) => { m[d.reason] = (m[d.reason] || 0) + 1; return m; }, {});
    console.log(
      `\nsummary: ${clean} clean · ${counts.changed || 0} drifted · `
      + `${counts.unpinned || 0} unpinned · ${counts.missing || 0} missing · ${counts.removed || 0} removed`,
    );
    if (proj.sourceHashes?.lastRecomputedAt) {
      console.log(`last pinned: ${proj.sourceHashes.lastRecomputedAt}`);
    }
    if (drifted.length > 0) process.exit(1);
    return;
  }

  console.error('Usage: maddu sources <rebuild|status>');
  console.error('       maddu sources rebuild --reason "<why the pinned files legitimately changed>"');
  process.exit(2);
}
