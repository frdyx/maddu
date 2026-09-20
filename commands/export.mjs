// `maddu export --otel` — read-side spine → OpenTelemetry (OTLP/JSON) log export.
//
// Usage:
//   maddu export --otel                        all events → OTLP JSON on stdout
//   maddu export --otel --since <eventId>      only events after <eventId>
//   maddu export --otel --pretty               pretty-printed (default: compact)
//   maddu export --otel --follow               stream: initial batch, then tail
//   maddu export --otel --endpoint <url>       POST OTLP to an OTLP/HTTP collector
//   maddu export --otel --endpoint <url> --header "Authorization: Bearer …"
//
// Discipline (per the framework's posture):
//   - READ-ONLY. Reads the append-only spine; writes nothing, mutates nothing.
//   - stdout by default. `--endpoint` POSTs per-invocation to a URL you pass —
//     no stored credentials, no background daemon. `--header` (repeatable) rides
//     only for that one invocation.
//   - Never touches auth/token files; the spine carries no secrets (e.g.
//     SECRET_DETECTED_IN_ARGV records the pattern name, never the value).
//   - Pure mapping lives in runtime/lib/otel.mjs; this file is only I/O.

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m' };
const err = (s) => process.stderr.write(s + '\n');

function usage() {
  err('Usage: maddu export --otel [--since <eventId>] [--follow] [--pretty]');
  err('                     [--endpoint <url> [--header "K: V"]...] [--service <name>]');
  err('');
  err('  Read-side spine → OTLP/JSON log-record export. stdout by default;');
  err('  --endpoint POSTs to an OTLP/HTTP collector (typically <collector>/v1/logs)');
  err('  per invocation — no stored creds, no daemon.');
}

// `--header "K: V"` — parseFlags already arrays repeats and handles `--header=…`,
// so read from the parsed flag value (string | string[] | undefined).
function collectHeaders(headerFlag) {
  const list = headerFlag == null ? [] : (Array.isArray(headerFlag) ? headerFlag : [headerFlag]);
  const headers = {};
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const idx = raw.indexOf(':');
    if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }
  return headers;
}

// The endpoint as it may be SHOWN (v1.143.0, P0 audit A4-002). The URL a user
// passes can carry credentials — `https://user:token@collector/…` or an api key
// in the query — and the sent/FAILED banners used to echo it verbatim into
// terminal scrollback and CI logs, while the payload one call away was scrubbed
// twice. Userinfo becomes `***`, every query VALUE becomes `***` (keys stay so
// the operator can still recognise the collector), host/path/port are kept. A
// string that is not a URL gets its `//user:pw@` masked by a fallback. Pure;
// never throws; the real endpoint is still used for the POST.
export function maskEndpointForDisplay(raw) {
  if (typeof raw !== 'string') return String(raw);
  try {
    const u = new URL(raw);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    if (u.search) {
      const masked = new URLSearchParams();
      for (const [k] of new URLSearchParams(u.search)) masked.append(k, '***');
      u.search = masked.toString();
    }
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^/@\s]+@/g, '//***@');
  }
}

async function post(endpoint, payload, headers) {
  if (typeof fetch !== 'function') throw new Error('global fetch is unavailable (needs Node ≥ 18)');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  // OTLP/HTTP partial success is a 200 with a body carrying rejected counts.
  let rejected = 0;
  try {
    const body = await res.json();
    rejected = Number(body?.partialSuccess?.rejectedLogRecords || 0);
  } catch { /* empty/non-JSON body = full success by the OTLP spec */ }
  return { status: res.status, ok: res.ok && rejected === 0, httpOk: res.ok, rejected };
}

