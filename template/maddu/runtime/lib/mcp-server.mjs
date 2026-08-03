// Máddu as an MCP server — read-only stdio facade over the runtime libs.
//
// v1.115.0 (memory-recall track, Phase 5). Hand-rolled newline-delimited
// JSON-RPC 2.0 over stdio — Node stdlib only (hard rule 4), no protocol
// dependency. Prior art: the complete stdio servers embedded in
// template/maddu/mcp-templates/*.json. mcp.mjs remains the CLIENT registry
// (Máddu consuming other servers); this module is Máddu BEING one.
//
// Contract: READ-ONLY, zero duplicated domain logic. Every tool forwards to
// an existing lib (search / hindsight / recall / wiki / projections /
// atlas-view) — this file owns framing and dispatch, nothing else. It never
// appends to the spine: inspection is not injection, so recall_packet here
// emits no MEMORY_INJECTED (only `brief --for-agent` witnesses feeds).
// The conformance fixture (scripts/test/mcp-serve.mjs) hash-proves the
// read-only property over .maddu/events/*.
//
// atlas_query degrades gracefully: atlas-view.mjs ships on the atlas track —
// where absent, the tool answers with an `atlas_unavailable` payload
// (mirroring the bridge's 503 posture) instead of failing tools/list.

import { search as crossSearch, KINDS as SEARCH_KINDS } from './search.mjs';
import { searchMemory, factsWithTrust } from './hindsight.mjs';
import { buildRecallPacket } from './recall.mjs';
import { listWiki, readPage } from './wiki.mjs';
import { project } from './projections.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'memory_search',
    description: 'Search Máddu memory facts (hindsight-extracted rules, constraints, discoveries, corrections). Results carry trust states: approved facts are operator-attested; asserted facts are unreviewed agent assertions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'substring to match against fact text and tags' },
        kind: { type: 'string', description: 'optional fact kind filter (rule|constraint|discovery|followup|touched|gate|summary|correction|vendor)' },
        limit: { type: 'number', description: 'max results (default 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'recall_packet',
    description: 'The bounded, trust-gated recall packet — the SAME packet `maddu brief --for-agent` injects. Only operator-approved facts appear in items; withheld lists what was excluded and why. Read-only: calling this never emits injection events.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'optional query; empty returns the standing rules/constraints digest' },
        lane: { type: 'string', description: 'optional lane id to boost same-lane facts' },
        tags: { type: 'array', items: { type: 'string' }, description: 'optional context tags' },
      },
    },
  },
  {
    name: 'wiki_read',
    description: 'Read the per-lane wiki (append-only slice-stop digests). Without `page`, lists pages with size and mtime; with `page`, returns that page markdown.',
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'string', description: 'page filename, e.g. lane-harness.md or general.md' } },
    },
  },
  {
    name: 'atlas_query',
    description: 'Query the Atlas architecture read model (entities, flows, findings). Answers { error: "atlas_unavailable" } on installs without the atlas subsystem.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: 'one of: status | overview | entities | findings (default status)' },
        id: { type: 'string', description: 'optional entity/finding id for a single-record view' },
      },
    },
  },
  {
    name: 'status',
    description: 'Máddu projection snapshot: goal, phase, active sessions, lane claims, event count.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(repoRoot, name, args = {}) {
  if (name === 'memory_search') {
    if (typeof args.query !== 'string' || !args.query.trim()) {
      throw invalidParams('query (string) is required');
    }
    // Clamp caller-controlled limit (r2 major 5): 0/negative/huge values must
    // never dump the whole corpus into agent context (searchMemory clamps
    // too — defense at both layers).
    const lim = Number.isFinite(Number(args.limit)) ? Math.min(Math.max(1, Math.floor(Number(args.limit))), 200) : 50;
    return searchMemory(repoRoot, args.query, {
      kind: typeof args.kind === 'string' ? args.kind : null,
      limit: lim,
    });
  }
  if (name === 'recall_packet') {
    const facts = await factsWithTrust(repoRoot);
    return buildRecallPacket({
      facts,
      query: typeof args.query === 'string' ? args.query : '',
      lane: typeof args.lane === 'string' ? args.lane : null,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
    });
  }
  if (name === 'wiki_read') {
    // Bounded like every other tool (r3 major 6): a naturally large or
    // hand-edited page must not consume arbitrary agent context in one call.
    const MAX_PAGE_BYTES = 65536;
    const MAX_PAGE_LIST = 200;
    if (typeof args.page === 'string' && args.page) {
      // Never reflect the raw caller argument (r4 major 6): a megabyte page
      // name that sanitizes to an existing file must not echo back whole.
      const pageName = args.page.slice(0, 256);
      const text = await readPage(repoRoot, pageName);
      if (text === null) throw invalidParams(`no wiki page "${pageName.slice(0, 64)}"`);
      const buf = Buffer.from(text, 'utf8');
      const truncated = buf.byteLength > MAX_PAGE_BYTES;
      return {
        page: pageName,
        text: truncated ? buf.subarray(0, MAX_PAGE_BYTES).toString('utf8') : text,
        totalBytes: buf.byteLength,
        ...(truncated ? { truncated: true, note: 'page exceeds 64KB — read the file directly or use narrower tooling' } : {}),
      };
    }
    const pages = await listWiki(repoRoot);
    return { pages: pages.slice(0, MAX_PAGE_LIST), pagesTotal: pages.length };
  }
  if (name === 'atlas_query') {
    let atlas = null;
    try { atlas = await import('./atlas-view.mjs'); } catch {}
    if (!atlas?.loadAtlasView) return { error: 'atlas_unavailable', detail: 'this install has no atlas subsystem' };
    const view = await atlas.loadAtlasView(repoRoot);
    const which = typeof args.view === 'string' ? args.view : 'status';
    if (which === 'status') return atlas.getStatus(view);
    if (which === 'overview') return atlas.getOverview(view);
    if (which === 'entities') return args.id ? atlas.getEntity(view, args.id) : atlas.listEntities(view, {});
    if (which === 'findings') return args.id ? atlas.getFinding(view, args.id) : atlas.listFindings(view, {});
    throw invalidParams(`unknown atlas view "${which}" (status|overview|entities|findings)`);
  }
  if (name === 'status') {
    const proj = await project(repoRoot);
    // Shaped like every other tool (r4 major 7): goal/phase/claims are
    // operator-authored unbounded structures — cap before they reach agent
    // context.
    const cap = (s, n) => { const v = String(s ?? ''); return v.length > n ? v.slice(0, n) + '…' : v; };
    const capList = (xs, n, len) => (Array.isArray(xs) ? xs.slice(0, n).map((x) => cap(typeof x === 'string' ? x : JSON.stringify(x), len)) : []);
    const goal = proj.goal && typeof proj.goal === 'object'
      ? {
          // Projections store the declaration as `objective` (r5 minor 5).
          text: cap(proj.goal.objective ?? proj.goal.text ?? proj.goal.goal, 500),
          constraints: capList(proj.goal.constraints, 10, 200),
          success: capList(proj.goal.success, 10, 200),
        }
      : proj.goal ? cap(proj.goal, 500) : null;
    return {
      goal,
      phase: proj.phase && typeof proj.phase === 'object' ? cap(JSON.stringify(proj.phase), 500) : cap(proj.phase, 200) || null,
      lastEventId: cap(proj.lastEventId, 128) || null,
      eventCount: proj.eventCount ?? null,
      activeSessions: Object.values(proj.sessions || {}).filter((s) => s.status === 'active').length,
      laneClaims: (proj.claims || []).slice(0, 50).map((c) => ({ lane: cap(c.lane, 128), sessionId: cap(c.sessionId, 128) })),
      searchKinds: SEARCH_KINDS,
    };
  }
  const err = new Error(`unknown tool: ${name}`);
  err.rpcCode = -32602;
  throw err;
}

