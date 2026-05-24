// `maddu mcp <subcommand>` — list / show / register / enable / disable / test / remove / visible / templates / install.
//
// Usage:
//   maddu mcp list
//   maddu mcp show <name>
//   maddu mcp register --name <n> --transport stdio --command <bin> [--args a,b] [--lanes a,b]
//                       [--display "…"] [--notes "…"]
//                       (or --transport http --url <u>  /  --transport sse --url <u>)
//   maddu mcp enable  <name>
//   maddu mcp disable <name>
//   maddu mcp test    [<name>]      (no arg → test-all)
//   maddu mcp remove  <name>
//   maddu mcp visible <lane>
//   maddu mcp templates list                          (v1.1.0)
//   maddu mcp templates show <template>               (v1.1.0)
//   maddu mcp install <template> [--name <override>]  (v1.1.0)
//   maddu mcp uninstall <name>                        (v1.1.0 — alias of remove)

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { exists as existsFs } from './_libroot.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = pathResolve(__dirname, '..');

async function templatesDir() {
  const candidates = [
    join(FRAMEWORK_ROOT, 'template', 'maddu', 'mcp-templates'),
    join(process.cwd(), 'maddu', 'mcp-templates'),
  ];
  for (const c of candidates) { if (await existsFs(c)) return c; }
  return null;
}

async function listTemplates() {
  const dir = await templatesDir();
  if (!dir) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      const body = JSON.parse(await readFile(join(dir, e.name), 'utf8'));
      body.__source = join(dir, e.name);
      out.push(body);
    } catch {}
  }
  return out.sort((a, b) => (a.template || '').localeCompare(b.template || ''));
}

async function readTemplate(name) {
  const all = await listTemplates();
  return all.find((t) => t.template === name) || null;
}

