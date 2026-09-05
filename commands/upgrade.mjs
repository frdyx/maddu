// `maddu upgrade` — pull newer framework files in place; never touch project state.
//
// Usage:
//   maddu upgrade [--force] [--dry-run]
//
// Rules:
//   • Refuses if maddu.json is missing — run `maddu init` first.
//   • For each currently-managed file: compares on-disk hash to the hash recorded
//     in maddu.json. Matches → safe to overwrite. Differs → operator modified
//     it; refuse unless --force, and append a warning event regardless.
//   • Files added in the new framework version are installed unconditionally.
//   • Files removed from the new framework are deleted from the target only if
//     their hashes are pristine; modified ones are left alone with a warning.
//   • Project state under .maddu/{events,state,sessions,inbox,archive,*/project}
//     is never touched.

import { mkdir, readFile, writeFile, unlink, copyFile, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import {
  exists, absent, writeJson, frameworkOwnedFiles, sha256OfFile, readMadduJson, writeMadduJson,
  frameworkVersion, ensureShimExecutable, requireSourceLayout, TEMPLATE_ROOT
} from './_manifest.mjs';

// ── the in-flight marker ────────────────────────────────────────────────────
// `maddu upgrade` records its intent before it touches a file, so an install
// can say "an apply began here and did not finish" without having to infer it.
// Inference does not work: the manifest is written last, so a crashed upgrade
// leaves files that `managed` never listed, and a path absent from `managed`
// cannot be reported missing. Comparing the recorded framework_version against
// the installed maddu/version.json fails too — version.json is itself managed
// and emitted last, so after a crash the two still agree.
//
// It lives under .maddu/state/ and NOT in maddu.json, which is tracked: a
// crashed upgrade on one machine must not be committed and then fail
// install-integrity for every teammate whose install is fine. .maddu/* is
// gitignored, so the marker stays device-local, which is what it describes.
//
// It carries the PLANNED APPLY SET, and that is what makes recovery work
// rather than merely detection. A file the crashed run half-delivered has a
// hash that no longer matches the stale manifest, and is otherwise
// indistinguishable from an operator's own edit — so the re-run would strand
// its own work as "locally modified", leaving a permanent warning and an
// install that demands --force forever, which would then also overwrite the
// operator's real edits.
//
// WHAT MEMBERSHIP DOES AND DOES NOT PROVE. Being in this set does NOT prove a
// mismatched file is the framework's rather than the operator's — `paths` is
// the PLANNED set, a superset of what was actually written, and a crash leaves
// no record of where it stopped. A `--force` plan is every managed file, so a
// crash at file 30 of 497 leaves 467 planned paths the run never went near.
//
// What narrows the exposure is the branch ORDER below, not this set: a planned
// file whose hash still matches the manifest is handled as pristine and never
// reaches the in-flight arm, so only a file that ALREADY drifted is
// force-completed. That leaves one real loss — a framework file the operator
// edits between the crash and the recovery — and the run announces each one
// (`completing interrupted write of <path>`) rather than taking it silently.
//
// That is the trade: an announced loss inside one window, against stranding the
// framework's own half-written file as a permanent "locally modified" and
// forcing the operator into `--force`, which would take their real edits too.
function markerPath(repoRoot) {
  return join(repoRoot, '.maddu', 'state', 'upgrade-in-progress.json');
}
// THREE outcomes, not two. `null` means no marker — the install claims to be
// settled. A marker that is PRESENT but unparseable or the wrong shape is a
// fourth state that used to collapse into `null`, and that was a hole exactly
// as large as the one this marker exists to close: a recovery interrupted while
// rewriting the marker leaves a truncated one, and reading it as "absent" sends
// the next run down the nothing-to-do path over an install that is still broken.
// A marker that exists at all is evidence something happened; only its DETAIL is
// lost. `{ malformed: true }` says so instead of lying about it.
async function readUpgradeMarker(repoRoot) {
  let raw;
  try { raw = await readFile(markerPath(repoRoot), 'utf8'); }
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
// Atomic, for the same reason the manifest is. An in-place write truncates
// first, so a kill mid-write produced the malformed marker handled above — the
// recovery mechanism damaging its own evidence.
async function writeUpgradeMarker(repoRoot, marker) {
  await mkdir(dirname(markerPath(repoRoot)), { recursive: true });
  await writeJson(markerPath(repoRoot), marker);
}

// ── the upgrade lock ────────────────────────────────────────────────────────
// One marker, one manifest, one file tree — and until now nothing stopped two
// upgrades running over each other. The failure is not a garbled file, it is
// LOST EVIDENCE: process A finishes and clears the marker while B is still
// copying; B is then killed mid-file; the manifest A wrote is intact, no marker
// stands, and a plain retry sees every file present and listed and exits
// silently over a truncated one. Atomic single-file writes cannot fix that,
// because the transaction being interrupted spans hundreds of files.
//
// `wx` is the whole mechanism: an exclusive create is atomic on NTFS and POSIX,
// so exactly one process wins. Refusing is the right behaviour rather than
// waiting — an upgrade is an explicit operator command, not a background task,
// and a second one is a mistake worth reporting rather than queueing.
function upgradeLockPath(repoRoot) {
  return join(repoRoot, '.maddu', 'state', 'upgrade.lock');
}
async function acquireUpgradeLock(repoRoot) {
  await mkdir(dirname(upgradeLockPath(repoRoot)), { recursive: true });
  try {
    const fh = await open(upgradeLockPath(repoRoot), 'wx');
    await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2) + '\n');
    await fh.close();
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // A lock whose owner is gone is not a lock, it is litter — and an upgrade
      // killed mid-run would otherwise block every future one permanently, which
      // is a worse failure than the race this guards. `kill(pid, 0)` signals
      // nothing; it only asks whether the process exists. Unknown/unreadable pid
      // is treated as LIVE, so the ambiguous case refuses rather than barges in.
      let ownerAlive = true;
      try {
        const j = JSON.parse(await readFile(upgradeLockPath(repoRoot), 'utf8'));
        if (Number.isInteger(j.pid)) {
          try { process.kill(j.pid, 0); } catch (e) { ownerAlive = !(e && e.code === 'ESRCH'); }
        }
      } catch { /* unreadable → treat as live */ }
      if (ownerAlive) return false;
      console.log(`Clearing a stale upgrade lock — the process that took it is gone.`);
      await releaseUpgradeLock(repoRoot);
      return acquireUpgradeLock(repoRoot);
    }
    // Any other failure (read-only FS, permissions) must not block an upgrade
    // that would otherwise work — the lock is a guard against a rare mistake,
    // not a precondition for correctness.
    return true;
  }
}
async function releaseUpgradeLock(repoRoot) {
  try { await unlink(upgradeLockPath(repoRoot)); } catch {}
}
async function describeUpgradeLock(repoRoot) {
  try {
    const j = JSON.parse(await readFile(upgradeLockPath(repoRoot), 'utf8'));
    return `pid ${j.pid}, started ${j.at}`;
  } catch { return 'details unreadable'; }
}
// Best-effort by design: a failed delete must never fail an upgrade that
// actually succeeded. A marker left standing over a complete install is a
// false critical, and it self-heals — the next plain `maddu upgrade` reaches
// the nothing-to-do path and clears it there.
// Still best-effort — a failed delete must never fail an upgrade that actually
// worked — but no longer SILENT. A swallowed failure here left the operator with
// a success report on stdout and a critical `install-integrity` failure
// afterwards, with nothing connecting the two; worse, the stale marker is then
// read by the next plain run as an interrupted apply, whose paths it will
// rewrite over any edit made since. Returns null on success (ENOENT included —
// gone is the state we wanted) or the error code, for the caller to announce.
async function clearUpgradeMarker(repoRoot) {
  try { await unlink(markerPath(repoRoot)); return null; }
  catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    return (err && err.code) || 'error';
  }
}

