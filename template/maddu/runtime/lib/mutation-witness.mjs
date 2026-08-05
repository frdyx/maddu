// Mutation-witness coverage guard (buzz-steals S1, v1.116.0).
//
// The spine's prev_hash chain proves recorded history wasn't altered; nothing
// proved a mutating seam RECORDED AT ALL. This lib is the runtime complement
// to the static tier census: a mutating seam (CLI verb / bridge write
// endpoint) that exits claiming success with zero spine appends and no
// declared no-op is a breach — witnessed as MUTATION_UNWITNESSED and failed
// non-zero. Silence is the only red; excuses must be declared
// (witnessNoop(reason)); a crash is not silent (non-zero exits never breach).
//
// Emission is TWO-STAGE on the CLI (Codex plan-review r1 F1 / r2 F3 / r3 F4 /
// r5 F1): commands call process.exit() directly (491 sites), so the verdict
// runs in a process 'exit' handler where only sync I/O works and the async
// append lock cannot be taken — a sync chained append could fork the
// prev_hash chain. So the exit handler writes one spool FILE per breach
// (O_EXCL, unique breachId) under .maddu/state/mutation-breaches/, and the
// NEXT dispatcher run drains the spool onto the spine through the normal
// funnel (via:'breach-drain'), claiming each file by atomic rename so
// concurrent dispatchers drain exactly-once in the normal path. Crash between
// append and unlink → at-least-once, deduped by breachId downstream. The
// bridge is long-lived and appends breaches inline (via:'inline'); if THAT
// append fails it falls back to this same spool (never rewrites the already-
// flushed HTTP response).
//
// ALS-loss law (r? design C): the CLI gets a module-level fallback context —
// one command per process makes it exact, not a green-wash. The bridge gets
// NO fallback: a lost per-request context stays uncredited (red-biased).
//
// Known residual (documented, out of scope): a seam that mutates files and
// THEN crashes exits non-zero and does not breach — that is a
// transactionality defect, not a coverage defect; this guard's claim is
// "success was asserted silently", nothing more.
//
// Pure lib — no console output except the documented one-line stderr breach
// signal inside recordBreachSync's caller contract; no process.exit. Node
// stdlib + sibling libs only (hard rule 4; first node:async_hooks use in the
// repo — AsyncLocalStorage is stdlib).

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { redactText } from './secret-scan.mjs';

export const BREACH_DIR = 'mutation-breaches';               // under .maddu/state/
export const CLAIM_STALE_MS = 10 * 60 * 1000;                // cross-host / unverifiable claims only
const CAP = 128;                                             // per string field; one spool file stays ~1KB

// Process-wide witness state anchored on globalThis — NOT module-level.
// Multiple instances of this module can coexist in one process (bin resolves
// cwd-first, `upgrade` imports the template tree's spine directly, a dev bin
// can run against an installed fixture); a module-level store would strand
// credits in whichever instance the crediting writer happened to import
// (found by the S1 calibration pass). One shared anchor makes every instance
// credit the same context. Guarded-global precedent: __MADDU_SPINE_SEAM_HOOK__.
const G = globalThis;
if (!G.__MADDU_MUTATION_WITNESS__) {
  G.__MADDU_MUTATION_WITNESS__ = {
    als: new AsyncLocalStorage(),
    // CLI-only fallback context (exactly one command runs per CLI process, so
    // a process-level slot is exact when an EventEmitter callback loses the
    // ALS store). The bridge NEVER arms this — a lost bridge context must
    // stay uncredited (fail toward red).
    cliCtx: null,
  };
}
const W = G.__MADDU_MUTATION_WITNESS__;

function cap(s) { return s == null ? null : redactText(String(s)).text.slice(0, CAP); }

