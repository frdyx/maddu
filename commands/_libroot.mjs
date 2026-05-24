// Canonical runtime-lib resolver for CLI command handlers (v1.3.0).
//
// Every command that needs a module from the runtime library faces the
// same resolution problem: in a consumer install the lib lives at
// `<cwd>/maddu/runtime/lib/`, but in the framework's own dev checkout it
// lives at `<frameworkRoot>/template/maddu/runtime/lib/`. Historically
// this cwd-installed → dev-template fallback (+ pathToFileURL import for
// Windows drive-letter safety) was reimplemented in _spine.mjs,
// _tools.mjs, bridges.mjs, _strict-approval.mjs, loop.mjs, coordinator.mjs,
// global.mjs, start.mjs, trust.mjs and workspace.mjs.
//
// This module is the single source of truth. It has ZERO framework
// imports (only node stdlib) so it can be imported by low-level helpers
// like _spine.mjs without risking a circular import.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
// commands/ sits at the framework root in dev, and at maddu/commands/ in
// an install. Either way `..` is the directory that holds either
// `template/maddu/runtime/lib` (dev) or `runtime/lib` (install).
const FRAMEWORK_ROOT = resolve(__dirname, '..');

// Shared stat-wrapper. Historically redefined ~17× across commands/ and
// runtime/lib/; this is the canonical copy for command handlers.
export async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// Resolve the runtime-lib directory. Prefers the consumer-installed copy
// under the current working directory; falls back to the framework's
// bundled template/ for dev runs. Throws a clear, actionable error if
// neither exists.
export async function resolveLibDir() {
  const installed = join(process.cwd(), 'maddu', 'runtime', 'lib');
  if (await exists(installed)) return installed;
  const dev = join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib');
  if (await exists(dev)) return dev;
  throw new Error('maddu runtime not found. Run `maddu init` first.');
}

async function resolveLibFile(file) {
  const installed = join(process.cwd(), 'maddu', 'runtime', 'lib', file);
  if (await exists(installed)) return installed;
  const dev = join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib', file);
  if (await exists(dev)) return dev;
  const err = new Error(`${file} not found. Run \`maddu init\` (or \`maddu upgrade\`) first.`);
  err.code = 'MADDU_LIB_NOT_FOUND';
  throw err;
}

// Import a single runtime-lib module by basename (with or without the
// `.mjs` suffix). Returns the module namespace.
export async function loadLib(name) {
  const file = name.endsWith('.mjs') ? name : `${name}.mjs`;
  return import(pathToFileURL(await resolveLibFile(file)).href);
}

// Optional-load variant: returns null instead of throwing when the
// module is absent (used for modules that landed in later versions and
// may be missing from an older consumer install).
export async function loadLibOptional(name) {
  try { return await loadLib(name); }
  catch (err) {
    if (err && err.code === 'MADDU_LIB_NOT_FOUND') return null;
    throw err;
  }
}

// The framework root (the directory that holds template/ in dev, or the
// install root). Exposed for the few callers that resolve non-lib paths
// (e.g. start.mjs locating server.js).
export { FRAMEWORK_ROOT };
