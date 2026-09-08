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
// One predicate, one place. Callers reach it through the resolver that finds
// the lib beside the CODE doing the asking — gates via
// `gate-libroot.loadGateLib(ctx.repoRoot, 'layout.mjs')`, doctor via its own
// CLI-relative `resolveRuntimeLib`. A cwd-relative resolver is wrong here: the
// question is about a repo that need not be the current directory.
//
// The signals are STRUCTURAL and all three are required, so a consumer repo
// that happens to be named "maddu" is not mistaken for the framework:
//   - package.json `name === "maddu"`
//   - a `template/maddu/` DIRECTORY — only the source layout has one
//   - a `commands/` CLI handler DIRECTORY at the root
// Absence of any signal, or an unreadable/invalid package.json, means "not
// the framework source" — the direction that keeps a genuinely broken
// consumer install FAILING rather than skipping.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// isDirectory, not merely exists: a consumer repo that happens to be named
// "maddu" and to have FILES at those two paths would otherwise be classified
// as the framework source, and every gate that skips on this predicate would
// stop checking it.
async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

export async function isFrameworkSourceRepo(repoRoot) {
  try {
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    if (pkg.name !== 'maddu') return false;
  } catch { return false; }
  if (!(await isDir(join(repoRoot, 'template', 'maddu')))) return false;
  if (!(await isDir(join(repoRoot, 'commands')))) return false;
  return true;
}

// The message a gate returns when it declines to check because this is the
// framework source repo. One wording, so the reason is recognisable wherever
// it surfaces (`maddu ci`, `maddu doctor`) and a row can assert it without
// pinning each gate's own prose.
export function sourceLayoutSkip(what) {
  return `framework source repo — ${what} is a consumer-install artifact, so this gate skipped (run it inside an install to check it)`;
}
