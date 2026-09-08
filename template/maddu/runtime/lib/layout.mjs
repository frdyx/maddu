// layout.mjs — which shape of repo am I looking at? (v1.135.0)
//
// The framework SOURCE repo is not a consumer install and never was: it IS
// Máddu, so it has no `maddu.json` install marker, no `maddu/` runtime copy,
// and none of the artifacts `maddu init` writes. Several checks have to know
// that, and until now each carried its own private copy of the test —
// commands/doctor.mjs and gates/builtin/project-test-recent.mjs held the same
// three signals, and three gates held no test at all and reported the source
// repo as a broken install (audit 2026-09-07, finding B1).
//
// One predicate, one place. Callers reach it through their normal resolver:
// commands via `_libroot.loadLib('layout.mjs')`, gates via
// `gate-libroot.loadGateLib(ctx.repoRoot, 'layout.mjs')`.
//
// The signals are STRUCTURAL and all three are required, so a consumer repo
// that happens to be named "maddu" is not mistaken for the framework:
//   - package.json `name === "maddu"`
//   - a `template/maddu/` tree — only the source layout has one
//   - a `commands/` CLI handler directory at the root
// Absence of any signal, or an unreadable/invalid package.json, means "not
// the framework source" — the direction that keeps a genuinely broken
// consumer install FAILING rather than skipping.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export async function isFrameworkSourceRepo(repoRoot) {
  try {
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    if (pkg.name !== 'maddu') return false;
  } catch { return false; }
  if (!(await exists(join(repoRoot, 'template', 'maddu')))) return false;
  if (!(await exists(join(repoRoot, 'commands')))) return false;
  return true;
}

// The message a gate returns when it declines to check because this is the
// framework source repo. One wording, so the reason is recognisable wherever
// it surfaces (`maddu ci`, `maddu doctor`) and a row can assert it without
// pinning each gate's own prose.
export function sourceLayoutSkip(what) {
  return `framework source repo — ${what} is a consumer-install artifact, so this gate skipped (run it inside an install to check it)`;
}