// The genuinely-nothing-to-do exit. Reached only after the framework tree has
// been enumerated and shown to hold no file this install is missing — version
// equality alone was never sufficient evidence for saying this.
//
// INVARIANT, and the line to defend in review: this must stay downstream of the
// enumeration AND downstream of the marker read. Clearing the marker here is
// only sound while arriving here proves the install is complete. The first
// version of this cleared it after checking two of the three states a
// half-applied install can be in — nothing unlisted, nothing missing — and
// missed the third: files PRESENT BUT CORRUPT, which is what a killed
// `--force` repair leaves behind. Every path existed, so the retry cleared the
// marker, printed "Nothing to do", and left the corruption; if the corrupt file
// was the hook core, enforcement was dead and the only evidence was gone.
//
// So a standing marker now short-circuits this function entirely (see the
// caller). Re-introduce any fast path in front of the enumeration, or let a
// marker reach this point, and the clear degrades from proof to inference and
// the marker becomes self-erasing garbage.
async function alreadyCurrent(repoRoot, madduJson, toVersion) {
  // THE CLEAR IS TAKEN UNDER THE LOCK, and skipped entirely if the lock is held.
  // The lock added in v1.132 guards the APPLY; it did not guard this line, and
  // this line deletes the apply's only evidence. The race is not hypothetical:
  // this function is reached at the nothing-to-do exit, long before the apply
  // path acquires the lock, so process B could read "no marker", pause, let
  // process A take the lock and write ITS marker, then resume here and delete
  // A's marker while A was still copying. If A was then killed, the install was
  // half-applied with no marker standing and no record that anything began —
  // precisely the lost-evidence failure the lock was introduced to close,
  // reopened by the one path that never touched the lock.
  //
  // Failing to acquire is not an error here. It means another upgrade owns this
  // install right now, so this run knows nothing about whether its own
  // enumeration is still true, and the one thing it must not do is delete the
  // other run's recovery evidence on the way out.
  if (await acquireUpgradeLock(repoRoot)) {
    await clearUpgradeMarker(repoRoot);
    await releaseUpgradeLock(repoRoot);
  } else {
    console.error(`maddu upgrade: another upgrade is running here (${await describeUpgradeLock(repoRoot)}); leaving its recovery marker alone.`);
  }
  // Mutation-witness declared no-op: already-current is a success that
  // deliberately touches nothing.
  try {
    const { loadLibOptional } = await import('./_libroot.mjs');
    (await loadLibOptional('mutation-witness.mjs'))?.witnessNoop?.('idempotent-already-current');
  } catch {}
  // A prior upgrade that skipped locally-modified files bumped
  // framework_version anyway, so those files are stranded at their old
  // content while the manifest claims the new version. Saying "nothing to
  // do" there is a false report about state, and the repo-wide rule is that
  // no command reports success it did not perform (v1.124.0). Report the
  // stranded set and exit non-zero, the same way `maddu sources status`
  // exits 1 when pins have drifted.
  const stranded = Array.isArray(madduJson.partial_upgrade?.paths) ? madduJson.partial_upgrade.paths : [];
  if (stranded.length) {
    console.error(`Framework version is v${toVersion}, but ${stranded.length} managed file(s) were never updated to it.`);
    console.error(`  Locally modified when v${madduJson.partial_upgrade.version} was applied, so upgrade left them alone:`);
    for (const p of stranded.slice(0, 20)) console.error(`    ${p}`);
    if (stranded.length > 20) console.error(`    ... and ${stranded.length - 20} more`);
    console.error(`  Resolve with: maddu upgrade --force   (overwrites those local edits)`);
    process.exit(1);
  }
  console.log(`Already on framework v${toVersion}. Nothing to do.`);
  console.log(`  (pass --force to re-overwrite all framework files anyway)`);
}

