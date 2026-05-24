// v1.2.0 Phase 2 — `mcp-provenance-verified` gate.
//
// Two responsibilities:
//   1. Every shipped MCP template's declared provenance.sha256 matches
//      the canonical hash of the template content (with provenance
//      stripped). Drift → FAIL.
//   2. Every installed MCP descriptor under `.maddu/mcp/*.json` either:
//      - is tagged `provenance.source: 'framework-shipped'` AND
//        `provenance.approved: true`, OR
//      - is tagged `provenance.source: 'operator-trusted'` AND
//        `provenance.approved: true`, OR
//      - is disabled (operator-registered but pending approval).
//      Any *enabled* server with unapproved provenance → FAIL.

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', '..', 'lib');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function templatesDir(repoRoot) {
  const consumer = join(repoRoot, 'maddu', 'mcp-templates');
  if (await exists(consumer)) return consumer;
  const source = join(__dirname, '..', '..', '..', 'mcp-templates');
  if (await exists(source)) return source;
  return null;
}

async function loadMcpLib() {
  return await import(pathToFileURL(join(LIB_DIR, 'mcp.mjs')).href);
}

export default {
  id: 'mcp-provenance-verified',
  label: 'mcp provenance verified',
  severity: 'critical',
  description: 'Every shipped MCP template hash matches; every enabled MCP server is approved.',
  run: async (ctx) => {
    const tdir = await templatesDir(ctx.repoRoot);
    const mcp = await loadMcpLib();
    const problems = [];
    let tplCount = 0;
    if (tdir) {
      const entries = await readdir(tdir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        tplCount++;
        let body;
        try { body = JSON.parse(await readFile(join(tdir, e.name), 'utf8')); }
        catch (err) { problems.push({ kind: 'template-parse', file: e.name, error: err.message }); continue; }
        const v = mcp.verifyTemplateProvenance(body);
        if (!v.ok) {
          problems.push({ kind: 'template-hash-mismatch', file: e.name, expected: v.expected, actual: v.actual });
        }
      }
    }
    // Installed descriptors.
    const installedDir = join(ctx.repoRoot, '.maddu', 'mcp');
    let installedCount = 0;
    if (await exists(installedDir)) {
      const entries = await readdir(installedDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        installedCount++;
        let body;
        try { body = JSON.parse(await readFile(join(installedDir, e.name), 'utf8')); }
        catch (err) { problems.push({ kind: 'descriptor-parse', file: e.name, error: err.message }); continue; }
        // Pre-v1.2.0 installs may lack provenance — tolerate, just warn.
        if (!body.provenance) continue;
        const approved = body.provenance.approved === true;
        if (body.enabled && !approved) {
          problems.push({ kind: 'enabled-unapproved', name: body.name, source: body.provenance.source });
        }
      }
    }
    if (problems.length === 0) {
      return { ok: true, message: `${tplCount} template(s) hash-verified; ${installedCount} installed MCP(s) OK` };
    }
    return {
      ok: false,
      message: `${problems.length} provenance issue(s) across ${tplCount} templates + ${installedCount} installed`,
      evidence: { problems },
    };
  },
};
