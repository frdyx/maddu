// `maddu advise <runtime> "<prompt>"` — non-claiming advisor query.
//
// Records the operator's request for a second opinion as an
// ADVISOR_INVOKED event and writes an artifact stub at
// `.maddu/artifacts/advisors/<advisorId>.md` capturing the prompt and
// metadata. Emits ADVISOR_ARTIFACT_WRITTEN once the file lands.
//
// **What this command does NOT do:** spawn the provider subprocess.
// The /maddu-advise slash command (Phase 5) handles that — the LLM
// agent in Claude Code / Codex inlines the prompt into its own
// transcript and runs the provider call. This command is the spine
// bookkeeping primitive: record the intent, allocate an artifact
// path, and let the agent fill in the body.
//
// **Hard rule #5 (no provider SDKs in framework code):** preserved by
// construction. We never call an API; we only write events + an
// artifact stub.
//
// **Hard rule #8 (lane ownership):** advisors are NON-CLAIMING — the
// event carries a `kind: 'advisor'` marker so the advisor-non-claiming
// gate (Phase 7) can refuse any LANE_CLAIMED that references an
// advisor session.

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function newId(prefix) {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${r}`;
}

export default async function advise(argv) {
  const [runtime, ...promptParts] = argv;
  const { flags, positional } = parseFlags(promptParts);
  if (!runtime) {
    console.error('maddu advise: <runtime> required (e.g. claude, codex, gemini)');
    process.exit(2);
  }
  const prompt = positional.join(' ').trim() || flags.prompt;
  if (!prompt) {
    console.error('maddu advise: prompt required (positional or --prompt "<text>")');
    process.exit(2);
  }

  const { paths, spine } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  const advisorId = newId('adv');
  const parentSessionId = process.env.MADDU_SESSION_ID || null;
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.ADVISOR_INVOKED,
    actor: parentSessionId,
    data: {
      advisorId,
      runtime,
      prompt,
      parentSessionId,
      kind: 'advisor',
    },
  });

  const artifactDir = join(repoRoot, '.maddu', 'artifacts', 'advisors');
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `${advisorId}.md`);
  const body = [
    `# Advisor: ${advisorId}`,
    ``,
    `- runtime: ${runtime}`,
    `- parent session: ${parentSessionId || '(none)'}`,
    `- invoked at: ${new Date().toISOString()}`,
    ``,
    `## Prompt`,
    ``,
    prompt,
    ``,
    `## Response`,
    ``,
    `_(The advisor's response is filled in by the /maddu-advise slash`,
    `command after the agent runs the underlying provider call. This`,
    `file is the stub Máddu wrote — append to it; do not rewrite the`,
    `header lines above.)_`,
    ``,
  ].join('\n');
  await writeFile(artifactPath, body);

  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.ADVISOR_ARTIFACT_WRITTEN,
    actor: parentSessionId,
    data: {
      advisorId,
      artifactPath: artifactPath.replace(repoRoot + (process.platform === 'win32' ? '\\' : '/'), ''),
    },
  });

  console.log(advisorId);
  if (process.stdout.isTTY) {
    console.log(`  runtime:    ${runtime}`);
    console.log(`  parent:     ${parentSessionId || '(none)'}`);
    console.log(`  artifact:   ${artifactPath}`);
    console.log(`  (claim-free — this advisor will not appear in lane claims)`);
  }
}
