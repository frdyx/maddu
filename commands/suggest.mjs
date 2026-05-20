// `maddu suggest` — recommend a slash command + lane for a vague task.
//
// Pure local heuristic — string match on operator-typed task description
// against:
//   1. A baked-in keyword → slash-command map (the same shape the agent
//      uses for intent routing in MADDU.md).
//   2. The lane catalog (`.maddu/lanes/catalog.json`) — match lane ids
//      and scope phrases against task words.
//   3. Recent activity from the spine projection — break ties by the
//      lane with the most recent claim, slice-stop, or heartbeat.
//
// No LLM call. No SDK import. Deterministic for the same input + spine
// state (the Phase 7 `suggest-engine-deterministic` gate runs this
// twice and compares).
//
// Flags:
//   --task "<text>"     the operator's vague description (required)
//   --emit-lane         print only the resolved lane id
//   --emit-command      print only the slash-command string (e.g. /maddu-autopilot)
//   --json              print full JSON shape { command, lane, confidence, reasoning[] }

import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keyword → slash command. Order matters: first match wins on ties.
// Keep this in sync with the intent-routing table in
// template/maddu/agent-files/MADDU.md.
const INTENT_TABLE = [
  { command: '/maddu-autopilot', keywords: ['autopilot', 'ship', 'build', 'end to end', 'end-to-end', 'implement', 'add feature', 'whole thing'] },
  { command: '/maddu-plan',      keywords: ['plan', 'design', 'architect', 'think through', 'outline', 'roadmap'] },
  { command: '/maddu-review',    keywords: ['review', 'verify', 'check', 'audit', 'qa', 'sanity'] },
  { command: '/maddu-team',      keywords: ['team', 'fan out', 'parallel', 'split into', 'multiple workers'] },
  { command: '/maddu-advise',    keywords: ['advise', 'ask claude', 'ask codex', 'ask gemini', 'second opinion', 'consult'] },
  { command: '/maddu-status',    keywords: ['status', "what's going on", 'where are we', 'current state'] },
  { command: '/maddu-cost',      keywords: ['cost', 'tokens', 'how much', 'budget', 'spend'] },
  { command: '/maddu-cancel',    keywords: ['cancel', 'stop', 'abort', 'kill the slice'] },
  { command: '/maddu-note',      keywords: ['note', 'remember', 'jot down', 'fyi'] },
  { command: '/maddu-skill',     keywords: ['skill', 'recipe', 'pattern'] },
  { command: '/maddu-help',      keywords: ['help', "don't know", 'unsure', 'what should i'] },
];

function normalize(text) {
  return String(text || '').toLowerCase().trim();
}

function tokenize(text) {
  return normalize(text).split(/[^a-z0-9]+/).filter(Boolean);
}

// Score: count of keyword phrases present in the (lowercased) task.
// Phrases match as substrings (e.g. "end to end" matches "do it end to end").
function scoreCommand(task, item) {
  const t = normalize(task);
  let score = 0;
  const hits = [];
  for (const kw of item.keywords) {
    if (t.includes(kw)) {
      score += kw.length; // longer phrases beat short ones for stable ranking
      hits.push(kw);
    }
  }
  return { score, hits };
}

function pickCommand(task) {
  let best = null;
  for (const item of INTENT_TABLE) {
    const { score, hits } = scoreCommand(task, item);
    if (score === 0) continue;
    if (!best || score > best.score) best = { ...item, score, hits };
  }
  // Confidence: top-score / sum-of-all-scores; saturates at 1.0 when only
  // one command matched.
  let confidence = 0;
  if (best) {
    const totals = INTENT_TABLE.map((it) => scoreCommand(task, it).score);
    const sum = totals.reduce((a, b) => a + b, 0);
    confidence = sum > 0 ? best.score / sum : 0;
  }
  return { command: best?.command || '/maddu-help', confidence, hits: best?.hits || [] };
}

async function loadLaneCatalog(repoRoot) {
  // Consumer-side: .maddu/lanes/catalog.json (operator-owned, seeded at init).
  const p = join(repoRoot, '.maddu', 'lanes', 'catalog.json');
  try {
    const text = await readFile(p, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.lanes) ? parsed.lanes : [];
  } catch { return []; }
}

