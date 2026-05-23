// v1.1.0 Phase 1 — shared tool runner loader. Mirrors _spine.mjs resolution.

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

export async function loadTools() {
  const dir = await libDir();
  return await import(pathToFileURL(join(dir, 'tools.mjs')).href);
}
