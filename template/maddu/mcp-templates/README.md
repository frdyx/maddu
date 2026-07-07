# MCP server templates

Curated, provenance-hashed MCP server definitions that `maddu mcp` can
register without the operator hand-writing a config:

```bash
maddu mcp templates         # list these
maddu mcp install local-fs  # register one from this catalog
```

Each template declares its transport (`stdio`/`sse`/`http`) and carries a
`provenance.sha256` over its own content — `maddu mcp` and the
`mcp-provenance-verified` / `mcp-template-shape` gates refuse a template
whose hash doesn't match (a tampered template never reaches the gateway).
Only `*.json` files here are read; see `docs/29-mcp-templates.md`.
