// spine-anchor.mjs — Tier-1 EXTERNAL witness: OpenTimestamps anchors over
// spine receipts (verification-witness track PR 4).
//
// WHAT AN ANCHOR IS: a canonical-JSON payload committing to one spine RECEIPT
// (a VERIFICATION_RAN event's exact stored line) AND the broader history (the
// chain head), stamped into Bitcoin via the STOCK OpenTimestamps client. The
// stamp places the evidence outside the agent's authority: altering an event
// covered by a retained anchor is detectable by anyone holding the proof.
//
// HONEST SCOPE (stated wherever anchors are documented):
//   - Anchor-a-lie is irreducible: an anchor proves the receipt EXISTED at
//     stamp time, not that its content is true. Content honesty comes from
//     replay (PR 5) + the human ceremony (PR 6a).
//   - Suffix deletion (dropping the newest anchors) and all-history deletion
//     are NOT detectable without a retained checkpoint (operator note of the
//     latest seq + digest, or an external index). Continuity checks catch
//     MID-HISTORY deletion/renumbering only.
//   - Bitcoin-backed `ots verify` is an OPERATOR action at consume time. It is
//     deliberately not wrapped in a maddu verb that "verifies for you" — a
//     runner the agent controls re-verifying its own evidence would be the
//     actor-as-witness pattern this track exists to remove.
//
// TOOLING: the stock `ots` client is a declared AMBIENT tool (like git/gh) —
// zero package deps; presence is checked with an honest error naming the
// install path. On Windows the stock client needs OpenSSL visible to
// python-bitcoinlib (see OTS_INSTALL_HINT). MADDU_OTS_BIN overrides the
// binary for tests ONLY (a stub cannot make anything more trusted — events
// record what ran).
//
// SYNC MODE: refused, fail-closed. One anchor chain covers ONE replica's flat
// spine; a singular chain head cannot cover a merged multi-replica spine.
// Lifted only by a future design that anchors a vector of replica tips.
//
// STORAGE (.maddu/anchors/ — TRACKED, a durable exception): one dir per
// sequence number:
//   .maddu/anchors/000001/payload.json      canonical bytes, digest-stable
//   .maddu/anchors/000001/payload.json.ots  the OpenTimestamps proof
//   .maddu/anchors/000001/meta.json         local bookkeeping (never evidence)
// Anchors travel with the repo; the receipt-bearing spine is device-local. A
// fresh clone can verify anchor continuity and payload self-consistency, and
// can check payloads against a spine only where that spine is available.

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withAppendLock } from './append-lock.mjs';
import { hashLine, readActiveReplicaId } from './spine-append-core.mjs';
import { redactLeaves } from './secret-scan.mjs';

const pExecFile = promisify(execFile);

export const PAYLOAD_VERSION = 1;
const SEQ_DIR_RE = /^\d{6}$/;

export function anchorsDir(repoRoot) { return join(repoRoot, '.maddu', 'anchors'); }
// The funnel lock lives under state/ (UNTRACKED), never inside the tracked
// anchors dir — a committed lockfile would hang every other host forever (the
// lock protocol never steals a foreign-host lock).
function lockPath(repoRoot) { return join(repoRoot, '.maddu', 'state', 'anchors.lock'); }
function seqDirName(seq) { return String(seq).padStart(6, '0'); }

// Both SHA-1 (40 hex) and SHA-256 (64 hex) git object ids are valid subjects.
export function isGitSha(s) {
  return typeof s === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
}

export function sha256Hex(bufOrStr) {
  return createHash('sha256').update(bufOrStr).digest('hex');
}

// Deterministic canonical JSON: object keys sorted recursively, no whitespace.
// The sha256 of these exact bytes is the stamped digest, so serialization must
// be stable across platforms and Node versions (JSON.stringify with sorted
// keys is; numbers in payloads are integers only).
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

