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

import { mkdir, readFile, writeFile, appendFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';
import { parseFlags } from './_args.mjs';
import {
  exists, frameworkOwnedFiles, copyFromTemplate, sha256OfFile,
  readMadduJson, writeMadduJson, frameworkVersion, FRAMEWORK_ROOT, TEMPLATE_ROOT
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
    '.maddu/harness/project'
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

  // 7. Project-local CLI shims so the user can run `./maddu <cmd>` from the
  //    repo root without a global install. Tiny, byte-stable wrappers that
  //    point at maddu/bin/maddu.mjs — they're not in the managed manifest,
  //    so `maddu upgrade` won't touch them.
  const shimPosix = `#!/usr/bin/env bash\nexec node "$(dirname "$0")/maddu/bin/maddu.mjs" "$@"\n`;
  const shimWin = `@echo off\r\nnode "%~dp0maddu\\bin\\maddu.mjs" %*\r\n`;
  const shimPosixPath = join(cwd, 'maddu');
  const shimWinPath = join(cwd, 'maddu.cmd');
  const shimExists = (await exists(shimPosixPath)) || (await exists(shimWinPath));
  if (!shimExists || force) {
    await writeFile(shimPosixPath, shimPosix);
    if (platform() !== 'win32') {
      try { await chmod(shimPosixPath, 0o755); } catch {}
    }
    await writeFile(shimWinPath, shimWin);
    console.log(`  installed ./maddu + ./maddu.cmd shims (project-local CLI)`);
  }

  console.log(`\nMáddu v${fwVersion} installed.`);
  console.log(`\nNext steps (from this repo):`);
  console.log(`  ./maddu doctor                          # verify install`);
  console.log(`  ./maddu start                           # boot bridge on 127.0.0.1:4177`);
  console.log(`  ./maddu session start "first session"   # register + cache active session`);
  console.log(`\nOr to use 'maddu' as a bare command anywhere:`);
  console.log(`  npm install -g github:frdyx/maddu#v${fwVersion}`);
}
