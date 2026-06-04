// `maddu init` — scaffold .maddu/ + maddu/ into the current directory.
//
// Usage:
//   maddu init [--force]
//
// What it does:
//   1. Refuses if .maddu/ or maddu/ already exists (unless --force or --upgrade).
//   2. Copies template/maddu/ → <cwd>/maddu/.
//   3. Creates .maddu/ skeleton with empty per-project subdirs.
//   4. Seeds .maddu/lanes/catalog.json from the framework default.
//   5. Writes maddu.json at the repo root with version + provenance manifest.
//   6. Appends FRAMEWORK_INSTALLED to the spine.
//   7. Adds Máddu's standard .gitignore entries (token paths, no-token-export).

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseFlags } from './_args.mjs';
import {
  exists, frameworkOwnedFiles, copyFromTemplate, sha256OfFile,
  readMadduJson, writeMadduJson, frameworkVersion, ensureShimExecutable,
  requireSourceLayout,
  FRAMEWORK_ROOT, TEMPLATE_ROOT
} from './_manifest.mjs';

const GITIGNORE_BLOCK = `
# Máddu token paths — device-bound, must never be committed.
.maddu/auth/
maddu/runtime/oauth/tokens/
`;

export default async function init(argv) {
  const { flags } = parseFlags(argv);
  const force = !!flags.force;
  const cwd = process.cwd();

  // v0.17.1: refuse early if invoked via a consumer install's bundled CLI.
  // Previously crashed mid-way with ERR_MODULE_NOT_FOUND on defaults.mjs
  // after creating a half-installed .maddu/ skeleton. Now exits with an
  // actionable error before touching the target.
  const layoutError = await requireSourceLayout('init');
  if (layoutError) {
    console.error(layoutError);
    process.exit(2);
  }

  if (await exists(join(cwd, '.maddu')) && !force) {
    console.error(`.maddu/ already exists in ${cwd}.`);
    console.error('  To pull newer framework files, run "maddu upgrade".');
    console.error('  To start over, delete .maddu/ first, or pass --force.');
    process.exit(1);
  }
  if (await exists(join(cwd, 'maddu')) && !force) {
    console.error(`maddu/ already exists in ${cwd}.`);
    console.error('  Pass --force to overwrite or move it out of the way.');
    process.exit(1);
  }

  console.log(`Installing Máddu into ${cwd}…`);

  // 1. Copy framework-owned files. frameworkOwnedFiles() mirrors
  //    template/maddu/** → maddu/**, plus bin/ + commands/ + version.json
  //    so the installed tree ships with a working CLI (used by the
  //    ./maddu shim below). Pass the whole entry to copyFromTemplate so
  //    non-template sources resolve via absSource.
  const files = await frameworkOwnedFiles();
  const managed = {};
  const fwVersion = await frameworkVersion();
  for (const entry of files) {
    const dst = await copyFromTemplate(cwd, entry);
    managed[entry.relPath] = {
      sha256: await sha256OfFile(dst),
      installedBy: fwVersion
    };
  }
  console.log(`  copied ${files.length} framework files into maddu/`);

  // 2. Create .maddu/ skeleton.
  const skeleton = [
    '.maddu',
    '.maddu/events',
    '.maddu/state',
    '.maddu/sessions',
    '.maddu/lanes',
    '.maddu/lanes/project',
    '.maddu/inbox',
    '.maddu/archive',
    '.maddu/briefs',
    '.maddu/briefs/project',
    '.maddu/wiki',
    '.maddu/wiki/project',
    '.maddu/harness',
    '.maddu/harness/project',
    // v1.1.0 Phase 5 — plan persistence root.
    '.maddu/state/plans',
    // v1.1.0 Phase 4 — receipt log root.
    '.maddu/state/log'
  ];
  for (const d of skeleton) {
    await mkdir(join(cwd, d), { recursive: true });
  }
  console.log(`  scaffolded .maddu/ skeleton (${skeleton.length} dirs)`);

  // 3. Seed lane catalog + empty claims.
  const { DEFAULT_LANE_CATALOG } = await import(
    'file://' + join(TEMPLATE_ROOT, 'maddu', 'runtime', 'lib', 'defaults.mjs').replace(/\\/g, '/')
  );
  await writeFile(
    join(cwd, '.maddu', 'lanes', 'catalog.json'),
    JSON.stringify(DEFAULT_LANE_CATALOG, null, 2) + '\n'
  );
  await writeFile(
    join(cwd, '.maddu', 'lanes', 'claims.json'),
    JSON.stringify({ schemaVersion: 1, claims: [] }, null, 2) + '\n'
  );
  // The lane catalog is a one-time seed — once installed, it belongs to the
  // project. `maddu upgrade` does NOT manage it, so we don't list it in the
  // managed manifest. To pull a newer framework default, delete the file and
  // re-run `maddu init --force` (or copy from docs/lanes.md by hand).

  // 4. Write maddu.json.
  const madduJson = {
    framework: 'maddu',
    framework_version: fwVersion,
    installed_at: new Date().toISOString(),
    upgraded_at: null,
    managed
  };
  await writeMadduJson(cwd, madduJson);
  console.log(`  wrote maddu.json (framework_version: ${fwVersion})`);

  // 5. First spine event.
  const eventsSegment = join(cwd, '.maddu', 'events', '000000000001.ndjson');
  const ts = new Date().toISOString();
  const ev = {
    v: 1,
    id: 'evt_' + ts.replace(/[-:T.Z]/g, '').slice(0, 14) + '_init00',
    ts,
    type: 'FRAMEWORK_INSTALLED',
    actor: null,
    lane: null,
    data: { version: fwVersion, files: files.length }
  };
  await writeFile(eventsSegment, JSON.stringify(ev) + '\n');
  console.log(`  spine seeded with FRAMEWORK_INSTALLED event`);

  // 6. .gitignore — append only if our block isn't already present.
  const gitignorePath = join(cwd, '.gitignore');
  let gi = '';
  try { gi = await readFile(gitignorePath, 'utf8'); } catch {}
  if (!gi.includes('Máddu token paths')) {
    await appendFile(gitignorePath, gi.endsWith('\n') || gi.length === 0 ? GITIGNORE_BLOCK : '\n' + GITIGNORE_BLOCK);
    console.log(`  updated .gitignore (token paths only)`);
  }

  // 6a. v0.17 Phase 5 — janitor config + triggers allowlist. Ships
  //     defaults; operator can edit (30min stale, 4hr auto-close) or
  //     remove the trigger from the allowlist to disable.
  const configDir = join(cwd, '.maddu', 'config');
  await mkdir(configDir, { recursive: true });
  const janitorPath = join(configDir, 'janitor.json');
  if (!(await exists(janitorPath))) {
    await writeFile(
      janitorPath,
      JSON.stringify({ staleAfterMs: 1800000, autoCloseAfterMs: 14400000 }, null, 2) + '\n'
    );
  }
  // v1.2.0 Phase 1 — seed trust.json with default freshness thresholds. Idempotent.
  const trustPath = join(configDir, 'trust.json');
  if (!(await exists(trustPath))) {
    await writeFile(
      trustPath,
      JSON.stringify({
        schemaVersion: 1,
        pinnedPackages: [],
        audit: { freshness_warn_days: 30, freshness_block_days: 7 },
      }, null, 2) + '\n'
    );
    console.log(`  trust config seeded (freshness warn=30d, block=7d)`);
  }
  // v1.2.0 Phase 2 — seed worker-env.json with default allow/deny lists. Idempotent.
  const workerEnvPath = join(configDir, 'worker-env.json');
  if (!(await exists(workerEnvPath))) {
    await writeFile(
      workerEnvPath,
      JSON.stringify({
        schemaVersion: 1,
        default_allow: [
          'PATH', 'HOME', 'USER', 'USERPROFILE', 'TEMP', 'TMP',
          'LANG', 'LC_*', 'NODE_*', 'MADDU_*',
          'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR',
          'APPDATA', 'LOCALAPPDATA', 'PROCESSOR_*',
          'TERM', 'SHELL',
          'CLAUDE_*', 'CLAUDECODE', 'CODEX_*', 'GEMINI_*',
          'HOMEDRIVE', 'HOMEPATH', 'PWD', 'OLDPWD', 'COMPUTERNAME',
          'USERDOMAIN', 'USERNAME', 'PUBLIC', 'PROGRAMFILES', 'PROGRAMDATA',
          'PSModulePath', 'COMMONPROGRAMFILES', 'SYSTEMDRIVE', 'OS',
        ],
        default_deny_secrets: [
          'AWS_*', 'OPENAI_*', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN',
          'GITLAB_*', 'AZURE_*', 'GCP_*', 'STRIPE_*',
        ],
        per_lane: {},
      }, null, 2) + '\n'
    );
    console.log(`  worker env allowlist seeded (default-deny secret-keyed vars)`);
  }
  // v1.1.0 Phase 3 — seed governance.json with mode: standard. Idempotent.
  const governancePath = join(configDir, 'governance.json');
  if (!(await exists(governancePath))) {
    await writeFile(
      governancePath,
      JSON.stringify({ mode: 'standard', overrides: {} }, null, 2) + '\n'
    );
    console.log(`  governance tier seeded (mode: standard)`);
  }
  const triggersPath = join(configDir, 'triggers.json');
  // Default rule-#9 auto-trigger allowlist. `slice-stop:skill-candidate`
  // (v1.4.0) auto-detects reusable skill patterns; `slice-stop:trust-audit`
  // (v1.7.0) re-audits deps when the dependency surface changed;
  // `coordinator:pre-run-checkpoint` (v1.7.0) snapshots HEAD before a real
  // coordinator run. Operator opts out of any by removing its entry.
  const DEFAULT_TRIGGERS = ['janitor:sessions', 'slice-stop:skill-candidate', 'slice-stop:trust-audit', 'coordinator:pre-run-checkpoint'];
  if (!(await exists(triggersPath))) {
    await writeFile(
      triggersPath,
      JSON.stringify({ allowed: DEFAULT_TRIGGERS }, null, 2) + '\n'
    );
  } else {
    // Existing file — merge our entries without disturbing operator additions.
    try {
      const text = await readFile(triggersPath, 'utf8');
      const cur = JSON.parse(text);
      const allowed = Array.isArray(cur?.allowed) ? cur.allowed : [];
      let changed = false;
      for (const t of DEFAULT_TRIGGERS) {
        if (!allowed.includes(t)) { allowed.push(t); changed = true; }
      }
      if (changed) await writeFile(triggersPath, JSON.stringify({ ...cur, allowed }, null, 2) + '\n');
    } catch {}
  }
  console.log(`  janitor + trigger allowlist seeded (.maddu/config/)`);

  // 6a-v0.18 — seed the built-in `plan-exec-verify-fix` pipeline. Like
  // janitor.json, operators can edit or delete; init re-seeds only when
  // missing (idempotent across re-runs).
  const pipelinesDir = join(configDir, 'pipelines');
  await mkdir(pipelinesDir, { recursive: true });
  // v1.3.0 — seed the default pipeline catalog. `ship-a-feature` is the
  // DEFAULT shape; `fix-a-bug` + `plan-and-delegate` cover the other two
  // common run shapes. `plan-exec-verify-fix` is kept (back-compat) as an
  // inline fallback below. Each .json source lives under
  // template/maddu/config/pipelines/ so the source repo validates them; we
  // read from there when present, otherwise fall back to inline. Seeding is
  // idempotent per-file (only when missing) so operator edits survive re-runs.
  const PLAN_EXEC_VERIFY_FIX = {
    name: 'plan-exec-verify-fix',
    description: 'End-to-end work shape: plan the change, execute it, verify with doctor + tests, fix what failed.',
    stages: [
      { name: 'plan',   intent: 'Outline the work. Declare goal + phase via `maddu goal`/`maddu phase` if not set. Identify the lane.' },
      { name: 'exec',   intent: 'Claim the lane. Implement the change. Heartbeat at each meaningful step.' },
      { name: 'verify', intent: 'Run `maddu doctor` + the project test suite. Surface any FAIL rows.' },
      { name: 'fix',    intent: 'Address failures. Repeat exec→verify until clean. Slice-stop with summary.' },
    ],
  };
  const DEFAULT_PIPELINES = ['ship-a-feature', 'fix-a-bug', 'plan-and-delegate', 'plan-exec-verify-fix'];
  const pipelineSrcDir = join(TEMPLATE_ROOT, 'maddu', 'config', 'pipelines');
  for (const name of DEFAULT_PIPELINES) {
    const dst = join(pipelinesDir, `${name}.json`);
    if (await exists(dst)) continue;
    let body = null;
    const src = join(pipelineSrcDir, `${name}.json`);
    if (await exists(src)) {
      body = await readFile(src, 'utf8');
      if (!body.endsWith('\n')) body += '\n';
    } else if (name === 'plan-exec-verify-fix') {
      body = JSON.stringify(PLAN_EXEC_VERIFY_FIX, null, 2) + '\n';
    } else {
      continue; // no source and no inline fallback — skip
    }
    await writeFile(dst, body);
    console.log(`  pipeline seeded: ${name}`);
  }

  // 6b. v0.17 agent-native bootstrap — drop MADDU.md + marker-delimited
  //     sections into CLAUDE.md / AGENTS.md at the repo root. The
  //     helper preserves operator content outside the markers and
  //     emits a single AGENT_FILE_SYNCED event with action: 'create' |
  //     'merge' | 'no-change'.
  try {
    const { loadAgentFileTemplates, syncAllAgentFiles, syncSlashCommands } = await import(
      'file://' + join(FRAMEWORK_ROOT, 'commands', '_agent-files.mjs').replace(/\\/g, '/')
    );
    const templates = await loadAgentFileTemplates(FRAMEWORK_ROOT);
    const result = await syncAllAgentFiles(cwd, templates);
    // v0.18 Phase 1 — install .claude/commands/ + .codex/commands/
    // directories (and any framework-shipped slash commands).
    const slashResult = await syncSlashCommands(cwd, FRAMEWORK_ROOT);
    // Append AGENT_FILE_SYNCED to the spine. Single event per init
    // (not per file) — the perFile breakdown rides in data for
    // operators reading the spine directly.
    const ts2 = new Date().toISOString();
    const ev2 = {
      v: 1,
      id: 'evt_' + ts2.replace(/[-:T.Z]/g, '').slice(0, 14) + '_' + randomBytes(3).toString('hex'),
      ts: ts2,
      type: 'AGENT_FILE_SYNCED',
      actor: null,
      lane: null,
      data: { files: result.files, action: result.action, perFile: result.perFile }
    };
    await appendFile(eventsSegment, JSON.stringify(ev2) + '\n');
    const perFileSummary = Object.entries(result.perFile)
      .map(([f, a]) => `${f}:${a}`).join(', ');
    console.log(`  agent files synced (${result.action}) — ${perFileSummary}`);

    // Emit a separate SLASH_COMMANDS_SYNCED event so the install path is
    // observable even when no commands ship yet (Phase 1).
    const ts3 = new Date().toISOString();
    const ev3 = {
      v: 1,
      id: 'evt_' + ts3.replace(/[-:T.Z]/g, '').slice(0, 14) + '_' + randomBytes(3).toString('hex'),
      ts: ts3,
      type: 'SLASH_COMMANDS_SYNCED',
      actor: null,
      lane: null,
      data: {
        action: slashResult.action,
        files: slashResult.files,
        perFile: slashResult.perFile,
        reason: slashResult.reason || null,
      }
    };
    await appendFile(eventsSegment, JSON.stringify(ev3) + '\n');
    const slashSummary = slashResult.files.length
      ? `${slashResult.files.length} command(s)`
      : (slashResult.reason || 'no commands');
    console.log(`  slash commands synced (${slashResult.action}) — ${slashSummary}`);
  } catch (err) {
    console.error(`  (agent-file sync skipped: ${err.message})`);
  }

  // v1.1.0 Phase 8b — seed starter skills into .maddu/skills/. Idempotent.
  try {
    const { readdir, copyFile } = await import('node:fs/promises');
    const starterSrc = join(FRAMEWORK_ROOT, 'template', 'maddu', 'skills', 'starter');
    const targetDir = join(cwd, '.maddu', 'skills');
    await mkdir(targetDir, { recursive: true });
    let entries = [];
    try { entries = await readdir(starterSrc, { withFileTypes: true }); } catch {}
    let seeded = 0;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const dest = join(targetDir, e.name);
      if (!(await exists(dest))) {
        await copyFile(join(starterSrc, e.name), dest);
        seeded += 1;
      }
    }
    if (seeded > 0) console.log(`  starter skills seeded (${seeded} skill${seeded === 1 ? '' : 's'})`);
  } catch (err) {
    console.error(`  (starter skills skipped: ${err.message})`);
  }

  // 7. Project-local CLI shim — the wrapper scripts ride with the template
  //    (maddu/run + maddu/run.cmd) so they're already on disk from step 1.
  //    Only the POSIX execute bit needs setting, since git/npm don't
  //    preserve it through copy.
  await ensureShimExecutable(cwd);

  console.log(`\nMáddu v${fwVersion} installed.`);
  console.log(`\nNext step: open this repo in Claude Code or Codex CLI and type:`);
  console.log(`\n  /maddu-help                # discover the slash-command surface`);
  console.log(`  /maddu-suggest <task>      # "what should I run for X?"`);
  console.log(`  /maddu-autopilot <task>    # end-to-end task pipeline`);
  console.log(`\nThe slash-command surface is the no-learning-curve entry point —`);
  console.log(`no flags to memorize, no command names to recall. Just describe what`);
  console.log(`you want to do.`);
  console.log(`\nPower users / scripts can still use the verbose CLI:`);
  console.log(`  ./maddu/run doctor                          # verify install`);
  console.log(`  ./maddu/run start                           # boot bridge on 127.0.0.1:4177`);
  console.log(`  ./maddu/run session start "first session"   # register + cache active session`);
  console.log(`\nOr install 'maddu' globally:`);
  console.log(`  npm install -g github:frdyx/maddu#v${fwVersion}`);
}