// Pure: normalize a git origin URL to scheme + host + path — no credentials,
// no trailing `.git`, no trailing slash. SSH scp-form (git@host:path) becomes
// ssh://host/path. Unparseable → null (recorded as null, never guessed).
export function normalizeOrigin(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u = url.trim();
  const scp = /^(?:[^@/]+@)([^:/]+):(?!\/)(.+)$/.exec(u);
  if (scp) u = `ssh://${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(u);
    if (!parsed.host) return null;
    const path = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch { return null; }
}

// IO: { project, origin } — project from maddu.json name (null if absent),
// origin from `git remote get-url origin` normalized (null if no git/remote).
export async function repoIdentity(repoRoot) {
  let project = null;
  try {
    const raw = await readFile(join(repoRoot, 'maddu.json'), 'utf8');
    const cfg = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (cfg && typeof cfg.name === 'string' && cfg.name.trim()) project = cfg.name.trim();
  } catch { /* absent/malformed → null; identity is descriptive, not a gate */ }
  let origin = null;
  try {
    const { stdout } = await pExecFile('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
    origin = normalizeOrigin(stdout.trim());
  } catch { /* no git / no origin → null */ }
  return { project, origin };
}

async function gitHead(repoRoot) {
  try {
    const { stdout } = await pExecFile('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    const sha = stdout.trim();
    return isGitSha(sha) ? sha : null;
  } catch { return null; }
}

// ── ots client resolution ────────────────────────────────────────────────

// MADDU_OTS_BIN is a TEST seam (like MADDU_CI_PROFILE): a stub binary cannot
// forge trust — it only changes what subprocess runs, and every event records
// outcomes, not claims. Operators use the real client on PATH.
export function resolveOtsBin() {
  const env = process.env.MADDU_OTS_BIN;
  return env && env.trim() ? env.trim() : 'ots';
}

// A .mjs/.js MADDU_OTS_BIN (the test stub) is run through the current Node
// binary — execFile with shell:false cannot express "node script.mjs" as one
// string, and enabling a shell for it would reintroduce quoting bugs.
function execOts(otsBin, args, opts) {
  return /\.(mjs|cjs|js)$/i.test(otsBin)
    ? pExecFile(process.execPath, [otsBin, ...args], opts)
    : pExecFile(otsBin, args, opts);
}

export const OTS_INSTALL_HINT = [
  'The stock OpenTimestamps client is a declared ambient tool (like git).',
  'Install:  pip install opentimestamps-client   (Python 3.8+)',
  'Windows:  python-bitcoinlib needs an OpenSSL DLL findable as "ssl":',
  '          copy your Python\'s DLLs\\libcrypto-3.dll to a PATH dir as ssl.dll',
  '          (the EC_* symbols it loads live in libcrypto, not libssl).',
].join('\n');

export async function otsPresence(otsBin = resolveOtsBin()) {
  try {
    const { stdout, stderr } = await execOts(otsBin, ['--version'], { timeout: 15000, shell: false });
    const version = String(stdout || stderr || '').trim().split('\n')[0] || 'unknown';
    return { ok: true, version };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200), hint: OTS_INSTALL_HINT };
  }
}

// ── maddu.json witness config ────────────────────────────────────────────

// witness.calendars[]: optional https URLs handed to `ots stamp` as explicit
// calendars. Validated hard — a bad entry refuses (an anchor quietly stamped
// against a typo'd calendar is worse than an error). Absent → stock defaults.
export async function witnessCalendars(repoRoot) {
  let cfg = null;
  try {
    const raw = await readFile(join(repoRoot, 'maddu.json'), 'utf8');
    cfg = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch { return { calendars: null }; }
  const c = cfg?.witness?.calendars;
  if (c === undefined) return { calendars: null };
  if (!Array.isArray(c) || c.length === 0) {
    return { error: 'maddu.json witness.calendars must be a non-empty array of https URLs (or absent for stock defaults)' };
  }
  for (const u of c) {
    let parsed = null;
    try { parsed = new URL(String(u)); } catch { /* fallthrough */ }
    if (!parsed || parsed.protocol !== 'https:') {
      return { error: `maddu.json witness.calendars entry ${JSON.stringify(u)} is not an https URL` };
    }
  }
  return { calendars: c.map(String) };
}

// ── receipt selection (flat spine, raw lines) ────────────────────────────

async function listFlatSegments(repoRoot) {
  const dir = join(repoRoot, '.maddu', 'events');
  try {
    return (await readdir(dir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  } catch { return []; }
}

// Scan the flat spine for (a) the newest VERIFICATION_RAN — the default
// receipt — or an explicit event id, and (b) the chain head (last stored
// line). Works on RAW stored lines because the digest/position must bind to
// the exact bytes on disk, not a re-serialization.
export async function findReceipt(repoRoot, { eventId = null } = {}) {
  const segs = await listFlatSegments(repoRoot);
  let found = null;
  let lastLine = null;
  for (const seg of segs) {
    let raw;
    try { raw = await readFile(join(repoRoot, '.maddu', 'events', seg), 'utf8'); } catch { continue; }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '');
      if (!line.trim()) continue;
      lastLine = line;
      let ev = null;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev || typeof ev !== 'object') continue;
      const match = eventId ? ev.id === eventId : ev.type === 'VERIFICATION_RAN';
      if (match) found = { event: ev, line, segment: seg, lineNo: i + 1 };
    }
  }
  return { receipt: found, chainHead: lastLine === null ? null : hashLine(lastLine) };
}

// ── payload ──────────────────────────────────────────────────────────────

export function buildPayload({ repoIdentity: identity, receipt, chainHead, subjectSha, prevAnchorSha256, seq }) {
  return {
    v: PAYLOAD_VERSION,
    repo_identity: { project: identity?.project ?? null, origin: identity?.origin ?? null },
    receipt_digest: hashLine(receipt.line),
    subject_sha: subjectSha ?? null,
    event_id: receipt.event.id,
    position: { replica: null, segment: receipt.segment, line: receipt.lineNo },
    chain_head: chainHead,
    prev_anchor_sha256: prevAnchorSha256 ?? null,
    seq,
  };
}

// ── on-disk anchors ──────────────────────────────────────────────────────

export async function listAnchors(repoRoot) {
  const dir = anchorsDir(repoRoot);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return { anchors: [], invalidDirs: [] }; }
  const anchors = [];
  const invalidDirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!SEQ_DIR_RE.test(e.name)) { invalidDirs.push(e.name); continue; }
    const seq = parseInt(e.name, 10);
    const base = join(dir, e.name);
    const a = { seq, dir: e.name, payload: null, payloadBytes: null, payloadDigest: null, meta: null, hasProof: false, proofDigest: null };
    try {
      const buf = await readFile(join(base, 'payload.json'));
      a.payloadBytes = buf;
      a.payloadDigest = sha256Hex(buf);
      try { a.payload = JSON.parse(buf.toString('utf8')); } catch { /* parse issue surfaces in verify */ }
    } catch { /* missing payload surfaces in verify */ }
    try {
      const proof = await readFile(join(base, 'payload.json.ots'));
      a.hasProof = true;
      a.proofDigest = sha256Hex(proof);
    } catch { /* pending crash recovery or missing proof */ }
    try { a.meta = JSON.parse(await readFile(join(base, 'meta.json'), 'utf8')); } catch { /* optional */ }
    anchors.push(a);
  }
  anchors.sort((x, y) => x.seq - y.seq);
  return { anchors, invalidDirs };
}

async function writeCanonical(destDir, payload) {
  // temp-file + rename so a crash mid-write never leaves a torn payload; the
  // stored bytes ARE the canonical bytes (payload_digest is over file bytes).
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  const tmp = join(destDir, `.payload.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, bytes);
  await rename(tmp, join(destDir, 'payload.json'));
  return bytes;
}

