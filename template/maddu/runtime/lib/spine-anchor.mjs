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

import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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

// Containment (PR 6a): every segment read in THIS lib must resolve inside a
// REAL .maddu/events directory with no symlink anywhere on the path — a
// canonical-named symlink (leaf OR ancestor) pointing outside the repo would
// let a forged payload bind to planted bytes that are not the spine. Scope:
// the anchor/assessment lib's own reads; the general spine lib is unchanged.
const SEGMENT_NAME_RE = /^\d{12}\.ndjson$/;

async function eventsDirSafe(repoRoot) {
  for (const p of [join(repoRoot, '.maddu'), join(repoRoot, '.maddu', 'events')]) {
    let st = null;
    try { st = await lstat(p); } catch { return { ok: false, detail: `${p} does not exist` }; }
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, detail: `${p} is a symlink or not a real directory — refusing to follow` };
  }
  return { ok: true };
}

// Canonical segment basenames that are REAL regular files; canonical-NAMED
// entries that are not (symlinks, dirs) are surfaced as badEntries so
// verifyAnchors can FAIL them — an unreferenced symlink segment must not
// silently skew the chain-head/newest-event scans either way.
async function listSegmentsSafe(repoRoot) {
  const dirOk = await eventsDirSafe(repoRoot);
  if (!dirOk.ok) return { ok: false, detail: dirOk.detail, segments: [], badEntries: [] };
  const dir = join(repoRoot, '.maddu', 'events');
  let names = [];
  try { names = (await readdir(dir)).filter((f) => SEGMENT_NAME_RE.test(f)).sort(); } catch { return { ok: true, segments: [], badEntries: [] }; }
  const segments = [];
  const badEntries = [];
  for (const n of names) {
    let st = null;
    try { st = await lstat(join(dir, n)); } catch { badEntries.push(n); continue; }
    if (st.isSymbolicLink() || !st.isFile()) badEntries.push(n); else segments.push(n);
  }
  return { ok: true, segments, badEntries };
}

