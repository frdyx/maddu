// `maddu status` — print a state snapshot of the spine.

import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { readFile } from 'node:fs/promises';

function fmtTime(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function head(label) {
  return `\n\x1b[1m${label}\x1b[0m`;
}

export default async function status(_args) {
  const { paths, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const p = paths.pathsFor(repoRoot);
  const proj = await projections.project(repoRoot);

  console.log(head('REPO'));
  console.log(`  root:   ${repoRoot}`);
  console.log(`  state:  ${p.state}`);

  console.log(head('SPINE'));
  console.log(`  events: ${proj.eventCount}`);
  console.log(`  last:   ${proj.lastEventId || '—'}`);

  console.log(head(`SESSIONS  (${proj.activeSessions.length} active / ${proj.sessions.length} total)`));
  if (proj.activeSessions.length === 0) {
    console.log('  (no active sessions)');
  } else {
    for (const s of proj.activeSessions) {
      console.log(`  ${s.id}`);
      console.log(`    role:   ${s.role || '—'}`);
      console.log(`    label:  ${s.label || '—'}`);
      console.log(`    focus:  ${s.focus || '—'}`);
      console.log(`    since:  ${fmtTime(s.registeredAt)}`);
      console.log(`    beat:   ${fmtTime(s.lastHeartbeatAt)}`);
    }
  }

  console.log(head(`LANE CLAIMS  (${proj.claims.length})`));
  if (proj.claims.length === 0) {
    console.log('  (no active claims)');
  } else {
    for (const c of proj.claims) {
      console.log(`  ${c.lane}  ←  ${c.sessionId}  ·  ${c.focus || '—'}`);
    }
  }

  console.log(head(`RECENT SLICE-STOPS  (${proj.sliceStops.length})`));
  const recent = proj.sliceStops.slice(-5);
  if (recent.length === 0) {
    console.log('  (none yet)');
  } else {
    for (const s of recent) {
      console.log(`  ${fmtTime(s.ts)}  [${s.lane || '—'}]  ${s.summary}`);
    }
  }

  try {
    const cat = JSON.parse(await readFile(p.laneCatalog, 'utf8'));
    console.log(head(`LANE CATALOG  (${cat.lanes.length} lanes)`));
    console.log(`  ${p.laneCatalog}`);
  } catch {}

  console.log();
}