export function createWitnessContext(label, { mode = 'mutating', surface = 'cli', verb = null, sub = null, method = null, path = null, sessionId = null } = {}) {
  return {
    label: cap(label) ?? '(unlabeled)',
    mode,                    // 'mutating' | 'read' — read contexts count but never breach
    surface,                 // 'cli' | 'bridge'
    verb: cap(verb), sub: cap(sub), method: cap(method), path: cap(path),
    sessionId: cap(sessionId),
    appends: 0,              // spine.append successes credited to this seam
    raw: 0,                  // witnessRawWrite credits (census-pinned direct writers)
    noops: [],               // declared excuses [{reason, ts}]
  };
}

export function armCliWitness(ctx) { W.cliCtx = ctx; return ctx; }
export function disarmCliWitness() { W.cliCtx = null; }

export function currentWitness() {
  return W.als.getStore() ?? W.cliCtx;
}

// Run fn inside an EXISTING context (ALS propagation). The CLI creates its
// ctx first (the exit-handler verdict closes over it directly — no ALS lookup
// at exit), arms the fallback slot, then dispatches through this.
export async function runWithWitness(ctx, fn) {
  return W.als.run(ctx, fn);
}

// Run fn inside a fresh witness context. The BRIDGE wraps each request with
// this; the CLI uses runWithWitness (see bin/maddu.mjs).
export async function withMutationWitness(label, fn, opts = {}) {
  const ctx = createWitnessContext(label, opts);
  const result = await W.als.run(ctx, fn);
  return { result, ctx };
}

// Called by spine.mjs on every SUCCESSFUL logical append (once per event,
// regardless of the retry loop). Inert when no context is active.
// GUARDED TEST-ONLY seam (invocation-receipts `_testBeforeRename` precedent;
// nothing outside scripts/test/ sets it): __MADDU_TEST_ZERO_CREDIT__=1
// suppresses credits so a spawned-CLI test can force a deterministic breach
// on a command that really appends — the only way to exercise the
// spool→drain path end-to-end without shipping a deliberately silent verb.
export function witnessSpineAppend() {
  if (process.env.__MADDU_TEST_ZERO_CREDIT__ === '1') return;
  const ctx = currentWitness();
  if (ctx) ctx.appends++;
}

// Declared excuse for a legitimately zero-append success path (idempotent
// early-returns, projection-write-on-read bridge routes, plugin-declared
// no-ops). NEVER a spine event — counter credit + in-ctx row only; the census
// enumerates the call sites, so excuses are source-visible.
export function witnessNoop(reason) {
  const ctx = currentWitness();
  if (ctx) ctx.noops.push({ reason: cap(reason) ?? '(unspecified)', ts: new Date().toISOString() });
}

// A REAL witness for the census-pinned direct spine writers (init genesis)
// that bypass spine.append — counts as an append, tagged raw.
export function witnessRawWrite(reason) {
  const ctx = currentWitness();
  if (ctx) { ctx.appends++; ctx.raw++; if (reason) ctx.noops.push({ reason: `raw:${cap(reason)}`, ts: new Date().toISOString() }); }
}

// Declared delegation: the mutation lands on ANOTHER repo's spine under a
// child process's own guard (fleet upgrade --apply). An excuse, not a credit.
export function witnessDelegated(label, detail = null) {
  witnessNoop(detail ? `delegated:${label}:${detail}` : `delegated:${label}`);
}

// The one verdict law. A breach is: a MUTATING seam that reported SUCCESS
// while recording nothing and excusing nothing. Read mode never breaches;
// non-zero exit never breaches (a crash is not silent).
export function evaluateWitness(ctx, { exitCode = 0 } = {}) {
  const breach = !!ctx
    && ctx.mode === 'mutating'
    && exitCode === 0
    && ctx.appends === 0
    && ctx.noops.length === 0;
  return { breach, appends: ctx?.appends ?? 0, noops: ctx?.noops?.length ?? 0 };
}

function breachDir(stateRoot) { return join(stateRoot, '.maddu', 'state', BREACH_DIR); }

let seq = 0;
export function newBreachId() {
  return `br_${Date.now()}-${process.pid}-${++seq}-${randomBytes(4).toString('hex')}`;
}

