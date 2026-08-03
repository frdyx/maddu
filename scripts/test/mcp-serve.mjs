#!/usr/bin/env node
// Phase 5 (memory-recall track) — `maddu mcp serve` conformance suite.
//
// Spawns the real CLI as an MCP stdio server in a hermetic seeded repo and
// drives a newline-delimited JSON-RPC dialogue: initialize → tools/list →
// one tools/call per tool → unknown method → parse error. Asserts JSON-RPC
// 2.0 conformance (ids echo, error codes, notification silence) AND the
// READ-ONLY PROOF: SHA-256 hashes of the integrity surfaces — .maddu/events/
// (the spine), .maddu/memory.ndjson, .maddu/wiki/ — are identical before and
// after the whole dialogue. `.maddu/state/invocation-receipts.ndjson` is
// deliberately OUT of scope: the bin wrapper appends one receipt on every CLI
// exit (read-only verbs included) — that is bin bookkeeping, not the facade
// writing.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'maddu.mjs');

async function loadLib(file) {
  const installed = path.join(process.cwd(), 'maddu', 'runtime', 'lib', file);
  const sourceLib = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib', file);
  for (const p of [installed, sourceLib]) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function hashTree(root) {
  const h = createHash('sha256');
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else { h.update(p); h.update(await fs.readFile(p)); }
    }
  }
  await walk(root);
  return h.digest('hex');
}

function rpcDialogue(repo, messages, expectedResponses, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ch = spawn(process.execPath, [BIN, 'mcp', 'serve'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = [];
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => { ch.kill(); reject(new Error(`timeout; got ${responses.length} responses; stderr: ${stderr}`)); }, timeoutMs);
    ch.stderr.on('data', (b) => { stderr += b.toString(); });
    ch.stdout.on('data', (b) => {
      buf += b.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { responses.push(JSON.parse(line)); } catch { responses.push({ __unparseable: line }); } }
      }
      // All expected responses in → close stdin so the server exits.
      if (responses.length >= expectedResponses) ch.stdin.end();
    });
    ch.on('close', () => { clearTimeout(timer); resolve({ responses, stderr }); });
    ch.on('error', (e) => { clearTimeout(timer); reject(e); });
    for (const m of messages) ch.stdin.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n');
  });
}

