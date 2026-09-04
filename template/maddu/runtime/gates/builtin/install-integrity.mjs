// Install integrity: framework-managed files present and hash-matched.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// EOL-normalized integrity hash — must match commands/_manifest.mjs#sha256OfFile.
// A CRLF working-tree copy (Windows autocrlf) hashes equal to its LF source, so
// framework files aren't misflagged as modified; binary files (any NUL byte)
// are hashed raw. The latin1 round-trip is byte-exact, collapsing only CRLF→LF.
async function sha256OfFile(p) {
  const buf = await readFile(p);
  const bytes = buf.includes(0) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(bytes).digest('hex');
}

// null = genuinely absent; THROWS = present but unparseable. The two need
// different verdicts and different remedies, and collapsing them into null made
// the gate report a truncated manifest as "missing".
// THREE outcomes. null = genuinely absent (ENOENT). A read failure for any other
// reason — an ACL, a sharing violation, a directory where a file belongs — is
// NOT absence and must not be reported as "missing"; it sends the operator to
// re-scaffold a file that is sitting right there. And a present-but-unparseable
// file throws, which the caller distinguishes again.
async function readMadduJson(repoRoot) {
  let raw;
  try { raw = await readFile(join(repoRoot, 'maddu.json'), 'utf8'); }
  catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    const e = new Error(`maddu.json could not be read (${err && err.code || 'error'})`);
    e.unreadable = true;
    throw e;
  }
  return JSON.parse(raw);
}

// `maddu upgrade` writes this before it touches a file and deletes it once the
// manifest is written, so its presence means an apply began and did not finish.
// Device-local under .maddu/state/ (gitignored) rather than in maddu.json,
// which is tracked — one machine's crashed upgrade must not be committed and
// then fail this gate for every teammate whose install is fine.
// THREE outcomes, mirroring commands/upgrade.mjs#readUpgradeMarker exactly.
// This function used to be `catch { return null; }`, and that single line was
// the same defect the marker exists to close, sitting one file over from where
// it was fixed: a recovery interrupted while rewriting the marker leaves a
// TRUNCATED marker, and reading it as "absent" let this critical gate return
// green over an install whose own evidence says an apply began and may never
// have finished. A marker that exists at all is proof something happened; only
// its detail is lost. Say that, rather than reporting settled.
//
// Keep this in step with upgrade.mjs. The two reads are a pair — a fix applied
// to one and not the other has now happened three times on this state file, and
// each time the half that was missed became the live hole.
async function readUpgradeMarker(repoRoot) {
  let raw;
  try { raw = await readFile(join(repoRoot, '.maddu', 'state', 'upgrade-in-progress.json'), 'utf8'); }
  catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    return { malformed: true, why: `unreadable (${err && err.code || 'error'})`, paths: [] };
  }
  try {
    const m = JSON.parse(raw);
    if (m && Array.isArray(m.paths)) return m;
    return { malformed: true, why: 'not a marker (no paths array)', paths: [] };
  } catch {
    return { malformed: true, why: 'not valid JSON — probably truncated mid-write', paths: [] };
  }
}