// Sync spool write — the ONLY emission path available inside a process 'exit'
// handler. One file per breach, O_EXCL ('wx') so concurrent writers can never
// interleave, every field capped at construction. FAIL-OPEN like invocation
// receipts: a spool failure never blocks or noises the verb beyond the breach
// signal itself. Returns the breachId on write, null on any failure.
export function recordBreachSync({ stateRoot, ctx, exitCode = 0, via = 'breach-spool' }) {
  try {
    if (!stateRoot || !ctx) return null;
    const dir = breachDir(stateRoot);
    mkdirSync(dir, { recursive: true });
    const breachId = newBreachId();
    const row = {
      v: 1,
      breachId,
      breachTs: new Date().toISOString(),
      surface: ctx.surface, label: ctx.label,
      verb: ctx.verb, sub: ctx.sub, method: ctx.method, path: ctx.path,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      sessionId: ctx.sessionId, via,
    };
    writeFileSync(join(dir, `${breachId}.json`), JSON.stringify(row) + '\n', { flag: 'wx' });
    return breachId;
  } catch { return null; }
}

// ── Drain: spool → spine, exactly-once normal path ──────────────────────────
// Claim protocol (Codex r2 F3 + r3 F4): rename `<id>.json` →
// `<id>.json.draining.<claimedAtMs>-<host>-<pid>-<nonce>` — one process wins
// each rename, and the claim transition CARRIES ITS OWN TIMESTAMP (a plain
// rename preserves the breach file's mtime, so mtime is never the staleness
// signal). Reclaim law: same-host claims only when the PID is proven dead
// (kill(pid, 0) → ESRCH); cross-host/unverifiable claims by claimedAtMs age.

const CLAIM_RE = /^(?<base>.+\.json)\.draining\.(?<at>\d+)-(?<host>[^-]*)-(?<pid>\d+)-(?<nonce>[a-f0-9]+)$/;

function pidAliveSameHost(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err && err.code === 'EPERM'; } // EPERM = alive, not ours
}

