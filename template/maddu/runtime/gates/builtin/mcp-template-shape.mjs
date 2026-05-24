// v1.1.0 Phase 2 — validate the shape of every shipped MCP template
// descriptor. Templates that don't compile (or that violate hard-rule
// posture — e.g. require a `package.json` dep) fail this gate.

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function templatesDir(repoRoot) {
  // Source layout: <framework>/template/maddu/mcp-templates/
  // Consumer layout: <repoRoot>/maddu/mcp-templates/
  const consumer = join(repoRoot, 'maddu', 'mcp-templates');
  if (await exists(consumer)) return consumer;
  const source = join(__dirname, '..', '..', '..', 'mcp-templates');
  if (await exists(source)) return source;
  return null;
}

const VALID_TRANSPORTS = new Set(['stdio', 'sse', 'http']);

function validate(t) {
  const errs = [];
  if (typeof t.template !== 'string' || !t.template) errs.push('missing string field: template');
  if (typeof t.displayName !== 'string' || !t.displayName) errs.push('missing string field: displayName');
  if (typeof t.summary !== 'string' || !t.summary) errs.push('missing string field: summary');
  // v1.2.0 Phase 2 — provenance is required on every shipped template.
  if (!t.provenance || typeof t.provenance !== 'object') errs.push('missing provenance block (v1.2.0)');
  else if (typeof t.provenance.sha256 !== 'string' || t.provenance.sha256.length !== 64) {
    errs.push('provenance.sha256 must be a 64-char hex string');
  }
  if (!VALID_TRANSPORTS.has(t.transport)) errs.push(`invalid transport: ${t.transport}`);
  if (t.transport === 'stdio') {
    if (!t.stdio || typeof t.stdio.command !== 'string' || !t.stdio.command) errs.push('stdio.command required');
    if (!Array.isArray(t.stdio?.args)) errs.push('stdio.args must be array');
  } else if (t.transport === 'sse' || t.transport === 'http') {
    if (!t[t.transport] || typeof t[t.transport].url !== 'string') errs.push(`${t.transport}.url required`);
  }
  if (!Array.isArray(t.requires)) errs.push('requires must be array (may be empty)');
  // Hard-rule scan: refuse templates that suggest framework deps.
  const raw = JSON.stringify(t);
  if (/package\.json/i.test(raw) && !/no.*package\.json/i.test(raw)) {
    errs.push('hard-rule violation: descriptor mentions package.json without a "no…" negation');
  }
  return errs;
}

export default {
  id: 'mcp-template-shape',
  label: 'mcp templates well-formed',
  severity: 'safety',
  description: 'Every shipped MCP template descriptor parses, declares transport + requires, and stays rule-#4-compliant.',
  run: async (ctx) => {
    const dir = await templatesDir(ctx.repoRoot);
    if (!dir) return { ok: true, message: 'no mcp-templates dir resolved (skipped — pre-v1.1.0 install)' };
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
    if (files.length === 0) {
      return { ok: false, message: 'mcp-templates dir empty', evidence: { dir } };
    }
    const problems = [];
    for (const f of files) {
      let body;
      try { body = JSON.parse(await readFile(join(dir, f.name), 'utf8')); }
      catch (err) { problems.push({ file: f.name, error: `parse: ${err.message}` }); continue; }
      const errs = validate(body);
      if (errs.length) problems.push({ file: f.name, errors: errs });
    }
    if (problems.length === 0) {
      return { ok: true, message: `${files.length} MCP template(s) shipped, all well-formed` };
    }
    return {
      ok: false,
      message: `${problems.length}/${files.length} template(s) malformed`,
      evidence: { problems },
    };
  },
};