async function writeMeta(destDir, meta) {
  const tmp = join(destDir, `.meta.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, JSON.stringify(meta, null, 2) + '\n');
  await rename(tmp, join(destDir, 'meta.json'));
}

function parseCalendars(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/Submitting to remote calendar (\S+)/g)) out.push(m[1]);
  return out;
}

// ── gitignore self-heal ──────────────────────────────────────────────────

// Anchors are a durable, tracked exception under an ignored .maddu/*. Fresh
// installs get `!.maddu/anchors/` from init's block; a repo initialized before
// this feature would silently leave anchors untracked — so the stamp path
// surgically inserts the re-include INSIDE Máddu's own block (only when the
// block exists and lacks it). Returns what happened so the caller can print it.
export async function ensureAnchorsGitignore(repoRoot) {
  const p = join(repoRoot, '.gitignore');
  let raw;
  try { raw = await readFile(p, 'utf8'); } catch { return { state: 'no-gitignore' }; }
  if (raw.includes('!.maddu/anchors/')) return { state: 'present' };
  const lines = raw.split('\n');
  const idx = lines.findIndex((l) => l.replace(/\r$/, '').trim() === '.maddu/*');
  if (idx === -1) return { state: 'no-maddu-block' };
  const cr = lines[idx].endsWith('\r') ? '\r' : '';
  lines.splice(idx + 1, 0, `!.maddu/anchors/${cr}`);
  await writeFile(p, lines.join('\n'));
  return { state: 'added' };
}

// ── stamp ────────────────────────────────────────────────────────────────

// Stamp a new anchor now. Requires network (NO offline queue: offline → the
// command says so and exits nonzero; a queue would create ambiguous
// sequences). Concurrency-safe: the whole read→build→write→stamp→event runs
// under the anchors funnel lock, so two simultaneous invocations serialize —
// the second sees the first's anchor and returns { already }.
export async function stampAnchor(repoRoot, {
  otsBin = resolveOtsBin(), eventId = null, spineLib = null,
} = {}) {
  const replicaId = await readActiveReplicaId(repoRoot);
  if (replicaId) return { ok: false, reason: 'sync-mode' };
  const presence = await otsPresence(otsBin);
  if (!presence.ok) return { ok: false, reason: 'ots-missing', detail: presence.error, hint: presence.hint };
  const cal = await witnessCalendars(repoRoot);
  if (cal.error) return { ok: false, reason: 'config-invalid', detail: cal.error };

  await mkdir(anchorsDir(repoRoot), { recursive: true });
  await mkdir(join(repoRoot, '.maddu', 'state'), { recursive: true });
  return withAppendLock(lockPath(repoRoot), async () => {
    // Re-check sync mode INSIDE the lock: a `spine sync init` that started
    // after the early check would otherwise race this stamp and migrate the
    // segment the payload is about to point at (TOCTOU).
    if (await readActiveReplicaId(repoRoot)) return { ok: false, reason: 'sync-mode' };
    const { receipt, chainHead } = await findReceipt(repoRoot, { eventId });
    if (!receipt) {
      return { ok: false, reason: eventId ? 'event-not-found' : 'no-receipt' };
    }
    const { anchors } = await listAnchors(repoRoot);
    const last = anchors.length ? anchors[anchors.length - 1] : null;

    // Crash recovery FIRST — two windows a death can leave behind:
    //   payload, no proof  → the stamp died before ots ran: re-stamp that
    //                        exact payload (idempotent, keyed by its digest).
    //   proof, no meta     → ots ran but finishStamp didn't: finalize (meta +
    //                        ANCHOR_STAMPED) without re-stamping, or the next
    //                        run would take the `already` shortcut and the
    //                        anchor would stay unrecorded forever.
    // Neither is a queue: they never grow past the single crashed stamp.
    if (last && !last.hasProof && last.payloadBytes) {
      const r = await runStamp(repoRoot, otsBin, last.seq, cal.calendars);
      if (!r.ok) return { ok: false, reason: 'stamp-failed', detail: r.detail, seq: last.seq, recovered: false };
      await finishStamp(repoRoot, last.seq, last.payloadDigest, r, spineLib);
      const giR = await ensureAnchorsGitignore(repoRoot);
      return { ok: true, seq: last.seq, payloadDigest: last.payloadDigest, calendars: r.calendars, recovered: true, gitignore: giR.state };
    }
    if (last && last.hasProof && !last.meta && last.payloadBytes) {
      await finishStamp(repoRoot, last.seq, last.payloadDigest, { calendars: [] }, spineLib);
      const gi = await ensureAnchorsGitignore(repoRoot);
      return { ok: true, seq: last.seq, payloadDigest: last.payloadDigest, calendars: [], recovered: true, gitignore: gi.state };
    }

    // Idempotency: nothing new to anchor when the latest anchor already
    // commits to this receipt. Keyed on the RECEIPT digest alone — the receipt
    // is the assurance subject; chain_head is a stamp-time snapshot of the
    // broader history, and comparing it would defeat idempotency entirely
    // (each stamp's own ANCHOR_STAMPED event advances the chain head).
    if (last && last.hasProof && last.payload
        && last.payload.receipt_digest === hashLine(receipt.line)) {
      await ensureAnchorsGitignore(repoRoot); // self-heal even on the no-op path
      return { ok: true, already: true, seq: last.seq, payloadDigest: last.payloadDigest };
    }

    const seq = (last ? last.seq : 0) + 1;
    const identity = await repoIdentity(repoRoot);
    const subjectSha = await gitHead(repoRoot);
    const payload = buildPayload({
      repoIdentity: identity, receipt, chainHead, subjectSha,
      prevAnchorSha256: last && last.payloadBytes ? sha256Hex(last.payloadBytes) : null, seq,
    });
    // Canonical write boundary: like every store, the payload passes the
    // secret scrub. Fields are digests/ids/urls, so this is normally a no-op —
    // but repo identity and event ids are caller-influenced text.
    const swept = redactLeaves(payload);
    const destDir = join(anchorsDir(repoRoot), seqDirName(seq));
    await mkdir(destDir, { recursive: true });
    const bytes = await writeCanonical(destDir, swept);
    const payloadDigest = sha256Hex(bytes);

    const r = await runStamp(repoRoot, otsBin, seq, cal.calendars);
    if (!r.ok) {
      // NO queue: a failed stamp removes the payload dir entirely rather than
      // leaving a pending artifact a later run would silently retry.
      await rm(destDir, { recursive: true, force: true });
      return { ok: false, reason: 'stamp-failed', detail: r.detail };
    }
    // Final sync recheck AFTER the (slow, networked) stamp: a `spine sync
    // init` that slipped past our lock via its own lock could have migrated
    // the segment this payload points at while ots ran. Roll the anchor back
    // (the calendar submission is unrecallable but records nothing locally)
    // rather than publish a payload pointing at a moved segment. syncInit
    // also refuses while anchors exist, so both sides now close this race.
    if (await readActiveReplicaId(repoRoot)) {
      await rm(destDir, { recursive: true, force: true });
      return { ok: false, reason: 'sync-mode' };
    }
    await finishStamp(repoRoot, seq, payloadDigest, r, spineLib);
    const gi = await ensureAnchorsGitignore(repoRoot);
    return { ok: true, seq, payloadDigest, calendars: r.calendars, subjectSha, gitignore: gi.state };
  });
}

