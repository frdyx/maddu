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

import { mkdir, readFile, writeFile, unlink, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
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

  // v1.11.0 — backfill ALL framework config defaults on upgrade, single-sourced
  // with `maddu init` via commands/_config-seed.mjs so the two can't drift.
  // This fixes the pre-v1.11.0 bug where upgrade's inline DEFAULT_TRIGGERS went
  // stale (missing v1.10.0 auto-handoff/auto-review) and where janitor / trust /
  // worker-env / governance were never backfilled on upgrade (a repo installed
  // before a config existed never got its defaults — incl. worker-env's
  // default-deny-secrets). Write-if-missing; triggers.json merges add-missing;
  // operator edits are never disturbed.
  try {
    const { seedConfigDefaults, seedStarterSkills } = await import('./_config-seed.mjs');
    const seeded = await seedConfigDefaults(repoRoot, { templateRoot: TEMPLATE_ROOT });
    // Starter skills got the same backfill treatment in the 2026-07-07 template
    // audit: init seeded them since v1.1.0 but upgrade never did, so pre-v1.1.0
    // installs warned "starter skills missing" forever. Write-if-missing.
    const { skillsSeeded } = await seedStarterSkills(repoRoot, { templateRoot: TEMPLATE_ROOT });
    const parts = [];
    if (seeded.triggersAdded.length) parts.push(`triggers +${seeded.triggersAdded.length}`);
    if (seeded.configsSeeded.length) parts.push(`config ${seeded.configsSeeded.join('/')}`);
    if (seeded.pipelinesSeeded.length) parts.push(`pipelines ${seeded.pipelinesSeeded.length}`);
    if (skillsSeeded.length) parts.push(`starter skills +${skillsSeeded.length}`);
    if (parts.length) console.log(`  config defaults backfilled: ${parts.join(', ')}`);
  } catch (err) {
    console.error(`  (config defaults backfill skipped: ${err.message})`);
  }

  // v1.4.0 — comms back-compat: the Telegram/Discord/Email subsystems moved
  // from the bridge's static boot path into the `comms` plugin (off by default).
  // A repo that had any of them enabled must keep working, so if their state
  // shows enabled we seed `comms` into the plugin enable-state. Idempotent;
  // never disables an already-listed plugin.
  try {
    const stateDir = join(repoRoot, '.maddu', 'state');
    let wasEnabled = false;
    for (const f of ['telegram.json', 'discord.json', 'email.json']) {
      try {
        const s = JSON.parse(await readFile(join(stateDir, f), 'utf8'));
        if (s && s.enabled === true) { wasEnabled = true; break; }
      } catch {}
    }
    if (wasEnabled) {
      const pluginsCfg = join(repoRoot, '.maddu', 'config', 'plugins.json');
      let cfg = { enabled: [] };
      try { cfg = JSON.parse(await readFile(pluginsCfg, 'utf8')); cfg.enabled = Array.isArray(cfg.enabled) ? cfg.enabled : []; } catch {}
      if (!cfg.enabled.includes('comms')) {
        cfg.enabled = [...new Set([...cfg.enabled, 'comms'])].sort();
        await mkdir(dirname(pluginsCfg), { recursive: true });
        await writeFile(pluginsCfg, JSON.stringify(cfg, null, 2) + '\n');
        console.log('  comms plugin auto-enabled (was active before the plugin split)');
      }
    }
  } catch (err) {
    console.error(`  (comms back-compat seed skipped: ${err.message})`);
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

  // Append upgrade events through the spine layer so chained installs keep
  // their prev_hash continuity.
  const spine = await import(pathToFileURL(join(TEMPLATE_ROOT, 'maddu', 'runtime', 'lib', 'spine.mjs')).href);
  const ev = await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.FRAMEWORK_UPGRADED,
    data: {
      from: fromVersion,
      to: toVersion,
      updated: actions.update.length,
      added: actions.add.length,
      removed: actions.remove.length,
      skipped: actions.skip.length,
      warnings: actions.warnings
    }
  });

  if (agentFileSync) {
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.AGENT_FILE_SYNCED,
      data: { files: agentFileSync.files, action: agentFileSync.action, perFile: agentFileSync.perFile }
    });
  }

  if (slashSync) {
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SLASH_COMMANDS_SYNCED,
      data: {
        action: slashSync.action,
        files: slashSync.files,
        perFile: slashSync.perFile,
        reason: slashSync.reason || null,
      }
    });
  }

  console.log(`\nUpgraded to v${toVersion}. (event ${ev.id})`);

  // Activation nudge (usage-audit Tier 3): hooks are the proven activation
  // lever — the ritual-active repos in the 2026-07-16 fleet audit are the
  // hooked ones. If this repo still isn't wired, say so once, at the moment
  // the operator is already paying attention. Best-effort, read-only.
  try {
    const { loadLibOptional } = await import(new URL('./_libroot.mjs', import.meta.url).href);
    const hooksLib = await loadLibOptional('claude-hooks.mjs');
    if (hooksLib && hooksLib.loadSettings && hooksLib.summarize) {
      const { settings } = await hooksLib.loadSettings(repoRoot);
      if (!hooksLib.summarize(settings).allInstalled) {
        console.log(`\nSession discipline is not wired in this repo — sessions won't auto-register.`);
        console.log(`  ./maddu/run hooks install   # the proven activation lever: register → claim → slice-stop with zero keystrokes`);
      }
    }
  } catch {}
}
