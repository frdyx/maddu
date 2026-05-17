// `maddu upgrade` — pull newer framework files in place; never touch project state.
//
// Usage:
//   maddu upgrade [--force] [--dry-run]
//
// Rules:
//   • Refuses if maddu.json is missing — run `maddu init` first.
//   • For each currently-managed file: compares on-disk hash to the hash recorded
//     in maddu.json. Matches → safe to overwrite. Differs → operator modified
//     it; refuse unless --force, and append a warning event regardless.
//   • Files added in the new framework version are installed unconditionally.
//   • Files removed from the new framework are deleted from the target only if
//     their hashes are pristine; modified ones are left alone with a warning.
//   • Project state under .maddu/{events,state,sessions,inbox,archive,*/project}
//     is never touched.

import { mkdir, readFile, writeFile, unlink, appendFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import {
  exists, frameworkOwnedFiles, sha256OfFile, readMadduJson, writeMadduJson,
  frameworkVersion, ensureShimExecutable, TEMPLATE_ROOT
} from './_manifest.mjs';

export default async function upgrade(argv) {
  const { flags } = parseFlags(argv);
  const force = !!flags.force;
  const dryRun = !!flags['dry-run'];

  const repoRoot = await findRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error('maddu upgrade: no .maddu/ found. Run `maddu init` first.');
    process.exit(1);
  }
  const madduJson = await readMadduJson(repoRoot);
  if (!madduJson) {
    console.error(`maddu upgrade: ${repoRoot}/maddu.json missing. Run \`maddu init\` first.`);
    process.exit(1);
  }

  const fromVersion = madduJson.framework_version;
  const toVersion = await frameworkVersion();
  if (fromVersion === toVersion && !force) {
    console.log(`Already on framework v${toVersion}. Nothing to do.`);
    console.log(`  (pass --force to re-overwrite all framework files anyway)`);
    return;
  }

  const nextFiles = await frameworkOwnedFiles();
  const nextRelPaths = new Set(nextFiles.map((f) => f.relPath));
  const prevRelPaths = new Set(Object.keys(madduJson.managed || {}));

  const actions = { update: [], skip: [], add: [], remove: [], warnings: [] };

  // 1. Files in both old and new manifests.
  for (const { relPath, absSource } of nextFiles) {
    if (!prevRelPaths.has(relPath)) {
      actions.add.push({ relPath, absSource });
      continue;
    }
    const recorded = madduJson.managed[relPath].sha256;
    const onDisk = join(repoRoot, relPath);
    let currentHash = null;
    try { currentHash = await sha256OfFile(onDisk); } catch {}
    if (currentHash === null) {
      actions.update.push({ relPath, absSource, reason: 'missing on disk' });
    } else if (currentHash === recorded) {
      // Pristine. Compare against new content to see if there's a real change.
      const newHash = await sha256OfFile(absSource);
      if (newHash === recorded && !force) continue; // identical
      actions.update.push({ relPath, absSource });
    } else if (force) {
      actions.update.push({ relPath, absSource, reason: 'local edit overwritten (--force)' });
      actions.warnings.push(`overwrote locally-modified ${relPath}`);
    } else {
      actions.skip.push({ relPath, reason: 'local edit; pass --force to overwrite' });
      actions.warnings.push(`skipped locally-modified ${relPath}`);
    }
  }

  // 2. Files present in old manifest but removed from new framework.
  for (const relPath of prevRelPaths) {
    if (nextRelPaths.has(relPath)) continue;
    const recorded = madduJson.managed[relPath].sha256;
    const onDisk = join(repoRoot, relPath);
    if (!(await exists(onDisk))) continue;
    let currentHash = null;
    try { currentHash = await sha256OfFile(onDisk); } catch {}
    if (currentHash === recorded || force) {
      actions.remove.push({ relPath });
    } else {
      actions.skip.push({ relPath, reason: 'removed upstream but locally modified' });
      actions.warnings.push(`framework removed ${relPath} but local copy is modified; left in place`);
    }
  }

  // Print plan.
  console.log(`Upgrade plan: v${fromVersion} → v${toVersion}`);
  console.log(`  update : ${actions.update.length}`);
  console.log(`  add    : ${actions.add.length}`);
  console.log(`  remove : ${actions.remove.length}`);
  console.log(`  skip   : ${actions.skip.length}`);
  if (actions.warnings.length) {
    console.log(`\nWarnings:`);
    for (const w of actions.warnings) console.log(`  ! ${w}`);
  }
  if (dryRun) {
    console.log(`\n(dry-run — no files changed)`);
    return;
  }

  // Apply.
  const newManaged = { ...madduJson.managed };
  for (const { relPath, absSource } of [...actions.update, ...actions.add]) {
    const dst = join(repoRoot, relPath);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(absSource, dst);
    newManaged[relPath] = { sha256: await sha256OfFile(dst), installedBy: toVersion };
  }
  for (const { relPath } of actions.remove) {
    try { await unlink(join(repoRoot, relPath)); } catch {}
    delete newManaged[relPath];
  }
  // Drop manifest entries for skipped-removed files? No — keep them so we can
  // re-detect on the next upgrade.

  const next = {
    ...madduJson,
    framework_version: toVersion,
    upgraded_at: new Date().toISOString(),
    managed: newManaged
  };
  await writeMadduJson(repoRoot, next);

  // The project-local CLI shims (maddu/run, maddu/run.cmd) ride along
  // with the managed manifest — they were either added in `actions.add`
  // (pre-v0.14 install upgrading into v0.14+) or refreshed in `actions.update`
  // (already had them). All we need to do here is re-set the POSIX execute
  // bit, which `copyFile` doesn't preserve.
  await ensureShimExecutable(repoRoot);

  // Append FRAMEWORK_UPGRADED to spine.
  const eventsSegment = join(repoRoot, '.maddu', 'events', '000000000001.ndjson');
  const ts = new Date().toISOString();
  const ev = {
    v: 1,
    id: 'evt_' + ts.replace(/[-:T.Z]/g, '').slice(0, 14) + '_upgr00',
    ts,
    type: 'FRAMEWORK_UPGRADED',
    actor: null,
    lane: null,
    data: {
      from: fromVersion,
      to: toVersion,
      updated: actions.update.length,
      added: actions.add.length,
      removed: actions.remove.length,
      skipped: actions.skip.length,
      warnings: actions.warnings
    }
  };
  await appendFile(eventsSegment, JSON.stringify(ev) + '\n');

  console.log(`\nUpgraded to v${toVersion}. (event ${ev.id})`);
}
