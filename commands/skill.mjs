// `maddu skill <subcommand>` — list / show / create / from-slice / apply / delete.
//
// Usage:
//   maddu skill list   [--tag <name>]
//   maddu skill show   <id>
//   maddu skill create --title "…" [--when "…"] [--tags a,b] [--body "…"]
//   maddu skill from-slice <eventId> [--title "…"] [--when "…"]
//   maddu skill apply  <id> [--session <sid>]
//   maddu skill delete <id>

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', accent: '\x1b[35m' };

function csv(s) { if (!s || s === true) return []; return String(s).split(',').map((x) => x.trim()).filter(Boolean); }
function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function skill(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, skills } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu skill <list|show|create|from-slice|apply|delete> [flags]');
    process.exit(2);
  }

  if (sub === 'list') {
    const { flags } = parseFlags(rest);
    let all = await skills.listSkills(repoRoot);
    if (flags.tag) all = all.filter((s) => s.tags.includes(flags.tag));
    console.log(`${ANSI.bold}SKILLS  (${all.length})${ANSI.reset}`);
    if (all.length === 0) { console.log('  (none — try `maddu skill create` or `maddu skill from-slice <eventId>`)'); return; }
    for (const s of all) {
      console.log(`  ${ANSI.accent}${s.id}${ANSI.reset}  ${ANSI.bold}${s.title}${ANSI.reset}`);
      if (s.when) console.log(`    ${ANSI.dim}when:${ANSI.reset} ${s.when}`);
      if (s.tags.length) console.log(`    ${ANSI.dim}tags:${ANSI.reset} ${s.tags.join(', ')}`);
      if (s.provenance.length) console.log(`    ${ANSI.dim}provenance: ${s.provenance.length} source(s)${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu skill show <id>'); process.exit(2); }
    const s = await skills.readSkill(repoRoot, id);
    if (!s) { console.error(`skill ${id} not found`); process.exit(3); }
    console.log(`${ANSI.bold}${s.title}${ANSI.reset}  ${ANSI.dim}${s.id}${ANSI.reset}`);
    if (s.when) console.log(`${ANSI.dim}when:${ANSI.reset}  ${s.when}`);
    if (Array.isArray(s.tags) && s.tags.length) console.log(`${ANSI.dim}tags:${ANSI.reset}  ${s.tags.join(', ')}`);
    if (Array.isArray(s.provenance) && s.provenance.length) {
      console.log(`${ANSI.dim}provenance:${ANSI.reset}`);
      for (const p of s.provenance) console.log(`  ↩ ${p.event}  ${ANSI.dim}${fmt(p.ts)}${ANSI.reset}  ${p.slice || ''}`);
    }
    console.log(`${ANSI.dim}created:${ANSI.reset} ${fmt(s.created)}   ${ANSI.dim}updated:${ANSI.reset} ${fmt(s.updated)}`);
    console.log('');
    console.log(s.body);
    return;
  }

  if (sub === 'create') {
    const { flags } = parseFlags(rest);
    const title = requireFlag(flags, 'title');
    const saved = await skills.saveSkill(repoRoot, {
      title,
      when: flags.when || '',
      tags: csv(flags.tags),
      body: flags.body || `# ${title}\n\n`,
      by: flags.by || null
    });
    console.log(`${ANSI.pass}created${ANSI.reset}  ${saved.id}  ${saved.title}`);
    return;
  }

  if (sub === 'from-slice') {
    const eventId = rest[0];
    if (!eventId) { console.error('usage: maddu skill from-slice <eventId>'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    const all = await spine.readAll(repoRoot);
    const ev = all.find((e) => e.id === eventId);
    if (!ev) { console.error(`event ${eventId} not found`); process.exit(3); }
    if (ev.type !== 'SLICE_STOP') { console.error(`event ${eventId} is not a SLICE_STOP (got ${ev.type})`); process.exit(4); }
    const draft = skills.draftFromSliceStop(ev);
    const saved = await skills.saveSkill(repoRoot, {
      title: flags.title || draft.title,
      when: flags.when || draft.when,
      tags: csv(flags.tags).length ? csv(flags.tags) : draft.tags,
      provenance: draft.provenance,
      body: draft.body,
      by: flags.by || null
    });
    console.log(`${ANSI.pass}distilled${ANSI.reset}  ${saved.id}  ${saved.title}`);
    console.log(`  from ${ev.id}`);
    return;
  }

  if (sub === 'apply') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu skill apply <id> [--session <sid>]'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    const s = await skills.applySkill(repoRoot, id, flags.by || null, flags.session || null);
    console.log(`${ANSI.pass}applied${ANSI.reset}  ${id}  ${s.title}`);
    return;
  }

  if (sub === 'delete') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu skill delete <id>'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    await skills.deleteSkill(repoRoot, id, flags.by || null);
    console.log(`${ANSI.warn}deleted${ANSI.reset}  ${id}`);
    return;
  }

  console.error(`maddu skill: unknown subcommand "${sub}"`);
  process.exit(2);
}