export default {
  id: 'install-integrity',
  label: 'install integrity',
  severity: 'critical',
  description: 'Every framework-managed file present and hash-matched.',
  run: async (ctx) => {
    // THE MARKER IS READ FIRST, before maddu.json is parsed. A crashed upgrade
    // could leave the manifest truncated (the write is atomic now, but an older
    // install can still carry one), and parsing first meant this gate answered
    // "maddu.json missing" over a file sitting on disk — describing the symptom
    // it happened to trip over rather than the interrupted upgrade that caused
    // it, and sending the operator to `maddu init` instead of `maddu upgrade`.
    // The marker is the more specific fact and it does not depend on the
    // manifest being readable, so it is consulted first.
    //
    // An upgrade records its intent before it touches a file and clears it only
    // once the manifest is written, so this marker standing means the apply loop
    // did not finish. That state is invisible to everything below: the manifest
    // is written LAST, so a crashed upgrade leaves files on disk that `managed`
    // never listed, and a path absent from `managed` cannot be reported missing.
    // Inferring it instead of reading it does not work — comparing the recorded
    // framework_version against the installed maddu/version.json fails because
    // version.json is itself managed, so after a crash the two still agree; and
    // comparing hashes only catches an interruption that got as far as the
    // update phase, which adds-before-updates deliberately makes the rarer case.
    const u = await readUpgradeMarker(ctx.repoRoot);
    // THE REMEDY DEPENDS ON THE MANIFEST, so the manifest is probed before one is
    // named. Reporting the marker first is right — it is the more specific fact —
    // but the remedy that follows from it is not constant. `maddu upgrade` cannot
    // recover an install whose maddu.json is missing or damaged: it needs the
    // manifest to compute a plan and exits before it can. Naming it there sent
    // the operator to a command that refuses, and the gate stayed critical after
    // they did exactly as they were told. `maddu init --force` re-scaffolds every
    // framework file, rewrites the manifest, and clears the marker, so it is the
    // remedy that actually ends this state — and it is only correct to name it
    // when the manifest really is unusable, because it also overwrites framework
    // files the operator may have edited on purpose.
    let manifestUsable = true;
    if (u) {
      try { manifestUsable = (await readMadduJson(ctx.repoRoot)) !== null; }
      catch { manifestUsable = false; }
    }
    const RECOVER = manifestUsable
      ? 're-run `maddu upgrade` to complete it'
      : 're-scaffold with `maddu init --force` — `maddu upgrade` cannot recover this one, because maddu.json is missing or damaged and it needs the manifest to plan';
    // `--force` is no escape from an unusable manifest: upgrade reads maddu.json
    // before it ever consults the flag, so `maddu upgrade --force` refuses in
    // exactly the same place as the plain form.
    const RECOVER_FULL = manifestUsable
      ? 're-apply every framework file with `maddu upgrade --force`'
      : 're-scaffold with `maddu init --force` — `maddu upgrade --force` cannot recover this one either, because maddu.json is missing or damaged and upgrade reads it before it reads the flag';
    if (u && u.malformed) {
      // Present but unreadable. We know an apply began; we do NOT know what it
      // planned, so nothing here can say which files are outstanding. `--force`
      // is named because it is the only remedy that does not need the marker's
      // detail: re-applying every framework file is sound whatever the lost
      // plan contained. Reporting this as a clean install because the evidence
      // is damaged would be the gate colluding with the damage.
      return {
        ok: false,
        message: `an upgrade marker is present but ${u.why} — an apply began here and there is no record of it finishing; ${RECOVER_FULL} (its plan cannot be recovered, so a targeted repair is not possible)`,
        evidence: { upgrade_in_progress: u },
      };
    }
    if (u) {
      return {
        ok: false,
        // Plain `maddu upgrade`, NOT --force. The re-run recomputes its plan
        // from the manifest as it stands, which is exactly right, and finishes
        // what was interrupted. --force would also overwrite the operator's own
        // local edits, which this state gives no reason to touch.
        message: `an upgrade to v${u.version} did not finish (started ${u.at}) — this install is half-applied; ${RECOVER}${manifestUsable ? ` (no --force needed: it rewrites only the ${u.paths.length} file(s) that run had planned, and leaves every other local edit alone — note that an edit you made to one of those ${u.paths.length} since the interruption is not distinguishable from that run's half-written output and will be replaced)` : ''}`,
        evidence: { upgrade_in_progress: u },
      };
    }
    // No marker: now the manifest has to be readable, and "unreadable" is a
    // distinct verdict from "absent" — saying missing about a file that exists
    // sends the operator to the wrong remedy.
    let madduJson = null, readErr = null;
    try { madduJson = await readMadduJson(ctx.repoRoot); }
    catch (err) { readErr = err; }
    if (readErr) {
      return {
        ok: false,
        message: readErr.unreadable
          ? `${String(readErr.message).split('\n')[0]} — it is present but this process cannot read it`
          : `maddu.json is present but not valid JSON — ${String((readErr && readErr.message) || readErr).split('\n')[0]}`,
        evidence: { repoRoot: ctx.repoRoot, unreadable: 'maddu.json' },
      };
    }
    if (!madduJson) {
      return { ok: false, message: `maddu.json missing at ${ctx.repoRoot}`, evidence: null };
    }
    const managed = madduJson.managed || {};
    const missing = [], modified = [];
    for (const [rel, meta] of Object.entries(managed)) {
      const abs = join(ctx.repoRoot, rel);
      if (!(await exists(abs))) { missing.push(rel); continue; }
      const h = await sha256OfFile(abs);
      if (h !== meta.sha256) modified.push(rel);
    }
    const total = Object.keys(managed).length;
    if (missing.length === 0 && modified.length === 0) {
      return { ok: true, message: `${total} managed files present, hashes match` };
    }
    if (missing.length) {
      return {
        ok: false,
        message: `missing: ${missing.join(', ')}`,
        evidence: { missing, modified, total },
      };
    }
    // modified-only: doctor's prior behavior was WARN, not FAIL. Surface
    // explicit status='warn' so the gate runner records a warn (preserving
    // hard-rule semantics: the rule isn't violated, but operator should know).
    return {
      ok: true,
      status: 'warn',
      message: `locally modified: ${modified.join(', ')}`,
      evidence: { missing, modified, total },
    };
  },
};