async function runStamp(repoRoot, otsBin, seq, calendars) {
  const payloadPath = join(anchorsDir(repoRoot), seqDirName(seq), 'payload.json');
  const args = ['stamp'];
  if (calendars) {
    for (const c of calendars) args.push('--calendar', c);
    args.push('-m', '1');
  }
  args.push(payloadPath);
  try {
    const { stdout, stderr } = await execOts(otsBin, args, { timeout: 120000, shell: false });
    return { ok: true, calendars: parseCalendars(`${stdout}\n${stderr}`), output: `${stdout}\n${stderr}` };
  } catch (e) {
    const detail = String((e && (e.stderr || e.message)) || e).slice(0, 400);
    return { ok: false, detail };
  }
}

async function finishStamp(repoRoot, seq, payloadDigest, stampResult, spineLib) {
  const base = join(anchorsDir(repoRoot), seqDirName(seq));
  const proof = await readFile(join(base, 'payload.json.ots'));
  const proofDigest = sha256Hex(proof);
  await writeMeta(base, {
    v: 1, seq, payload_digest: payloadDigest, stamped_at: new Date().toISOString(),
    calendars: stampResult.calendars, complete: false,
  });
  if (spineLib && spineLib.append) {
    await spineLib.append(repoRoot, {
      type: 'ANCHOR_STAMPED',
      actor: process.env.MADDU_SESSION_ID || null,
      data: {
        seq, payload_digest: payloadDigest, calendars: stampResult.calendars,
        proof_files: [{ path: `.maddu/anchors/${seqDirName(seq)}/payload.json.ots`, digest: proofDigest }],
      },
    });
  }
}

// ── upgrade ──────────────────────────────────────────────────────────────

