// `maddu skill <subcommand>` — list / show / create / add / from-slice / apply / delete.
//
// Usage:
//   maddu skill list   [--tag <name>]
//   maddu skill show   <id>
//   maddu skill create --title "…" [--when "…"] [--tags a,b] [--body "…"]
//   maddu skill add    --title "…" [--when "…"] [--tags a,b] [--body "…"]   (alias of create)
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
    console.error('Usage: maddu skill <list|show|create|add|from-slice|apply|delete> [flags]');
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

  // v0.19.1 (A5): `add` is a documented alias of `create`. Help text +
  // intent table both advertise "add" — make the verb work for parity.
  if (sub === 'create' || sub === 'add') {
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

  // v1.1.0 Phase 8c — autonomous skill curation verbs.
  if (sub === 'candidates') {
    const tsub = rest[0] || 'list';
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const { dirname, join, resolve: pathResolve } = await import('node:path');
    const { stat } = await import('node:fs/promises');
    const __dirname2 = dirname(fileURLToPath(import.meta.url));
    const FRAMEWORK_ROOT2 = pathResolve(__dirname2, '..');
    async function existsP(p) { try { await stat(p); return true; } catch { return false; } }
    let lib;
    for (const c of [join(process.cwd(), 'maddu', 'runtime', 'lib', 'skill-candidates.mjs'), join(FRAMEWORK_ROOT2, 'template', 'maddu', 'runtime', 'lib', 'skill-candidates.mjs')]) {
      if (await existsP(c)) { lib = await import(pathToFileURL(c).href); break; }
    }
    if (!lib) { console.error('skill-candidates.mjs not present — run `maddu upgrade`'); process.exit(2); }
    if (tsub === 'list') {
      // First detect + emit any fresh candidates.
      await lib.emitFreshCandidates(repoRoot);
      const candidates = await lib.listCandidates(repoRoot);
      if (candidates.length === 0) { console.log('(no skill candidates)'); return; }
      console.log(`${ANSI.bold}SKILL CANDIDATES  (${candidates.length})${ANSI.reset}`);
      for (const c of candidates) {
        const color = c.status === 'approved' ? ANSI.pass : (c.status === 'rejected' ? ANSI.dim : ANSI.warn);
        console.log(`  ${ANSI.accent}${c.hash}${ANSI.reset}  ${color}${c.status.padEnd(10)}${ANSI.reset}  ${ANSI.dim}tags:${ANSI.reset} ${c.tags.join(', ')}  ${ANSI.dim}(${c.examples.length} ex)${ANSI.reset}`);
      }
      return;
    }
    console.error('usage: maddu skill candidates list');
    process.exit(2);
  }

  if (sub === 'from-candidate') {
    const hash = rest[0];
    if (!hash) { console.error('usage: maddu skill from-candidate <hash> [--title "..."]'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const { dirname, join, resolve: pathResolve } = await import('node:path');
    const { stat } = await import('node:fs/promises');
    const __dirname2 = dirname(fileURLToPath(import.meta.url));
    const FRAMEWORK_ROOT2 = pathResolve(__dirname2, '..');
    async function existsP(p) { try { await stat(p); return true; } catch { return false; } }
    let lib;
    for (const c of [join(process.cwd(), 'maddu', 'runtime', 'lib', 'skill-candidates.mjs'), join(FRAMEWORK_ROOT2, 'template', 'maddu', 'runtime', 'lib', 'skill-candidates.mjs')]) {
      if (await existsP(c)) { lib = await import(pathToFileURL(c).href); break; }
    }
    const all = await lib.listCandidates(repoRoot);
    const candidate = all.find((c) => c.hash === hash);
    if (!candidate) { console.error(`candidate ${hash} not found`); process.exit(3); }
    const title = (typeof flags.title === 'string' && flags.title) || `Skill from candidate ${hash}`;
    const body = `# ${title}\n\nDetected tag set: \`${candidate.tags.join('` , `')}\`\n\nExamples that triggered this candidate:\n\n` +
      candidate.examples.map((e) => `- \`${e.sliceStopId}\` — ${e.summary || '(no summary)'}`).join('\n') + '\n';
    const saved = await skills.saveSkill(repoRoot, { title, when: '', tags: candidate.tags, body });
    await lib.approveCandidate(repoRoot, hash, null);
    console.log(`${ANSI.pass}materialized${ANSI.reset}  ${saved.id}  ${saved.title}  ${ANSI.dim}(from candidate ${hash})${ANSI.reset}`);
    return;
  }

  if (sub === 'candidate-reject') {
    const hash = rest[0];
    if (!hash) { console.error('usage: maddu skill candidate-reject <hash> [--reason "..."]'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const { dirname, join, resolve: pathResolve } = await import('node:path');
    const { stat } = await import('node:fs/promises');
    const __dirname2 = dirname(fileURLToPath(import.meta.url));
    const FRAMEWORK_ROOT2 = pathResolve(__dirname2, '..');
    async function existsP(p) { try { await stat(p); return true; } catch { return false; } }
    let lib;
    for (const c of [join(process.cwd(), 'maddu', 'runtime', 'lib', 'skill-candidates.mjs'), join(FRAMEWORK_ROOT2, 'template', 'maddu', 'runtime', 'lib', 'skill-candidates.mjs')]) {
      if (await existsP(c)) { lib = await import(pathToFileURL(c).href); break; }
    }
    await lib.rejectCandidate(repoRoot, hash, typeof flags.reason === 'string' ? flags.reason : null, null);
    console.log(`${ANSI.warn}rejected${ANSI.reset}  ${hash}`);
    return;
  }

  // v1.2.0 Phase 4 — operator-trusted skill import.
  //   maddu skill import <path> --trust
  //   maddu skill trust  <id>
  if (sub === 'import') {
    const src = rest[0];
    if (!src) { console.error('usage: maddu skill import <path> --trust'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    if (!flags.trust) {
      console.error('refused: skill import requires --trust to confirm the operator has reviewed the source.');
      console.error('  Importing arbitrary skill files is a trust decision (rule #6 spirit).');
      console.error('  Re-run with --trust after you have read the file.');
      process.exit(2);
    }
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { join, basename, resolve } = await import('node:path');
    let body;
    try { body = await readFile(resolve(src), 'utf8'); }
    catch (err) { console.error(`refused: cannot read ${src}: ${err.message}`); process.exit(3); }
    const sha = createHash('sha256').update(body).digest('hex');
    // Inject provenance frontmatter if absent.
    let final = body;
    if (final.startsWith('---')) {
      const end = final.indexOf('\n---', 4);
      if (end > 0 && !/\nprovenance\s*:/.test(final.slice(0, end + 4))) {
        const head = final.slice(0, end);
        final = head + `\nprovenance: imported\nsource_url: ${typeof flags['source-url'] === 'string' ? flags['source-url'] : src}\nsha256: ${sha}\ntrusted: false` + final.slice(end);
      }
    } else {
      final = `---\nprovenance: imported\nsource_url: ${typeof flags['source-url'] === 'string' ? flags['source-url'] : src}\nsha256: ${sha}\ntrusted: false\n---\n\n` + final;
    }
    const dest = join(repoRoot, '.maddu', 'skills', basename(src).replace(/\.md$/i, '') + '.md');
    await mkdir(join(repoRoot, '.maddu', 'skills'), { recursive: true });
    await writeFile(dest, final);
    await spine.append(repoRoot, {
      type: 'SKILL_IMPORTED',
      data: { source: src, sha256: sha, trusted: false, dest: dest.replace(repoRoot, '').replace(/^[\\\/]/, '') },
    });
    console.log(`${ANSI.pass}imported${ANSI.reset}  ${basename(dest)}  ${ANSI.dim}sha256=${sha.slice(0, 12)}…${ANSI.reset}  ${ANSI.warn}(untrusted — run \`maddu skill trust ${basename(dest, '.md')}\`)${ANSI.reset}`);
    return;
  }
  if (sub === 'trust') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu skill trust <id>'); process.exit(2); }
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const p = join(repoRoot, '.maddu', 'skills', `${id}.md`);
    let body;
    try { body = await readFile(p, 'utf8'); }
    catch { console.error(`skill ${id} not found`); process.exit(3); }
    if (body.startsWith('---')) {
      const end = body.indexOf('\n---', 4);
      if (end > 0) {
        let head = body.slice(0, end);
        if (/\ntrusted\s*:/.test(head)) head = head.replace(/\ntrusted\s*:\s*(false|true)/, '\ntrusted: true');
        else head += '\ntrusted: true';
        body = head + body.slice(end);
        await writeFile(p, body);
        await spine.append(repoRoot, { type: 'SKILL_TRUSTED', data: { id } });
        console.log(`${ANSI.pass}trusted${ANSI.reset}  ${id}`);
        return;
      }
    }
    console.error(`refused: ${id} has no frontmatter to update`);
    process.exit(4);
  }

  console.error(`maddu skill: unknown subcommand "${sub}"`);
  process.exit(2);
}
