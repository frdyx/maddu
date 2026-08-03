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
    return searchMemory(repoRoot, args.query, {
      kind: typeof args.kind === 'string' ? args.kind : null,
      limit: Number.isFinite(args.limit) ? args.limit : 50,
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
    if (typeof args.page === 'string' && args.page) {
      const text = await readPage(repoRoot, args.page);
      if (text === null) throw invalidParams(`no wiki page "${args.page}"`);
      return { page: args.page, text };
    }
    return { pages: await listWiki(repoRoot) };
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
    return {
      goal: proj.goal || null,
      phase: proj.phase || null,
      lastEventId: proj.lastEventId || null,
      eventCount: proj.eventCount ?? null,
      activeSessions: Object.values(proj.sessions || {}).filter((s) => s.status === 'active').length,
      laneClaims: (proj.claims || []).map((c) => ({ lane: c.lane, sessionId: c.sessionId })),
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
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(-32600, 'invalid request');
  }
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
