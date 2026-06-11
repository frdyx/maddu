// Project blueprint export (`maddu blueprint`) — v1.12.0 (prototype).
//
// Assembles a single PORTABLE, agent-ready brief of how a project was built, so
// the operator can carry it into a NEW (non-Máddu) repo and instruct an agent to
// reproduce the operation as a variable-driven system — exactly the manual
// lulu → crawl/forge move, but exported in one command.
//
// Sources (all already present; this just collects + renders them):
//   - the operator's PROMPT SEQUENCE from the Claude Code transcripts — the
//     genesis (step-0) prompt + every instruction that drove the build. This is
//     the procedure backbone, and it works even for freeform (non-Máddu)
//     projects.
//   - the spine (when the project has a .maddu/): goal, plan phases, slice-stops
//     (each a structured step), and `learn` corrections (lessons).
//
// Pure core: reads files, returns/renders strings. No provider SDK.

import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { transcriptsRoot, listSessionFiles, parseTranscript, mineTranscripts } from './learn.mjs';
import { redactText } from './secret-scan.mjs';

// ── Operator prompt extraction ──────────────────────────────────────────────

// Pull the operator's real prompt turns from one transcript (skip tool-results,
// injected system reminders, and command-wrapper noise). Returns ordered
// { text, ts, line } for genuine user instructions.
export async function extractPrompts(filePath) {
  const prompts = [];
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;
  for await (const raw of rl) {
    line++;
    const t = raw.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.type !== 'user') continue;
    const c = o.message?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      // A real prompt is text content; tool_result turns are not operator input.
      if (c.some((x) => x && x.type === 'tool_result')) continue;
      text = c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
    }
    text = (text || '').trim();
    if (!text) continue;
    // Skip harness-injected noise.
    if (/^<(system-reminder|command-name|local-command)/.test(text)) continue;
    if (/^\[Request interrupted/.test(text)) continue;
    prompts.push({ text, ts: o.timestamp || o.ts || null, line });
  }
  return prompts;
}

function clamp(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

// Match a transcript folder slug against a (possibly comma-separated) filter.
// One project can span several repos/slugs (e.g. `crawl,forge`).
function slugMatch(fileSlug, slug) {
  if (!slug) return true;
  const fs = String(fileSlug).toLowerCase();
  return String(slug).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).some((s) => fs.includes(s));
}

// A session whose FIRST prompt is a system/sub-agent instruction (not a human
// directive) is a spawned worker/eval run, not operator-driven — exclude it so
// the procedure/timeline stay focused on the real build arc.
const AGENT_SESSION_RE = /^(you are\b|you extract\b|reply with exactly|return only|use only the|act as |<system|extract structured)/i;

// Collect the operator's chronological prompt sequence for a project (across its
// operator-driven sessions). Returns the kept session uuids too, so action
// gathering can restrict to the same sessions.
export async function gatherPrompts({ root = transcriptsRoot(), slug = null, since = null } = {}) {
  const files = await listSessionFiles(root);
  const sinceMs = since ? new Date(since).getTime() : null;
  const all = [];
  const operatorSessions = new Set();
  let sessionsScanned = 0, agentSessions = 0;
  for (const f of files) {
    if (!slugMatch(f.slug, slug)) continue;
    sessionsScanned++;
    let ps;
    try { ps = await extractPrompts(f.path); } catch { continue; }
    if (!ps.length) continue;
    if (AGENT_SESSION_RE.test(ps[0].text)) { agentSessions++; continue; } // spawned worker/eval
    operatorSessions.add(f.sessionUuid);
    for (const p of ps) {
      if (sinceMs && p.ts && new Date(p.ts).getTime() < sinceMs) continue;
      all.push({ ...p, session: f.sessionUuid });
    }
  }
  all.sort((a, b) => (a.ts ? Date.parse(a.ts) : 0) - (b.ts ? Date.parse(b.ts) : 0));
  return { sessionsScanned, agentSessions, prompts: all, operatorSessions };
}

// ── Agent action distillation (what the agent actually DID) ─────────────────
// The operator prompts give the DIRECTION; the agent's tool calls give the
// PROCESS (audit competitor sites, extract tokens, scaffold, build). We surface
// the meaningful actions and drop the noise (Reads, repeats).

