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
