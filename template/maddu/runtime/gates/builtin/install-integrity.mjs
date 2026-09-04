// Install integrity: framework-managed files present and hash-matched.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// EOL-normalized integrity hash — must match commands/_manifest.mjs#sha256OfFile.
// A CRLF working-tree copy (Windows autocrlf) hashes equal to its LF source, so
// framework files aren't misflagged as modified; binary files (any NUL byte)
// are hashed raw. The latin1 round-trip is byte-exact, collapsing only CRLF→LF.
async function sha256OfFile(p) {
  const buf = await readFile(p);
  const bytes = buf.includes(0) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(bytes).digest('hex');
}

async function readMadduJson(repoRoot) {
  try { return JSON.parse(await readFile(join(repoRoot, 'maddu.json'), 'utf8')); }
  catch { return null; }
}

// `maddu upgrade` writes this before it touches a file and deletes it once the
// manifest is written, so its presence means an apply began and did not finish.
// Device-local under .maddu/state/ (gitignored) rather than in maddu.json,
// which is tracked — one machine's crashed upgrade must not be committed and
// then fail this gate for every teammate whose install is fine.
async function readUpgradeMarker(repoRoot) {
  try {
    const m = JSON.parse(await readFile(join(repoRoot, '.maddu', 'state', 'upgrade-in-progress.json'), 'utf8'));
    return m && Array.isArray(m.paths) ? m : null;
  } catch { return null; }
}

export default {
  id: 'install-integrity',
  label: 'install integrity',
  severity: 'critical',
  description: 'Every framework-managed file present and hash-matched.',
  run: async (ctx) => {
    const madduJson = await readMadduJson(ctx.repoRoot);
    if (!madduJson) {
      return { ok: false, message: `maddu.json missing at ${ctx.repoRoot}`, evidence: null };
    }
    // An upgrade records its intent before it touches a file and clears it only
    // once the manifest is written, so this marker standing means the apply loop
    // did not finish. That state is invisible to everything below: the manifest
    // is written LAST, so a crashed upgrade leaves files on disk that `managed`
    // never listed, and a path absent from `managed` cannot be reported missing.
    // Inferring it instead of reading it does not work — comparing the recorded
    // framework_version against the installed maddu/version.json fails because
    // version.json is itself managed, so after a crash the two still agree; and
    // comparing hashes only catches an interruption that got as far as the
    // update phase, which adds-before-updates deliberately makes the rarer case.
    const u = await readUpgradeMarker(ctx.repoRoot);
    if (u) {
      return {
        ok: false,
        // Plain `maddu upgrade`, NOT --force. The re-run recomputes its plan
        // from the manifest as it stands, which is exactly right, and finishes
        // what was interrupted. --force would also overwrite the operator's own
        // local edits, which this state gives no reason to touch.
        message: `an upgrade to v${u.version} did not finish (started ${u.at}) — this install is half-applied; re-run \`maddu upgrade\` to complete it (no --force needed; --force would also overwrite local edits)`,
        evidence: { upgrade_in_progress: u },
      };
    }
    const managed = madduJson.managed || {};
    const missing = [], modified = [];
    for (const [rel, meta] of Object.entries(managed)) {
      const abs = join(ctx.repoRoot, rel);
      if (!(await exists(abs))) { missing.push(rel); continue; }
      const h = await sha256OfFile(abs);
      if (h !== meta.sha256) modified.push(rel);
    }
    const total = Object.keys(managed).length;
    if (missing.length === 0 && modified.length === 0) {
      return { ok: true, message: `${total} managed files present, hashes match` };
    }
    if (missing.length) {
      return {
        ok: false,
        message: `missing: ${missing.join(', ')}`,
        evidence: { missing, modified, total },
      };
    }
    // modified-only: doctor's prior behavior was WARN, not FAIL. Surface
    // explicit status='warn' so the gate runner records a warn (preserving
    // hard-rule semantics: the rule isn't violated, but operator should know).
    return {
      ok: true,
      status: 'warn',
      message: `locally modified: ${modified.join(', ')}`,
      evidence: { missing, modified, total },
    };
  },
};
