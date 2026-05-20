# Gate authoring skill

> **Copy this file to `.maddu/skills/gate-authoring-skill.md` to give agents a stable recipe for adding operator gates.**

## When to use

When the repo wants `maddu doctor` to fail on a project-specific condition that the built-in gates don't cover. Common candidates:

- "No `.md` file under `docs/` exceeds 800 lines."
- "Every component in `src/components/` has a corresponding `.test.tsx`."
- "No file in `src/api/` calls `process.exit`."

## Gate contract

A gate is a single `.mjs` file under `<repoRoot>/.maddu/gates/` that exports a default object:

```js
export default {
  id: 'kebab-case-id',
  label: 'human label shown by doctor',
  severity: 'critical' | 'safety' | 'warn',
  description: 'one-line description',
  run: async (ctx) => ({
    ok: true | false,
    status: 'ok' | 'warn' | 'fail',   // optional override
    message: 'one-line verdict',
    evidence: { /* JSON-serializable */ } | null,
  }),
};
```

`ctx` is `{ repoRoot, paths, spine, projections, project, verify }`. When called from `slice-stop`, it also carries `sliceId` and `touchedPaths`.

## Recipe

```bash
mkdir -p .maddu/gates

cat > .maddu/gates/no-bare-process-exit.mjs <<'EOF'
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !p.includes('node_modules')) out.push(...await walk(p));
    else if (e.isFile() && /\.(m?js|ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

export default {
  id: 'no-bare-process-exit',
  label: 'no bare process.exit in src/api',
  severity: 'critical',
  description: 'Library code must throw, not exit.',
  run: async (ctx) => {
    const files = await walk(join(ctx.repoRoot, 'src', 'api'));
    const hits = [];
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      if (/process\.exit\s*\(/.test(text)) hits.push(f.slice(ctx.repoRoot.length + 1));
    }
    if (hits.length === 0) return { ok: true, message: `scanned ${files.length} files` };
    return { ok: false, message: hits.join(', '), evidence: { files: hits } };
  },
};
EOF

maddu doctor --gate no-bare-process-exit
```

## Severity guidance

- `critical` — hard-rule violation; FAILs doctor (exit 1).
- `safety` — invariant about how the framework is used; FAILs doctor.
- `warn` — operator-visible drift; surfaces as WARN, doesn't fail.

## What a good gate looks like

- **Cheap to run.** Doctor invokes the whole stack on every call.
- **Deterministic.** Same repo state → same verdict. No clocks, no random.
- **Evidence-bearing.** `evidence` is what the operator needs to fix the issue; put paths + line hints, not just counts.
- **Single concern.** One gate per invariant. Avoid combining unrelated checks.

## Anti-patterns

- Mutating spine or files from inside a gate.
- Importing provider SDKs (hard rule #5).
- Adding npm dependencies (hard rule #4 — gates are operator code but should still avoid this).
- A gate that prints to stdout; use `evidence` instead.
