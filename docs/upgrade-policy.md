# Upgrade policy

`maddu upgrade` is **strictly additive on framework-owned files and never touches project state.**

## Files Máddu owns

`maddu upgrade` may rewrite these:

- `maddu/runtime/server.js`
- `maddu/cockpit/index.html`
- `maddu/cockpit/tokens.css`
- `maddu/runtime/oauth/**`
- `.maddu/harness/**`
- `.maddu/wiki/**` (framework-default pages only — see below)
- `.maddu/briefs/**` (framework-default briefs only — see below)
- `.maddu/lanes/catalog.json` (framework-default lane catalog — project lanes untouched)
- `maddu.json` (version field only; other fields preserved)

## Files Máddu never touches

`maddu upgrade` refuses to read, write, or remove:

- `.maddu/events/**`
- `.maddu/state/**`
- `.maddu/sessions/**`
- `.maddu/inbox/**`
- `.maddu/archive/**`
- `.maddu/lanes/claims.json`
- `.maddu/lanes/project/**`
- `.maddu/briefs/project/**`
- `.maddu/wiki/project/**`
- Anything outside the `maddu/` and `.maddu/` trees.

## Provenance manifest

`maddu.json` includes a `managed` object listing the framework version that installed each managed file plus its content hash at install time. Before overwriting a managed file, `maddu upgrade`:

1. Computes the current on-disk hash of the file.
2. Compares it to the recorded install hash.
3. If they match → safe to overwrite. Proceeds.
4. If they differ → operator edited a framework-owned file. Refuses, prints a diff, and exits with code 1. Pass `--force` to overwrite anyway (a warning event is appended to the spine).

## Framework-default vs project subdirectories

Briefs, wiki pages, and lanes have a strict directory split:

- `.maddu/briefs/<name>.md` — framework default. May be replaced by `maddu upgrade`.
- `.maddu/briefs/project/<name>.md` — project-owned. Never touched.

Same convention for `.maddu/wiki/` and `.maddu/lanes/`. If a project wants to customize a framework default, it copies it to the `project/` subdirectory and edits the copy. The bridge resolves `project/` entries before framework defaults.

## Downgrades

Not supported. Always upgrade forward. To roll back, restore from git history.

## Event trail

Every upgrade appends a single `FRAMEWORK_UPGRADED` event to the spine with the from-version, to-version, the list of files changed, and the operator's session id. The spine is the source of truth for "when did Máddu change."
