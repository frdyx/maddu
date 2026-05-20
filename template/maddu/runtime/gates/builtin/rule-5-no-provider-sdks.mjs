// Rule #5: no provider SDK imports in framework code.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function walkFiles(dir, predicate) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walkFiles(p, predicate));
    else if (ent.isFile() && predicate(p)) out.push(p);
  }
  return out;
}

const BANNED = [
  /from\s+['"]anthropic['"]/,
  /from\s+['"]@anthropic-ai/,
  /from\s+['"]openai['"]/,
  /from\s+['"]@google\/generative-ai['"]/,
  /require\(['"](anthropic|openai|@anthropic-ai|@google\/generative-ai)['"]/,
];

export default {
  id: 'rule-5-no-provider-sdks',
  label: 'rule #5 no provider SDKs in app code',
  severity: 'critical',
  description: 'No provider SDKs (anthropic / openai / google) imported in framework code.',
  run: async (ctx) => {
    const madduDir = join(ctx.repoRoot, 'maddu');
    const codeFiles = await walkFiles(madduDir, (p) => /\.(m?js|ts|mjs|html|css)$/.test(p));
    const hits = [];
    for (const f of codeFiles) {
      let text;
      try { text = await readFile(f, 'utf8'); } catch { continue; }
      for (const re of BANNED) {
        if (re.test(text)) { hits.push(f.slice(ctx.repoRoot.length + 1)); break; }
      }
    }
    if (hits.length === 0) {
      return { ok: true, message: `scanned ${codeFiles.length} files` };
    }
    return { ok: false, message: hits.join(', '), evidence: { files: hits } };
  },
};