// Oldest-first `ots upgrade` over incomplete anchors. Emits ANCHOR_UPGRADED
// only when the proof bytes actually changed (partial or complete upgrade) —
// a no-op pending poll leaves no event. Idempotent under the funnel lock.
export async function upgradeAnchors(repoRoot, { otsBin = resolveOtsBin(), spineLib = null } = {}) {
  const replicaId = await readActiveReplicaId(repoRoot);
  if (replicaId) return { ok: false, reason: 'sync-mode' };
  const presence = await otsPresence(otsBin);
  if (!presence.ok) return { ok: false, reason: 'ots-missing', detail: presence.error, hint: presence.hint };

  await mkdir(join(repoRoot, '.maddu', 'state'), { recursive: true });
  return withAppendLock(lockPath(repoRoot), async () => {
    if (await readActiveReplicaId(repoRoot)) return { ok: false, reason: 'sync-mode' };
    const { anchors } = await listAnchors(repoRoot);
    const newestEv = await newestAnchorEventDigests(repoRoot);
    const results = [];
    for (const a of anchors) {
      if (!a.hasProof) { results.push({ seq: a.seq, state: 'no-proof' }); continue; }
      const base = join(anchorsDir(repoRoot), a.dir);
      const proofPath = join(base, 'payload.json.ots');
      if (a.meta && a.meta.complete === true) {
        // Reconcile: the newest ANCHOR_* event must record the CURRENT proof
        // digest. A mismatch here is the benign twin of the --verify FAIL (an
        // upgrade whose event append failed) — re-emit so the record matches
        // disk again instead of skipping forever.
        const rec = newestEv.get(a.seq);
        if (spineLib && spineLib.append && rec && rec.digest !== a.proofDigest) {
          await spineLib.append(repoRoot, {
            type: 'ANCHOR_UPGRADED',
            actor: process.env.MADDU_SESSION_ID || null,
            data: {
              seq: a.seq, payload_digest: a.payloadDigest, complete: true,
              proof_files: [{ path: `.maddu/anchors/${a.dir}/payload.json.ots`, digest: a.proofDigest }],
            },
          });
          results.push({ seq: a.seq, state: 'reconciled' });
        } else {
          results.push({ seq: a.seq, state: 'complete' });
        }
        continue;
      }
      // The stock client backs the proof up to `<file>.bak` on upgrade and
      // REFUSES the next upgrade while that backup exists. A leftover .bak
      // can also be the ONLY valid copy (a crash mid-rewrite leaves a
      // truncated primary) — so before clearing it, validate the primary with
      // the client itself (`ots info`) and restore from the backup if the
      // primary is unparseable. Only then is the .bak safe to remove.
      try {
        await stat(`${proofPath}.bak`);
        try {
          await execOts(otsBin, ['info', proofPath], { timeout: 60000, shell: false });
        } catch {
          await rename(`${proofPath}.bak`, proofPath); // primary corrupt → the backup IS the proof
        }
      } catch { /* no .bak — nothing to reconcile */ }
      await rm(`${proofPath}.bak`, { force: true });
      // Recompute from disk — a .bak restore just above may have replaced the
      // bytes listAnchors saw.
      let before = a.proofDigest;
      try { before = sha256Hex(await readFile(proofPath)); } catch { /* keep listed */ }
      let complete = false, detail = null;
      try {
        await execOts(otsBin, ['upgrade', proofPath], { timeout: 120000, shell: false });
        complete = true; // exit 0 = upgraded to a Bitcoin attestation
      } catch (e) {
        detail = String((e && (e.stderr || e.stdout || e.message)) || e).slice(0, 300);
        complete = false;
      }
      await rm(`${proofPath}.bak`, { force: true });
      let after = before;
      try { after = sha256Hex(await readFile(proofPath)); } catch { /* unchanged */ }
      const upgraded = after !== before;
      if (upgraded || complete) {
        await writeMeta(base, {
          ...(a.meta || { v: 1, seq: a.seq, payload_digest: a.payloadDigest, calendars: [] }),
          payload_digest: a.payloadDigest,
          upgraded_at: new Date().toISOString(),
          complete,
        });
        if (spineLib && spineLib.append) {
          await spineLib.append(repoRoot, {
            type: 'ANCHOR_UPGRADED',
            actor: process.env.MADDU_SESSION_ID || null,
            data: {
              seq: a.seq, payload_digest: a.payloadDigest, complete,
              proof_files: [{ path: `.maddu/anchors/${a.dir}/payload.json.ots`, digest: after }],
            },
          });
        }
      }
      if (!upgraded && !complete) {
        // Pending with NOTHING new — but if an earlier partial upgrade's
        // event append failed, the newest recorded digest still mismatches
        // disk; reconcile here too (round-2 F5: reconciliation must not be
        // gated on complete anchors only).
        const rec = newestEv.get(a.seq);
        if (spineLib && spineLib.append && rec && rec.digest !== before) {
          await spineLib.append(repoRoot, {
            type: 'ANCHOR_UPGRADED',
            actor: process.env.MADDU_SESSION_ID || null,
            data: {
              seq: a.seq, payload_digest: a.payloadDigest, complete: false,
              proof_files: [{ path: `.maddu/anchors/${a.dir}/payload.json.ots`, digest: before }],
            },
          });
          results.push({ seq: a.seq, state: 'reconciled', detail });
          continue;
        }
      }
      results.push({ seq: a.seq, state: complete ? 'completed' : upgraded ? 'partial' : 'pending', detail });
    }
    return { ok: true, results };
  });
}

