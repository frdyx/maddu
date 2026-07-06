// EXP Phase 0 slice 0.1 — ground-truth census: what the spine ACTUALLY holds.
// Reads the live spine + EVENT_SCHEMA; emits per-type: live count, contract
// data fields, and which fields carry non-null values in practice.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAll } from '../template/maddu/runtime/lib/spine.mjs';
import { EVENT_SCHEMA } from '../template/maddu/runtime/lib/event-schema.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const events = await readAll(REPO_ROOT);
const byType = new Map();
for (const ev of events) {
  const t = ev.type || '(untyped)';
  const cur = byType.get(t) || { count: 0, fieldsSeen: new Map(), firstTs: ev.ts, lastTs: ev.ts };
  cur.count++;
  cur.lastTs = ev.ts;
  for (const [k, v] of Object.entries(ev.data || {})) {
    const f = cur.fieldsSeen.get(k) || { nonNull: 0, total: 0 };
    f.total++;
    if (v !== null && v !== undefined) f.nonNull++;
    cur.fieldsSeen.set(k, f);
  }
  byType.set(t, cur);
}
const schemaTypes = Object.keys(EVENT_SCHEMA);
const live = [...byType.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`SPINE: ${events.length} events, ${byType.size} live types / ${schemaTypes.length} contract types\n`);
for (const [t, info] of live) {
  const fields = [...info.fieldsSeen.entries()]
    .map(([k, f]) => `${k}${f.nonNull < f.total ? `(${f.nonNull}/${f.total})` : ''}`)
    .join(' ');
  console.log(`${String(info.count).padStart(6)}  ${t}\n        fields: ${fields || '(none)'}`);
}
console.log('\nDORMANT (in contract, never fired here):');
console.log(schemaTypes.filter((t) => !byType.has(t)).join(', '));
