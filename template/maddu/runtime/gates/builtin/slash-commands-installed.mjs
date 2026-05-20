// Slash-commands-installed gate — v0.18 Phase 1.
//
// Verifies that:
//   1. `.claude/commands/` and `.codex/commands/` directories exist (the
//      install path was exercised by `maddu init` / `maddu upgrade`).
//   2. For every `maddu-*.md` template under `maddu/agent-files/commands/`
//      (consumer layout) or `template/maddu/agent-files/commands/`
//      (source layout), a marker-wrapped copy exists under both
//      `.claude/commands/` and `.codex/commands/`, with the body between
//      <!-- BEGIN MADDU v1 --> / <!-- END MADDU v1 --> markers byte-equal
//      (after LF normalization) to the template body.
//
// Phase 1 ships zero slash-command templates, so this gate trivially
// passes with "no commands shipped yet" — but it still verifies the two
// directories exist, which is the Phase 1 acceptance criterion (empty
// install path works).
//
// Fix on drift: `maddu upgrade` re-runs `syncSlashCommands` and refreshes
// every framework-owned slash command. Operator-authored slash commands
// (any *.md not prefixed `maddu-`) are NOT touched by either Máddu or
// this gate.
//
// In the framework source repo with no .claude/.codex consumer layout
// at the root, the gate no-ops gracefully — same pattern as
// docs-in-sync / agent-file-current.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER_BEGIN = '<!-- BEGIN MADDU v1 -->';
const MARKER_END = '<!-- END MADDU v1 -->';
const TARGET_DIRS = ['.claude/commands', '.codex/commands'];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

function hashText(text) {
  return createHash('sha256').update(normalize(text)).digest('hex');
}

function extractMarkerBlock(text) {
  const t = normalize(text);
  const i = t.indexOf(MARKER_BEGIN);
  const j = t.indexOf(MARKER_END, i + MARKER_BEGIN.length);
  if (i < 0 || j < 0) return null;
  return t.slice(i + MARKER_BEGIN.length, j).trim();
}

async function listTemplates(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name.startsWith('maddu-'))
    .map((e) => e.name)
    .sort();
}

export default {
  id: 'slash-commands-installed',
  label: 'slash commands installed',
  severity: 'safety',
  description: 'maddu-* slash commands are present under .claude/commands/ + .codex/commands/ and match templates.',
  run: async (ctx) => {
    const root = ctx.repoRoot;

    // 1. Verify target directories exist. This is the v0.18 Phase 1
    //    acceptance criterion — install creates both dirs even when no
    //    commands ship yet, so operators (and future phases) can drop
    //    files in.
    const missingDirs = [];
    for (const d of TARGET_DIRS) {
      if (!(await exists(join(root, d)))) missingDirs.push(d);
    }
    if (missingDirs.length === TARGET_DIRS.length) {
      // Both missing — likely a pre-v0.18 install or a framework dev
      // checkout with no consumer scaffolding. Treat as no-op.
      return {
        ok: true,
        message: 'no slash-command dirs — pre-v0.18 install or framework dev checkout (skipped)',
      };
    }
    if (missingDirs.length > 0) {
      return {
        ok: false,
        message: `${missingDirs.length} slash-command dir(s) missing: ${missingDirs.join(', ')} — run \`maddu upgrade\``,
        evidence: { missingDirs },
      };
    }

    // 2. Locate template dir. Consumer layout first, source layout
    //    fallback. If neither is present we can only verify directory
    //    presence (step 1) — already done.
    const consumerBase = join(root, 'maddu', 'agent-files', 'commands');
    const sourceBase = join(root, 'template', 'maddu', 'agent-files', 'commands');
    const base = (await exists(consumerBase)) ? consumerBase
               : (await exists(sourceBase)) ? sourceBase
               : null;
    if (!base) {
      return { ok: true, message: 'slash-command dirs present; no template source (skipped)' };
    }

    const names = await listTemplates(base);
    if (names.length === 0) {
      // Phase 1 case — install path works, nothing to install yet.
      return { ok: true, message: 'slash-command dirs present; no commands shipped yet (Phase 1)' };
    }

    const missing = [];
    const drifted = [];

    for (const name of names) {
      const tplBody = normalize(await readFile(join(base, name), 'utf8')).trim();
      const tplHash = hashText(tplBody);
      for (const dir of TARGET_DIRS) {
        const target = join(root, dir, name);
        if (!(await exists(target))) {
          missing.push(`${dir}/${name}`);
          continue;
        }
        const existing = await readFile(target, 'utf8');
        const block = extractMarkerBlock(existing);
        if (block === null) {
          drifted.push(`${dir}/${name} (no markers)`);
          continue;
        }
        if (hashText(block) !== tplHash) {
          drifted.push(`${dir}/${name}`);
        }
      }
    }

    if (missing.length === 0 && drifted.length === 0) {
      return {
        ok: true,
        message: `${names.length} slash command(s) × 2 surfaces in sync`,
      };
    }

    const problems = [];
    if (missing.length) problems.push(`${missing.length} missing: ${missing.join(', ')}`);
    if (drifted.length) problems.push(`${drifted.length} drifted: ${drifted.join(', ')}`);

    return {
      ok: false,
      message: `slash commands out of sync — ${problems.join('; ')} — run \`maddu upgrade\``,
      evidence: { missing, drifted },
    };
  },
};
