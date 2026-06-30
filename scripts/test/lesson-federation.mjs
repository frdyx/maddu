#!/usr/bin/env node
// lesson-federation — corrections compound across the fleet (roadmap #8).
//
// Pure logic: normalize a lesson to its portable essence (paths stripped) so the
// same lesson in two repos shares a recurrence-hash; a lesson is portable when it
// recurs in >= 2 sibling repos OR is @portable; foreign lessons already known
// here are deduped out; adopted text is redacted of OS-absolute paths.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import {
  normalizeLesson, recurrenceHash, isPortableTagged, redact, federate,
} from '../../template/maddu/runtime/lib/lesson-federation.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// ── normalize + recurrence-hash: the SAME lesson with different paths matches ──
const a = 'In the Bash tool use forward-slash paths (C:/Users/FRDY/proj-a) not backslash.';
const b = 'in the bash tool use forward-slash paths (C:\\Users\\BOB\\proj-b), not backslash';
ok('different paths normalize to the same essence', normalizeLesson(a) === normalizeLesson(b), `${normalizeLesson(a)} || ${normalizeLesson(b)}`);
ok('same essence → same recurrence-hash', recurrenceHash(a) === recurrenceHash(b));
ok('a genuinely different lesson → different hash', recurrenceHash('Always run npm install before tests') !== recurrenceHash(a));

// ── @portable tag detection ──
ok('@portable detected', isPortableTagged('do X not Y @portable') === true);
ok('no tag → false', isPortableTagged('do X not Y') === false);

// ── redaction strips OS-absolute paths ──
ok('windows abs path redacted', redact('write into C:\\Users\\X\\tmp\\f.mjs here') === 'write into <path> here');
ok('unix abs path redacted', redact('logs live in /var/log/app and rotate') === 'logs live in <path> and rotate');
ok('@portable tag stripped on adopt', !/@portable/.test(redact('keep state in files @portable')));

// ── federate: recurrence threshold, tag override, dedup, siloing ──
const local = [{ text: 'Use the project test runner, not jest.', category: 'test' }];
const foreign = {
  'repo-x': [
    { text: 'In the Bash tool use forward-slash paths (C:/Users/A/x) not backslash.', category: 'shell' },
    { text: 'A one-off quirk only repo-x has @portable', category: 'misc' },
    { text: 'repo-x specific: the widget id is 42', category: 'misc' },
  ],
  'repo-y': [
    { text: 'in the bash tool use forward-slash paths (C:\\Users\\B\\y), not backslash', category: 'shell' },
    { text: 'Use the project test runner, not jest.', category: 'test' }, // already local → deduped
  ],
};
const r = federate(local, foreign);
const hashes = r.portable.map((p) => p.text);
ok('a lesson recurring in 2 repos is portable', r.portable.some((p) => /forward-slash/.test(p.text) && p.recurrence === 2));
ok('a single-repo @portable lesson is portable', r.portable.some((p) => p.reason === '@portable'));
ok('a single-repo untagged lesson stays siloed', !r.portable.some((p) => /widget id is 42/.test(p.text)) && r.siloed >= 1);
ok('a lesson already known locally is deduped out', !r.portable.some((p) => /test runner/.test(p.text)));
ok('portable text is redacted', r.portable.find((p) => /forward-slash/.test(p.text)).text.includes('<path>'));
ok('portable rows carry sources + recurrence', r.portable.every((p) => Array.isArray(p.sources) && typeof p.recurrence === 'number'));
ok('foreignRepos counted', r.foreignRepos === 2, String(r.foreignRepos));
ok('sorted by recurrence desc', r.portable.length < 2 || r.portable[0].recurrence >= r.portable[r.portable.length - 1].recurrence);

// ── degrade cleanly ──
ok('empty fleet → nothing portable', federate([], {}).portable.length === 0);
ok('garbage corrections skipped', federate([], { z: [null, { text: '' }, { notText: 1 }] }).portable.length === 0);

console.log('');
console.log(`lesson-federation: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('lesson-federation OK');
process.exit(0);