// The newest ANCHOR_STAMPED/ANCHOR_UPGRADED event per seq (spine order), with
// the proof digest it recorded. Shared by --verify (forgery predicate: the
// NEWEST event must match disk; older events are superseded history) and by
// --upgrade's reconciliation.
async function newestAnchorEventDigests(repoRoot) {
  const map = new Map();
  for (const seg of await listFlatSegments(repoRoot)) {
    let raw = null;
    try { raw = await readFile(join(repoRoot, '.maddu', 'events', seg), 'utf8'); } catch { continue; }
    for (const l of raw.split('\n')) {
      const line = l.replace(/\r$/, '');
      if (!line.trim()) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev || (ev.type !== 'ANCHOR_STAMPED' && ev.type !== 'ANCHOR_UPGRADED')) continue;
      const d = ev.data || {};
      if (typeof d.seq !== 'number') continue;
      const digest = Array.isArray(d.proof_files) && d.proof_files[0] && typeof d.proof_files[0].digest === 'string'
        ? d.proof_files[0].digest : null;
      map.set(d.seq, { type: ev.type, id: ev.id, digest });
    }
  }
  return map;
}

// ── status ───────────────────────────────────────────────────────────────

export async function anchorStatus(repoRoot) {
  const { anchors, invalidDirs } = await listAnchors(repoRoot);
  return {
    anchors: anchors.map((a) => ({
      seq: a.seq,
      payloadDigest: a.payloadDigest,
      eventId: a.payload?.event_id ?? null,
      subjectSha: a.payload?.subject_sha ?? null,
      stampedAt: a.meta?.stamped_at ?? null,
      complete: a.meta?.complete === true,
      hasProof: a.hasProof,
    })),
    invalidDirs,
  };
}

// ── verify (read-only diagnostic — NEVER assurance evidence) ─────────────

