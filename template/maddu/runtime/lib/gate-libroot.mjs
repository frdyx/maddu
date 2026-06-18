// Canonical runtime-lib resolver for builtin gates (v1.19.0).
//
// Every gate that reaches into a runtime lib faces the same resolution
// problem: in a consumer install the lib lives at
// `<repoRoot>/maddu/runtime/lib/`, but in the framework's own dev checkout
// it lives beside THIS file (the source `template/maddu/runtime/lib/`).
// Historically each gate reimplemented an identical `exists` + dual-path
// `loadLib(repoRoot)` (governance-mode-coherent, kanban-coherent,
// plan-state-derivable, receipts-coherent). This module is the single
// source of truth for that pattern, mirroring commands/_libroot.mjs on the
// gate side. ZERO framework imports (node stdlib only) so it never risks a
// circular import. gates -> runtime-libs is an allowed architecture edge.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { stat } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));

// Shared stat-wrapper (mirrors commands/_libroot.exists on the gate side).
export async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// Load a runtime-lib module by basename (with or without `.mjs`). Prefers the
// consumer-installed copy under `<repoRoot>/maddu/runtime/lib`; falls back to
// the source sibling next to this file. Returns null when neither exists, so
// gates can degrade to a clean skip.
export async function loadGateLib(repoRoot, name) {
  const file = name.endsWith('.mjs') ? name : `${name}.mjs`;
  const consumer = join(repoRoot, 'maddu', 'runtime', 'lib', file);
  if (await exists(consumer)) return import(pathToFileURL(consumer).href);
  const source = join(HERE, file);
  if (await exists(source)) return import(pathToFileURL(source).href);
  return null;
}
