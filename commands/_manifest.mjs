// Manifest helpers — enumerate framework-owned files, compute provenance hashes,
// and read/write maddu.json.
//
// Framework-owned: everything under template/maddu/ — these get overwritten by
// `maddu upgrade`.
//
// NOT framework-owned (never touched by upgrade):
//   .maddu/events/  .maddu/state/  .maddu/sessions/  .maddu/inbox/
//   .maddu/archive/  .maddu/lanes/catalog.json (a one-time init seed —
//   operator-owned from the moment it exists; Tier 4b)  .maddu/lanes/claims.json
//   .maddu/lanes/project/  .maddu/briefs/project/  .maddu/wiki/project/
//   .maddu/harness/project/

import { readdir, readFile, stat, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FRAMEWORK_ROOT = join(__dirname, '..');
export const TEMPLATE_ROOT = join(FRAMEWORK_ROOT, 'template');
export const TEMPLATE_MADDU = join(TEMPLATE_ROOT, 'maddu');

// Layout detection (v0.17.1).
//
// Two valid framework layouts ship with this codebase:
//
//   source — a clone of frdyx/maddu or the npm-extracted package. Has
//            `template/maddu/{runtime,cockpit,docs,agent-files,...}/` as
//            the install source. This is the only layout that can scaffold
//            new consumer repos.
//
//   installed — a consumer's `<repo>/maddu/` directory, produced by
//               `maddu init`. The `template/maddu/` prefix has been
//               flattened on the way in (so `runtime/`, `cockpit/`, etc.
//               live directly under `maddu/`). The bridge requires this
//               flat layout to find files; it CANNOT be used to scaffold
//               other repos.
//
// `frameworkOwnedFiles`, init, and upgrade ALL require
// the `source` layout. Calling any of them via a consumer's bundled
// `./maddu/run` would semantically mean "copy the install onto itself" —
// meaningless and historically silently broken (init would crash mid-way;
// upgrade would no-op every file). v0.17.1 refuses these calls early with
// a clear actionable error.
export async function detectFrameworkLayout() {
  if (await exists(TEMPLATE_MADDU)) return 'source';
  if (await exists(join(FRAMEWORK_ROOT, 'runtime'))) return 'installed';
  return 'unknown';
}

// Used by init.mjs and upgrade.mjs to refuse running from the wrong layout.
// Returns null when ok; returns an error message (operator-friendly) when not.
export async function requireSourceLayout(commandName) {
  const layout = await detectFrameworkLayout();
  if (layout === 'source') return null;
  if (layout === 'installed') {
    return [
      `maddu ${commandName}: refused — this is a consumer install's CLI, not a framework source.`,
      `Run from a framework source instead:`,
      `  npx github:frdyx/maddu ${commandName}`,
      ``,
      `The consumer's own CLI is for operating on THIS install (doctor, brief, start, status, register, …).`,
    ].join('\n');
  }
  return [
    `maddu ${commandName}: refused.`,
    ``,
    `Unable to detect framework layout. Neither \`${TEMPLATE_MADDU}\` (source layout)`,
    `nor \`${join(FRAMEWORK_ROOT, 'runtime')}\` (installed layout) exists relative to`,
    `the CLI's framework root. This usually means the framework checkout is`,
    `broken or partially extracted.`,
    ``,
    `Expected one of:`,
    `  - source layout: ${TEMPLATE_MADDU} present (clone of frdyx/maddu)`,
    `  - installed layout: ${join(FRAMEWORK_ROOT, 'runtime')} present (consumer install)`,
  ].join('\n');
}

export async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

export async function writeJson(p, obj) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(obj, null, 2) + '\n');
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walk(p);
    } else if (ent.isFile()) {
      yield p;
    }
  }
}

