# Runtime descriptor samples

JSON **runtime descriptors** the operator copies into `.maddu/runtimes/` to
register a non-builtin provider CLI as a spawnable worker runtime:

```bash
cp maddu/runtimes/hermes.json .maddu/runtimes/hermes.json
maddu runtime list          # should now show it
```

No code reads this directory at runtime — live descriptors are read from
`.maddu/runtimes/<name>.json` only. See `docs/35-hermes-adapter.md` for the
full adapter walkthrough.

Not to be confused with `runtime/lib/runtimes/` — those are the token-usage
**wrapper scripts** for builtin runtimes (claude/codex/gemini/hermes),
registered in `runtime/lib/runtimes.mjs` `BUILTIN_WRAPPERS`, a different
artifact class entirely.
