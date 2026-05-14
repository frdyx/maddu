// Manifest helpers — enumerate framework-owned files, compute provenance hashes,
// and read/write maddu.json.
//
// Framework-owned: everything under template/maddu/ — these get overwritten by
// `maddu upgrade`. Plus the seed file .maddu/lanes/catalog.json.
//
// NOT framework-owned (never touched by upgrade):
//   .maddu/events/  .maddu/state/  .maddu/sessions/  .maddu/inbox/
//   .maddu/archive/  .maddu/lanes/claims.json  .maddu/lanes/project/
//   .maddu/briefs/project/  .maddu/wiki/project/  .maddu/harness/project/

import { readdir, readFile, stat, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FRAMEWORK_ROOT = join(__dirname, '..');
export const TEMPLATE_ROOT = join(FRAMEWORK_ROOT, 'template');
export const TEMPLATE_MADDU = join(TEMPLATE_ROOT, 'maddu');

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
// Mirrors template/ → target structure. Always uses forward slashes for the
// manifest keys (cross-platform stability).
export async function frameworkOwnedFiles() {
  const out = [];
  if (!(await exists(TEMPLATE_MADDU))) return out;
  for await (const abs of walk(TEMPLATE_MADDU)) {
    const rel = relative(TEMPLATE_ROOT, abs).split(sep).join('/');
    out.push({ relPath: rel, absSource: abs });
  }
  return out;
}

export async function sha256OfFile(p) {
  const buf = await readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

export async function sha256OfBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Hash every framework-owned file in the framework repo. Returns
// { 'maddu/runtime/server.js': 'sha256-…', … }.
export async function buildSourceManifest() {
  const files = await frameworkOwnedFiles();
  const manifest = {};
  for (const { relPath, absSource } of files) {
    manifest[relPath] = await sha256OfFile(absSource);
  }
  return manifest;
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

// Copy a single file from template/ into the target repo, creating intermediate
// directories. Returns the destination absolute path.
export async function copyFromTemplate(repoRoot, relPath) {
  const src = join(TEMPLATE_ROOT, relPath);
  const dst = join(repoRoot, relPath);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  return dst;
}