async function readSegmentSafe(repoRoot, basename) {
  if (typeof basename !== 'string' || !SEGMENT_NAME_RE.test(basename)) return { ok: false, reason: 'bad-name' };
  const dirOk = await eventsDirSafe(repoRoot);
  if (!dirOk.ok) return { ok: false, reason: 'events-dir', detail: dirOk.detail };
  const p = join(repoRoot, '.maddu', 'events', basename);
  // Open-then-fstat so the bytes provably come from the file we checked (a
  // bare lstat→readFile pair can be raced by a symlink swap). O_NOFOLLOW
  // refuses a leaf symlink at open time on POSIX; Windows has no O_NOFOLLOW,
  // so the post-read lstat catches a persistent symlink there. The dir/leaf
  // state is re-verified AFTER the read as well, shrinking the swap window
  // to the syscall gap. RESIDUAL (all platforms, stated in threat model
  // §13): a writer RACING these syscalls — swapping a path component in and
  // back out inside that gap — can still win. That is a live co-resident
  // adversary with repo write authority, who is outside the cooperative
  // model's boundary anyway (such an actor can rewrite the record
  // wholesale); the checks here are about STATIC adversarial states, which
  // they refuse deterministically.
  let fh = null;
  try {
    fh = await open(p, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: 'not-regular', detail: `${basename} is not a regular file — refusing to follow` };
    const raw = await fh.readFile({ encoding: 'utf8' });
    // Post-read recheck: the path (leaf AND ancestors) must still be the
    // symlink-free shape we validated before the open.
    const lst = await lstat(p);
    if (lst.isSymbolicLink() || !lst.isFile()) return { ok: false, reason: 'not-regular', detail: `${basename} is not a regular file — refusing to follow` };
    const dirOk2 = await eventsDirSafe(repoRoot);
    if (!dirOk2.ok) return { ok: false, reason: 'events-dir', detail: dirOk2.detail };
    return { ok: true, raw };
  } catch (e) {
    if (e && (e.code === 'ENOENT')) return { ok: false, reason: 'absent' };
    if (e && (e.code === 'ELOOP' || e.code === 'EMLINK')) return { ok: false, reason: 'not-regular', detail: `${basename} is a symlink — refusing to follow` };
    return { ok: false, reason: 'read-error', detail: String((e && e.message) || e).slice(0, 120) };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function listFlatSegments(repoRoot) {
  // Refusal direction: an unsafe events dir yields NO segments (stamp then
  // refuses no-receipt) rather than following a symlinked tree.
  const r = await listSegmentsSafe(repoRoot);
  return r.segments;
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
    const rs = await readSegmentSafe(repoRoot, seg);
    if (!rs.ok) continue;
    const lines = rs.raw.split('\n');
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
      // An upgrade crash can leave the proof only in `.bak` — restore that
      // EARLIER attestation instead of re-stamping (a fresh stamp would carry
      // a later date and silently discard the original evidence).
      const lastProof = join(anchorsDir(repoRoot), last.dir, 'payload.json.ots');
      try {
        const rb = await reconcileBak(otsBin, lastProof);
        if (rb.restored) {
          if (!last.meta) await finishStamp(repoRoot, last.seq, last.payloadDigest, { calendars: [] }, spineLib);
          const giB = await ensureAnchorsGitignore(repoRoot);
          return { ok: true, seq: last.seq, payloadDigest: last.payloadDigest, calendars: [], recovered: true, gitignore: giB.state };
        }
      } catch (e) {
        return { ok: false, reason: 'bak-error', detail: `could not reconcile payload.json.ots.bak (${String((e && e.message) || e).slice(0, 120)}) — backup preserved; resolve manually`, seq: last.seq };
      }
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

// ── .bak reconciliation protocol ─────────────────────────────────────────

// The stock client's upgrade path renames the proof to `<file>.bak`, then
// rewrites the primary — so a crash can leave the BACKUP as the only valid
// copy (primary missing OR truncated). The protocol: a .bak is NEVER deleted
// until the primary is proven parseable by the client itself (`ots info`).
//   primary missing            → restore (rename .bak → primary)
//   primary unparseable        → restore (replace the corrupt primary)
//   primary parses             → the backup is redundant → delete it
// Any fs failure THROWS with the .bak preserved — the caller reports the
// anchor as errored and skips it; irreversible loss is never the fallback.
async function reconcileBak(otsBin, proofPath) {
  const bak = `${proofPath}.bak`;
  try { await stat(bak); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { restored: false, hadBak: false };
    throw e; // unreadable ≠ absent — proceeding could orphan a sole-copy backup
  }
  let primaryMissing = false;
  try { await stat(proofPath); }
  catch (e) {
    if (e && e.code === 'ENOENT') primaryMissing = true;
    else throw e; // can't tell — never decide destructively on a transient error
  }
  let primaryOk = false;
  if (!primaryMissing) {
    try {
      await execOts(otsBin, ['info', proofPath], { timeout: 60000, shell: false });
      primaryOk = true;
    } catch (e) {
      // Only the client REJECTING the file (a clean nonzero exit) proves it
      // unparseable. A spawn failure, timeout, or kill proves nothing about
      // the file — restoring on those would delete a VALID newer primary.
      const clientRejected = typeof (e && e.code) === 'number' && !(e && e.killed);
      if (!clientRejected) throw e;
    }
  }
  if (!primaryOk) {
    await rm(proofPath, { force: true });
    await rename(bak, proofPath); // throws → caller aborts, .bak intact
    return { restored: true, hadBak: true };
  }
  await rm(bak, { force: true });
  return { restored: false, hadBak: true };
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
      const base = join(anchorsDir(repoRoot), a.dir);
      const proofPath = join(base, 'payload.json.ots');
      // Reconcile the backup BEFORE any presence decision: a crash between
      // the client's rename-to-.bak and its rewrite leaves hasProof false
      // with the backup as the only valid proof — restoring here is what
      // keeps `no-proof` (and a later destructive re-stamp) from being the
      // answer to a recoverable state.
      let hasProof = a.hasProof;
      try {
        const rb = await reconcileBak(otsBin, proofPath);
        if (rb.restored) hasProof = true;
      } catch (e) {
        results.push({ seq: a.seq, state: 'bak-error', detail: `could not reconcile payload.json.ots.bak (${String((e && e.message) || e).slice(0, 120)}) — backup preserved; resolve manually` });
        continue;
      }
      if (!hasProof) { results.push({ seq: a.seq, state: 'no-proof' }); continue; }
      // Digest from DISK — a restore above may have replaced the bytes
      // listAnchors saw.
      let diskDigest = a.proofDigest;
      try { diskDigest = sha256Hex(await readFile(proofPath)); } catch { /* keep listed */ }
      if (a.meta && a.meta.complete === true) {
        // Reconcile: the newest ANCHOR_* event must record the CURRENT proof
        // digest. A mismatch here is the benign twin of the --verify FAIL (an
        // upgrade whose event append failed) — re-emit so the record matches
        // disk again instead of skipping forever.
        const rec = newestEv.get(a.seq);
        if (spineLib && spineLib.append && rec && rec.digest !== diskDigest) {
          await spineLib.append(repoRoot, {
            type: 'ANCHOR_UPGRADED',
            actor: process.env.MADDU_SESSION_ID || null,
            data: {
              seq: a.seq, payload_digest: a.payloadDigest, complete: true,
              proof_files: [{ path: `.maddu/anchors/${a.dir}/payload.json.ots`, digest: diskDigest }],
            },
          });
          results.push({ seq: a.seq, state: 'reconciled' });
        } else {
          results.push({ seq: a.seq, state: 'complete' });
        }
        continue;
      }
      const before = diskDigest; // reconcileBak already ran at the loop top
      let complete = false, detail = null;
      try {
        await execOts(otsBin, ['upgrade', proofPath], { timeout: 120000, shell: false });
        complete = true; // exit 0 = upgraded to a Bitcoin attestation
      } catch (e) {
        detail = String((e && (e.stderr || e.stdout || e.message)) || e).slice(0, 300);
        complete = false;
      }
      // Post-run backup reconciliation: the client just created a fresh .bak
      // and rewrote the primary — if that rewrite died (truncated primary),
      // restore from the backup and record NOTHING as upgraded; the .bak is
      // deleted only once the primary parses. A reconcile failure preserves
      // the backup and reports the anchor instead of proceeding.
      let restoredPostRun = false;
      try {
        const rb2 = await reconcileBak(otsBin, proofPath);
        restoredPostRun = rb2.restored;
      } catch (e) {
        results.push({ seq: a.seq, state: 'bak-error', detail: `could not reconcile payload.json.ots.bak after upgrade (${String((e && e.message) || e).slice(0, 120)}) — backup preserved; resolve manually` });
        continue;
      }
      if (restoredPostRun) complete = false; // the client's rewrite was bad — nothing advanced
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
    const rs = await readSegmentSafe(repoRoot, seg);
    if (!rs.ok) continue;
    const raw = rs.raw;
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
      receiptDigest: a.payload?.receipt_digest ?? null,
      proofDigest: a.proofDigest ?? null,
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
  const segList = await listSegmentsSafe(repoRoot);
  if (!segList.ok) {
    issues.push({ level: 'FAIL', kind: 'events-dir-unsafe', detail: `${segList.detail} — every position/chain check would read outside the spine` });
  }
  for (const bad of segList.badEntries) {
    issues.push({ level: 'FAIL', kind: 'segment-not-regular', detail: `.maddu/events/${bad} is a canonical-named entry that is not a regular file (symlink?) — refusing to read it; it would skew chain-head and event scans` });
  }
  const segsAll = segList.segments;
  for (const seg of segsAll) {
    const rs = await readSegmentSafe(repoRoot, seg);
    if (!rs.ok) continue;
    const raw = rs.raw;
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
    // Spine-position binding. EVERY payload must carry a canonical position:
    // a v1 payload always has one, so an absent/malformed position is a
    // forged payload, never a benign omission. A path-shaped segment
    // (`../fake.ndjson`), a non-positive or non-integer line, or a replica
    // that is not the EXPLICIT null v1 writes are all refused; only "the
    // named segment is not on this device" stays a WARN (fresh clone).
    {
      const pos = a.payload.position;
      const posValid = pos && typeof pos === 'object' && typeof pos.segment === 'string' && SEGMENT_NAME_RE.test(pos.segment)
        && Number.isInteger(pos.line) && pos.line >= 1 && pos.replica === null;
      let raw = null;
      let unsafe = null;
      if (!posValid) {
        issues.push({ level: 'FAIL', kind: 'position-invalid', seq: a.seq, detail: `payload position is not a canonical in-spine segment/line/replica reference — forged or hand-built payload` });
      } else {
        const rs = await readSegmentSafe(repoRoot, pos.segment);
        if (rs.ok) raw = rs.raw;
        else if (rs.reason !== 'absent') unsafe = rs.detail || rs.reason;
      }
      if (!posValid) {
        /* already FAILed above */
      } else if (unsafe) {
        issues.push({ level: 'FAIL', kind: 'position-unsafe', seq: a.seq, detail: `refusing to read segment ${pos.segment}: ${unsafe}` });
      } else if (raw === null) {
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
  for (const seg of segsAll) {
    const rs = await readSegmentSafe(repoRoot, seg);
    if (!rs.ok) continue;
    for (const l of rs.raw.split('\n')) {
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
    // carry the on-disk payload digest — old or new. A forged event that
    // OMITS the field (or carries a non-string) must not slip past the
    // equality check by being falsy: presence, type, and equality are all
    // required wherever the stored payload exists to compare against.
    if (a.payloadDigest && (typeof d.payload_digest !== 'string' || d.payload_digest !== a.payloadDigest)) {
      issues.push({ level: 'FAIL', kind: 'event-digest-mismatch', seq: d.seq, detail: `${ev.type} (${ev.id}) ${typeof d.payload_digest === 'string' ? 'payload_digest does not match the stored payload' : 'carries no string payload_digest — real anchor events always do'} — forged event or edited payload` });
    }
    newestPerSeq.set(d.seq, ev);
  }
  // Proof digests DO change across upgrades, so only the NEWEST event per seq
  // is held to disk: a forged "upgraded" event (wrong or absent proof digest)
  // FAILs; older events are superseded history and are not compared.
  for (const [seqNo, ev] of newestPerSeq) {
    const a = bySeq.get(seqNo);
    const d = ev.data || {};
    // (payload_digest presence/type/equality for EVERY event — newest
    // included — is enforced in the loop above.)
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

// ── PR 6a: the assess ceremony's local refusal gates ─────────────────────
//
// These checks can only BLOCK an assessment — they never grant one. The
// positive evidence for `anchored` is the OPERATOR's own external
// Bitcoin-backed `ots verify` run; the tool never executes a verifier and
// never derives the level from local state alone.

// maddu.json → witness.maxAnchorAge: optional "<n>d" (days). A missing
// maddu.json means no policy; a PRESENT-but-unparseable file or a malformed
// value is invalid — the ceremony fails closed on it (a consume gate must
// never guess its own policy).
export async function readMaxAnchorAge(repoRoot) {
  let raw = null;
  try { raw = await readFile(join(repoRoot, 'maddu.json'), 'utf8'); } catch (e) {
    // Fail closed on everything but a genuinely ABSENT file: an unreadable or
    // replaced maddu.json (EACCES, EISDIR, …) must not silently skip the age
    // gate — only "there is no maddu.json" means "no policy declared".
    if (e && e.code === 'ENOENT') return { set: false };
    return { set: true, invalid: true, detail: `maddu.json exists but cannot be read (${(e && e.code) || 'error'}) — cannot read witness.maxAnchorAge` };
  }
  let cfg = null;
  try { cfg = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch {
    return { set: true, invalid: true, detail: 'maddu.json is present but not valid JSON — cannot read witness.maxAnchorAge' };
  }
  const v = cfg?.witness?.maxAnchorAge;
  if (v === undefined || v === null) return { set: false };
  // Bounded by construction: at most 5 digits (≈273 years). An unbounded
  // digit run would parse to Infinity and make every stale-date comparison
  // false — a policy that can never fire is worse than none.
  if (typeof v !== 'string' || !/^\d{1,5}d$/.test(v) || parseInt(v, 10) < 1) {
    // The offending VALUE is caller-typed config text — never echo it (a
    // secret pasted into the wrong field would land on stderr and in logs).
    return { set: true, invalid: true, detail: 'maddu.json witness.maxAnchorAge must be "<n>d" (whole days, 1–99999) — the configured value does not conform (value not echoed)' };
  }
  return { set: true, invalid: false, days: parseInt(v, 10) };
}

// assessBinding — the read-only binding check the ceremony runs TWICE (before
// prompting and again after the final confirm, immediately before append).
// ANY FAIL blocks. Stricter than verifyAnchors on one point: the receipt
// bytes must be readable on THIS device (a fresh clone missing the segment is
// a verify WARN but an assess refusal — the ceremony cannot confirm
// payload↔receipt binding it cannot read).
export async function assessBinding(repoRoot, { sha, seq = null } = {}) {
  const issues = [];
  const warns = [];
  if (!isGitSha(sha)) {
    return { ok: false, anchor: null, warns, issues: [{ level: 'FAIL', kind: 'bad-sha', detail: 'subject must be a FULL lowercase 40- or 64-hex git commit sha (no abbreviations, no refs)' }] };
  }
  const v = await verifyAnchors(repoRoot);
  for (const i of v.issues) (i.level === 'FAIL' ? issues : warns).push(i);
  const { anchors } = await listAnchors(repoRoot);
  const matches = anchors.filter((a) => a.payload && a.payload.subject_sha === sha);
  let target = null;
  if (seq !== null) {
    target = matches.find((a) => a.seq === seq) || null;
    if (!target) issues.push({ level: 'FAIL', kind: 'seq-not-matching', detail: `--seq ${seq} does not name an anchor whose payload commits to subject ${sha.slice(0, 12)}…` });
  } else if (matches.length) {
    target = matches[matches.length - 1]; // newest seq wins
  } else {
    issues.push({ level: 'FAIL', kind: 'no-anchor-for-sha', detail: `no anchor payload commits to subject ${sha.slice(0, 12)}… — stamp one first (\`maddu spine anchor\`)` });
  }
  let anchor = null;
  if (target) {
    if (!target.hasProof || !target.proofDigest) {
      issues.push({ level: 'FAIL', kind: 'proof-missing', seq: target.seq, detail: `anchor #${target.seq} has no payload.json.ots on disk — there is nothing to verify externally` });
    }
    if (target.payload?.v !== PAYLOAD_VERSION) {
      issues.push({ level: 'FAIL', kind: 'payload-version', seq: target.seq, detail: `payload version is not the known v${PAYLOAD_VERSION} — refusing to assess a shape this code cannot vouch for` });
    }
    const pos = target.payload?.position;
    const posValid = pos && typeof pos === 'object' && typeof pos.segment === 'string' && SEGMENT_NAME_RE.test(pos.segment)
      && Number.isInteger(pos.line) && pos.line >= 1 && pos.replica === null;
    if (!posValid) {
      issues.push({ level: 'FAIL', kind: 'position-invalid', seq: target.seq, detail: 'payload position is not a canonical in-spine segment/line/replica reference' });
    } else {
      const rs = await readSegmentSafe(repoRoot, pos.segment);
      if (!rs.ok) {
        issues.push({ level: 'FAIL', kind: 'receipt-unavailable', seq: target.seq, detail: `cannot read spine segment ${pos.segment} (${rs.detail || rs.reason}) — assessment requires the receipt bytes on this device` });
      } else {
        const line = (rs.raw.split('\n')[pos.line - 1] || '').replace(/\r$/, '');
        let ev = null;
        try { ev = JSON.parse(line); } catch { /* handled below */ }
        if (!line || hashLine(line) !== target.payload.receipt_digest) {
          issues.push({ level: 'FAIL', kind: 'receipt-mismatch', seq: target.seq, detail: `spine ${pos.segment}:${pos.line} does not hash to the payload's receipt_digest — the spine was rewritten, or the anchor lies` });
        } else if (!ev || ev.type !== 'VERIFICATION_RAN' || ev.id !== target.payload.event_id) {
          issues.push({ level: 'FAIL', kind: 'receipt-wrong-event', seq: target.seq, detail: 'the line at the recorded position is not the VERIFICATION_RAN receipt the payload names' });
        }
      }
    }
    anchor = {
      seq: target.seq,
      payloadDigest: target.payloadDigest,
      proofDigest: target.proofDigest,
      receiptDigest: target.payload?.receipt_digest ?? null,
      subjectSha: sha,
      eventId: target.payload?.event_id ?? null,
    };
  }
  return { ok: issues.length === 0, anchor, issues, warns };
}