export default async function upgrade(argv) {
  const { flags } = parseFlags(argv);
  const force = !!flags.force;
  const dryRun = !!flags['dry-run'];

  // v0.17.1: refuse early if invoked via a consumer install's bundled CLI.
  // Previously a silent no-op — walked an empty template/maddu/ and copied
  // bin+commands onto itself, then reported "Upgraded to vX.Y.Z" with 0 updates.
  const layoutError = await requireSourceLayout('upgrade');
  if (layoutError) {
    console.error(layoutError);
    process.exit(2);
  }

  const repoRoot = await findRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error('maddu upgrade: no .maddu/ found. Run `maddu init` first.');
    process.exit(1);
  }
  // THE MARKER IS READ FIRST, before the manifest, and its report is printed on
  // BOTH failure branches below — not only the malformed one. An interrupted
  // upgrade explains a damaged or missing manifest, and it is the more specific
  // fact; reading it second meant an ABSENT manifest exited saying only
  // "missing", never mentioning the apply that was cut short.
  const strandedMarker = await readUpgradeMarker(repoRoot);
  const sayMarker = () => {
    if (!strandedMarker) return;
    if (strandedMarker.malformed) {
      console.error(`  An upgrade marker is also present but ${strandedMarker.why} — an apply began here and there is no record of it finishing.`);
    } else {
      console.error(`  An upgrade to v${strandedMarker.version} began ${strandedMarker.at} and did not finish; ${strandedMarker.paths.length} file(s) were in its plan.`);
      console.error(`  That is very likely why this file is damaged.`);
    }
  };
  // The remedy has to be a command that actually runs. `maddu init` REFUSES when
  // .maddu/ already exists (commands/init.mjs), which is always true here, so
  // naming it plain sent the operator to an immediate refusal — the exact defect
  // class v1.129.0 existed to close.
  const REPAIR = '  Restore maddu.json from version control, or re-scaffold with `maddu init --force` (which overwrites framework files, not your project).';

  let madduJson = null;
  try {
    madduJson = await readMadduJson(repoRoot);
  } catch (err) {
    console.error(err && err.unreadable
      ? `maddu upgrade: ${join(repoRoot, 'maddu.json')} is present but this process cannot read it — ${String(err.message).split('\n')[0]}`
      : `maddu upgrade: ${join(repoRoot, 'maddu.json')} is present but not valid JSON — ${String((err && err.message) || err).split('\n')[0]}`);
    sayMarker();
    console.error(REPAIR);
    process.exit(1);
  }
  if (!madduJson) {
    console.error(`maddu upgrade: ${join(repoRoot, 'maddu.json')} is missing.`);
    sayMarker();
    console.error(REPAIR);
    process.exit(1);
  }

  const fromVersion = madduJson.framework_version;
  const toVersion = await frameworkVersion();

  // Enumerated BEFORE the version check, deliberately. Version equality is not
  // evidence that there is nothing to do: a managed file can be missing from
  // disk, and the shipped framework can hold a file this install's manifest
  // never listed — a release that ADDS a module, or an upgrade that died before
  // writing the manifest. Neither is visible without walking the framework
  // tree, and the old short-circuit returned above this walk, so `maddu upgrade`
  // answered "Nothing to do" over an install genuinely missing a module and
  // only `--force` could reach it.
  const nextFiles = await frameworkOwnedFiles();
  const nextRelPaths = new Set(nextFiles.map((f) => f.relPath));
  const prevRelPaths = new Set(Object.keys(madduJson.managed || {}));

  // READ BEFORE THE VERSION DECISION. A marker still standing means a previous
  // apply was interrupted; its path set tells this run which hash mismatches are
  // that run's unfinished work rather than the operator's edits. It is read here
  // rather than after the same-version branch because a killed `--force` repair
  // leaves every path PRESENT BUT CORRUPT — nothing unlisted, nothing missing —
  // so the "nothing to do" branch below would have cleared the marker and walked
  // away from the corruption. The marker is the only evidence that state exists;
  // deleting it while it is still true was the whole defect.
  // Already read above, before the manifest — reused rather than re-read so the
  // two branches can never disagree about whether a marker is standing.
  const inFlight = strandedMarker;
  const inFlightPaths = new Set(inFlight ? inFlight.paths : []);
  if (inFlight && inFlight.malformed) {
    // Present but unreadable. We know an apply began and not that it finished,
    // but not WHICH files it planned — so there is no path set to complete, and
    // every hash mismatch stays an operator edit. What this must not do is take
    // the nothing-to-do exit, which is why `sameVersion` below tests `!inFlight`
    // rather than `!inFlight?.paths.length`.
    console.error(`An upgrade marker is present but ${inFlight.why}.`);
    console.error(`  Something began an apply here and there is no record of it finishing.`);
    console.error(`  Re-applying every framework file is the only way to be sure: maddu upgrade --force`);
    if (!force) {
      // AND THEN IT STOPS. Saying "--force is the only way to be sure" and
      // continuing anyway was worse than either choice alone. With no readable
      // plan there is no path set, so every corrupt managed file reads as a hash
      // mismatch with no marker entry — i.e. as an operator edit — and is
      // skipped; the run then reached the manifest write, cleared the marker,
      // and reported a repair. The corruption survived, the only evidence that
      // an apply had been interrupted was destroyed, and the next run saw a
      // settled install. The command performed none of what it reported, which
      // is the one thing this repo does not allow (v1.124.0).
      //
      // Refusing keeps the marker standing, so `install-integrity` stays
      // critical and the state remains visible until someone actually repairs
      // it. The remedy named above is a command that runs and that does fix
      // this, which is the other half of the rule (v1.129.0).
      console.error(`  Refusing to continue: without that plan this run cannot tell your edits from the interrupted apply's half-written files, and finishing would clear the marker while leaving any corruption in place.`);
      process.exit(1);
    }
  } else if (inFlight) {
    console.log(`Recovering: an upgrade to v${inFlight.version} began ${inFlight.at} and did not finish.`);
    // Says what it DOES, not what sounds reassuring. The marker carries the
    // PLANNED set, never the applied set — a crash records nothing about where
    // it stopped — so a file in that plan is rewritten from the framework even
    // if the operator edited it after the crash. "Without disturbing local
    // edits" was true only of files outside the plan, and stating it flatly
    // meant the one case where the operator loses work was the case the message
    // promised was safe. The exposure is small and bounded (the window between
    // the crash and this recovery) but it is real, so it is named here and in
    // the integrity gate's remedy rather than left in a source comment.
    console.log(`  ${inFlightPaths.size} file(s) were in its plan; completing them.`);
    console.log(`  Those ${inFlightPaths.size} are re-written from the framework — including any you edited since the interruption, which cannot be told apart from that run's half-written output. Files outside the plan are left alone.`);
  }

  // A standing marker SHORT-CIRCUITS the nothing-to-do exit: an interrupted
  // apply is by definition something to do, and its damage may be invisible to
  // the probe below (a corrupt file is present and listed).
  // Two DIFFERENT questions, deliberately separate variables. `versionUnchanged`
  // asks whether this run moves the framework version — it decides whether
  // anything can honestly be called "stranded BY this upgrade". `sameVersion`
  // asks whether this run may take the nothing-to-do exit, which additionally
  // requires that no interrupted apply is outstanding. Collapsing them made a
  // same-version RECOVERY brand the operator's untouched local edits as a
  // partial upgrade, which is the permanent-alarm defect all over again.
  const versionUnchanged = fromVersion === toVersion;
  const sameVersion = versionUnchanged && !force && !inFlight;
  if (sameVersion) {
    // Repairable = a shipped file the manifest never listed, a managed file gone
    // from disk, or a manifest entry for a file the framework no longer ships.
    // The third is not cosmetic: the removal loop lives below this branch, so
    // an obsolete entry was previously unreachable on the same-version path and
    // `install-integrity` failed on it forever.
    const neverInstalled = nextFiles.filter((f) => !prevRelPaths.has(f.relPath));
    const absent = [];
    for (const relPath of prevRelPaths) {
      if (!(await exists(join(repoRoot, relPath)))) absent.push(relPath);
    }
    const obsolete = [...prevRelPaths].filter((p) => !nextRelPaths.has(p));
    if (neverInstalled.length || absent.length || obsolete.length) {
      console.log(`Framework is already v${toVersion}, but this install is incomplete:`);
      if (neverInstalled.length) console.log(`  never installed : ${neverInstalled.length}`);
      if (absent.length) console.log(`  missing on disk : ${absent.length}`);
      if (obsolete.length) console.log(`  no longer shipped but still listed : ${obsolete.length}`);
      console.log(`Repairing (local edits are left alone; pass --force to overwrite those too).`);
      // Fall through to the normal plan+apply.
    } else {
      return alreadyCurrent(repoRoot, madduJson, toVersion);
    }
  }

  const actions = { update: [], skip: [], add: [], remove: [], warnings: [] };

  // 1. Files in both old and new manifests.
  for (const { relPath, absSource } of nextFiles) {
    if (!prevRelPaths.has(relPath)) {
      actions.add.push({ relPath, absSource });
      continue;
    }
    const recorded = madduJson.managed[relPath].sha256;
    const onDisk = join(repoRoot, relPath);
    let currentHash = null;
    try { currentHash = await sha256OfFile(onDisk); } catch {}
    if (currentHash === null) {
      actions.update.push({ relPath, absSource, reason: 'missing on disk' });
    } else if (currentHash === recorded) {
      // Pristine. Compare against new content to see if there's a real change.
      const newHash = await sha256OfFile(absSource);
      if (newHash === recorded && !force) continue; // identical
      actions.update.push({ relPath, absSource });
    } else if (force) {
      actions.update.push({ relPath, absSource, reason: 'local edit overwritten (--force)' });
      actions.warnings.push(`overwrote locally-modified ${relPath}`);
    } else if (inFlight && inFlightPaths.has(relPath)) {
      // A mismatch on a file the interrupted run had planned to write is that
      // run's own half-finished work, not an operator edit. Completing it is
      // the recovery; treating it as a local edit would strand the framework's
      // own file and force the operator into --force to escape, taking their
      // real edits with it.
      actions.update.push({ relPath, absSource, reason: 'completing an interrupted upgrade' });
      actions.warnings.push(`completing interrupted write of ${relPath}`);
    } else {
      actions.skip.push({ relPath, reason: 'local edit; pass --force to overwrite' });
      actions.warnings.push(`skipped locally-modified ${relPath}`);
    }
  }

  // 2. Files present in old manifest but removed from new framework.
  for (const relPath of prevRelPaths) {
    if (nextRelPaths.has(relPath)) continue;
    const recorded = madduJson.managed[relPath].sha256;
    const onDisk = join(repoRoot, relPath);
    // `absent`, not `!exists`: dropping a manifest entry is a decision to FORGET
    // a file, and only ENOENT justifies it. A path whose attributes are
    // momentarily unreadable would otherwise be classified as gone, its entry
    // deleted, and the still-present file left unmanaged forever.
    if (await absent(onDisk)) {
      // Already gone from disk — but still LISTED. This is what a crashed
      // upgrade leaves behind: it unlinked the obsolete file and died before
      // rewriting the manifest. `continue` here left the entry in `newManaged`
      // forever, because that object starts as the stale manifest — so every
      // later run skipped the file again and `install-integrity` reported it
      // missing permanently, including after `--force`. Recording the removal
      // drops the entry; the unlink below is already tolerant of an absent file.
      actions.remove.push({ relPath, reason: 'already gone from disk; dropping the stale manifest entry' });
      continue;
    }
    let currentHash = null;
    try { currentHash = await sha256OfFile(onDisk); } catch {}
    if (currentHash === recorded || force) {
      actions.remove.push({ relPath });
    } else {
      actions.skip.push({ relPath, reason: 'removed upstream but locally modified' });
      actions.warnings.push(`framework removed ${relPath} but local copy is modified; left in place`);
    }
  }

  // Print plan.
  console.log(`Upgrade plan: v${fromVersion} → v${toVersion}`);
  console.log(`  update : ${actions.update.length}`);
  console.log(`  add    : ${actions.add.length}`);
  console.log(`  remove : ${actions.remove.length}`);
  console.log(`  skip   : ${actions.skip.length}`);
  if (actions.warnings.length) {
    console.log(`\nWarnings:`);
    for (const w of actions.warnings) console.log(`  ! ${w}`);
  }
  if (dryRun) {
    console.log(`\n(dry-run — no files changed)`);
    return;
  }

  // Intent-first. The manifest is written only AFTER the apply loop, so an
  // interruption leaves files on disk that `managed` never listed — and a path
  // absent from `managed` cannot be reported missing by anything downstream.
  // Recording the intent before touching a single file gives the install a
  // locally-decidable "this did not finish" marker that survives a crash, a
  // kill, or a full disk. The final writeMadduJson below rebuilds the object
  // from `madduJson`, which has no marker, so success clears it by construction
  // rather than by a second act that could itself fail.
  // Taken HERE, immediately before the first byte is written, and released
  // immediately after the marker is cleared. Deliberately not earlier: planning
  // is read-only and two processes may plan concurrently without harming
  // anything, and holding a lock across the whole enumeration would make a
  // `--dry-run` block a real upgrade.
  if (!(await acquireUpgradeLock(repoRoot))) {
    console.error(`maddu upgrade: another upgrade is already running in this repo (${await describeUpgradeLock(repoRoot)}).`);
    console.error(`  Two upgrades sharing one file tree can erase each other's recovery evidence, so this one is refusing.`);
    console.error(`  If you are sure nothing is running, delete ${upgradeLockPath(repoRoot)} and retry.`);
    process.exit(1);
  }

  const planned = [...actions.add, ...actions.update].map((a) => a.relPath);
  // IF THE INTENT CANNOT BE RECORDED, THE APPLY DOES NOT BEGIN.
  //
  // This used to be an unguarded await, and an unwritable marker path — a
  // directory sitting where the file belongs, an ACL, a file held open — threw
  // straight out of `writeJson`'s rename. The operator got a raw Node stack
  // trace naming `async rename`, from a command whose own reader had already
  // classified that exact state and printed a sentence about it two screens
  // earlier: the recovery path crashing on the state it exists to recover from.
  // The lock had been acquired by then and was never released, so the failure
  // also left the repo refusing every subsequent upgrade until someone deleted
  // a lock file by hand.
  //
  // Refusing is not caution, it is the same rule the marker itself encodes. The
  // marker is what makes an interruption recoverable; an apply that begins
  // without one is an apply whose failure mode is silent, and this command is
  // about to rewrite several hundred files. Better to change nothing and say
  // why.
  try {
    await writeUpgradeMarker(repoRoot, {
      version: toVersion,
      from: fromVersion,
      at: new Date().toISOString(),
      paths: planned,
    });
  } catch (err) {
    await releaseUpgradeLock(repoRoot);
    console.error(`maddu upgrade: cannot record this upgrade's recovery marker (${(err && err.code) || 'error'}), so nothing has been applied.`);
    console.error(`    ${markerPath(repoRoot)}`);
    console.error(`  That path must be a writable file. If a directory or a read-only file is sitting there, remove it and retry;`);
    console.error(`  without the marker an interruption mid-apply would leave this install half-written with no record that it happened.`);
    process.exit(1);
  }

  // Apply. ADDS FIRST, and the order is load-bearing rather than tidy: a file
  // being ADDED is referenced by nothing yet, while an UPDATE can be a file
  // whose new content depends on one of those adds. Updates-first meant an
  // interruption left new code with its dependency missing — a broken install.
  // Adds-first leaves old code beside unreferenced new files, which still runs.
  const newManaged = { ...madduJson.managed };
  for (const { relPath, absSource } of [...actions.add, ...actions.update]) {
    const dst = join(repoRoot, relPath);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(absSource, dst);
    newManaged[relPath] = { sha256: await sha256OfFile(dst), installedBy: toVersion };
  }
  // ENOENT is the success case (the file is already gone, which is the state we
  // wanted). Anything else — EPERM, EBUSY, a Windows sharing violation because
  // something has the file open — means it is STILL THERE, and dropping its
  // manifest entry anyway would leave a framework file on disk that nothing
  // manages, tracks, or hash-checks, while the run reported a clean removal.
  // Keeping the entry is the honest outcome: the file stays managed, doctor can
  // still see it, and the next upgrade retries the removal.
  const removeFailed = [];
  for (const { relPath } of actions.remove) {
    try {
      await unlink(join(repoRoot, relPath));
      delete newManaged[relPath];
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) { delete newManaged[relPath]; continue; }
      removeFailed.push({ relPath, code: (err && err.code) || 'error' });
    }
  }
  if (removeFailed.length) {
    console.error(`  ${removeFailed.length} file(s) removed upstream could not be deleted and are STILL PRESENT:`);
    for (const { relPath, code } of removeFailed) console.error(`    ${relPath} (${code})`);
    console.error(`  Their manifest entries are kept so they stay managed; delete them by hand or re-run \`maddu upgrade\`.`);
  }
  // Drop manifest entries for skipped-removed files? No — keep them so we can
  // re-detect on the next upgrade.

  // Skipped files keep their OLD content while framework_version moves to the
  // new one. Record which, so the next run can say so instead of reporting
  // "Already on framework vX. Nothing to do." over a half-applied install.
  //
  // A SAME-VERSION REPAIR RECORDS NOTHING HERE, and that is the whole point:
  // the version did not move, so nothing was stranded BY this run. A local edit
  // that was lawful a moment ago must not be branded a partial upgrade merely
  // because an unrelated missing file was restored alongside it — that would
  // make every subsequent `maddu upgrade` exit 1 forever over an edit the
  // operator is entitled to keep. Any partial_upgrade record from a genuine
  // earlier version move is left exactly as it was, neither written nor erased.
  const strandedPaths = actions.skip.map((a) => a.relPath).sort();
  const next = {
    ...madduJson,
    framework_version: toVersion,
    upgraded_at: new Date().toISOString(),
    managed: newManaged
  };
  // A path this run actually WROTE is no longer stranded, whatever an older
  // record says. Without this, the documented sequence — a version move strands
  // an edit, the operator runs `upgrade --force`, that run is interrupted, the
  // plain retry completes it through the marker — left the stale record standing
  // over files it had just repaired, so every later run exited 1 demanding a
  // --force that had already happened.
  const writtenNow = new Set([...actions.add, ...actions.update].map((a) => a.relPath));
  const priorStranded = Array.isArray(madduJson.partial_upgrade?.paths) ? madduJson.partial_upgrade.paths : [];
  const stillStranded = priorStranded.filter((p) => !writtenNow.has(p));

  if (versionUnchanged && !force) {
    // A same-version repair or recovery — carry the prior record through, minus
    // anything this run repaired. NOT on --force: that is the documented remedy
    // for a stranded set ("Resolve with: maddu upgrade --force"), it overwrites
    // the local edits that were stranded, and so it must be allowed to clear the
    // record outright. Leaving
    // `force` out of this condition made the remedy unable to settle the install
    // it exists to settle, so every later run kept exiting 1.
    if (!stillStranded.length) delete next.partial_upgrade;
    else if (stillStranded.length !== priorStranded.length) {
      next.partial_upgrade = { ...madduJson.partial_upgrade, paths: stillStranded };
    }
  } else if (strandedPaths.length) {
    next.partial_upgrade = { version: toVersion, at: new Date().toISOString(), paths: strandedPaths };
  } else {
    delete next.partial_upgrade;
  }
  await writeMadduJson(repoRoot, next);
  // Cleared HERE, immediately after the manifest, and not at the end of this
  // function. The marker stands for exactly one window: the one in which the
  // managed file set and its manifest disagree. That window closes on the line
  // above. Everything below — shim chmod, config backfill, agent-file sync — is
  // guarded, but `spine.append` is not, and a throw there over a fully-applied
  // install must not leave a critical failure behind it.
  const markerLeft = await clearUpgradeMarker(repoRoot);
  if (markerLeft) {
    console.error(`  WARNING: the upgrade completed, but its recovery marker could not be deleted (${markerLeft}).`);
    console.error(`    ${markerPath(repoRoot)}`);
    console.error(`    Until it is gone, \`maddu doctor\` reports this install as half-applied, and a later plain \`maddu upgrade\` will re-write that run's planned files over any edit you make to them. Delete it by hand.`);
  }
  // Released with the marker, and for the same reason: the window this guards is
  // the one where the file tree and its manifest disagree, and that window has
  // just closed. Everything below is post-hoc bookkeeping that a second upgrade
  // could safely interleave with.
  await releaseUpgradeLock(repoRoot);

  // The project-local CLI shims (maddu/run, maddu/run.cmd) ride along
  // with the managed manifest — they were either added in `actions.add`
  // (pre-v0.14 install upgrading into v0.14+) or refreshed in `actions.update`
  // (already had them). All we need to do here is re-set the POSIX execute
  // bit, which `copyFile` doesn't preserve.
  await ensureShimExecutable(repoRoot);

  // v1.11.0 — backfill ALL framework config defaults on upgrade, single-sourced
  // with `maddu init` via commands/_config-seed.mjs so the two can't drift.
  // This fixes the pre-v1.11.0 bug where upgrade's inline DEFAULT_TRIGGERS went
  // stale (missing v1.10.0 auto-handoff/auto-review) and where janitor / trust /
  // worker-env / governance were never backfilled on upgrade (a repo installed
  // before a config existed never got its defaults — incl. worker-env's
  // default-deny-secrets). Write-if-missing; triggers.json merges add-missing;
  // operator edits are never disturbed.
  try {
    const { seedConfigDefaults, seedStarterSkills } = await import('./_config-seed.mjs');
    const seeded = await seedConfigDefaults(repoRoot, { templateRoot: TEMPLATE_ROOT });
    // Starter skills got the same backfill treatment in the 2026-07-07 template
    // audit: init seeded them since v1.1.0 but upgrade never did, so pre-v1.1.0
    // installs warned "starter skills missing" forever. Write-if-missing.
    const { skillsSeeded } = await seedStarterSkills(repoRoot, { templateRoot: TEMPLATE_ROOT });
    const parts = [];
    if (seeded.triggersAdded.length) parts.push(`triggers +${seeded.triggersAdded.length}`);
    if (seeded.configsSeeded.length) parts.push(`config ${seeded.configsSeeded.join('/')}`);
    if (seeded.pipelinesSeeded.length) parts.push(`pipelines ${seeded.pipelinesSeeded.length}`);
    if (skillsSeeded.length) parts.push(`starter skills +${skillsSeeded.length}`);
    if (parts.length) console.log(`  config defaults backfilled: ${parts.join(', ')}`);
  } catch (err) {
    console.error(`  (config defaults backfill skipped: ${err.message})`);
  }

  // v1.4.0 — comms back-compat: the Telegram/Discord/Email subsystems moved
  // from the bridge's static boot path into the `comms` plugin (off by default).
  // A repo that had any of them enabled must keep working, so if their state
  // shows enabled we seed `comms` into the plugin enable-state. Idempotent;
  // never disables an already-listed plugin.
  try {
    const stateDir = join(repoRoot, '.maddu', 'state');
    let wasEnabled = false;
    for (const f of ['telegram.json', 'discord.json', 'email.json']) {
      try {
        const s = JSON.parse(await readFile(join(stateDir, f), 'utf8'));
        if (s && s.enabled === true) { wasEnabled = true; break; }
      } catch {}
    }
    if (wasEnabled) {
      const pluginsCfg = join(repoRoot, '.maddu', 'config', 'plugins.json');
      let cfg = { enabled: [] };
      try { cfg = JSON.parse(await readFile(pluginsCfg, 'utf8')); cfg.enabled = Array.isArray(cfg.enabled) ? cfg.enabled : []; } catch {}
      if (!cfg.enabled.includes('comms')) {
        cfg.enabled = [...new Set([...cfg.enabled, 'comms'])].sort();
        await mkdir(dirname(pluginsCfg), { recursive: true });
        await writeFile(pluginsCfg, JSON.stringify(cfg, null, 2) + '\n');
        console.log('  comms plugin auto-enabled (was active before the plugin split)');
      }
    }
  } catch (err) {
    console.error(`  (comms back-compat seed skipped: ${err.message})`);
  }

  // v0.17 agent-native bootstrap — re-run the agent-file sync. Same
  // helper as init, but the helper-discovered framework root is the
  // installed maddu/ directory in the consumer (init lives in the
  // dev tree; here we're in the consumer). The helper probes both.
  let agentFileSync = null;
  let slashSync = null;
  try {
    const { loadAgentFileTemplates, syncAllAgentFiles, syncSlashCommands } = await import(
      'file://' + join(TEMPLATE_ROOT, '..', 'commands', '_agent-files.mjs').replace(/\\/g, '/')
    );
    // TEMPLATE_ROOT points at the framework's template/ dir; its
    // parent is the framework repo root, which doubles as the
    // template-root the helper expects in dev mode.
    const templates = await loadAgentFileTemplates(repoRoot);
    agentFileSync = await syncAllAgentFiles(repoRoot, templates);
    const perFile = Object.entries(agentFileSync.perFile)
      .map(([f, a]) => `${f}:${a}`).join(', ');
    console.log(`  agent files synced (${agentFileSync.action}) — ${perFile}`);

    // v0.18 Phase 1 — install/refresh slash-command directories. The
    // consumer's installed `maddu/agent-files/commands/` was copied
    // above via the managed-file manifest; sync from there into
    // `.claude/commands/` + `.codex/commands/`.
    slashSync = await syncSlashCommands(repoRoot, repoRoot);
    const slashSummary = slashSync.files.length
      ? `${slashSync.files.length} command(s)`
      : (slashSync.reason || 'no commands');
    console.log(`  slash commands synced (${slashSync.action}) — ${slashSummary}`);
  } catch (err) {
    console.error(`  (agent-file sync skipped: ${err.message})`);
  }

  // Append upgrade events through the spine layer so chained installs keep
  // their prev_hash continuity.
  const spine = await import(pathToFileURL(join(TEMPLATE_ROOT, 'maddu', 'runtime', 'lib', 'spine.mjs')).href);
  const ev = await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.FRAMEWORK_UPGRADED,
    data: {
      from: fromVersion,
      to: toVersion,
      updated: actions.update.length,
      added: actions.add.length,
      removed: actions.remove.length,
      skipped: actions.skip.length,
      warnings: actions.warnings
    }
  });

  if (agentFileSync) {
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.AGENT_FILE_SYNCED,
      data: { files: agentFileSync.files, action: agentFileSync.action, perFile: agentFileSync.perFile }
    });
  }

  if (slashSync) {
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SLASH_COMMANDS_SYNCED,
      data: {
        action: slashSync.action,
        files: slashSync.files,
        perFile: slashSync.perFile,
        reason: slashSync.reason || null,
      }
    });
  }

  if (versionUnchanged && !force) {
    // A repair or a recovery, not a version move. Local edits were left alone as
    // always, but nothing was stranded BY this run, so it is not a partial
    // upgrade and must not be reported as one. A --force run at the same version
    // is excluded for the same reason as the manifest branch above: it is the
    // remedy, it resolves the stranded set, and it reports as an upgrade.
    console.log(`\nRepaired install at v${toVersion}. (event ${ev.id})`);
    if (strandedPaths.length) {
      console.log(`  ${strandedPaths.length} locally-modified file(s) left untouched, as before.`);
    }
  } else if (strandedPaths.length) {
    console.log(`\nUpgraded to v${toVersion} - PARTIAL. (event ${ev.id})`);
    console.log(`  ${strandedPaths.length} managed file(s) were NOT updated: locally modified, left in place.`);
    console.log(`  They stay at their previous content until: maddu upgrade --force`);
  } else {
    console.log(`\nUpgraded to v${toVersion}. (event ${ev.id})`);
  }

  // Activation nudge (usage-audit Tier 3): hooks are the proven activation
  // lever — the ritual-active repos in the 2026-07-16 fleet audit are the
  // hooked ones. If this repo still isn't wired, say so once, at the moment
  // the operator is already paying attention. Best-effort, read-only.
  try {
    const { loadLibOptional } = await import(new URL('./_libroot.mjs', import.meta.url).href);
    const hooksLib = await loadLibOptional('claude-hooks.mjs');
    if (hooksLib && hooksLib.loadSettings && hooksLib.summarize) {
      const { settings } = await hooksLib.loadSettings(repoRoot);
      if (!hooksLib.summarize(settings).allInstalled) {
        console.log(`\nSession discipline is not wired in this repo — sessions won't auto-register.`);
        console.log(`  ./maddu/run hooks install   # the proven activation lever: register → claim → slice-stop with zero keystrokes`);
      }
    }
  } catch {}
}