// Reduce a Bash command to its reusable "shape" (verb + object), dropping
// arguments/paths so repeats collapse: `npm test -- --runInBand` → `npm test`.
function bashShape(cmd) {
  const c = String(cmd).trim().replace(/^cd\s+\S+\s*&&\s*/i, '');
  const toks = c.split(/\s+/);
  const head = toks[0] || '';
  const multi = new Set(['npm', 'pnpm', 'yarn', 'git', 'npx', 'node', 'docker', 'gh', 'python', 'pip', 'uv']);
  let shape = multi.has(head) && toks[1] ? `${head} ${toks[1].replace(/[^\w./@-].*$/, '')}` : head;
  return clamp(shape, 40);
}

// Strip the longest shared directory prefix so absolute paths group by their
// PROJECT-RELATIVE area (e.g. `C:/…/crawl/packages/x.ts` → `packages/x.ts`).
function stripCommonPrefix(paths) {
  const split = paths.map((p) => String(p).replace(/\\/g, '/').split('/').filter(Boolean));
  if (split.length < 2) return split.map((s) => s.join('/'));
  let i = 0;
  while (split.every((s) => i < s.length - 1 && s[i] === split[0][i])) i++;
  return split.map((s) => s.slice(i).join('/'));
}

// Group artifact file paths by top-level area: { area, count, samples }.
function groupArtifacts(rawPaths) {
  const paths = stripCommonPrefix(rawPaths);
  const byArea = new Map();
  for (const norm of paths) {
    const segs = norm.split('/').filter(Boolean);
    const area = segs.length > 1 ? segs.slice(0, segs.length - 1).join('/') : (segs[0] ? '(root)' : '.');
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(segs[segs.length - 1]);
  }
  return [...byArea.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([area, files]) => ({ area, count: files.length, samples: [...new Set(files)].slice(0, 4) }));
}