export default async function exportCmd(argv) {
  const { flags } = parseFlags(argv);
  if (!flags.otel) {
    err(`${ANSI.fail}maddu export: only --otel is supported${ANSI.reset}`);
    usage();
    process.exit(2);
  }

  const { paths, spine } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const otel = await loadLib('otel.mjs');

  const endpoint = typeof flags.endpoint === 'string' ? flags.endpoint : null;
  const headers = endpoint ? collectHeaders(flags.header) : {};
  // What the operator sees (v1.143.0, A4-002): the banners and any error text
  // name the endpoint ONLY in masked form. Node's fetch refuses a URL that embeds
  // credentials and its error message echoes the whole URL — so an embedded
  // user:token used to leak through that message even though the POST never
  // happened. Refuse it here, masked, and point at --header.
  const shownEndpoint = endpoint ? maskEndpointForDisplay(endpoint) : null;
  const maskMessage = (msg) => {
    let s = String(msg == null ? '' : msg);
    if (endpoint && shownEndpoint && endpoint !== shownEndpoint) s = s.split(endpoint).join(shownEndpoint);
    return s.replace(/\/\/[^/@\s]+@/g, '//***@');
  };
  if (endpoint) {
    let credentialed = false;
    try { const u = new URL(endpoint); credentialed = !!(u.username || u.password); } catch { /* not a URL — fetch will say so, masked */ }
    if (credentialed) {
      err(`${ANSI.fail}maddu export: --endpoint must not embed credentials${ANSI.reset} (${shownEndpoint}) — fetch refuses them; pass them with --header "Authorization: …" instead`);
      process.exit(2);
    }
  }
  const service = typeof flags.service === 'string' ? flags.service : 'maddu';
  const pretty = !!flags.pretty && !flags.follow; // pretty is for one-shot reads
  const since = typeof flags.since === 'string' ? flags.since : null;

  const observedNano = () => String(BigInt(Date.now()) * 1000000n);

  // Returns { count, delivered }. `delivered` is false when an --endpoint POST
  // fails or partially rejects — the caller (follow) must NOT advance past an
  // undelivered batch, or those events are silently dropped.
  async function emit(events) {
    if (!events.length) return { count: 0, delivered: true };
    const payload = otel.toOtlpPayload(events, { observedNano: observedNano(), serviceName: service });
    if (endpoint) {
      let r;
      try {
        r = await post(endpoint, payload, headers);
      } catch (e) {
        err(`${ANSI.fail}FAILED${ANSI.reset}  ${events.length} record(s) → ${shownEndpoint}  ${ANSI.dim}${maskMessage(e && e.message)}${ANSI.reset}`);
        process.exitCode = 1;
        return { count: 0, delivered: false };
      }
      const rej = r.rejected ? ` · ${ANSI.warn}${r.rejected} rejected${ANSI.reset}` : '';
      err(`${r.ok ? ANSI.pass + 'sent' : ANSI.fail + 'FAILED'}${ANSI.reset}  ${events.length} record(s) → ${shownEndpoint}  ${ANSI.dim}HTTP ${r.status}${ANSI.reset}${rej}`);
      if (!r.ok) process.exitCode = 1;
      return { count: events.length, delivered: r.ok };
    }
    process.stdout.write(JSON.stringify(payload, null, pretty ? 2 : 0) + '\n');
    return { count: events.length, delivered: true };
  }

  // Initial batch. Read the whole spine once, then slice after --since. A bad
  // --since must NOT silently export everything (readSince returns all when the
  // id is absent — a replay footgun for an outbound export), so verify it.
  const full = await spine.readAll(repoRoot);
  let batch = full;
  if (since) {
    const idx = full.findIndex((e) => e.id === since);
    if (idx < 0) {
      err(`${ANSI.fail}maddu export: --since event id not found on the spine: ${since}${ANSI.reset}`);
      process.exit(2);
    }
    batch = full.slice(idx + 1);
  }
  const first = await emit(batch);
  // lastId = the last DELIVERED event id. If the initial batch failed to deliver
  // (endpoint mode), keep the pre-batch anchor so --follow retries it rather than
  // skipping past it (a null anchor makes readSince re-read from the top).
  let lastId = (first.delivered && batch.length) ? batch[batch.length - 1].id : (since || null);

  if (!flags.follow) {
    if (endpoint) err(`${ANSI.dim}exported ${first.count} event(s)${ANSI.reset}`);
    return;
  }

  // Follow: tail the spine, emitting each new batch as its own OTLP payload
  // line (NDJSON of payloads). Poll — the spine is append-only files, no daemon.
  err(`${ANSI.dim}following spine (Ctrl-C to stop)…${ANSI.reset}`);
  const intervalMs = Number.isFinite(Number(flags.interval)) ? Math.max(250, Number(flags.interval)) : 2000;
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  while (!stop) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (stop) break;
    const fresh = await spine.readSince(repoRoot, lastId);
    if (fresh.length) {
      const r = await emit(fresh);
      // Only advance past a DELIVERED batch; an undelivered one stays pending
      // and is retried on the next poll.
      if (r.delivered) lastId = fresh[fresh.length - 1].id;
    }
  }
}