function checkBinary(bin) {
  return new Promise((resolve) => {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const ch = spawn(which, [bin], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ch.stdout.on('data', (b) => out += b.toString());
    ch.on('error', () => resolve({ ok: false, path: null }));
    ch.on('close', (code) => resolve({ ok: code === 0 && !!out.trim(), path: out.trim().split('\n')[0] || null }));
  });
}

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', info: '\x1b[36m', accent: '\x1b[35m' };

function csv(s) { if (!s || s === true) return []; return String(s).split(',').map((x) => x.trim()).filter(Boolean); }
function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

function badge(h) {
  if (!h) return `${ANSI.dim}—${ANSI.reset}`;
  if (h.skipped) return `${ANSI.dim}skipped${ANSI.reset} ${ANSI.dim}${h.reason || ''}${ANSI.reset}`;
  if (h.ok) return `${ANSI.pass}✓${ANSI.reset} ${ANSI.dim}${h.status || h.note || ''}${ANSI.reset}`;
  return `${ANSI.fail}✗${ANSI.reset} ${ANSI.dim}${h.error || ('status ' + h.status)}${ANSI.reset}`;
}

export default async function mcpCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const spineLib = await loadSpineLib();
  const { paths, mcp } = spineLib;
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu mcp <list|show|register|enable|disable|test|remove|visible> [flags]');
    process.exit(2);
  }

  if (sub === 'list') {
    const all = await mcp.listMcp(repoRoot);
    const h = await mcp.mcpHealth(repoRoot);
    console.log(`${ANSI.bold}MCP SERVERS  (${all.length})${ANSI.reset}`);
    if (all.length === 0) { console.log('  (none registered)'); return; }
    for (const r of all) {
      const enabled = r.enabled ? `${ANSI.pass}on${ANSI.reset}` : `${ANSI.dim}off${ANSI.reset}`;
      console.log(`  ${ANSI.accent}${r.name.padEnd(20)}${ANSI.reset}  ${r.displayName || r.name}  ${enabled}`);
      console.log(`    ${ANSI.dim}transport:${ANSI.reset} ${r.transport}  ${ANSI.dim}lanes:${ANSI.reset} ${(r.lanes || ['*']).join(', ')}`);
      console.log(`    ${ANSI.dim}health:${ANSI.reset}    ${badge(h[r.name])}`);
    }
    return;
  }

  if (sub === 'show') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu mcp show <name>'); process.exit(2); }
    const r = await mcp.readMcp(repoRoot, name);
    if (!r) { console.error(`mcp ${name} not found`); process.exit(3); }
    const h = (await mcp.mcpHealth(repoRoot))[name];
    console.log(`${ANSI.bold}${r.displayName || r.name}${ANSI.reset}  ${ANSI.dim}(${r.name})${ANSI.reset}`);
    console.log(`  transport:  ${r.transport}`);
    console.log(`  enabled:    ${r.enabled ? 'yes' : 'no'}`);
    console.log(`  lanes:      ${(r.lanes || ['*']).join(', ')}`);
    console.log(`  slot:       ${r.slot || '—'}`);
    if (r.transport === 'stdio') {
      console.log(`  command:    ${r.stdio?.command || '—'}`);
      console.log(`  args:       ${(r.stdio?.args || []).join(' ') || '—'}`);
    } else {
      const cfg = r[r.transport] || {};
      console.log(`  url:        ${cfg.url || '—'}`);
    }
    console.log(`  health:     ${badge(h)}`);
    if (h?.at) console.log(`  last test:  ${fmt(h.at)}`);
    if (r.notes) console.log(`\n${r.notes}`);
    return;
  }

  if (sub === 'register') {
    const { flags } = parseFlags(rest);
    const name = requireFlag(flags, 'name');
    const transport = flags.transport || 'stdio';
    const patch = {
      name,
      displayName: flags.display || name,
      transport,
      enabled: flags.disabled ? false : true,
      lanes: csv(flags.lanes).length ? csv(flags.lanes) : ['*'],
      notes: flags.notes || ''
    };
    if (transport === 'stdio') {
      patch.stdio = { command: flags.command || null, args: csv(flags.args), env: csv(flags.env) };
    } else if (transport === 'sse') {
      patch.sse = { url: flags.url || null };
    } else if (transport === 'http') {
      patch.http = { url: flags.url || null };
    }
    // v1.2.0 Phase 2 — operator-registered MCPs are NOT pre-approved.
    // They tag as 'operator-trusted' and require explicit `maddu mcp approve <name>`
    // before they can be enabled. Cockpit + visibleFor surface the badge.
    patch.provenance = {
      source: 'operator-trusted',
      approved: false,
      registeredAt: new Date().toISOString(),
    };
    // Default to disabled-until-approved unless the operator explicitly passes --approve.
    if (!flags.approve) patch.enabled = false;
    else patch.provenance.approved = true;
    const saved = await mcp.saveMcp(repoRoot, patch, flags.by || null);
    if (flags.approve) {
      await spineLib.spine.append(repoRoot, {
        type: spineLib.spine.EVENT_TYPES.MCP_APPROVAL_GRANTED,
        data: { name: saved.name, by: flags.by || null },
      });
    }
    console.log(`${ANSI.pass}registered${ANSI.reset}  ${saved.name}  (${saved.transport})  ${saved.provenance?.approved ? '' : ANSI.warn + '[pending approval — run `maddu mcp approve ' + saved.name + '`]' + ANSI.reset}`);
    return;
  }
  if (sub === 'approve') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu mcp approve <name>'); process.exit(2); }
    const r = await mcp.readMcp(repoRoot, name);
    if (!r) { console.error(`mcp ${name} not found`); process.exit(3); }
    const next = { ...r, provenance: { ...(r.provenance || {}), source: r.provenance?.source || 'operator-trusted', approved: true, approvedAt: new Date().toISOString() }, enabled: true };
    await mcp.saveMcp(repoRoot, next, null);
    await spineLib.spine.append(repoRoot, {
      type: spineLib.spine.EVENT_TYPES.MCP_APPROVAL_GRANTED,
      data: { name, by: null },
    });
    console.log(`${ANSI.pass}approved${ANSI.reset}  ${name} (now enabled)`);
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const name = rest[0];
    if (!name) { console.error(`usage: maddu mcp ${sub} <name>`); process.exit(2); }
    await mcp.setEnabled(repoRoot, name, sub === 'enable');
    const c = sub === 'enable' ? ANSI.pass : ANSI.dim;
    console.log(`${c}${sub === 'enable' ? 'enabled' : 'disabled'}${ANSI.reset}  ${name}`);
    return;
  }

  if (sub === 'test') {
    const name = rest[0];
    if (!name) {
      const results = await mcp.testAll(repoRoot);
      console.log(`${ANSI.bold}TEST ALL  (${results.length})${ANSI.reset}`);
      for (const r of results) console.log(`  ${r.name.padEnd(20)}  ${badge(r)}`);
      return;
    }
    const r = await mcp.testMcp(repoRoot, name);
    console.log(`${name}  ${badge(r)}`);
    if (r.sample) console.log(`  ${ANSI.dim}${r.sample.split('\n').slice(0, 3).join('\n  ')}${ANSI.reset}`);
    return;
  }

  if (sub === 'remove') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu mcp remove <name>'); process.exit(2); }
    await mcp.removeMcp(repoRoot, name);
    console.log(`${ANSI.warn}removed${ANSI.reset}  ${name}`);
    return;
  }

  if (sub === 'visible') {
    const lane = rest[0];
    if (!lane) { console.error('usage: maddu mcp visible <lane>'); process.exit(2); }
    const all = await mcp.visibleFor(repoRoot, lane);
    console.log(`${ANSI.bold}VISIBLE for lane "${lane}"  (${all.length})${ANSI.reset}`);
    for (const r of all) console.log(`  ${r.name}  ${ANSI.dim}(${r.transport})${ANSI.reset}`);
    return;
  }

  // ─── v1.1.0 Phase 2: templates + install ──────────────────────────────
  if (sub === 'templates') {
    const tsub = rest[0];
    if (tsub === 'list' || !tsub) {
      const all = await listTemplates();
      if (all.length === 0) { console.log('(no templates available — framework source not found)'); return; }
      console.log(`${ANSI.bold}MCP TEMPLATES  (${all.length})${ANSI.reset}`);
      for (const t of all) {
        console.log(`  ${ANSI.accent}${(t.template || '?').padEnd(18)}${ANSI.reset}  ${t.displayName || ''}`);
        if (t.summary) console.log(`    ${ANSI.dim}${t.summary}${ANSI.reset}`);
        if (Array.isArray(t.requires) && t.requires.length) {
          console.log(`    ${ANSI.dim}requires: ${t.requires.map((r) => r.binary).join(', ')}${ANSI.reset}`);
        }
      }
      console.log(`\nInstall one with:  ${ANSI.info}maddu mcp install <template>${ANSI.reset}`);
      return;
    }
    if (tsub === 'show') {
      const name = rest[1];
      if (!name) { console.error('usage: maddu mcp templates show <template>'); process.exit(2); }
      const t = await readTemplate(name);
      if (!t) { console.error(`template ${name} not found`); process.exit(3); }
      console.log(`${ANSI.bold}${t.displayName || t.template}${ANSI.reset}  ${ANSI.dim}(${t.template})${ANSI.reset}`);
      console.log(`  transport: ${t.transport}`);
      if (t.transport === 'stdio') {
        console.log(`  command:   ${t.stdio?.command} ${(t.stdio?.args || []).join(' ')}`);
      } else {
        console.log(`  url:       ${t[t.transport]?.url}`);
      }
      console.log(`  lanes:     ${(t.lanes || ['*']).join(', ')}`);
      if (Array.isArray(t.requires) && t.requires.length) {
        console.log(`\n${ANSI.bold}Requires:${ANSI.reset}`);
        for (const r of t.requires) console.log(`  - ${r.binary}  ${ANSI.dim}${r.install || ''}${ANSI.reset}`);
      }
      if (Array.isArray(t.hardRuleNotes) && t.hardRuleNotes.length) {
        console.log(`\n${ANSI.bold}Hard-rule notes:${ANSI.reset}`);
        for (const n of t.hardRuleNotes) console.log(`  - ${n}`);
      }
      if (t.notes) console.log(`\n${t.notes}`);
      return;
    }
    console.error(`maddu mcp templates: unknown verb "${tsub}" — try list | show`);
    process.exit(2);
  }

  if (sub === 'install') {
    const { flags } = parseFlags(rest);
    const template = rest.find((a) => !a.startsWith('-'));
    if (!template) { console.error('usage: maddu mcp install <template> [--name <override>]'); process.exit(2); }
    const tpl = await readTemplate(template);
    if (!tpl) { console.error(`template "${template}" not found — try \`maddu mcp templates list\``); process.exit(3); }
    // 1. Check required binaries.
    const missing = [];
    for (const req of (tpl.requires || [])) {
      const found = await checkBinary(req.binary);
      if (!found.ok) missing.push(req);
    }
    if (missing.length) {
      console.error(`${ANSI.fail}refused${ANSI.reset}  required binary not found:`);
      for (const m of missing) console.error(`  - ${m.binary}  ${ANSI.dim}${m.install || ''}${ANSI.reset}`);
      console.error(`\nInstall the missing binary then re-run \`maddu mcp install ${template}\`.`);
      process.exit(4);
    }
    // 1b. v1.2.0 Phase 2 — verify template provenance hash. Refuse on
    // mismatch unless --skip-provenance (kept for emergency overrides;
    // logged as a violation regardless).
    const { ok: provOk, expected, actual } = mcp.verifyTemplateProvenance(tpl);
    if (!provOk && !flags['skip-provenance']) {
      await spineLib.spine.append(repoRoot, {
        type: spineLib.spine.EVENT_TYPES.MCP_PROVENANCE_MISMATCH,
        data: {
          template: tpl.template,
          expected,
          actual,
          detail: expected == null ? 'no provenance.sha256 declared in template' : 'template content changed since hash was baked',
        },
      });
      console.error(`${ANSI.fail}refused${ANSI.reset}  MCP_PROVENANCE_MISMATCH for template "${tpl.template}"`);
      console.error(`  expected sha256: ${expected || '(none)'}`);
      console.error(`  actual sha256:   ${actual}`);
      console.error(`  Either the template was tampered with or its provenance hash is stale.`);
      console.error(`  Re-pull the framework or pass --skip-provenance to override (recorded as a violation).`);
      process.exit(5);
    }
    if (provOk) {
      await spineLib.spine.append(repoRoot, {
        type: spineLib.spine.EVENT_TYPES.MCP_PROVENANCE_VERIFIED,
        data: { template: tpl.template, sha256: actual },
      });
    }
    // 2. Scaffold any companion files (server.mjs, feeds.json, etc.).
    if (tpl.scaffold && Array.isArray(tpl.scaffold.files)) {
      for (const f of tpl.scaffold.files) {
        const dest = join(repoRoot, f.path);
        await mkdir(dirname(dest), { recursive: true });
        if (!(await existsFs(dest))) {
          await writeFile(dest, f.content);
          console.log(`${ANSI.dim}scaffolded${ANSI.reset}  ${f.path}`);
        } else {
          console.log(`${ANSI.dim}kept${ANSI.reset}        ${f.path}  (already present)`);
        }
      }
    }
    // 3. Register descriptor via the existing saveMcp path.
    const name = (typeof flags.name === 'string' && flags.name) || tpl.template;
    const patch = {
      name,
      displayName: tpl.displayName || name,
      transport: tpl.transport || 'stdio',
      enabled: true,
      lanes: Array.isArray(tpl.lanes) && tpl.lanes.length ? tpl.lanes : ['*'],
      notes: `Installed from template "${tpl.template}".` + (tpl.notes ? '\n\n' + tpl.notes : ''),
      // v1.2.0 Phase 2 — provenance tag rides on the saved descriptor so
      // the cockpit Trust route and the mcp-provenance-verified gate can
      // tell framework-shipped servers from operator-trusted ones.
      provenance: {
        source: 'framework-shipped',
        templateName: tpl.template,
        templateSha256: actual,
        approved: true,  // framework templates are pre-approved
        installedAt: new Date().toISOString(),
      },
    };
    if (patch.transport === 'stdio') {
      patch.stdio = {
        command: tpl.stdio?.command || null,
        args: Array.isArray(tpl.stdio?.args) ? tpl.stdio.args : [],
        env: Array.isArray(tpl.stdio?.env) ? tpl.stdio.env : [],
      };
    } else if (patch.transport === 'sse') {
      patch.sse = { url: tpl.sse?.url || null };
    } else if (patch.transport === 'http') {
      patch.http = { url: tpl.http?.url || null };
    }
    const saved = await mcp.saveMcp(repoRoot, patch, null);
    console.log(`${ANSI.pass}installed${ANSI.reset}  ${saved.name}  (${saved.transport})  ← template:${tpl.template}`);
    return;
  }

  if (sub === 'uninstall') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu mcp uninstall <name>'); process.exit(2); }
    await mcp.removeMcp(repoRoot, name);
    console.log(`${ANSI.warn}uninstalled${ANSI.reset}  ${name}`);
    return;
  }

  console.error(`maddu mcp: unknown subcommand "${sub}"`);
  process.exit(2);
}