// Returns the list of framework-owned file paths relative to the target repo.
// Each entry is { relPath, absSource } — relPath is where the file will live in
// the target repo (with forward slashes for cross-platform manifest stability),
// absSource is the absolute path to read from on this framework checkout.
//
// Three roots get mirrored into the target's maddu/ directory:
//   template/maddu/**  →  maddu/**          (runtime + cockpit)
//   bin/**             →  maddu/bin/**      (CLI entry; lets ./maddu shim work)
//   commands/**        →  maddu/commands/** (CLI subcommand handlers)
// Plus version.json so the installed CLI can self-report.
export async function frameworkOwnedFiles() {
  const out = [];
  if (await exists(TEMPLATE_MADDU)) {
    for await (const abs of walk(TEMPLATE_MADDU)) {
      const rel = relative(TEMPLATE_ROOT, abs).split(sep).join('/');
      out.push({ relPath: rel, absSource: abs });
    }
  }
  const BIN_DIR = join(FRAMEWORK_ROOT, 'bin');
  if (await exists(BIN_DIR)) {
    for await (const abs of walk(BIN_DIR)) {
      const rel = 'maddu/bin/' + relative(BIN_DIR, abs).split(sep).join('/');
      out.push({ relPath: rel, absSource: abs });
    }
  }
  const COMMANDS_DIR = join(FRAMEWORK_ROOT, 'commands');
  if (await exists(COMMANDS_DIR)) {
    for await (const abs of walk(COMMANDS_DIR)) {
      const rel = 'maddu/commands/' + relative(COMMANDS_DIR, abs).split(sep).join('/');
      out.push({ relPath: rel, absSource: abs });
    }
  }
  const versionJson = join(FRAMEWORK_ROOT, 'version.json');
  if (await exists(versionJson)) {
    out.push({ relPath: 'maddu/version.json', absSource: versionJson });
  }
  return out;
}

// Integrity hash. EOL-NORMALIZED for text files: a CRLF working-tree copy
// (Windows `core.autocrlf=true` rewrites every framework file to CRLF on
// checkout) hashes EQUAL to its LF source, so it isn't misread as "locally
// modified" — otherwise upgrade/doctor flag all ~300 framework files and skip
// them. Binary files (any NUL byte, git's own heuristic) are hashed raw. The
// `latin1` round-trip is byte-exact (lossless 1:1 byte↔codepoint), so this only
// collapses CRLF→LF and never perturbs other bytes. Framework source is LF, so
// normalized == raw for it: existing manifests stay valid, no format change.
export async function sha256OfFile(p) {
  const buf = await readFile(p);
  const bytes = buf.includes(0) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(bytes).digest('hex');
}

// Read maddu.json from a target repo. Returns null if the file doesn't exist.
export async function readMadduJson(repoRoot) {
  const p = join(repoRoot, 'maddu.json');
  if (!(await exists(p))) return null;
  return await readJson(p);
}

export async function writeMadduJson(repoRoot, obj) {
  await writeJson(join(repoRoot, 'maddu.json'), obj);
}

// Read framework's own version.json.
export async function frameworkVersion() {
  const v = await readJson(join(FRAMEWORK_ROOT, 'version.json'));
  return v.version;
}

// Make the project-local CLI shim (maddu/run) executable on POSIX. The
// shim file itself is part of the managed template tree (it ships in
// every install + upgrade via the manifest), so this only handles the
// one thing the manifest copy can't carry: the POSIX execute bit.
// No-op on Windows.
export async function ensureShimExecutable(repoRoot) {
  if (platform() === 'win32') return;
  const shimPath = join(repoRoot, 'maddu', 'run');
  try { await chmod(shimPath, 0o755); } catch {}
}

// Copy a single file into the target repo, creating intermediate directories.
// Accepts either a string (legacy: path relative to template/) or a manifest
// entry { relPath, absSource } so callers can copy from bin/, commands/, or
// any other framework root without re-deriving the source path.
// Returns the destination absolute path.
export async function copyFromTemplate(repoRoot, entry) {
  let relPath, src;
  if (typeof entry === 'string') {
    relPath = entry;
    src = join(TEMPLATE_ROOT, entry);
  } else {
    relPath = entry.relPath;
    src = entry.absSource || join(TEMPLATE_ROOT, relPath);
  }
  const dst = join(repoRoot, relPath);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  return dst;
}
