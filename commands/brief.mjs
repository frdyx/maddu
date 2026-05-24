// `maddu brief [--json]` — Governance Phase 1.
//
// Builds a turn-start orientation digest from the spine and writes:
//   .maddu/state/orientation.json   (canonical JSON)
//   .maddu/state/handoff.md         (markdown)
//
// Both files are deterministically rebuildable: delete them and run brief
// again, the bytes are identical (no `new Date()` on the write path).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

export default async function command(argv) {
  const { flags } = parseFlags(argv);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  // Load handoff renderer from the same runtime tree the projector came from.
  const handoffMod = await loadHandoff(repoRoot);

  // Governance Phase 4: --drain returns open read-only pending actions and
  // marks them drained on the spine.
  if (flags.drain) {
    const pending = await loadPendingActions(repoRoot);
    let drained = [];
    if (pending?.drain) drained = await pending.drain(spine, projections, repoRoot, { limit: 50 });
    if (flags.json) {
      process.stdout.write(JSON.stringify({ drained }, null, 2) + '\n');
    } else {
      console.log(`drained ${drained.length} pending action(s)`);
      for (const a of drained) console.log(`  ${a.actionId}  ${a.kind}  ${JSON.stringify(a.payload)}`);
    }
    return;
  }

  const proj = await projections.project(repoRoot);
  const orientation = handoffMod.buildOrientation(proj);
  const handoff = handoffMod.renderHandoff(proj);

  // v0.17 Phase 6: --for-agent renders a single self-contained text
  // block agents can consume at turn start without reading multiple
  // files. JSON sibling lives at GET /bridge/agent-context for HTTP
  // callers; the same builder is reused there.
  if (flags['for-agent']) {
    const agentCtxMod = await loadAgentContext(repoRoot);
    const baseCtx = agentCtxMod.buildAgentContext(proj);
    // v0.19 Phase 3 — skill auto-injection.
    //
    // Operator passes `--triggers a,b` and/or `--tags x,y` (comma-separated)
    // to describe what triggered this orientation read. The active lane's
    // id is folded in automatically as both a trigger ("lane:<id>") and a
    // tag ("<id>"). Matched skill bodies are appended inline; one
    // SKILL_INJECTED event is emitted per --for-agent call that actually
    // injects ≥1 skill.
    const triggers = parseCsv(flags.triggers);
    const tags = parseCsv(flags.tags);
    if (baseCtx.activeSession) {
      // The active session's focus often hints at the slice trigger.
      // Pure heuristic — split on whitespace; LLMs don't care about precision.
      if (baseCtx.activeSession.focus) {
        for (const w of String(baseCtx.activeSession.focus).split(/\W+/).filter((x) => x.length > 2)) {
          tags.push(w.toLowerCase());
        }
      }
    }
    for (const c of baseCtx.laneClaims || []) {
      if (c.lane) {
        triggers.push(`lane:${c.lane}`);
        tags.push(c.lane);
      }
    }
    let injected = [];
    if (triggers.length || tags.length) {
      const skillsList = await loadSkillsForInjection(repoRoot);
      const matched = agentCtxMod.matchSkillsForContext(skillsList, { triggers, tags });
      injected = matched;
      if (injected.length > 0 && !flags['dry-run']) {
        const totalBytes = injected.reduce((n, s) => n + (s.body || '').length, 0);
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.SKILL_INJECTED,
          actor: baseCtx.activeSession?.id || null,
          data: {
            sessionId: baseCtx.activeSession?.id || null,
            triggers,
            tags,
            skillIds: injected.map((s) => s.id),
            totalBytes,
          },
        });
      }
    }
    const ctxWithSkills = { ...baseCtx, injectedSkills: injected };
    const block = agentCtxMod.renderAgentContextText(ctxWithSkills);
    process.stdout.write(block);
    return;
  }

  // Write through to .maddu/state/. Side-effects, but deterministic on input.
  const stateDir = path.join(repoRoot, '.maddu', 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const orientationJson = JSON.stringify(orientation, null, 2) + '\n';
  await fs.writeFile(path.join(stateDir, 'orientation.json'), orientationJson);
  await fs.writeFile(path.join(stateDir, 'handoff.md'), handoff);

  if (flags.json) {
    process.stdout.write(orientationJson);
    return;
  }

  // Pretty print
  console.log(`# Brief — ${orientation.lastEventId || '—'}`);
  console.log('');
  if (orientation.goal) {
    console.log(`Goal: ${orientation.goal.objective}`);
    if (orientation.goal.constraints?.length) {
      console.log(`  constraints (${orientation.goal.constraints.length}):`);
      for (const c of orientation.goal.constraints) console.log(`    - ${c}`);
    }
  } else {
    console.log('Goal: —');
  }
  if (orientation.phase) {
    console.log(`Phase: ${orientation.phase.name}`);
    if (orientation.phase.notes) console.log(`  notes: ${orientation.phase.notes}`);
  } else {
    console.log('Phase: —');
  }
  if (orientation.activeSession) {
    console.log(`Active session: ${orientation.activeSession.id} (${orientation.activeSession.label || ''})`);
  }
  if (orientation.lastSliceStop) {
    console.log(`Last slice: ${orientation.lastSliceStop.summary || '—'}`);
  }
  console.log(`Counters: ${JSON.stringify(orientation.counters)}`);
  if (orientation.openFollowups?.length) {
    console.log('\nOpen follow-ups:');
    for (const f of orientation.openFollowups) {
      console.log(`  [${f.severity}] ${f.fromReviewEventId}`);
    }
  }
  console.log('\n--- Handoff ---');
  console.log(handoff);
}