// Decompose the agent's tool calls into the reusable PROCESS, not a raw list:
// what was researched (sources), what was produced (artifacts), what operations
// ran, and what was delegated. Each category is deduped with counts.
export async function gatherActions({ root = transcriptsRoot(), slug = null, since = null, onlySessions = null } = {}) {
  const files = await listSessionFiles(root);
  const sinceMs = since ? new Date(since).getTime() : null;
  const sources = new Map(), artifacts = new Map(), operations = new Map(), delegations = new Map();
  const repoRoots = new Set();
  let total = 0;
  for (const f of files) {
    if (!slugMatch(f.slug, slug)) continue;
    if (onlySessions && !onlySessions.has(f.sessionUuid)) continue;
    let calls;
    try { calls = await parseTranscript(f.path); } catch { continue; }
    for (const c of calls) {
      if (sinceMs && c.ts && new Date(c.ts).getTime() < sinceMs) continue;
      const i = c.input || {};
      if (c.tool === 'WebFetch' && i.url) { sources.set(clamp(i.url, 120), (sources.get(clamp(i.url, 120)) || 0) + 1); total++; }
      else if (c.tool === 'WebSearch' && i.query) { const k = 'search: ' + clamp(i.query, 90); sources.set(k, (sources.get(k) || 0) + 1); total++; }
      else if ((c.tool === 'Write' || c.tool === 'Edit' || c.tool === 'NotebookEdit')) {
        const p = i.file_path || i.notebook_path;
        if (p) {
          artifacts.set(p, (artifacts.get(p) || 0) + 1); total++;
          // Infer the product repo root from where files were written (skip
          // Claude Code's own ~/.claude/projects/<slug>/ transcript dirs).
          const np = String(p).replace(/\\/g, '/');
          const m = np.match(/^(.*\/[Pp]rojects\/[^/]+)\//);
          if (m && !/\/\.claude\//i.test(np)) repoRoots.add(m[1]);
        }
      }
      else if (c.tool === 'Bash' && i.command) { const s = bashShape(i.command); operations.set(s, (operations.get(s) || 0) + 1); total++; }
      else if (c.tool === 'Task') { const d = clamp(i.description || i.prompt, 90); if (d) { delegations.set(d, (delegations.get(d) || 0) + 1); total++; } }
    }
  }
  const sortByCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  // Iteration hotspots: files rewritten many times = where the hard work was.
  const relArtifacts = stripCommonPrefix([...artifacts.keys()]);
  const iterated = [...artifacts.values()].map((n, idx) => ({ file: relArtifacts[idx], n }))
    .filter((x) => x.n > 2).sort((a, b) => b.n - a.n).slice(0, 12);
  return {
    total,
    repoRoots: [...repoRoots],
    iterated,
    sources: sortByCount(sources).map(([k, n]) => ({ k, n })),
    artifacts: groupArtifacts([...artifacts.keys()]),
    artifactCount: artifacts.size,
    operations: sortByCount(operations).map(([op, n]) => ({ op, n })),
    delegations: [...delegations.keys()],
  };
}

// The arc as a per-session timeline: each session's opening operator prompt is
// what that work-chunk was about. Returns [{ session, ts, opening }].
export function buildTimeline(prompts) {
  const seen = new Map();
  for (const p of prompts) {
    if (!p.session) continue;
    if (!seen.has(p.session)) seen.set(p.session, { session: p.session, ts: p.ts, opening: p.text });
  }
  return [...seen.values()].sort((a, b) => (a.ts ? Date.parse(a.ts) : 0) - (b.ts ? Date.parse(b.ts) : 0));
}

// ── The actual product (ground truth from the real repo) ────────────────────
// The transcript tells you what the agent DID; the repo tells you what actually
// EXISTS now. When the operator has the product repo on disk, scan it so the
// blueprint records the true end state — real file tree, stack, docs, and git
// remote (so the consuming agent can read or clone the real thing).

const PRUNE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', '.turbo', 'coverage', 'out', '.maddu', 'maddu', '.cache', 'tmp', '.claude', '.codex']);

function git(root, args) {
  try { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; }
}

async function fileTree(root, { maxDepth = 3, maxEntries = 220 } = {}) {
  const lines = [];
  let count = 0, truncated = false;
  async function walk(dir, prefix, depth) {
    if (depth > maxDepth || truncated) return;
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    ents = ents
      .filter((e) => !PRUNE_DIRS.has(e.name) && !(e.name.startsWith('.') && e.name !== '.github'))
      .sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (count >= maxEntries) { truncated = true; return; }
      count++;
      lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) await walk(join(dir, e.name), prefix + '  ', depth + 1);
    }
  }
  await walk(root, '', 0);
  return { lines, truncated };
}

// Files an implementing agent should read first to ground itself in the repo.
const KEY_FILE_RE = /(^|\/)(package\.json|tsconfig\.json|pnpm-workspace\.yaml)$|\.schema\.json$|(^|\/)(README|HANDOFF|PLAN|ARCHITECTURE|RUNBOOK|COMPONENTS|BEST-PRACTICE-CHECKLIST)\.md$|(^|\/)(orchestrator|pipeline|index|main|server|compose|generate|extract|research|scaffold)\.(ts|tsx|js|mjs)$|(^|\/)profiles?\/[^/]+\.json$/i;

// Vendored/copied dependency dirs (e.g. `gluestack-ui-5.0.0-alpha.0/`) — their
// internals aren't the product; skip them so the reading list stays focused.
const VENDORED_DIR_RE = /\d+\.\d+\.\d+|-alpha|-beta|-rc\b|vendor|third[_-]?party/i;

async function collectKeyFiles(root, { max = 40 } = {}) {
  const out = [];
  async function walk(dir, rel, depth) {
    if (depth > 4 || out.length >= max) return;
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (PRUNE_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
      if (e.isDirectory() && VENDORED_DIR_RE.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(join(dir, e.name), r, depth + 1); continue; }
      // package.json / tsconfig only near the top (deep ones = sub-packages/vendored).
      if (/(package\.json|tsconfig\.json|pnpm-workspace\.yaml)$/.test(e.name) && (r.split('/').length > 3)) continue;
      if (KEY_FILE_RE.test(r) && out.length < max) out.push(r);
    }
  }
  await walk(root, '', 0);
  return out;
}

