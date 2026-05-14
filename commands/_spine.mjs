// Helper for CLI commands that need the spine library. Walks up from cwd to
// find .maddu/, falls back to the framework's template/ in dev mode, and
// imports the library via file:// URLs (Windows-safe).

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frameworkRoot = resolve(__dirname, '..');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function libDir() {
  const installed = join(process.cwd(), 'maddu', 'runtime', 'lib');
  if (await exists(installed)) return installed;
  const dev = join(frameworkRoot, 'template', 'maddu', 'runtime', 'lib');
  if (await exists(dev)) return dev;
  throw new Error('maddu runtime not found. Run `maddu init` first.');
}

export async function loadSpineLib() {
  const dir = await libDir();
  const paths = await import(pathToFileURL(join(dir, 'paths.mjs')).href);
  const spine = await import(pathToFileURL(join(dir, 'spine.mjs')).href);
  const projections = await import(pathToFileURL(join(dir, 'projections.mjs')).href);
  const hindsight = await import(pathToFileURL(join(dir, 'hindsight.mjs')).href);
  const mailbox = await import(pathToFileURL(join(dir, 'mailbox.mjs')).href);
  const skills = await import(pathToFileURL(join(dir, 'skills.mjs')).href);
  const search = await import(pathToFileURL(join(dir, 'search.mjs')).href);
  const runtimes = await import(pathToFileURL(join(dir, 'runtimes.mjs')).href);
  const mcp = await import(pathToFileURL(join(dir, 'mcp.mjs')).href);
  return { paths, spine, projections, hindsight, mailbox, skills, search, runtimes, mcp };
}

export async function resolveRepoRoot(paths) {
  const found = await paths.findRepoRoot(process.cwd());
  if (found) return found;
  // Dev fallback: framework's template/ acts as the .maddu/ host.
  return join(frameworkRoot, 'template');
}