async function loadHandoff(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'maddu', 'runtime', 'lib', 'handoff.mjs'),
    path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
                 '..', 'template', 'maddu', 'runtime', 'lib', 'handoff.mjs'),
  ];
  for (const p of candidates) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  throw new Error('handoff.mjs not found');
}

async function loadAgentContext(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'maddu', 'runtime', 'lib', 'agent-context.mjs'),
    path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
                 '..', 'template', 'maddu', 'runtime', 'lib', 'agent-context.mjs'),
  ];
  for (const p of candidates) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  throw new Error('agent-context.mjs not found');
}

function parseCsv(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap((x) => parseCsv(x));
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

// Load the full skill set from .maddu/skills/, parsing frontmatter
// triggers/tags. Returns [{ id, title, triggers, tags, body, updated, provenance }].
//
// v1.2.0 Phase 4 — skills without a `provenance` field are REFUSED for
// auto-injection. Pre-v1.2 skills are grandfathered with
// provenance: 'pre-v1.2-grandfathered' on first read so existing installs
// keep working.
async function loadSkillsForInjection(repoRoot) {
  const skillsDir = path.join(repoRoot, '.maddu', 'skills');
  let entries;
  try { entries = await fs.readdir(skillsDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    try {
      const text = await fs.readFile(path.join(skillsDir, ent.name), 'utf8');
      const parsed = parseSkillFrontmatter(text);
      const provenance = parsed.fm.provenance || 'pre-v1.2-grandfathered';
      out.push({
        id: parsed.fm.id || ent.name.replace(/\.md$/, ''),
        title: parsed.fm.title || null,
        triggers: Array.isArray(parsed.fm.triggers) ? parsed.fm.triggers : (typeof parsed.fm.triggers === 'string' ? parsed.fm.triggers.split(',').map(t => t.trim()).filter(Boolean) : []),
        tags: Array.isArray(parsed.fm.tags) ? parsed.fm.tags : (typeof parsed.fm.tags === 'string' ? parsed.fm.tags.split(',').map(t => t.trim()).filter(Boolean) : []),
        body: parsed.body,
        updated: parsed.fm.updated || null,
        provenance,
        // Operator-imported skills are 'pending-trust' until `maddu skill trust <id>`.
        trusted: provenance === 'pre-v1.2-grandfathered'
              || /^framework-starter-pack/.test(provenance)
              || provenance === 'operator'
              || /^operator-trusted/.test(provenance)
              || (provenance === 'imported' && parsed.fm.trusted === true),
      });
    } catch {}
  }
  return out;
}

// Minimal frontmatter parser. Mirrors lib/skills.mjs#parseSkill but kept
// local so brief.mjs doesn't have to import skills.mjs (which has writer
// side-effects).
function parseSkillFrontmatter(text) {
  const out = { fm: {}, body: '' };
  if (!text.startsWith('---')) { out.body = text; return out; }
  const end = text.indexOf('\n---', 4);
  if (end < 0) { out.body = text; return out; }
  const head = text.slice(4, end).replace(/^\n/, '');
  out.body = text.slice(end + 4).replace(/^\r?\n/, '');
  for (const raw of head.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const rest = line.slice(i + 1).trim();
    let value;
    if (rest === '') value = '';
    else if (/^(\[|\{|".*"|-?\d+(\.\d+)?|true|false|null)/.test(rest)) {
      try { value = JSON.parse(rest); } catch { value = rest; }
    } else { value = rest; }
    out.fm[key] = value;
  }
  return out;
}

async function loadPendingActions(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'maddu', 'runtime', 'lib', 'pending-actions.mjs'),
    path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
                 '..', 'template', 'maddu', 'runtime', 'lib', 'pending-actions.mjs'),
  ];
  for (const p of candidates) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}