// Continuity + self-consistency + spine-position + event cross-checks. Emits
// NO spine event and is not evidence for any assurance level: it proves the
// LOCAL files are mutually consistent, not that Bitcoin confirms them — the
// Bitcoin-backed check is the operator's `ots verify`, run at consume time.
export async function verifyAnchors(repoRoot) {
  const issues = [];
  const { anchors, invalidDirs } = await listAnchors(repoRoot);
  for (const d of invalidDirs) {
    issues.push({ level: 'FAIL', kind: 'invalid-dir', detail: `.maddu/anchors/${d} is not a 6-digit sequence dir` });
  }
  // Index every stored line's hash → position, once. Used for the chain_head
  // membership check: the payload's chain_head must be the hash of a line that
  // STILL EXISTS at/after the receipt. Rewriting any covered event either
  // breaks the spine's own prev_hash chain (spine verify) or re-chains the
  // suffix — which changes the head line's bytes, so no stored line hashes to
  // the anchored chain_head anymore and this check FAILs.
  const lineIndex = new Map();
  const ordered = []; // every stored line in spine order, with its own hash + declared prev_hash
  const segsAll = await listFlatSegments(repoRoot);
  for (const seg of segsAll) {
    let raw = null;
    try { raw = await readFile(join(repoRoot, '.maddu', 'events', seg), 'utf8'); } catch { continue; }
    const ls = raw.split('\n');
    for (let n = 0; n < ls.length; n++) {
      const line = ls[n].replace(/\r$/, '');
      if (!line.trim()) continue;
      const h = hashLine(line);
      lineIndex.set(h, { segment: seg, line: n + 1 });
      let prevHash;
      try { const ev = JSON.parse(line); prevHash = ev && typeof ev === 'object' ? ev.prev_hash : undefined; } catch { /* torn */ }
      ordered.push({ segment: seg, line: n + 1, hash: h, prevHash });
    }
  }
  // Chain breaks INSIDE the stored spine: a line whose declared prev_hash does
  // not match its predecessor's stored bytes. Membership of the head line
  // alone would miss a rewritten MIDDLE event whose immediate successor
  // carries no prev_hash — the break list closes that: any break inside an
  // anchor's covered range (receipt, head] is a FAIL. Links are only checked
  // where prev_hash is declared (pre-chain events are honestly uncovered —
  // that is spine verify's forward-only stance, mirrored here).
  const chainBreaks = [];
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].prevHash !== undefined && ordered[i].prevHash !== null
        && ordered[i].prevHash !== ordered[i - 1].hash) {
      chainBreaks.push({ segment: ordered[i].segment, line: ordered[i].line });
    }
  }
  const posLE = (a, b) => a.segment < b.segment || (a.segment === b.segment && a.line <= b.line);
  const posLT = (a, b) => a.segment < b.segment || (a.segment === b.segment && a.line < b.line);
  // Sequence continuity: strictly 1..N with no gaps. A gap or renumbering is
  // MID-HISTORY tampering; suffix/all-history deletion is NOT detectable here.
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const expected = i + 1;
    if (a.seq !== expected) {
      issues.push({ level: 'FAIL', kind: 'seq-gap', seq: a.seq, detail: `expected seq ${expected}, found ${a.seq} — a mid-history anchor was deleted or renumbered` });
    }
    if (!a.payloadBytes) {
      issues.push({ level: 'FAIL', kind: 'payload-missing', seq: a.seq, detail: 'payload.json missing' });
      continue;
    }
    if (!a.payload) {
      issues.push({ level: 'FAIL', kind: 'payload-unparseable', seq: a.seq, detail: 'payload.json is not valid JSON' });
      continue;
    }
    if (a.payload.seq !== a.seq) {
      issues.push({ level: 'FAIL', kind: 'seq-mismatch', seq: a.seq, detail: `payload says seq ${a.payload.seq} but lives in dir ${a.dir} — renumbered` });
    }
    if (canonicalJson(a.payload) !== a.payloadBytes.toString('utf8')) {
      issues.push({ level: 'FAIL', kind: 'payload-edited', seq: a.seq, detail: 'stored bytes are not the canonical serialization of their own content (reformatted or hand-edited)' });
    }
    const prev = i > 0 ? anchors[i - 1] : null;
    const expectPrev = prev && prev.payloadBytes ? sha256Hex(prev.payloadBytes) : null;
    if ((a.payload.prev_anchor_sha256 ?? null) !== expectPrev) {
      issues.push({ level: 'FAIL', kind: 'prev-mismatch', seq: a.seq, detail: `prev_anchor_sha256 does not match the stored bytes of anchor ${prev ? prev.seq : '(none)'} — chain broken (edited or reordered)` });
    }
    if (!a.hasProof) {
      // A missing proof is only benign BEFORE the stamp finalized (mid-stamp
      // crash: payload, no meta, no event). Once meta exists, a stamp
      // demonstrably completed — a vanished proof is destroyed evidence.
      if (a.meta) {
        issues.push({ level: 'FAIL', kind: 'proof-destroyed', seq: a.seq, detail: 'payload.json.ots missing but meta.json records a completed stamp — the proof was deleted; the Bitcoin-backed protection for this anchor is gone' });
      } else {
        issues.push({ level: 'WARN', kind: 'proof-missing', seq: a.seq, detail: 'payload.json.ots missing — crashed stamp (re-run `maddu spine anchor`) or deleted proof' });
      }
    }
    // Spine-position binding — only where this device's spine has the segment.
    if (a.payload.position && a.payload.position.segment) {
      let raw = null;
      try { raw = await readFile(join(repoRoot, '.maddu', 'events', a.payload.position.segment), 'utf8'); } catch { /* absent */ }
      if (raw === null) {
        issues.push({ level: 'WARN', kind: 'spine-unavailable', seq: a.seq, detail: `segment ${a.payload.position.segment} not on this device (fresh clone?) — position check skipped; continuity + self-consistency still hold` });
      } else {
        const line = (raw.split('\n')[a.payload.position.line - 1] || '').replace(/\r$/, '');
        if (!line || hashLine(line) !== a.payload.receipt_digest) {
          issues.push({ level: 'FAIL', kind: 'position-mismatch', seq: a.seq, detail: `spine ${a.payload.position.segment}:${a.payload.position.line} does not hash to receipt_digest — the spine was rewritten after stamping, or the anchor lies` });
        } else {
          let ev = null;
          try { ev = JSON.parse(line); } catch { /* hash matched; parse is belt-and-suspenders */ }
          if (ev && ev.id !== a.payload.event_id) {
            issues.push({ level: 'FAIL', kind: 'event-id-mismatch', seq: a.seq, detail: `event at position has id ${ev.id}, payload says ${a.payload.event_id}` });
          }
        }
        // chain_head membership: the anchored head line must still exist, at
        // or after the receipt — otherwise a covered TAIL event was rewritten
        // (re-chaining changes the head line's bytes) or the head was dropped.
        if (typeof a.payload.chain_head === 'string' && lineIndex.size) {
          const at = lineIndex.get(a.payload.chain_head);
          if (!at) {
            issues.push({ level: 'FAIL', kind: 'chain-head-missing', seq: a.seq, detail: `no stored spine line hashes to the anchored chain_head — a covered event after the receipt was rewritten, or the head line was deleted` });
          } else if (!posLE(a.payload.position, at)) {
            issues.push({ level: 'FAIL', kind: 'chain-head-order', seq: a.seq, detail: `the anchored chain_head line (${at.segment}:${at.line}) precedes the receipt position — inconsistent anchor` });
          } else {
            const inRange = chainBreaks.filter((b) => posLT(a.payload.position, b) && posLE(b, at));
            for (const b of inRange) {
              issues.push({ level: 'FAIL', kind: 'covered-chain-break', seq: a.seq, detail: `prev_hash break at ${b.segment}:${b.line} inside this anchor's covered range — a covered event between the receipt and the anchored head was rewritten` });
            }
          }
        }
      }
    }
  }
  // Cross-check ANCHOR_* spine events against disk: a forged event claiming an
  // upgrade/stamp that disk doesn't back is flagged; disk anchors with no
  // STAMPED event are a WARN (the event append is best-effort after the stamp).
  const events = [];
  const segs = await listFlatSegments(repoRoot);
  for (const seg of segs) {
    let raw = null;
    try { raw = await readFile(join(repoRoot, '.maddu', 'events', seg), 'utf8'); } catch { continue; }
    for (const l of raw.split('\n')) {
      const line = l.replace(/\r$/, '');
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && (ev.type === 'ANCHOR_STAMPED' || ev.type === 'ANCHOR_UPGRADED')) events.push(ev);
      } catch { /* torn lines are spine verify's problem */ }
    }
  }
  const bySeq = new Map(anchors.map((a) => [a.seq, a]));
  const newestPerSeq = new Map(); // spine order → the last event per seq wins
  for (const ev of events) {
    const d = ev.data || {};
    const a = bySeq.get(d.seq);
    if (!a) {
      issues.push({ level: 'FAIL', kind: 'event-anchor-missing', seq: d.seq ?? null, detail: `${ev.type} (${ev.id}) references anchor seq ${d.seq} which does not exist on disk — forged event or deleted anchor` });
      continue;
    }
    // The payload NEVER legitimately changes, so EVERY event for a seq must
    // carry the on-disk payload digest — old or new.
    if (d.payload_digest && a.payloadDigest && d.payload_digest !== a.payloadDigest) {
      issues.push({ level: 'FAIL', kind: 'event-digest-mismatch', seq: d.seq, detail: `${ev.type} (${ev.id}) payload_digest does not match the stored payload — forged event or edited payload` });
    }
    newestPerSeq.set(d.seq, ev);
  }
  // Proof digests DO change across upgrades, so only the NEWEST event per seq
  // is held to disk: a forged "upgraded" event (wrong or absent proof digest)
  // FAILs; older events are superseded history and are not compared.
  for (const [seqNo, ev] of newestPerSeq) {
    const a = bySeq.get(seqNo);
    const d = ev.data || {};
    // The newest event must CARRY the payload digest — a forged event that
    // simply omits it must not slip past the every-event equality check.
    if (!d.payload_digest) {
      issues.push({ level: 'FAIL', kind: 'event-digest-mismatch', seq: seqNo, detail: `newest ${ev.type} (${ev.id}) carries no payload_digest — real anchor events always do; forged or corrupted event` });
    }
    const recorded = Array.isArray(d.proof_files) && d.proof_files[0] && typeof d.proof_files[0].digest === 'string'
      ? d.proof_files[0].digest : null;
    if (!a.proofDigest) {
      // An event proves a stamp happened; no proof on disk (and possibly no
      // meta either, so the loop above stayed WARN) = destroyed evidence.
      if (!a.meta) {
        issues.push({ level: 'FAIL', kind: 'proof-destroyed', seq: seqNo, detail: `${ev.type} (${ev.id}) records a stamp for seq ${seqNo} but no proof exists on disk — the proof was deleted; the Bitcoin-backed protection for this anchor is gone` });
      }
      continue;
    }
    if (recorded !== a.proofDigest) {
      issues.push({ level: 'FAIL', kind: 'event-proof-mismatch', seq: seqNo, detail: `newest ${ev.type} (${ev.id}) records proof digest ${recorded ? String(recorded).slice(0, 12) + '…' : '(none)'} but disk has ${String(a.proofDigest).slice(0, 12)}… — forged event or replaced proof (if an upgrade's event append failed, \`maddu spine anchor --upgrade\` reconciles)` });
    }
  }
  const stampedSeqs = new Set(events.filter((e) => e.type === 'ANCHOR_STAMPED').map((e) => e.data?.seq));
  for (const a of anchors) {
    if (!stampedSeqs.has(a.seq)) {
      issues.push({ level: 'WARN', kind: 'unrecorded-anchor', seq: a.seq, detail: `no ANCHOR_STAMPED event for seq ${a.seq} on this device's spine (fresh clone, or the event append failed)` });
    }
  }
  return {
    ok: !issues.some((i) => i.level === 'FAIL'),
    anchors: anchors.length,
    issues,
    residual: 'suffix deletion (dropping the newest anchors) and all-history deletion are NOT detectable without a retained checkpoint — keep an operator note of the latest seq + payload digest.',
    operatorVerify: 'Bitcoin-backed verification is an operator action: `ots verify .maddu/anchors/<seq>/payload.json.ots` with a local Bitcoin Core node (the stock Python client has NO explorer fallback), or the JS client\'s lite mode (`npx opentimestamps` → ots-cli.js verify) which trusts block explorers, not PoW directly — know which one you ran. It is deliberately not wrapped in a maddu verb: a runner the agent controls re-verifying its own evidence would be actor-as-witness.',
  };
}

