// `maddu search <query>` — cross-corpus search over the spine.
//
// Usage:
//   maddu search <query> [--kinds event,slice,memory,skill,mailbox,inbox] [--limit N]

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', info: '\x1b[36m', accent: '\x1b[35m' };

function colorFor(kind) {
  return {
    event: ANSI.info,
    slice: ANSI.bold,
    memory: ANSI.accent,
    skill: ANSI.pass,
    mailbox: ANSI.warn,
    inbox: ANSI.dim
  }[kind] || '';
}

function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function searchCmd(argv) {
  const { flags, positional } = parseFlags(argv);
  const query = positional.join(' ');
  if (!query) {
    console.error('Usage: maddu search <query> [--kinds e,m,…] [--limit N]');
    process.exit(2);
  }
  const { paths, search } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const kinds = flags.kinds ? String(flags.kinds).split(',').map((x) => x.trim()).filter(Boolean) : null;
  const limit = parseInt(flags.limit, 10);
  const out = await search.search(repoRoot, query, {
    kinds,
    limit: Number.isFinite(limit) ? limit : 50
  });
  console.log(`${ANSI.bold}SEARCH "${query}"  (${out.count} match${out.count === 1 ? '' : 'es'})${ANSI.reset}`);
  if (out.count === 0) { console.log('  (no matches)'); return; }
  for (const r of out.results) {
    const c = colorFor(r.kind);
    console.log(`  ${c}${r.kind.padEnd(7)}${ANSI.reset}  ${ANSI.dim}${fmt(r.ts)}${ANSI.reset}  ${r.title || r.id}`);
    if (r.snippet && r.snippet !== r.title) {
      console.log(`           ${ANSI.dim}${r.snippet}${ANSI.reset}`);
    }
    const meta = [];
    if (r.lane) meta.push(`lane:${r.lane}`);
    if (r.actor) meta.push(`actor:${r.actor.length > 24 ? r.actor.slice(0, 24) + '…' : r.actor}`);
    if (r.sourceEvent) meta.push(`src:${r.sourceEvent}`);
    if (r.id && r.kind !== 'event') meta.push(`id:${r.id}`);
    if (meta.length) console.log(`           ${ANSI.dim}${meta.join('  ·  ')}${ANSI.reset}`);
  }
}