async function loadRecentActivity(repoRoot) {
  // Read the spine projection; pull the most recent LANE_CLAIMED /
  // SLICE_STOP per lane for recency tie-breaks. Lazy-import to keep
  // the suggest command lightweight when projections aren't needed.
  try {
    const candidates = [
      // Consumer layout: maddu/runtime/lib/projections.mjs
      join(repoRoot, 'maddu', 'runtime', 'lib', 'projections.mjs'),
      // Source layout: template/maddu/runtime/lib/projections.mjs
      join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'projections.mjs'),
    ];
    let projMod = null;
    for (const c of candidates) {
      try { await stat(c); projMod = await import(pathToFileURL(c).href); break; } catch {}
    }
    if (!projMod) return new Map();
    const p = await projMod.project(repoRoot);
    // p.claims is a Map(lane -> {...}). p.sliceStops is an array (newest last).
    const recencyByLane = new Map();
    if (p.claims instanceof Map) {
      for (const [lane, claim] of p.claims) {
        recencyByLane.set(lane, Date.parse(claim.claimedAt || 0) || 0);
      }
    }
    if (Array.isArray(p.sliceStops)) {
      // Walk newest-first; for each lane mentioned in a slice-stop's
      // targets/paths, bump recency. Slice-stops don't carry a lane
      // field explicitly — skip if absent.
      for (let i = p.sliceStops.length - 1; i >= 0; i--) {
        const s = p.sliceStops[i];
        const lane = s?.lane || s?.data?.lane;
        if (!lane) continue;
        const ts = Date.parse(s.ts || 0) || 0;
        if (ts > (recencyByLane.get(lane) || 0)) recencyByLane.set(lane, ts);
      }
    }
    return recencyByLane;
  } catch { return new Map(); }
}

// English stopwords filtered before lane-keyword matching. Without this,
// "fix the login form" picks any lane whose scope happens to contain the
// substring "the" — which is almost any of them.
const STOPWORDS = new Set([
  'the','and','for','from','with','into','onto','that','this','these','those',
  'fix','add','use','run','get','make','have','has','had','will','would','should',
  'about','after','before','below','above','some','any','all','just','only',
  'when','where','what','why','how','who','which','because','also','than',
  'more','less','very','can','could','please','want','need','task','thing'
]);

function scoreLane(task, lane) {
  const tokens = tokenize(task);
  if (tokens.length === 0) return { score: 0, hits: [] };
  const haystack = `${lane.id} ${lane.scope || ''}`.toLowerCase();
  // Word-boundary match — substring-of-substring noise (e.g. "the" inside
  // "authentication") would otherwise dominate. Split haystack on
  // non-alphanumerics so token matching is whole-word.
  const haystackTokens = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
  let score = 0;
  const hits = [];
  for (const tk of tokens) {
    if (tk.length < 3) continue;
    if (STOPWORDS.has(tk)) continue;
    if (haystackTokens.has(tk)) {
      score += tk.length;
      hits.push(tk);
    }
  }
  return { score, hits };
}

function pickLane(task, lanes, recencyByLane) {
  const scored = lanes
    .map((lane) => {
      const { score, hits } = scoreLane(task, lane);
      const recency = recencyByLane.get(lane.id) || 0;
      return { lane, score, hits, recency };
    })
    .filter((x) => x.score > 0);

  if (scored.length === 0) {
    // No keyword hit. Fall back to the most recently active lane (if any),
    // else the first lane in the catalog (deterministic ordering).
    const recent = [...recencyByLane.entries()].sort((a, b) => b[1] - a[1])[0];
    if (recent) {
      const lane = lanes.find((l) => l.id === recent[0]);
      if (lane) return { laneId: lane.id, score: 0, hits: [], reason: 'most-recent-activity' };
    }
    return { laneId: lanes[0]?.id || null, score: 0, hits: [], reason: 'first-in-catalog' };
  }

  // Sort: score desc, then recency desc, then lane id asc (stable + deterministic).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.recency !== a.recency) return b.recency - a.recency;
    return a.lane.id.localeCompare(b.lane.id);
  });
  const top = scored[0];
  return { laneId: top.lane.id, score: top.score, hits: top.hits, reason: 'keyword-match' };
}

export default async function suggest(argv) {
  const { flags } = parseFlags(argv);
  const task = flags.task;
  if (!task) {
    console.error('maddu suggest: --task "<text>" is required');
    process.exit(2);
  }
  const repoRoot = await findRepoRoot(process.cwd()) || process.cwd();

  const { command, confidence, hits: commandHits } = pickCommand(task);

  const lanes = await loadLaneCatalog(repoRoot);
  const recency = await loadRecentActivity(repoRoot);
  const { laneId, score: laneScore, hits: laneHits, reason: laneReason } = pickLane(task, lanes, recency);

  const result = {
    task,
    command,
    lane: laneId,
    confidence: Math.round(confidence * 100) / 100,
    reasoning: [
      `command: ${command} (matched ${commandHits.length ? commandHits.join(', ') : 'no keyword — defaulted to /maddu-help'})`,
      `lane: ${laneId || '(none)'} (${laneReason}; ${laneHits.length ? `matched ${laneHits.join(', ')}` : 'no keyword'})`,
    ],
  };

  if (flags['emit-lane']) {
    process.stdout.write((laneId || '') + '\n');
    return;
  }
  if (flags['emit-command']) {
    process.stdout.write(command + '\n');
    return;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  // Human-friendly default.
  console.log(`Suggestion for: ${JSON.stringify(task)}`);
  console.log(`  command: ${command}`);
  console.log(`  lane:    ${laneId || '(none in catalog)'}`);
  console.log(`  confidence: ${result.confidence}`);
  for (const line of result.reasoning) console.log(`  · ${line}`);
}
