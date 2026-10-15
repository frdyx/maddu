#!/usr/bin/env node
// spine-parent-ack (v1.154.0) — SESSION_PARENT_ACKNOWLEDGED, the append-only
// way out of a permanent `unknown_parent_session` FAIL.
//
// The case it exists for: session registrations recorded before the v1.112.0
// CP5 guard named a parentSessionId that was registered in ANOTHER repo's
// spine (an ambient MADDU_PARENT_SESSION_ID leaked across repos). The spine
// cannot be edited, so without a sanctioned acknowledgement the FAIL — and
// every check that needs a verified chain — stays red forever.
//
// Proves, on real temp spines:
//   A. verifier (flat):
//      • an unknown parent FAILs as unknown_parent_session and carries the
//        parent as a structured field; a resolved parent is not flagged;
//      • an acknowledgement listing the references downgrades exactly those
//        to WARN unknown_parent_session_acknowledged naming the ack, counts
//        stay consistent with the issue list, readVerifiedEvents reads 'ok';
//      • scope is exact: a LATER reference to the same parent still FAILs; an
//        ack listing a later id, another parent, an already-acknowledged id,
//        or another issue kind's event downgrades nothing (WARN unmatched);
//      • a reasonless or malformed ack is ignored with a WARN (never a FAIL,
//        which would recreate the permanent-FAIL trap) and downgrades nothing.
//   B. verifier (sync, merged order): an ack in one replica covers a
//      reference in another only when it follows it in merged order.
//   C. the real CLI (`maddu spine acknowledge`, hermetic env):
//      • --list (read-only) groups references by parent;
//      • usage errors exit 2 and append nothing (no --reason, malformed
//        --parent-session, unknown flag, --list mixed with --parent-session, bare verb);
//      • a secret-shaped --reason and an unknown parent are refused (exit 1)
//        with nothing appended — the verb never acknowledges ahead of time;
//      • success appends one event with the exact ids and reason, and verify
//        exits 0; a rerun is a witnessed idempotent no-op (no second event,
//        no mutation-witness breach);
//      • `spine verify` names the remedy; the spine-integrity gate names it
//        while red and goes green after.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hermeticEnv } from './_hermetic-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'template', 'maddu', 'runtime', 'lib');
const BIN = path.join(ROOT, 'bin', 'maddu.mjs');
const GATE = path.join(ROOT, 'template', 'maddu', 'runtime', 'gates', 'builtin', 'spine-integrity.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}

const PARENT = 'ses_20260930031629_f32500';
const OTHER = 'ses_20260930031629_aaaaaa';

async function newTmp() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-parentack-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}

