// deliverables (v1.17.0) — declared-deliverable verification.
//
// A slice-stop (the same ritual a spawned/sub-worker runs on its way out)
// declares the files it produced via `--targets`. The D2 git cross-check
// already catches the inverse — files changed but NOT declared. This catches
// the hollow claim: a target the agent *named* that has no evidence of
// existing. An agent that reports writing `src/foo.ts` when no such file is on
// disk (and git never saw it) produced a phantom deliverable; surfacing that
// is the point. Kept files-only and WARN-only — it records and reports, it
// never blocks the stop.
//
// A target counts as verified if it exists on disk OR appears in git's changed
// set (so a legitimately deleted/renamed file isn't a false positive).

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function norm(p) {
  return String(p || '').replace(/\\/g, '/').trim();
}

export async function verifyDeliverables({ repoRoot, targets = [], gitTouched = null } = {}) {
  const declared = [...new Set((targets || []).map(norm).filter(Boolean))];
  if (declared.length === 0) return { declared: 0, verified: 0, missing: [] };

  const touched = gitTouched ? new Set(gitTouched.map(norm)) : null;
  const missing = [];
  let verified = 0;
  for (const t of declared) {
    if (await pathExists(join(repoRoot, t))) { verified++; continue; }
    if (touched && touched.has(t)) { verified++; continue; } // deleted/renamed — real
    missing.push(t);
  }
  return { declared: declared.length, verified, missing };
}
