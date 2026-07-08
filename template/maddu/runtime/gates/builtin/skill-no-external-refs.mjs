// `skill-no-external-refs` gate.
//
// Audit-time half of the skill URL-swap countermeasure (cybernews, 2026: a fake
// "brand landing page" skill hijacked ~26,000 agents). The attack keeps a skill
// markdown file CLEAN at review, gets it approved, then swaps the content behind
// an EXTERNAL instruction link the body points at — the reviewed markdown never
// changes, a dependency it references does. The inject-time half is enforced in
// commands/brief.mjs (a skill with unacknowledged external refs is refused
// injection and witnessed as SKILL_INJECTION_REFUSED). This gate is the standing
// audit: it FAILs `maddu doctor`/`maddu ci` while such a skill sits on disk, so
// the surface can't drift back in silently.
//
// Detection + scoping live in the shared `skill-refs.mjs` lib so this gate and
// the loader can never disagree. Scope by provenance (false-positive-free on
// shipped skills that legitimately cite doc URLs):
//   - framework-* / pre-v1.2-grandfathered : SKIP (origin-trusted).
//   - imported : the attack vector. External ref + no acknowledgment → FAIL.
//   - operator (your own hand)             : External ref + no ack → WARN.
//   - missing provenance : SKIP — `skill-provenance-required` owns it.
//
// Acknowledgment: frontmatter `external_refs: allowed`, set AFTER reading the
// skill. Severity: safety.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGateLib } from '../../lib/gate-libroot.mjs';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function parseSkill(text) {
  const out = { fm: {}, body: text };
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return out;
  const head = text.slice(4, end).replace(/^\n/, '');
  out.body = text.slice(end + 4).replace(/^\r?\n/, '');
  for (const raw of head.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const i = line.indexOf(':');
    if (i < 0) continue;
    out.fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export default {
  id: 'skill-no-external-refs',
  label: 'skill no external refs',
  severity: 'safety',
  description: 'Auto-injectable operator/imported skills are locally resident — no unacknowledged external instruction links (skill URL-swap attack surface).',
  run: async (ctx) => {
    const dir = join(ctx.repoRoot, '.maddu', 'skills');
    if (!(await exists(dir))) {
      return { ok: true, message: 'no .maddu/skills/ — skipped' };
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));
    if (files.length === 0) {
      return { ok: true, message: 'no skill files (skipped)' };
    }
    const refs = await loadGateLib(ctx.repoRoot, 'skill-refs.mjs');
    if (!refs?.findExternalRefs) {
      return { ok: true, message: 'skill-refs lib not present (skipped — install predates external-ref detection)' };
    }

    const failed = [];        // imported + external ref + not acknowledged
    const warned = [];        // operator  + external ref + not acknowledged
    let scanned = 0, acknowledged = 0, frameworkSkipped = 0, noProvenance = 0;

    for (const f of files) {
      const { fm, body } = parseSkill(await readFile(join(dir, f.name), 'utf8'));
      const provenance = fm.provenance || null;

      if (!provenance) { noProvenance++; continue; }
      if (refs.isFrameworkOrigin(provenance)) { frameworkSkipped++; continue; }

      const found = refs.findExternalRefs(body);
      if (found.length === 0) { scanned++; continue; }
      if (refs.externalRefsAcknowledged(fm)) { acknowledged++; continue; }

      const rec = { skill: f.name, provenance, refs: found.slice(0, 5) };
      if (provenance === 'imported') failed.push(rec);
      else warned.push(rec);
    }

    if (failed.length > 0) {
      const names = failed.map((r) => r.skill).slice(0, 3).join(', ');
      return {
        ok: false,
        message: `${failed.length} imported skill(s) reference external content without \`external_refs: allowed\`: ${names}${failed.length > 3 ? ' …' : ''}`,
        evidence: { failed, warned, frameworkSkipped, acknowledged },
      };
    }
    if (warned.length > 0) {
      const names = warned.map((r) => r.skill).slice(0, 3).join(', ');
      return {
        ok: true,
        status: 'warn',
        message: `${warned.length} operator skill(s) reference external content (add \`external_refs: allowed\` after review): ${names}`,
        evidence: { warned, frameworkSkipped, acknowledged },
      };
    }
    return {
      ok: true,
      message: `${scanned} operator/imported skill(s) locally resident`
        + `${acknowledged ? `, ${acknowledged} acknowledged` : ''}`
        + `${frameworkSkipped ? ` (${frameworkSkipped} framework-origin skipped)` : ''}`,
    };
  },
};