function run(repo, args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: hermeticEnv(),
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

async function main() {
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const verify = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);
  const gate = (await import(pathToFileURL(GATE).href)).default;
  const tmps = [];

  const autoReg = (tmp, sid, parent) => spine.append(tmp, {
    type: 'SESSION_AUTO_REGISTERED', actor: sid, lane: null,
    data: { sessionId: sid, parentSessionId: parent, source: 'cli', label: 'fixture', role: 'implementer' },
  });
  const reg = (tmp, sid, parent) => spine.append(tmp, {
    type: 'SESSION_REGISTERED', actor: sid, lane: null,
    data: { focus: null, label: 'fixture', role: 'implementer', runtime: null, ...(parent ? { parentSessionId: parent } : {}) },
  });
  const ack = (tmp, data) => spine.append(tmp, { type: 'SESSION_PARENT_ACKNOWLEDGED', actor: null, lane: null, data: { schemaVersion: 1, ...data } });
  const of = (res, kind) => res.issues.filter((i) => i.kind === kind);
  const consistent = (res) => res.counts.FAIL === res.issues.filter((i) => i.level === 'FAIL').length
    && res.counts.WARN === res.issues.filter((i) => i.level === 'WARN').length;
  const ackCount = async (tmp) => (await spine.readAll(tmp)).filter((e) => e.type === 'SESSION_PARENT_ACKNOWLEDGED').length;

  try {
    ok('SESSION_PARENT_ACKNOWLEDGED is a registered event type', spine.EVENT_TYPES.SESSION_PARENT_ACKNOWLEDGED === 'SESSION_PARENT_ACKNOWLEDGED');

    console.log('spine-parent-ack: A. verifier, flat');
    {
      const tmp = await newTmp(); tmps.push(tmp);
      await reg(tmp, 'ses_root');
      const resolved = await autoReg(tmp, 'ses_child', 'ses_root');
      const a = await autoReg(tmp, 'ses_a', PARENT);
      const b = await reg(tmp, 'ses_b', PARENT);
      let res = await verify.verifySpine(tmp);
      const orphans = of(res, 'unknown_parent_session');
      ok('two unknown parents FAIL as unknown_parent_session', orphans.length === 2 && orphans.every((i) => i.level === 'FAIL'), JSON.stringify(res.counts));
      ok('both registration types are covered', orphans.some((i) => i.eventId === a.id) && orphans.some((i) => i.eventId === b.id));
      ok('the parent rides as a structured field', orphans.every((i) => i.parentSessionId === PARENT));
      ok('a parent registered earlier on this spine is not flagged', !res.issues.some((i) => i.eventId === resolved.id));
      ok('readVerifiedEvents reads broken before the acknowledgement', (await verify.readVerifiedEvents(tmp)).integrity === 'broken');

      const k = await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id, b.id], reason: 'parent registered in another repo; MADDU_PARENT_SESSION_ID leaked' });
      res = await verify.verifySpine(tmp);
      const acked = of(res, 'unknown_parent_session_acknowledged');
      ok('the acknowledgement clears every FAIL', res.counts.FAIL === 0, JSON.stringify(res.issues.map((i) => i.kind)));
      ok('both references stay on record as WARN acknowledged', acked.length === 2 && acked.every((i) => i.level === 'WARN'));
      ok('each names the acknowledgement event', acked.every((i) => i.acknowledgedBy === k.id && i.detail.includes(k.id)));
      ok('no unknown_parent_session left', of(res, 'unknown_parent_session').length === 0);
      ok('counts match the issue list after in-place reclassification', consistent(res), JSON.stringify(res.counts));
      ok('readVerifiedEvents reads ok after the acknowledgement', (await verify.readVerifiedEvents(tmp)).integrity === 'ok');

      // A later leak to the SAME parent is a new defect — never pre-acknowledged.
      const c = await autoReg(tmp, 'ses_c', PARENT);
      res = await verify.verifySpine(tmp);
      ok('a later reference to the acknowledged parent still FAILs',
        of(res, 'unknown_parent_session').some((i) => i.eventId === c.id && i.level === 'FAIL'));
      ok('the earlier references stay acknowledged', of(res, 'unknown_parent_session_acknowledged').length === 2);

      // Re-acknowledging an already-acknowledged id downgrades nothing twice.
      await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id], reason: 'again' });
      res = await verify.verifySpine(tmp);
      ok('a second ack for an acknowledged id is unmatched (WARN), not a double downgrade',
        of(res, 'session_parent_ack_unmatched').length === 1 && of(res, 'unknown_parent_session_acknowledged').length === 2 && consistent(res));
    }

    {
      const tmp = await newTmp(); tmps.push(tmp);
      const a = await autoReg(tmp, 'ses_a', PARENT);
      const d = await autoReg(tmp, 'ses_d', OTHER);
      // An unregistered SESSION_CLOSED — another FAIL kind on an event the ack lists.
      const closed = await spine.append(tmp, { type: 'SESSION_CLOSED', actor: 'ses_ghost', lane: null, data: { handoff: null } });
      // Hand-written ack naming: the wrong parent's ref, another kind's event,
      // and an id that does not exist yet — none may be downgraded.
      await ack(tmp, { parentSessionId: PARENT, eventIds: [d.id, closed.id, 'evt_29991231235959_ffffff'], reason: 'over-broad' });
      const later = await autoReg(tmp, 'ses_later', PARENT);
      await ack(tmp, { parentSessionId: PARENT, eventIds: [], reason: 'empty list' });
      let res = await verify.verifySpine(tmp);
      ok('an ack only covers references to ITS parent', of(res, 'unknown_parent_session').some((i) => i.eventId === d.id && i.level === 'FAIL'));
      ok('an ack never touches another issue kind', of(res, 'unknown_session_close').some((i) => i.eventId === closed.id && i.level === 'FAIL'));
      ok('unlisted earlier reference stays FAIL', of(res, 'unknown_parent_session').some((i) => i.eventId === a.id && i.level === 'FAIL'));
      ok('a reference written after the ack stays FAIL', of(res, 'unknown_parent_session').some((i) => i.eventId === later.id && i.level === 'FAIL'));
      ok('each non-matching listed id is a WARN unmatched', of(res, 'session_parent_ack_unmatched').length === 3);
      ok('an empty eventIds list is malformed (WARN), not a FAIL', of(res, 'session_parent_ack_malformed').length === 1 && of(res, 'session_parent_ack_malformed')[0].level === 'WARN');
      ok('nothing was acknowledged', of(res, 'unknown_parent_session_acknowledged').length === 0 && consistent(res));
    }

    {
      const tmp = await newTmp(); tmps.push(tmp);
      const a = await autoReg(tmp, 'ses_a', PARENT);
      await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id], reason: '   ' });
      await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id] });
      await ack(tmp, { eventIds: [a.id], reason: 'no parent' });
      await ack(tmp, { parentSessionId: PARENT, eventIds: a.id, reason: 'not an array' });
      await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id, 42], reason: 'non-string id' });
      const res = await verify.verifySpine(tmp);
      ok('whitespace-only and missing reasons are WARN unreasoned and ignored', of(res, 'session_parent_ack_unreasoned').length === 2
        && of(res, 'session_parent_ack_unreasoned').every((i) => i.level === 'WARN'));
      ok('missing parent / non-array / non-string ids are WARN malformed and ignored', of(res, 'session_parent_ack_malformed').length === 3);
      ok('the reference is still a FAIL after five invalid acks', of(res, 'unknown_parent_session').length === 1 && res.counts.FAIL === 1 && consistent(res));
    }

    console.log('spine-parent-ack: B. verifier, sync (merged order)');
    {
      const tmp = await newTmp(); tmps.push(tmp);
      const line = (o) => JSON.stringify({ v: 1, id: o.id, ts: o.ts, type: o.type, actor: o.actor ?? null, lane: null, data: o.data });
      const part = async (rid, rows) => {
        const dir = path.join(tmp, '.maddu', 'events', 'by-replica', rid);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, '000000000001.ndjson'), rows.map(line).join('\n') + '\n');
      };
      const orphan = (id, ts) => ({ id, ts, type: 'SESSION_AUTO_REGISTERED', actor: `ses_${id.slice(-6)}`,
        data: { sessionId: `ses_${id.slice(-6)}`, parentSessionId: PARENT, source: 'cli', label: 'x', role: 'implementer' } });
      // repA: two references; repB: an ack that follows the first in merged
      // order and lists both — the second (later ts) must NOT be covered.
      await part('repA', [orphan('evt_20260930120000_aaaa01', '2026-09-30T12:00:00.000Z'), orphan('evt_20260930140000_aaaa02', '2026-09-30T14:00:00.000Z')]);
      await part('repB', [{ id: 'evt_20260930130000_bbbb01', ts: '2026-09-30T13:00:00.000Z', type: 'SESSION_PARENT_ACKNOWLEDGED',
        data: { schemaVersion: 1, parentSessionId: PARENT, eventIds: ['evt_20260930120000_aaaa01', 'evt_20260930140000_aaaa02'], reason: 'leaked parent' } }]);
      const res = await verify.verifySpine(tmp);
      const acked = of(res, 'unknown_parent_session_acknowledged');
      ok('merged order: the earlier cross-replica reference is acknowledged', acked.length === 1 && acked[0].eventId === 'evt_20260930120000_aaaa01');
      ok('merged order: the later reference is not', of(res, 'unknown_parent_session').some((i) => i.eventId === 'evt_20260930140000_aaaa02'));
      ok('merged order: the not-yet-seen id is reported unmatched', of(res, 'session_parent_ack_unmatched').length === 1);
      ok('merged order: counts stay consistent', consistent(res), JSON.stringify(res.counts));
    }

    console.log('spine-parent-ack: C. the CLI');
    {
      const tmp = await newTmp(); tmps.push(tmp);
      const a = await autoReg(tmp, 'ses_a', PARENT);
      const b = await autoReg(tmp, 'ses_b', PARENT);

      const vBefore = run(tmp, ['spine', 'verify']);
      ok('spine verify exits 1 and names the remedy', vBefore.code === 1 && vBefore.stdout.includes('maddu spine acknowledge --list'), vBefore.stdout.slice(-300));
      const gBefore = await gate.run({ verify, repoRoot: tmp });
      ok('the spine-integrity gate is red and names the remedy', gBefore.ok === false && gBefore.message.includes('maddu spine acknowledge --list'), gBefore.message);

      const list = run(tmp, ['spine', 'acknowledge', '--list', '--json']);
      const lb = parseJson(list.stdout);
      const p = lb?.parents?.find((x) => x.parentSessionId === PARENT);
      ok('--list --json exits 0 and groups the references by parent', list.code === 0 && p && p.pending.length === 2 && p.acknowledged.length === 0, list.stdout.slice(0, 300));
      ok('--list rows carry the event type', p && p.pending.every((r) => r.type === 'SESSION_AUTO_REGISTERED'));
      const listHuman = run(tmp, ['spine', 'acknowledge', '--list']);
      ok('--list (human) prints the parent and the command to run', listHuman.code === 0 && listHuman.stdout.includes(PARENT) && listHuman.stdout.includes(`--parent-session ${PARENT}`));

      const usage = [
        [['spine', 'acknowledge'], 'bare verb'],
        [['spine', 'acknowledge', '--parent-session', PARENT], 'missing --reason'],
        [['spine', 'acknowledge', '--parent-session', PARENT, '--reason', '  '], 'blank --reason'],
        [['spine', 'acknowledge', '--parent-session', 'bad id!', '--reason', 'x'], 'malformed --parent-session'],
        [['spine', 'acknowledge', '--parent-session', PARENT, '--reason', 'x', '--force'], 'unknown flag'],
        [['spine', 'acknowledge', '--list', '--parent-session', PARENT], '--list mixed with --parent-session'],
        [['spine', 'acknowledge', 'extra', '--parent-session', PARENT, '--reason', 'x'], 'stray positional'],
      ];
      for (const [args, label] of usage) {
        const r = run(tmp, args);
        // The verb's OWN validation must answer (the global strict-flag guard
        // only knows flag names; '--force' is the one case it owns).
        const own = label === 'unknown flag' || /maddu spine acknowledge|--reason "…" is required/.test(r.stderr);
        ok(`usage error exits 2: ${label}`, r.code === 2 && own, `code ${r.code} ${r.stderr.slice(0, 160)}`);
      }
      ok('no usage error appended an acknowledgement', (await ackCount(tmp)) === 0);

      const secret = run(tmp, ['spine', 'acknowledge', '--parent-session', PARENT, '--reason', `leaked; token ghp_${'a'.repeat(36)}`]);
      ok('a secret-shaped --reason is refused (exit 1)', secret.code === 1 && /secret/i.test(secret.stderr), secret.stderr.slice(0, 200));
      const ghost = run(tmp, ['spine', 'acknowledge', '--parent-session', OTHER, '--reason', 'pre-emptive']);
      ok('a parent with no current reference is refused (never acknowledges ahead of time)', ghost.code === 1 && ghost.stderr.includes('nothing to acknowledge'), ghost.stderr.slice(0, 200));
      ok('refusals appended nothing', (await ackCount(tmp)) === 0);

      const reason = 'parent registered in snyggare-agents; ambient MADDU_PARENT_SESSION_ID leaked before the v1.112.0 CP5 guard';
      const done = run(tmp, ['spine', 'acknowledge', '--parent-session', PARENT, '--reason', reason, '--json']);
      const db = parseJson(done.stdout);
      ok('acknowledge exits 0 with ok:true', done.code === 0 && db?.ok === true, done.stdout.slice(0, 300) + done.stderr.slice(0, 200));
      ok('it lists exactly the two references', db && db.eventIds.length === 2 && db.eventIds.includes(a.id) && db.eventIds.includes(b.id));
      ok('it reports the re-verified counts (0 FAIL)', db?.verify?.FAIL === 0);
      const evs = (await spine.readAll(tmp)).filter((e) => e.type === 'SESSION_PARENT_ACKNOWLEDGED');
      ok('exactly one SESSION_PARENT_ACKNOWLEDGED was appended', evs.length === 1);
      ok('the event records schemaVersion, parent, ids and the reason verbatim', evs[0] && evs[0].data.schemaVersion === 1
        && evs[0].data.parentSessionId === PARENT && evs[0].data.reason === reason && evs[0].id === db.event);

      const vAfter = run(tmp, ['spine', 'verify']);
      ok('spine verify exits 0 after the acknowledgement', vAfter.code === 0 && vAfter.stdout.includes('unknown_parent_session_acknowledged'), vAfter.stdout.slice(-300));
      const gAfter = await gate.run({ verify, repoRoot: tmp });
      ok('the spine-integrity gate is green (warn) after', gAfter.ok === true && gAfter.status === 'warn', gAfter.message);

      const again = run(tmp, ['spine', 'acknowledge', '--parent-session', PARENT, '--reason', reason, '--json']);
      const ab = parseJson(again.stdout);
      ok('a rerun is an idempotent no-op (exit 0, already:true)', again.code === 0 && ab?.already === true, again.stdout + again.stderr);
      ok('the rerun appended nothing', (await ackCount(tmp)) === 1);
      const listAfter = parseJson(run(tmp, ['spine', 'acknowledge', '--list', '--json']).stdout);
      const pa = listAfter?.parents?.find((x) => x.parentSessionId === PARENT);
      ok('--list now shows 0 pending, 2 acknowledged', pa && pa.pending.length === 0 && pa.acknowledged.length === 2);

      let breaches = [];
      try { breaches = (await readdir(path.join(tmp, '.maddu', 'state', 'mutation-breaches'))).filter((n) => n.endsWith('.json')); } catch {}
      const unwitnessed = (await spine.readAll(tmp)).filter((e) => e.type === 'MUTATION_UNWITNESSED');
      ok('no mutation-witness breach (no-op declared, --list read-shaped)', breaches.length === 0 && unwitnessed.length === 0,
        `${breaches.join(',')} ${unwitnessed.map((e) => JSON.stringify(e.data)).join(' ')}`);
    }

    console.log('spine-parent-ack: D. review round 1');
    {
      // Only the schemaVersion this verifier knows (1) can downgrade anything.
      const tmp = await newTmp(); tmps.push(tmp);
      const a = await autoReg(tmp, 'ses_a', PARENT);
      await spine.append(tmp, { type: 'SESSION_PARENT_ACKNOWLEDGED', actor: null, lane: null,
        data: { schemaVersion: 2, parentSessionId: PARENT, eventIds: [a.id], reason: 'a version this verifier does not know' } });
      await spine.append(tmp, { type: 'SESSION_PARENT_ACKNOWLEDGED', actor: null, lane: null,
        data: { parentSessionId: PARENT, eventIds: [a.id], reason: 'no version at all' } });
      const res = await verify.verifySpine(tmp);
      ok('an acknowledgement whose schemaVersion is not 1, or missing, is malformed and downgrades nothing',
        of(res, 'session_parent_ack_malformed').length === 2
          && of(res, 'unknown_parent_session').some((i) => i.eventId === a.id && i.level === 'FAIL') && consistent(res),
        JSON.stringify(res.issues.map((i) => `${i.level} ${i.kind}`)));
    }

    {
      // One acknowledgement listing a matching id and an unmatched one applies per id.
      const tmp = await newTmp(); tmps.push(tmp);
      const a = await autoReg(tmp, 'ses_a', PARENT);
      await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id, 'evt_20260101000000_000000'], reason: 'one real id, one not' });
      const res = await verify.verifySpine(tmp);
      ok('the matching id is acknowledged and the unmatched id in the same event is a WARN',
        of(res, 'unknown_parent_session_acknowledged').some((i) => i.eventId === a.id)
          && of(res, 'session_parent_ack_unmatched').length === 1 && res.counts.FAIL === 0 && consistent(res));
    }

    {
      // The doctor gate scans a capped prefix. A reference inside the prefix
      // whose acknowledgement lies past the cap must still clear.
      const tmp = await newTmp(); tmps.push(tmp);
      const a = await autoReg(tmp, 'ses_a', PARENT);
      for (let n = 0; n < 4; n++) await reg(tmp, `ses_fill${n}`);
      await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id], reason: 'acknowledged past the cap' });
      const smallCap = { verifySpine: (root, o = {}) => verify.verifySpine(root, { ...o, maxEvents: o.maxEvents === Infinity ? Infinity : 3 }) };
      const g = await gate.run({ verify: smallCap, repoRoot: tmp });
      ok('the spine-integrity gate clears a reference whose acknowledgement lies past its cap', g.ok === true, g.message);
    }

    // A synced spine. Replica repA's clock runs far ahead, so its reference
    // sorts AFTER an acknowledgement written now; this checkout is repB.
    const synced = async (rows) => {
      const tmp = await newTmp(); tmps.push(tmp);
      await mkdir(path.join(tmp, '.maddu', 'config'), { recursive: true });
      await writeFile(path.join(tmp, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repB' }));
      const line = (o) => JSON.stringify({ v: 1, id: o.id, ts: o.ts, type: o.type, actor: o.actor ?? null, lane: null, data: o.data });
      for (const [rid, evs] of Object.entries(rows)) {
        const dir = path.join(tmp, '.maddu', 'events', 'by-replica', rid);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, '000000000001.ndjson'), evs.map(line).join('\n') + '\n');
      }
      return tmp;
    };
    const orphanRow = (id, ts) => ({ id, ts, type: 'SESSION_AUTO_REGISTERED', actor: `ses_${id.slice(-6)}`,
      data: { sessionId: `ses_${id.slice(-6)}`, parentSessionId: PARENT, source: 'cli', label: 'x', role: 'implementer' } });
    const repBRow = { id: 'evt_20260930120000_bbbb00', ts: '2026-09-30T12:00:00.000Z', type: 'SESSION_REGISTERED', actor: 'ses_bbbb00',
      data: { focus: null, label: 'x', role: 'implementer', runtime: null } };
    {
      const ahead = 'evt_20990101000000_aaaa01';
      const tmp = await synced({ repA: [orphanRow(ahead, '2099-01-01T00:00:00.000Z')], repB: [repBRow] });

      const list = parseJson(run(tmp, ['spine', 'acknowledge', '--list', '--json']).stdout);
      const row = list?.parents?.find((x) => x.parentSessionId === PARENT)?.pending?.[0];
      ok('--list reports the verifier\'s own level (WARN in merged order), not a fixed FAIL', row && row.level === 'WARN', JSON.stringify(row));
      const human = stripAnsi(run(tmp, ['spine', 'acknowledge', '--list']).stdout);
      ok('--list (human) tags a merged-order reference WARN', /WARN\s+evt_20990101000000_aaaa01/.test(human) && !/FAIL\s+evt_20990101000000_aaaa01/.test(human), human.slice(0, 300));

      const r = run(tmp, ['spine', 'acknowledge', '--parent-session', PARENT, '--reason', 'clock-skewed replica', '--json']);
      const j = parseJson(r.stdout);
      ok('an acknowledgement that applied to none of its references exits 1 and lists them as unapplied',
        r.code === 1 && j?.ok === false && Array.isArray(j?.unapplied) && j.unapplied.includes(ahead), `code ${r.code} ${r.stdout.slice(0, 300)}`);
      ok('the failed application still names the event it recorded',
        typeof j?.event === 'string' && (await spine.readAll(tmp)).some((e) => e.type === 'SESSION_PARENT_ACKNOWLEDGED' && e.id === j.event));
    }

    {
      // A duplicate id across replicas: --list describes the registration the
      // verifier flagged, not whichever event last carried that id.
      const dup = 'evt_20260930120000_dddd01';
      const tmp = await synced({
        repA: [orphanRow(dup, '2026-09-30T12:00:00.000Z')],
        repB: [{ id: dup, ts: '2026-09-30T13:00:00.000Z', type: 'SLICE_STOP', actor: null, data: { summary: 'same id, another event' } }],
      });
      const list = parseJson(run(tmp, ['spine', 'acknowledge', '--list', '--json']).stdout);
      const row = list?.parents?.find((x) => x.parentSessionId === PARENT)?.pending?.find((x) => x.eventId === dup);
      ok('--list rows carry the flagged event\'s own type and time', row && row.type === 'SESSION_AUTO_REGISTERED' && row.ts === '2026-09-30T12:00:00.000Z', JSON.stringify(row));
    }

    {
      // An explicit --session is validated on every path, including the ones
      // that exit before anything is appended.
      const tmp = await newTmp(); tmps.push(tmp);
      const a = await autoReg(tmp, 'ses_a', PARENT);
      const bad = [['--session'], ['--session='], ['--session', 'bad id!'], ['--session', 'ses_x', '--session', 'ses_y']];
      const shapes = [
        ['pending', ['spine', 'acknowledge', '--parent-session', PARENT, '--reason', 'x']],
        ['--list', ['spine', 'acknowledge', '--list']],
      ];
      for (const [label, base] of shapes) {
        for (const b of bad) {
          const r = run(tmp, [...base, ...b]);
          ok(`a malformed --session exits 2 (${label}: ${b.join(' ')})`, r.code === 2, `code ${r.code} ${r.stderr.slice(0, 160)}`);
        }
      }
      ok('no malformed --session appended anything', (await ackCount(tmp)) === 0);
      await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id], reason: 'acknowledged' });
      for (const b of bad) {
        const r = run(tmp, ['spine', 'acknowledge', '--parent-session', PARENT, '--reason', 'x', ...b]);
        ok(`a malformed --session exits 2 on the no-op path too (${b.join(' ')})`, r.code === 2, `code ${r.code} ${r.stderr.slice(0, 160)}`);
      }
    }

    console.log('spine-parent-ack: E. review round 2');
    {
      // The same id twice across replicas: one copy sorts before the new
      // acknowledgement, the other (its replica's clock ahead) after it. The
      // read-back checks each occurrence, so the uncovered copy is reported.
      const dupX = 'evt_20260930120000_eeee01';
      const later = orphanRow(dupX, '2099-01-01T00:00:00.000Z');
      const tmp = await synced({
        repA: [orphanRow(dupX, '2026-09-30T12:00:00.000Z')],
        repB: [repBRow],
        repC: [{ ...later, actor: 'ses_eeee02', data: { ...later.data, sessionId: 'ses_eeee02' } }],
      });
      const r = run(tmp, ['spine', 'acknowledge', '--parent-session', PARENT, '--reason', 'duplicate id across replicas', '--json']);
      const j = parseJson(r.stdout);
      ok('a duplicate id whose later copy stays unacknowledged is reported as not applied (exit 1)',
        r.code === 1 && j?.ok === false && Array.isArray(j?.unapplied) && j.unapplied.includes(dupX), `code ${r.code} ${r.stdout.slice(0, 300)}`);
    }

    {
      // Two runs overlap: both scanned the same pending reference, and the
      // other run appended first and covered it, so this run's entry is
      // unmatched. The read-back must class the reference as covered, not as
      // still unacknowledged.
      const { classifyAckReadback } = await import(pathToFileURL(path.join(ROOT, 'commands', 'spine.mjs')).href);
      const tmp = await newTmp(); tmps.push(tmp);
      const a = await autoReg(tmp, 'ses_a', PARENT);
      const before = await verify.verifySpine(tmp);
      const targets = of(before, 'unknown_parent_session')
        .map((i) => ({ eventId: i.eventId, segment: i.segment, line: i.line, replicaId: i.replicaId ?? null }));
      const first = await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id], reason: 'the other run' });
      const mine = await ack(tmp, { parentSessionId: PARENT, eventIds: [a.id], reason: 'this run' });
      const after = await verify.verifySpine(tmp);
      const out = typeof classifyAckReadback === 'function' ? classifyAckReadback(targets, after.issues, mine.id) : null;
      ok('a reference another acknowledgement covered first is classed as covered elsewhere, not pending',
        !!out && out.pending.length === 0 && out.applied.length === 0 && out.elsewhere.length === 1 && out.elsewhere[0].acknowledgedBy === first.id,
        JSON.stringify(out));
      const theirs = typeof classifyAckReadback === 'function' ? classifyAckReadback(targets, after.issues, first.id) : null;
      ok('the same reference reads as applied for the run that covered it',
        !!theirs && theirs.applied.length === 1 && theirs.pending.length === 0 && theirs.elsewhere.length === 0, JSON.stringify(theirs));
    }
  } finally {
    for (const t of tmps) await rm(t, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`spine-parent-ack: ${passed} pass - ${failed} fail`);
  if (failed) process.exit(1);
  console.log('spine-parent-ack OK');
}

main().catch((err) => { console.error('spine-parent-ack harness error:', err); process.exit(2); });