function claimName(base) {
  return `${base}.draining.${Date.now()}-${hostname().replace(/-/g, '_').slice(0, 32)}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

// Reclaim stale claims (rename back to the bare spool name) so a crashed
// drainer never strands a breach. Sync + fail-open per file.
export function reclaimStaleClaimsSync(stateRoot, { now = Date.now() } = {}) {
  const dir = breachDir(stateRoot);
  let names = [];
  try { names = readdirSync(dir); } catch { return 0; }
  let reclaimed = 0;
  for (const name of names) {
    const m = CLAIM_RE.exec(name);
    if (!m) continue;
    const { base, at, host, pid } = m.groups;
    const sameHost = host === hostname().replace(/-/g, '_').slice(0, 32);
    const stale = sameHost
      ? !pidAliveSameHost(Number(pid))
      : now - Number(at) > CLAIM_STALE_MS;
    if (!stale) continue;
    try { renameSync(join(dir, name), join(dir, base)); reclaimed++; } catch {}
  }
  return reclaimed;
}

// Every row that is EVIDENCE: drainable spool rows, live claims, and
// quarantined .corrupt rows (Codex diff-review r1 F6 — a quarantined row must
// keep redding the census until an operator disposes of it, never vanish
// after its first warning). `.drained` consume-markers are excluded — they
// are cleanup debt, not evidence.
export function listBreachesSync(stateRoot) {
  const dir = breachDir(stateRoot);
  try { return readdirSync(dir).filter((n) => n.endsWith('.json') || n.endsWith('.corrupt') || CLAIM_RE.test(n)); }
  catch { return []; }
}

// Drain every unclaimed spool file onto the spine via the injected appendFn
// (spine.append, injected to avoid an import cycle). Runs BEFORE the command
// witness is armed — a drain append must never credit the upcoming command
// (Codex r1 F1), which the caller guarantees by ordering (bin/maddu.mjs).
// Returns { drained, failed, remaining, errors } — a failure restores the
// claim (rename back) and reports the error so the caller can apply the
// pinned recovery exception (Codex r5 F1) or abort dispatch.
//
// breachId idempotency (Codex diff-review r1 F5 — "at-least-once with
// dedupe" must be IMPLEMENTED, not aspirational): the crash window is
// append-succeeded → unlink-failed. Two layers close it:
//   1. `hasBreachId(id)` (optional, injected — bin supplies a spine scan):
//      a claimed row whose breachId is ALREADY on the spine is cleaned up
//      without a second append.
//   2. after a successful append the claim is renamed to `<base>.drained`
//      BEFORE unlink — an unlink failure leaves a consumed marker that
//      reclaim NEVER renames back and later drains only clean up.
export async function drainBreachesToSpine(repoRoot, stateRoot, appendFn, { hasBreachId = null } = {}) {
  const dir = breachDir(stateRoot);
  reclaimStaleClaimsSync(stateRoot);
  let names = [];
  try { names = await readdir(dir); } catch { return { drained: 0, failed: 0, remaining: 0, errors: [] }; }
  // Consumed markers from a prior unlink failure: cleanup only, never re-drain.
  for (const n of names.filter((x) => x.endsWith('.drained'))) {
    try { await unlink(join(dir, n)); } catch {}
  }
  const spool = names.filter((n) => n.endsWith('.json'));
  let drained = 0, failed = 0;
  const errors = [];
  for (const name of spool) {
    const claimed = claimName(name);
    try { await rename(join(dir, name), join(dir, claimed)); } catch { continue; } // another drainer won
    // Read and parse are distinct failure classes: a TRANSIENT read error
    // (Windows AV holding a just-renamed file) restores the claim so the row
    // survives for the next drain; only a PARSE failure quarantines — a
    // valid row must never land in .corrupt over a transient EPERM.
    let raw = null;
    try { raw = await readFile(join(dir, claimed), 'utf8'); } catch (err) {
      try { await rename(join(dir, claimed), join(dir, name)); } catch {}
      failed++; errors.push({ name, error: err?.message || String(err), code: err?.code ?? null });
      continue;
    }
    let row = null;
    try { row = JSON.parse(raw); } catch {}
    if (!row || typeof row.breachId !== 'string') {
      // Unparseable spool row: not silently dropped — renamed to .corrupt for
      // the census to surface, never drained as a guessed event.
      try { await rename(join(dir, claimed), join(dir, `${name}.corrupt`)); } catch {}
      failed++; errors.push({ name, error: 'unparseable spool row' });
      continue;
    }
    try {
      // Idempotency layer 1: skip an already-drained breachId (a prior run
      // crashed between append and unlink) — clean up, count as drained.
      let alreadyOnSpine = false;
      if (typeof hasBreachId === 'function') {
        try { alreadyOnSpine = await hasBreachId(row.breachId); } catch {}
      }
      if (!alreadyOnSpine) {
        await appendFn({
          type: 'MUTATION_UNWITNESSED',
          actor: row.sessionId || null,
          lane: null,
          data: {
            breachId: row.breachId, breachTs: row.breachTs ?? null,
            surface: row.surface ?? 'cli', label: row.label ?? '(unlabeled)',
            verb: row.verb ?? null, sub: row.sub ?? null,
            method: row.method ?? null, path: row.path ?? null,
            exitCode: Number.isInteger(row.exitCode) ? row.exitCode : null,
            sessionId: row.sessionId ?? null, via: 'breach-drain',
          },
        });
      }
      // Idempotency layer 2: consume-marker rename BEFORE unlink — an unlink
      // failure leaves `<base>.drained`, which is never re-drained.
      const drainedName = `${name}.drained`;
      try { await rename(join(dir, claimed), join(dir, drainedName)); } catch {}
      try { await unlink(join(dir, drainedName)); } catch {}
      drained++;
    } catch (err) {
      try { await rename(join(dir, claimed), join(dir, name)); } catch {}
      failed++; errors.push({ name, error: err?.message || String(err), code: err?.code ?? null });
    }
  }
  let remaining = 0;
  try { remaining = (await readdir(dir)).filter((n) => n.endsWith('.json')).length; } catch {}
  return { drained, failed, remaining, errors };
}
