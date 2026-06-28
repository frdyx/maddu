// `maddu focus <subcommand>` — the Focus Director operator surface.
//
//   maddu focus status                            trajectory + open flag (default)
//   maddu focus enable                            opt IN  (allowlist the triggers)
//   maddu focus disable                           opt OUT (remove them)
//   maddu focus resolve <swap|revert|continue>    answer an open drift flag
//
// The director is OFF by default (opt-in): `enable` adds its two triggers to the
// rule-#9 allowlist, `disable` removes them. `status` is read-only; `resolve`
// appends a cleared DRIFT_FLAGGED so the open flag resolves to the chosen path.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m', pass: '\x1b[32m', warn: '\x1b[33m', accent: '\x1b[35m' };
const FOCUS_TRIGGERS = ['heartbeat:focus-director', 'slice-stop:focus-director'];
const CHOICES = ['swap', 'revert', 'continue'];

function triggersPath(repoRoot) { return join(repoRoot, '.maddu', 'config', 'triggers.json'); }

async function readTriggers(repoRoot) {
  try {
    const raw = JSON.parse(await readFile(triggersPath(repoRoot), 'utf8'));
    return { raw, allowed: Array.isArray(raw.allowed) ? raw.allowed : [] };
  } catch { return { raw: { allowed: [] }, allowed: [] }; }
}

async function writeTriggers(repoRoot, raw, allowed) {
  await mkdir(join(repoRoot, '.maddu', 'config'), { recursive: true }).catch(() => {});
  await writeFile(triggersPath(repoRoot), JSON.stringify({ ...raw, allowed }, null, 2) + '\n');
}

export default async function focus(argv) {
  const sub = argv[0] || 'status';
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'status') {
    const proj = await projections.project(repoRoot);
    const f = proj.focus || { lastTag: null, window: [], openFlag: null };
    const { allowed } = await readTriggers(repoRoot);
    const on = FOCUS_TRIGGERS.every((t) => allowed.includes(t));
    console.log(`${ANSI.bold}Focus Director${ANSI.reset}  ${on ? `${ANSI.pass}enabled${ANSI.reset}` : `${ANSI.dim}disabled — opt in with \`maddu focus enable\`${ANSI.reset}`}`);
    console.log(`  last tag:  ${f.lastTag || '—'}`);
    console.log(`  window:    ${(f.window || []).map((x) => x.tag).join(' ') || '—'}`);
    if (f.openFlag) {
      console.log(`  ${ANSI.warn}⚑ open flag:${ANSI.reset} ${f.openFlag.reason}`);
      console.log(`     resolve:  maddu focus resolve <${(f.openFlag.menu || CHOICES).join('|')}>`);
    } else {
      console.log(`  flag:      ${ANSI.dim}none open${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const { raw, allowed } = await readTriggers(repoRoot);
    const next = sub === 'enable'
      ? [...new Set([...allowed, ...FOCUS_TRIGGERS])]
      : allowed.filter((t) => !FOCUS_TRIGGERS.includes(t));
    await writeTriggers(repoRoot, raw, next);
    console.log(`Focus Director ${sub === 'enable' ? `${ANSI.pass}enabled${ANSI.reset}` : `${ANSI.warn}disabled${ANSI.reset}`}  ${ANSI.dim}(${FOCUS_TRIGGERS.join(', ')})${ANSI.reset}`);
    return;
  }

  if (sub === 'resolve') {
    const choice = rest.find((x) => !x.startsWith('-'));
    if (!CHOICES.includes(choice)) {
      console.error(`usage: maddu focus resolve <${CHOICES.join('|')}>`);
      process.exit(2);
    }
    const sessionId = process.env.MADDU_SESSION_ID || null;
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.DRIFT_FLAGGED,
      actor: sessionId,
      data: { cleared: true, choice },
    });
    console.log(`${ANSI.pass}resolved${ANSI.reset}  focus flag → ${choice}`);
    return;
  }

  console.error(`maddu focus: unknown subcommand "${sub}" (status|enable|disable|resolve)`);
  process.exit(2);
}