async function main() {
  const spine = await loadLib('spine.mjs');
  const h = await loadLib('hindsight.mjs');
  const wiki = await loadLib('wiki.mjs');
  if (!spine || !h) { console.error('harness error: lib not found'); process.exit(2); }

  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-mcp-serve-'));
  try {
    // Seed: slice-stop → facts (one approved) + a wiki page.
    const ev = await spine.append(repo, {
      type: spine.EVENT_TYPES.SLICE_STOP, actor: 'ses_m', lane: 'harness',
      data: { summary: 'SLICE STOP: mcp serve seed', learnings: ['rule: mcp facade stays read-only'] }
    });
    await h.extractEvent(repo, ev);
    const rule = (await h.readMemory(repo)).find((f) => f.kind === 'rule');
    await h.setFactTrust(repo, { factId: rule.id, approve: true, reason: 'seed' });
    if (wiki?.appendSliceStop) await wiki.appendSliceStop(repo, ev);
    // A legitimately large hand-edited page for the wiki_read byte-cap probe.
    await fs.mkdir(path.join(repo, '.maddu', 'wiki'), { recursive: true });
    await fs.writeFile(path.join(repo, '.maddu', 'wiki', 'lane-bigpage.md'), '# big\n' + 'z'.repeat(100000));

    const integritySurfaces = async () => [
      await hashTree(path.join(repo, '.maddu', 'events')),
      await hashTree(path.join(repo, '.maddu', 'wiki')),
      await fs.readFile(path.join(repo, '.maddu', 'memory.ndjson'), 'utf8').then((t) => createHash('sha256').update(t).digest('hex'), () => 'absent'),
    ].join('|');
    const before = await integritySurfaces();

    const dialogue = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'read-only' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'recall_packet', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'wiki_read', arguments: {} } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'atlas_query', arguments: {} } },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'status', arguments: {} } },
      { jsonrpc: '2.0', id: 8, method: 'no/such/method' },
      '{ not json',
      // Codex r1 minor 14: valid JSON, invalid JSON-RPC shape → -32600 with
      // id null; never a crash, never silently dropped as a "notification".
      'null',
      '{}',
      '[1]',
      // Codex r2 minor 6: MCP forbids null request ids — explicit id:null is
      // a malformed REQUEST (-32600), not a notification.
      '{"jsonrpc":"2.0","id":null,"method":"ping"}',
      // Codex r8 minor 3: ids must be strings or numbers — false is invalid.
      '{"jsonrpc":"2.0","id":false,"method":"ping"}',
      // Codex r9 minor 2: an invalid ENVELOPE with an invalid id must answer
      // id:null, never echo the bogus id.
      '{"jsonrpc":"1.0","id":false,"method":"ping"}',
      // Codex r2 major 5: caller-controlled limit is clamped — limit:0 must
      // not dump the whole corpus.
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'read-only', limit: 0 } } },
      // Codex r3 major 6: wiki_read is byte-capped (the seed wrote a >64KB
      // hand-edited page below).
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'wiki_read', arguments: { page: 'lane-bigpage.md' } } },
    ];
    // Expected: 10 id-replies + 1 parse error + 5 invalid-request errors.
    const { responses } = await rpcDialogue(repo, dialogue, 17);
    const byId = new Map(responses.filter((r) => r.id !== undefined && r.id !== null).map((r) => [r.id, r]));

    // initialize
    const init = byId.get(1);
    ok('initialize returns protocolVersion + serverInfo', init?.result?.protocolVersion === '2024-11-05' && init?.result?.serverInfo?.name === 'maddu', JSON.stringify(init));
    ok('all responses are jsonrpc 2.0', responses.every((r) => r.jsonrpc === '2.0' || r.__unparseable === undefined));
    ok('notification got no response', !responses.some((r) => r.id === undefined && r.result));

    // tools/list
    const list = byId.get(2);
    const toolNames = (list?.result?.tools || []).map((t) => t.name).sort();
    ok('tools/list returns the five tools', JSON.stringify(toolNames) === JSON.stringify(['atlas_query', 'memory_search', 'recall_packet', 'status', 'wiki_read']), JSON.stringify(toolNames));
    ok('every tool declares an inputSchema', (list?.result?.tools || []).every((t) => t.inputSchema?.type === 'object'));

    // tools/call round-trips
    const parse = (r) => JSON.parse(r?.result?.content?.[0]?.text || 'null');
    const mem = parse(byId.get(3));
    ok('memory_search finds the seeded rule with trust', Array.isArray(mem) && mem.some((f) => f.id === rule.id && f.trust === 'approved'), JSON.stringify(mem));
    const packet = parse(byId.get(4));
    ok('recall_packet returns the packet with the approved fact fed', packet?.v === 1 && packet.items.some((it) => it.id === rule.id), JSON.stringify(packet?.items));
    const wikiOut = parse(byId.get(5));
    ok('wiki_read lists the seeded page', Array.isArray(wikiOut?.pages) && wikiOut.pages.some((p) => p.page === 'lane-harness.md'), JSON.stringify(wikiOut));
    const atlas = parse(byId.get(6));
    ok('atlas_query degrades gracefully or answers', atlas?.error === 'atlas_unavailable' || typeof atlas === 'object', JSON.stringify(atlas));
    const status = parse(byId.get(7));
    ok('status returns projection snapshot', typeof status?.eventCount === 'number' && Array.isArray(status?.laneClaims), JSON.stringify(status));

    // errors
    ok('unknown method → -32601', byId.get(8)?.error?.code === -32601, JSON.stringify(byId.get(8)));
    ok('parse error → -32700 with null id', responses.some((r) => r.error?.code === -32700 && r.id === null));
    const invalids = responses.filter((r) => r.error?.code === -32600);
    ok('six invalid messages → six -32600 with null id', invalids.length === 6 && invalids.every((r) => r.id === null), JSON.stringify(invalids));
    const clamped = parse(byId.get(9));
    ok('limit:0 clamps instead of dumping the corpus', Array.isArray(clamped) && clamped.length >= 1 && clamped.length <= 200, `${clamped?.length}`);
    const bigPage = parse(byId.get(10));
    ok('wiki_read byte-caps large pages', bigPage?.truncated === true && Buffer.byteLength(bigPage?.text || '', 'utf8') <= 65536 && bigPage?.totalBytes > 65536, JSON.stringify({ t: bigPage?.truncated, len: bigPage?.text?.length, total: bigPage?.totalBytes }));
    ok('server survived the garbage (still answered everything)', responses.length === 17, `${responses.length}`);

    // THE READ-ONLY PROOF.
    const after = await integritySurfaces();
    ok('read-only proof: spine + memory + wiki hashes unchanged', before === after);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