// ── assurance evidence shapes (contract 1.10.0; producer ships in PR 6a) ──

// Per-level REQUIRED evidence for ASSURANCE_ASSESSED. The event-schema grammar
// declares field TYPES; this is the single canonical checker for the per-level
// requirement ("missing per-level evidence = schema-invalid"). The PR 6a
// ceremony producer must refuse to append an event this rejects; consumers
// label every ASSURANCE_ASSESSED non-authoritative regardless.
export const ASSURANCE_LEVELS = ['actor-reported', 'replayed', 'anchored', 'presence-attested'];
export function validateAssuranceEvidence(level, evidence) {
  const need = {
    'actor-reported': [],
    'replayed': ['replay_receipt_digest'],
    'anchored': ['anchor_seq', 'anchor_payload_digest', 'proof_digest'],
    'presence-attested': ['replay_receipt_digest', 'anchor_seq', 'anchor_payload_digest', 'proof_digest', 'presence_sig_digest', 'manifest_digest'],
  }[level];
  if (!need) return { ok: false, missing: [], error: `unknown assurance level ${JSON.stringify(level)}` };
  const ev = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {};
  const missing = need.filter((k) => ev[k] === undefined || ev[k] === null || ev[k] === '');
  return missing.length ? { ok: false, missing } : { ok: true, missing: [] };
}
