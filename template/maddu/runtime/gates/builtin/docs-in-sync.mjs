// Docs-in-sync gate — v0.16.2.
//
// In the framework source repo, `docs/*.md` is authored and edited at
// the repo root, while `template/maddu/docs/*.md` is the bundled copy
// that ships to consumers via `maddu init` / `maddu upgrade`
// (frameworkOwnedFiles() in commands/_manifest.mjs walks the template
// tree). The two trees must stay byte-equal — content drift means a
// consumer reads stale docs.
//
// This gate hashes every `.md` file in both directories and fails on
// any pair that differs (after line-ending normalization), plus any
// orphan file present in one tree but not the other.
//
// Consumer installs have no `template/` at repo root; the gate detects
// that and no-ops gracefully so `maddu doctor` stays green for end users.
//
// Severity is `safety` (not `critical`) — drift doesn't break runtime,
// only release discipline. Fail surfaces as WARN in the doctor summary.
//
// Fix: `cp docs/*.md template/maddu/docs/` and re-commit.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function normalize(text) {
  // CRLF → LF so Windows checkouts don't false-flag drift.
  return text.replace(/\r\n/g, '\n');
}

function hashText(text) {
  return createHash('sha256').update(normalize(text)).digest('hex');
}

async function listMarkdown(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
}

// C1 (v1.13.0): optional recorded-divergence allowlist. The two trees default
// to byte-equal, but a doc may legitimately differ (e.g. a root-only contributor
// note). Listing it in docs/doc-sync-exceptions.json — `{ "divergent": {
// "file.md": "why" } }` — makes the divergence a recorded DECISION: the gate
// reports it but does not fail. An UNrecorded divergence still fails, so
// accidental drift can never hide.
async function readExceptions(repoRoot) {
  try {
    const parsed = JSON.parse(await readFile(join(repoRoot, 'docs', 'doc-sync-exceptions.json'), 'utf8'));
    return (parsed && typeof parsed.divergent === 'object' && parsed.divergent) || {};
  } catch { return {}; }
}

export default {
  id: 'docs-in-sync',
  label: 'docs in sync',
  severity: 'safety',
  description: 'Source docs/*.md and template/maddu/docs/*.md are byte-equal (after LF normalization).',
  run: async (ctx) => {
    const sourceDir = join(ctx.repoRoot, 'docs');
    const templateDir = join(ctx.repoRoot, 'template', 'maddu', 'docs');

    // Consumer installs have no `template/` at repo root. Gate only
    // meaningfully runs inside the framework source checkout.
    if (!(await exists(templateDir))) {
      return { ok: true, message: 'not a framework source repo (template/maddu/docs/ absent) — skipped' };
    }
    if (!(await exists(sourceDir))) {
      return {
        ok: false,
        message: 'docs/ missing at repo root — cannot verify sync',
        evidence: { templateDir, sourceDir },
      };
    }

    const sourceFiles = await listMarkdown(sourceDir);
    const templateFiles = await listMarkdown(templateDir);

    const onlyInSource = sourceFiles.filter((f) => !templateFiles.includes(f));
    const onlyInTemplate = templateFiles.filter((f) => !sourceFiles.includes(f));
    const inBoth = sourceFiles.filter((f) => templateFiles.includes(f));

    const drifted = [];
    for (const f of inBoth) {
      const a = await readFile(join(sourceDir, f), 'utf8');
      const b = await readFile(join(templateDir, f), 'utf8');
      if (hashText(a) !== hashText(b)) drifted.push(f);
    }

    // Partition divergence into RECORDED (intentional, allowlisted) vs
    // ACCIDENTAL. Only accidental divergence fails the gate.
    const exceptions = await readExceptions(ctx.repoRoot);
    const allowed = (f) => Object.prototype.hasOwnProperty.call(exceptions, f);
    const recorded = [...new Set([...drifted, ...onlyInSource, ...onlyInTemplate].filter(allowed))];
    const accDrift = drifted.filter((f) => !allowed(f));
    const accOnlySource = onlyInSource.filter((f) => !allowed(f));
    const accOnlyTemplate = onlyInTemplate.filter((f) => !allowed(f));

    if (accDrift.length === 0 && accOnlySource.length === 0 && accOnlyTemplate.length === 0) {
      const note = recorded.length ? ` (${recorded.length} intentionally divergent, recorded in doc-sync-exceptions.json)` : '';
      return { ok: true, message: `${inBoth.length} doc file(s) in sync${note}`, evidence: recorded.length ? { recorded } : undefined };
    }

    const problems = [];
    if (accOnlySource.length) problems.push(`${accOnlySource.length} only in docs/`);
    if (accOnlyTemplate.length) problems.push(`${accOnlyTemplate.length} only in template/maddu/docs/`);
    if (accDrift.length) problems.push(`${accDrift.length} drifted`);

    return {
      ok: false,
      message: `docs out of sync: ${problems.join(', ')} — reconcile (\`cp docs/*.md template/maddu/docs/\`) or record the divergence in docs/doc-sync-exceptions.json`,
      evidence: { onlyInSource: accOnlySource, onlyInTemplate: accOnlyTemplate, drifted: accDrift, recorded },
    };
  },
};