function invalidParams(msg) {
  const err = new Error(msg);
  err.rpcCode = -32602;
  return err;
}

// Handle one parsed JSON-RPC message. Returns the response object, or null
// for notifications (no id → nothing goes back on the wire).
export async function handleMessage(repoRoot, msg, { serverVersion = '0.0.0' } = {}) {
  // Invalid-request law (Codex r1 minor 14): valid JSON that is not a valid
  // JSON-RPC request — null, numbers, arrays, {} — must answer -32600 with
  // id null (per spec), never throw and never be silently swallowed as a
  // "notification". Only a WELL-FORMED request without an id is a
  // notification.
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)
      || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // Echo the id only when it is itself VALID (r9 minor 2): an invalid
    // envelope with id:false/{}/[] answers with id null, never an echo.
    const id = (msg && typeof msg === 'object' && !Array.isArray(msg)
      && (typeof msg.id === 'string' || typeof msg.id === 'number')) ? msg.id : null;
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } };
  }
  // MCP 2024-11-05 forbids null request ids (r2 minor 6), and JSON-RPC ids
  // must be strings or numbers (r8 minor 3: false/{}/[] were accepted and
  // echoed). Any present-but-invalid id → -32600 with id null; only a
  // message WITHOUT an id key is a notification.
  if ('id' in msg && typeof msg.id !== 'string' && typeof msg.id !== 'number') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: id must be a string or number (omit id for notifications)' } };
  }
  const isNotification = !('id' in msg);
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.method === 'initialize') {
    return reply({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'maddu', version: serverVersion },
    });
  }
  if (msg.method.startsWith('notifications/')) return null;
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') {
    return reply({ tools: TOOLS });
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    if (typeof name !== 'string') return fail(-32602, 'params.name (string) required');
    try {
      const result = await callTool(repoRoot, name, args);
      return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      if (err.rpcCode === -32602) return fail(-32602, err.message);
      // Tool execution failure — MCP convention: isError result, not protocol error.
      return reply({ content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
  }
  return fail(-32601, `method not found: ${msg.method}`);
}

// Serve newline-delimited JSON-RPC over the given streams until stdin ends.
export function serveMcp(repoRoot, { input = process.stdin, output = process.stdout, serverVersion = '0.0.0' } = {}) {
  let buf = '';
  return new Promise((resolve) => {
    input.setEncoding('utf8');
    input.on('data', async (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch {
          output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
          continue;
        }
        const res = await handleMessage(repoRoot, msg, { serverVersion });
        if (res) output.write(JSON.stringify(res) + '\n');
      }
    });
    input.on('end', () => resolve());
  });
}
