// `maddu wiki <subcommand>` — the wiki's first CLI surface (memory-recall
// track, Phase 1; wiki ops were bridge-only before).
//
// Usage:
//   maddu wiki list                  pages with size + mtime
//   maddu wiki drift                 per-page drift incl. missing-event counts
//   maddu wiki page <name>           print one page (e.g. lane-harness.md)
//   maddu wiki sync                  append-missing-only backfill from the
//                                    spine (idempotent; preserves hand-edits)
//   maddu wiki rebuild --force       destructive truncate-and-replay (drops
//                                    hand-edits; restores strict chronology)
//
// Every subcommand honors --json. Exit codes: 0 ok, 1 refusal, 2 usage error.
//
// `sync` is THE backfill for historical CLI-only slice-stops that never
// reached the wiki. Blocks append in spine order, so a page that already has
// newer blocks becomes interleaved-at-the-end; `rebuild --force` restores
// strict chronology at the cost of operator hand-edits.

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLibOptional } from './_libroot.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m' };

const KNOWN_FLAGS = ['json', 'force'];

export default async function wikiCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { flags, positional } = parseFlags(rest);
  for (const k of Object.keys(flags)) {
    if (!KNOWN_FLAGS.includes(k)) {
      console.error(`maddu wiki: unknown flag --${k} (supported: ${KNOWN_FLAGS.map((f) => `--${f}`).join(', ')})`);
      process.exit(2);
    }
  }
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const wiki = await loadLibOptional('wiki.mjs');
  if (!wiki) { console.error('maddu wiki: this install predates the wiki lib — upgrade first'); process.exit(1); }
  const json = (obj) => { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); };

  if (!sub || sub === 'list') {
    const pages = await wiki.listWiki(repoRoot);
    if (flags.json) return json({ pages });
    console.log(`${ANSI.bold}WIKI  (${pages.length} page${pages.length === 1 ? '' : 's'})${ANSI.reset}`);
    if (!pages.length) console.log('  (no pages yet — slice-stops populate the wiki; `maddu wiki sync` backfills)');
    for (const p of pages) console.log(`  ${p.page.padEnd(28)}  ${ANSI.dim}${p.bytes}B  ${p.mtime}${ANSI.reset}`);
    return;
  }

  if (sub === 'drift') {
    const drift = await wiki.computeDrift(repoRoot);
    if (flags.json) return json({ pages: drift });
    const drifted = drift.filter((d) => d.drifted);
    console.log(`${ANSI.bold}WIKI DRIFT  (${drifted.length} of ${drift.length} page${drift.length === 1 ? '' : 's'} drifted)${ANSI.reset}`);
    for (const d of drift) {
      const mark = d.drifted ? `${ANSI.warn}drifted${ANSI.reset}` : `${ANSI.pass}ok${ANSI.reset}`;
      const missing = d.missingEvents ? `  ${ANSI.fail}${d.missingEvents} missing event(s)${ANSI.reset}` : '';
      console.log(`  ${d.page.padEnd(28)}  ${mark}${d.missing ? ' (page absent)' : ''}${missing}`);
    }
    if (drifted.length) console.log(`${ANSI.dim}Run \`maddu wiki sync\` to backfill missing entries.${ANSI.reset}`);
    return;
  }

  if (sub === 'page') {
    const name = positional[0];
    if (!name) { console.error('Usage: maddu wiki page <name>'); process.exit(2); }
    const text = await wiki.readPage(repoRoot, name);
    if (text === null) { console.error(`maddu wiki page: no page "${name}"`); process.exit(1); }
    if (flags.json) return json({ page: name, text });
    process.stdout.write(text);
    return;
  }

  if (sub === 'sync') {
    if (!wiki.syncWiki) { console.error('maddu wiki sync: this install predates syncWiki — upgrade first'); process.exit(1); }
    // Mutation-witness declared no-op: wiki pages are DERIVED state
    // (rebuildable renderings of spine slice-stops) — sync/rebuild write
    // pages, never spine events, so success is legitimately append-free.
    const mw = await loadLibOptional('mutation-witness.mjs');
    mw?.witnessNoop?.('derived-state-write:wiki-pages');
    const r = await wiki.syncWiki(repoRoot);
    if (flags.json) return json(r);
    console.log(`wiki sync: ${r.appended} block(s) appended, ${r.skipped} already present`);
    if (r.appended > 0) console.log(`${ANSI.dim}Backfilled blocks append in spine order; \`maddu wiki rebuild --force\` restores strict chronology (drops hand-edits).${ANSI.reset}`);
    return;
  }

  if (sub === 'rebuild') {
    if (!flags.force) {
      console.error('maddu wiki rebuild: destructive truncate-and-replay — drops operator hand-edits. Pass --force to proceed (or use `maddu wiki sync` for the non-destructive backfill).');
      process.exit(1);
    }
    // Derived-state write — same declared no-op rationale as sync above.
    const mwr = await loadLibOptional('mutation-witness.mjs');
    mwr?.witnessNoop?.('derived-state-write:wiki-pages');
    const n = await wiki.rebuildWiki(repoRoot);
    if (flags.json) return json({ pagesWritten: n });
    console.log(`wiki rebuild: ${n} page(s) rewritten from the spine`);
    return;
  }

  console.error(`maddu wiki: unknown subcommand "${sub}" (list|drift|page|sync|rebuild)`);
  process.exit(2);
}
