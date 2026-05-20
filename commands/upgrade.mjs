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
import { randomBytes } from 'node:crypto';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import {
  exists, frameworkOwnedFiles, sha256OfFile, readMadduJson, writeMadduJson,
  frameworkVersion, ensureShimExecutable, requireSourceLayout, TEMPLATE_ROOT
} from './_manifest.mjs';

export default async function upgrade(argv) {
  const { flags } = parseFlags(argv);
  const force = !!flags.force;
  const dryRun = !!flags['dry-run'];

  // v0.17.1: refuse early if invoked via a consumer install's bundled CLI.
  // Previously a silent no-op — walked an empty template/maddu/ and copied
  // bin+commands onto itself, then reported "Upgraded to vX.Y.Z" with 0 updates.
  const layoutError = await requireSourceLayout('upgrade');
  if (layoutError) {
    console.error(layoutError);
    process.exit(2);
  }

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

  // v0.17 Phase 5 — backfill the janitor's trigger allowlist entry
  // for existing v0.16 repos so the trigger-discipline gate doesn't
  // trip on the first auto-close fire. janitor.json itself is optional
  // (readJanitorConfig falls back to baked-in defaults), so we only
  // write it when missing and never disturb operator overrides.
  try {
    const configDir = join(repoRoot, '.maddu', 'config');
    await mkdir(configDir, { recursive: true });
    const triggersPath = join(configDir, 'triggers.json');
    if (await exists(triggersPath)) {
      const text = await readFile(triggersPath, 'utf8');
      const cur = JSON.parse(text);
      const allowed = Array.isArray(cur?.allowed) ? cur.allowed : [];
      if (!allowed.includes('janitor:sessions')) {
        allowed.push('janitor:sessions');
        await writeFile(triggersPath, JSON.stringify({ ...cur, allowed }, null, 2) + '\n');
      }
    } else {
      await writeFile(
        triggersPath,
        JSON.stringify({ allowed: ['janitor:sessions'] }, null, 2) + '\n'
      );
    }
  } catch (err) {
    console.error(`  (janitor trigger allowlist seed skipped: ${err.message})`);
  }

  // v0.17 agent-native bootstrap — re-run the agent-file sync. Same
  // helper as init, but the helper-discovered framework root is the
  // installed maddu/ directory in the consumer (init lives in the
  // dev tree; here we're in the consumer). The helper probes both.
  let agentFileSync = null;
  let slashSync = null;
  try {
    const { loadAgentFileTemplates, syncAllAgentFiles, syncSlashCommands } = await import(
      'file://' + join(TEMPLATE_ROOT, '..', 'commands', '_agent-files.mjs').replace(/\\/g, '/')
    );
    // TEMPLATE_ROOT points at the framework's template/ dir; its
    // parent is the framework repo root, which doubles as the
    // template-root the helper expects in dev mode.
    const templates = await loadAgentFileTemplates(repoRoot);
    agentFileSync = await syncAllAgentFiles(repoRoot, templates);
    const perFile = Object.entries(agentFileSync.perFile)
      .map(([f, a]) => `${f}:${a}`).join(', ');
    console.log(`  agent files synced (${agentFileSync.action}) — ${perFile}`);

    // v0.18 Phase 1 — install/refresh slash-command directories. The
    // consumer's installed `maddu/agent-files/commands/` was copied
    // above via the managed-file manifest; sync from there into
    // `.claude/commands/` + `.codex/commands/`.
    slashSync = await syncSlashCommands(repoRoot, repoRoot);
    const slashSummary = slashSync.files.length
      ? `${slashSync.files.length} command(s)`
      : (slashSync.reason || 'no commands');
    console.log(`  slash commands synced (${slashSync.action}) — ${slashSummary}`);
  } catch (err) {
    console.error(`  (agent-file sync skipped: ${err.message})`);
  }

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

  if (agentFileSync) {
    const ts2 = new Date().toISOString();
    const ev2 = {
      v: 1,
      id: 'evt_' + ts2.replace(/[-:T.Z]/g, '').slice(0, 14) + '_' + randomBytes(3).toString('hex'),
      ts: ts2,
      type: 'AGENT_FILE_SYNCED',
      actor: null,
      lane: null,
      data: { files: agentFileSync.files, action: agentFileSync.action, perFile: agentFileSync.perFile }
    };
    await appendFile(eventsSegment, JSON.stringify(ev2) + '\n');
  }

  if (slashSync) {
    const ts3 = new Date().toISOString();
    const ev3 = {
      v: 1,
      id: 'evt_' + ts3.replace(/[-:T.Z]/g, '').slice(0, 14) + '_' + randomBytes(3).toString('hex'),
      ts: ts3,
      type: 'SLASH_COMMANDS_SYNCED',
      actor: null,
      lane: null,
      data: {
        action: slashSync.action,
        files: slashSync.files,
        perFile: slashSync.perFile,
        reason: slashSync.reason || null,
      }
    };
    await appendFile(eventsSegment, JSON.stringify(ev3) + '\n');
  }

  console.log(`\nUpgraded to v${toVersion}. (event ${ev.id})`);
}