async function firstHeading(path) {
  try {
    const txt = await readFile(path, 'utf8');
    const h = txt.split('\n').find((l) => /^#\s+/.test(l));
    return h ? h.replace(/^#\s+/, '').trim() : null;
  } catch { return null; }
}

// Scan a product repo for its actual end state. Returns null if absent.
export async function gatherProduct(root) {
  if (!root) return null;
  try { await stat(root); } catch { return null; }
  const product = { root, tree: null, pkg: null, readme: null, docs: [], git: null, keyFiles: [] };

  product.tree = await fileTree(root);
  product.keyFiles = await collectKeyFiles(root);

  try {
    const pj = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    product.pkg = {
      name: pj.name || null,
      scripts: Object.keys(pj.scripts || {}),
      workspaces: pj.workspaces || null,
      deps: [...Object.keys(pj.dependencies || {}), ...Object.keys(pj.devDependencies || {})].slice(0, 24),
    };
  } catch {}

  product.readme = await firstHeading(join(root, 'README.md'));
  // Documented design under docs/ (first heading of each .md).
  try {
    const docsDir = join(root, 'docs');
    for (const e of (await readdir(docsDir, { withFileTypes: true })).filter((x) => x.isFile() && x.name.endsWith('.md')).slice(0, 12)) {
      product.docs.push({ file: `docs/${e.name}`, title: await firstHeading(join(docsDir, e.name)) });
    }
  } catch {}

  product.git = {
    remote: git(root, ['remote', 'get-url', 'origin']),
    head: git(root, ['rev-parse', '--short', 'HEAD']),
    commits: git(root, ['rev-list', '--count', 'HEAD']),
    last: git(root, ['log', '-1', '--format=%s']),
  };
  return product;
}

// ── Implementation-handoff derivations (acceptance / reading / output / guards)

// "The rebuild is done when…" — generic core + criteria derived from the real
// product's scripts and schemas.
export function deriveAcceptance(products, variables) {
  const c = [];
  if (variables?.length) c.push('the intake schema validates — all required inputs collected and typed');
  const scripts = new Set();
  for (const p of products) for (const s of (p.pkg?.scripts || [])) scripts.add(s);
  const has = (...n) => n.some((x) => scripts.has(x));
  if (has('build')) c.push('`build` passes for every package');
  if (has('typecheck')) c.push('`typecheck` is clean');
  if (has('test')) c.push('`test` passes');
  if (has('smoke')) c.push('`smoke` passes');
  if (has('crawl')) c.push('the crawler runs from the CLI');
  if (has('cron') || has('worker')) c.push('the crawler runs unattended (cron/worker)');
  if (products.some((p) => (p.keyFiles || []).some((f) => /\.schema\.json$/.test(f)))) c.push('output validates against the canonical dossier/contract schema');
  if (products.length > 1) c.push(`the artifact produced by \`${products[0].pkg?.name || 'repo-1'}\` is consumed end-to-end by \`${products[1].pkg?.name || 'repo-2'}\``);
  c.push('one real {brand} + {vertical} example has been generated end-to-end');
  return c;
}

// Files the implementing agent must read first (from the real repos).
export function deriveReadingList(products) {
  const rank = (f) => (/package\.json$/.test(f) ? 0 : /\.schema\.json$/.test(f) ? 1 : /(HANDOFF|PLAN|ARCHITECTURE|RUNBOOK)\.md$/i.test(f) ? 2 : /profiles?\//i.test(f) ? 3 : /(orchestrator|pipeline|index|main|generate|extract|research)\./.test(f) ? 4 : 5);
  return products.map((p) => ({
    repo: p.pkg?.name || p.root.split(/[\\/]/).pop(),
    files: [...(p.keyFiles || [])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 12),
  })).filter((r) => r.files.length);
}

// What the rebuild must PRODUCE — mirrors the source's contract/profile/stage
// shape so the generalized system is structurally equivalent.
export function deriveOutputContract(products) {
  const dossier = products.flatMap((p) => p.keyFiles || []).find((f) => /dossier.*\.schema\.json$/i.test(f))
    || products.flatMap((p) => p.keyFiles || []).find((f) => /\.schema\.json$/i.test(f));
  return [
    '`contracts/intake.schema.json` — the intake contract (from the schema above)',
    `\`contracts/dossier.schema.json\`${dossier ? ` — or an adapter to the canonical \`${dossier}\`` : ' — the canonical output contract'}`,
    '`profiles/{vertical}.profile.json` — one per supported vertical (read the live list, don\'t freeze)',
    '`src/stages/{research,extract,scaffold,build,verify}.*` — a stage per procedure phase',
    '`scripts/run-intake.*`, `scripts/run-crawl.*`, `scripts/run-build.*` — runnable entry points',
    '`docs/RUNBOOK.md` (how to run it) + `docs/AGENT-HANDOFF.md` (how an agent extends it)',
  ];
}

// Real-data / legal guardrails — only when the build shows crawling/PII signals.
export function deriveGuardrails(actions, genesis) {
  const hay = `${genesis || ''} ${(actions.sources || []).map((s) => s.k).join(' ')}`.toLowerCase();
  if (!/(scrap|crawl|robots|gdpr|google business|places api|contact|email|competitor|\bpii\b|listing)/.test(hay)) return null;
  return [
    'Prefer official APIs (e.g. Google Places) over scraping wherever available.',
    'Respect robots.txt and site terms; rate-limit and identify the crawler.',
    'Record provenance (source URL + fetch timestamp) for every extracted fact — never invent competitor/SEO data.',
    'For business contact data / PII: collect only what is needed, document retention, honour GDPR data-subject rights.',
    'Keep a per-run source-URL manifest so every output is auditable.',
  ];
}

// ── Optional spine enrichment (when the project has a .maddu/) ───────────────

export function gatherSpine(events, proj) {
  const out = { goal: null, phases: [], sliceStops: [], corrections: [] };
  if (proj?.goal) out.goal = { objective: proj.goal.objective || null, constraints: proj.goal.constraints || [] };
  out.sliceStops = (events || [])
    .filter((e) => e.type === 'SLICE_STOP')
    .map((e) => ({ ts: e.ts, summary: e.data?.summary || null, targets: e.data?.targets || [], learnings: e.data?.learnings || [], next: e.data?.next || [] }));
  // Plan phases (in declaration order).
  for (const e of (events || [])) {
    if (e.type === 'PLAN_CREATED') out.phases.push({ planId: e.data?.planId, title: e.data?.title, phases: (e.data?.phases || []).map((p) => p.name || p) });
  }
  out.corrections = (events || [])
    .filter((e) => e.type === 'LEARN_CORRECTION_WRITTEN' && e.data?.fact?.text)
    .map((e) => e.data.fact.text);
  return out;
}

// ── Problems & fixes (the crux — reuse learn's failure→success pairing) ─────

export async function gatherProblems({ slug = null, since = null } = {}) {
  const parts = slug ? String(slug).split(',').map((s) => s.trim()).filter(Boolean) : [null];
  const seen = new Set(), out = [];
  for (const part of parts) {
    let digest;
    try { digest = await mineTranscripts({ slug: part, since }); } catch { continue; }
    for (const c of digest.candidates || []) {
      const key = c.category + '|' + c.failure;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ category: c.category, fail: c.failure, err: c.failureError, fix: c.success });
    }
  }
  return out.slice(0, 18);
}

// ── Variables (what was project-specific → what to ASK the user) ────────────
// Heuristic: the strongest signals are per-instance / per-vertical files the
// build created, and the source URLs it audited. Surfaced as CANDIDATES for the
// new agent to confirm with the user — never asserted as complete.

export function inferVariables({ products = [], actions = {}, genesis = '' } = {}) {
  const vars = [];
  // Source inputs — the live site(s)/competitors the system crawls & audits.
  const domains = new Set();
  for (const s of (actions.sources || [])) {
    const m = String(s.k).match(/https?:\/\/([^/\s]+)/);
    if (m && !/github\.com|google\.com/.test(m[1])) domains.add(m[1]);
  }
  const gm = String(genesis).match(/https?:\/\/([^/\s)]+)/g);
  if (gm) for (const u of gm) { const d = u.replace(/^https?:\/\//, ''); if (!/github|google/.test(d)) domains.add(clamp(d, 40)); }
  if (domains.size) vars.push({ name: 'source input(s)', key: 'source_urls', type: 'string[]', required: true, hint: 'the live site / competitor URL(s) the system crawls & audits', values: [...domains].slice(0, 5) });

  // Per-instance + per-vertical files → the parameterized dimensions.
  const fileNames = new Set();
  for (const pr of products) for (const l of (pr.tree?.lines || [])) fileNames.add(l.trim().replace(/\/$/, ''));
  for (const g of (actions.artifacts || [])) for (const s of g.samples) fileNames.add(s);
  const instances = new Set(), verticals = new Set();
  for (const fn of fileNames) {
    let m;
    if ((m = fn.match(/(?:^|\.)([a-z0-9][a-z0-9-]+)\.example\./i))) instances.add(m[1].toLowerCase());
    if ((m = fn.match(/^([a-z0-9][a-z0-9-]+)\.profile\.json$/i))) verticals.add(m[1].toLowerCase());
  }
  for (const skip of ['base', 'default', 'index', 'target', 'dossier']) { instances.delete(skip); verticals.delete(skip); }
  if (instances.size) vars.push({ name: 'instance / brand', key: 'brand', type: 'string', required: true, hint: 'the specific brand/client this run targets (was hard-coded — make it an input)', values: [...instances].slice(0, 6) });
  if (verticals.size) vars.push({ name: 'industry / vertical', key: 'vertical', type: 'enum', required: true, hint: 'the business vertical — selects the per-vertical profile', values: [...verticals].slice(0, 12) });
  return vars;
}

// Render the inferred variables as a STARTER intake schema (JSON) — the
// required, structured inputs every future run must collect before building.
// Heuristic + incomplete by design: the agent confirms + extends it.
export function renderIntakeSchema(variables) {
  const props = {};
  for (const v of variables) {
    const field = { type: v.type === 'string[]' ? 'array' : (v.type === 'enum' ? 'string' : v.type), required: v.required !== false, description: v.hint };
    if (v.type === 'enum' && v.values?.length) field.enum = v.values;
    if (v.values?.length) field.example = v.type === 'string[]' ? v.values : v.values[0];
    props[v.key || v.name] = field;
  }
  return JSON.stringify({ intake: props, note: 'STARTER schema — confirm + extend with the user from the genesis before running.' }, null, 2);
}

// ── Render the portable blueprint (Markdown) — lean, essentials only ────────

export function renderBlueprint({ slug, prompts = [], actions = {}, problems = [], variables = [], products = [], relatedRepos = [], full = false, generatedAt }) {
  const L = [];
  const title = (slug || 'project').split(',').map((s) => s.trim()).filter(Boolean).join(' + ') || 'project';
  const product = products[0] || null;
  const cloneList = products.map((p) => p.git?.remote || p.root).filter(Boolean);
  const acceptance = deriveAcceptance(products, variables);
  const reading = deriveReadingList(products);
  const outputContract = deriveOutputContract(products);
  const guardrails = deriveGuardrails(actions, prompts[0]?.text || '');

  L.push(`# Project blueprint — ${title}`);
  L.push('');
  L.push(`_Exported by \`maddu blueprint\`${generatedAt ? ' · ' + generatedAt : ''}. The essentials to rebuild this as a **variable-driven** framework: the genesis, the variables to ask about, the procedure, the problems & fixes, and a pointer to the real product. Read the live repo for full detail._`);
  L.push('');

  // What it produces (one tight paragraph from the product scan).
  if (product?.readme || product?.pkg) {
    L.push('## What it produces');
    L.push('');
    L.push(`${product.readme || product.pkg?.name || title}${product.pkg?.scripts?.length ? ` — run via: ${product.pkg.scripts.slice(0, 6).map((s) => '`' + s + '`').join(', ')}` : ''}.`);
    L.push('');
  }

  // THE headline: the required intake schema — structured variables to collect.
  L.push('## Intake schema  (collect these before every run)');
  L.push('');
  if (variables.length) {
    L.push('The project-specific values that must become INPUTS. **Every future run starts by collecting these from the user — structured, not free-text.** Detected (heuristic — confirm + extend):');
    L.push('');
    for (const v of variables) L.push(`- **\`${v.key || v.name}\`** (${v.type}${v.required !== false ? ', required' : ''}) — ${v.hint}.${v.values?.length ? `  _(this run: ${v.values.join(', ')})_` : ''}`);
    L.push('');
    L.push('Starter intake contract:');
    L.push('```json');
    L.push(renderIntakeSchema(variables));
    L.push('```');
    L.push('');
    L.push('> Any `enum` here (e.g. `vertical`) is a **starter** from this run\'s files. The generalized system must read the live `profiles/` in the repo for the authoritative, current list — do not freeze it to these values.');
  } else {
    L.push('_None auto-detected — the new agent must derive the input variables from the genesis + product and define the intake schema with the user._');
  }
  L.push('');

  // The procedure — genesis verbatim + the essential operator instructions.
  L.push('## The procedure (step 0 → product)');
  L.push('');
  if (prompts.length) {
    L.push('**Genesis (step 0), verbatim:**');
    L.push('> ' + clamp(prompts[0].text, 700).replace(/\n/g, ' '));
    L.push('');
    L.push('**Then, the operator\'s direction in order (the recipe to generalize):**');
    const seen = new Set();
    let n = 0;
    for (const p of prompts.slice(1)) {
      const c = clamp(p.text, 200);
      const key = c.slice(0, 40).toLowerCase();
      if (seen.has(key) || c.length < 4) continue;
      seen.add(key);
      L.push(`${++n}. ${c}`);
      if (n >= 25) break;
    }
    L.push('');
  }

  // Problems & fixes — the crux/gotchas (failure→success pairs).
  if (problems.length) {
    L.push('## Problems hit & how they were solved');
    L.push('');
    L.push('The failure→fix pairs from the build — preserve these so the generalized system avoids the same dead-ends:');
    L.push('');
    for (const p of problems) L.push(`- **[${p.category}]** \`${clamp(p.fail, 90)}\`${p.err ? ` — ${clamp(p.err, 60)}` : ''} → fixed with \`${clamp(p.fix, 90)}\``);
    L.push('');
  }

  // Iteration hotspots — where the hard/iterative work concentrated.
  if (actions.iterated?.length) {
    L.push('## Iteration hotspots (where the work concentrated)');
    L.push('');
    L.push('Files reworked many times — the tricky parts that needed iteration:');
    L.push('');
    for (const it of actions.iterated) L.push(`- \`${it.file}\` ×${it.n}`);
    L.push('');
  }

  // What was researched — the inputs/standards behind the system.
  if (actions.sources?.length) {
    L.push('## What was researched (the knowledge baked in)');
    L.push('');
    for (const s of actions.sources.slice(0, 18)) L.push(`- ${s.k}`);
    if (actions.sources.length > 18) L.push(`… (+${actions.sources.length - 18} more)`);
    L.push('');
  }

  // The actual product — ground truth pointer (lean; tree only with --full).
  if (products.length) {
    L.push('## The actual product (ground truth — clone & read this)');
    L.push('');
    L.push('**The authoritative end result is the real repo, not this summary. Clone/read it first.**');
    L.push('');
    for (const pr of products) {
      const name = pr.pkg?.name || pr.root.split(/[\\/]/).pop();
      L.push(`### ${name}`);
      if (pr.git?.remote) L.push(`- clone: \`${pr.git.remote}\``);
      L.push(`- local: \`${pr.root}\`${pr.git?.commits ? ` (${pr.git.commits} commits)` : ''}`);
      if (pr.pkg?.workspaces) L.push(`- workspaces: ${JSON.stringify(pr.pkg.workspaces)}`);
      if (pr.pkg?.scripts?.length) L.push(`- scripts: ${pr.pkg.scripts.map((s) => '`' + s + '`').join(', ')}`);
      if (pr.pkg?.deps?.length) L.push(`- key deps: ${pr.pkg.deps.slice(0, 16).join(', ')}`);
      if (pr.docs?.length) L.push(`- design docs: ${pr.docs.map((d) => d.file.replace('docs/', '')).join(', ')}`);
      // Top-level areas (not the full tree) — the shape, cheaply.
      if (pr.tree?.lines?.length) {
        const top = pr.tree.lines.filter((l) => !l.startsWith(' ') && l.endsWith('/')).map((l) => l.trim());
        if (top.length) L.push(`- structure: ${top.slice(0, 14).join(', ')}`);
      }
      L.push('');
    }
    if (full) {
      for (const pr of products) {
        if (!pr.tree?.lines?.length) continue;
        L.push(`### Full tree — ${pr.pkg?.name || pr.root.split(/[\\/]/).pop()}`);
        L.push('```');
        L.push(pr.tree.lines.join('\n'));
        if (pr.tree.truncated) L.push('… (truncated)');
        L.push('```');
        L.push('');
      }
    } else {
      L.push('_(file trees omitted for brevity — re-run with `--full`, or just read the repo.)_');
      L.push('');
    }
  }
  if (relatedRepos?.length) {
    L.push(`**Related repos** (also inspect): ${relatedRepos.map((r) => '`' + r + '`').join(', ')}`);
    L.push('');
  }

  // Required reading — the files to inspect before building (ground truth).
  if (reading.length) {
    L.push('## Required reading (inspect these before building)');
    L.push('');
    for (const r of reading) {
      L.push(`**${r.repo}:**`);
      for (const f of r.files) L.push(`- \`${f}\``);
      L.push('');
    }
  }

  // Output contract — what the rebuild must produce (structurally equivalent).
  if (outputContract.length) {
    L.push('## Output contract (the rebuild must produce)');
    L.push('');
    L.push('At minimum, mirroring the source structure:');
    L.push('');
    for (const o of outputContract) L.push(`- ${o}`);
    L.push('');
  }

  // Acceptance criteria — the rebuild is done only when these pass.
  if (acceptance.length) {
    L.push('## Acceptance criteria (done only when all pass)');
    L.push('');
    for (const a of acceptance) L.push(`- [ ] ${a}`);
    L.push('');
  }

  // Real-data / legal guardrails (only when crawling/PII is in scope).
  if (guardrails) {
    L.push('## Guardrails — real data & legal');
    L.push('');
    for (const g of guardrails) L.push(`- ${g}`);
    L.push('');
  }

  // The generalization prompt — paste-ready, asks the right questions.
  L.push('## Generalization prompt (paste this into the new project)');
  L.push('');
  L.push('```text');
  L.push(`You are given a blueprint of how "${title}" was built. Your job: rebuild it as a VARIABLE-DRIVEN system that produces the equivalent end result for ANY input of this type — not a one-off clone.`);
  L.push('');
  if (cloneList.length) {
    L.push(`1. GROUND TRUTH FIRST. The real product is at ${cloneList.map((c) => '`' + c + '`').join(' and ')}. Clone/read it — start with the "Required reading" files; the actual code, schemas, and docs are authoritative. The blueprint is the map; the repo is the territory.`);
  }
  L.push(`2. INTAKE FIRST. Fill the intake schema by asking the user${variables.length ? ` (at minimum: ${variables.map((v) => v.key || v.name).join(', ')})` : ''} — confirm + extend it with any variables the genesis implies (and read the live profiles for the real vertical list). Validate the structured inputs before building; don't proceed on free-text assumptions.`);
  L.push('3. Walk the procedure step 0 → product, turning each operator instruction into a parameterized stage. Keep the steps that mattered (research/audit → extract → scaffold → build → verify); drop dead-ends.');
  L.push('4. Carry the "problems & fixes" forward as guardrails so the generalized system avoids the same failures.' + (guardrails ? ' Honour the real-data/legal guardrails.' : ''));
  L.push('5. Produce the "Output contract" deliverables (variable-driven framework + intake/dossier schemas + per-vertical profiles + stages + run scripts + runbook).');
  L.push('6. DONE only when every "Acceptance criteria" checkbox passes (incl. one real {brand}+{vertical} generated end-to-end).');
  L.push('```');
  L.push('');
  // A4 (v1.13.0): blueprint mines transcripts + scans real product repos, then
  // writes a PORTABLE handoff meant to travel into other repos. That is exactly
  // the artifact that can carry a secret (an API key pasted into a prompt, a
  // `.env` line read off disk) across the export boundary hard rule #6 protects.
  // Scrub through the canonical secret-scan engine before returning, so every
  // path that writes a blueprint emits a redacted one.
  return redactText(L.join('\n')).text;
}
