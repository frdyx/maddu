// `maddu plugin` — manage capabilities that live outside the core (v1.4.0).
//
// The plugin system lets a capability ship as a self-contained directory with a
// `plugin.json` manifest, loaded only when enabled. See
// docs/audit/2026-06-03-ADR-plugin-system.md.
//
// Subcommands:
//   list                  installed plugins + enabled/trusted/source state
//   info <name>           manifest detail + what the plugin contributes
//   enable <name>         add to enable-state (.maddu/config/plugins.json)
//   disable <name>        remove from enable-state
//
// Flags:
//   --trust   required to enable a user-added (untrusted) plugin; records its
//             current sha256 as the trust anchor.
//   --json    machine-readable (list/info)
//
// Read paths are safe; enable/disable write enable-state only. Exit 0 ok,
// 1 on error, 2 on usage error.

import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { loadLib } from './_libroot.mjs';

const ANSI = { on: '\x1b[32m', off: '\x1b[2m', warn: '\x1b[33m', bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m' };
const SUB = new Set(['list', 'info', 'enable', 'disable']);

function printHelp() {
  console.log('Usage: maddu plugin <list|info|enable|disable> [name] [--trust] [--json]');
}

export default async function plugin(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return; }
  const { flags, positional } = parseFlags(argv);
  const sub = positional[0];
  const name = positional[1];
  if (!sub || !SUB.has(sub)) { printHelp(); process.exit(2); }

  const repoRoot = await findRepoRoot(process.cwd());
  if (!repoRoot) { console.error('maddu plugin: not inside a Máddu repo (run `maddu init` first).'); process.exit(1); }

  const plugins = await loadLib('plugins.mjs');

  if (sub === 'list') {
    const all = await plugins.discoverPlugins(repoRoot);
    if (flags.json) { process.stdout.write(JSON.stringify(all.map((p) => ({ name: p.name, source: p.source, enabled: !!p.enabled, trusted: !!p.trusted, error: p.error || null, eventTypes: p.manifest?.eventTypes?.length || 0 })), null, 2) + '\n'); return; }
    if (!all.length) { console.log('(no plugins installed — bundled plugins ship under maddu/plugins/)'); return; }
    console.log(`${ANSI.bold}Plugins (${all.length})${ANSI.reset}`);
    for (const p of all) {
      if (p.error) { console.log(`  ${ANSI.warn}!${ANSI.reset} ${p.name.padEnd(16)} ${ANSI.warn}${p.error}${ANSI.reset}`); continue; }
      const state = p.enabled ? `${ANSI.on}enabled${ANSI.reset}` : `${ANSI.off}disabled${ANSI.reset}`;
      const trust = p.trusted ? '' : ` ${ANSI.warn}untrusted${ANSI.reset}`;
      console.log(`  ${p.enabled ? ANSI.on + '●' + ANSI.reset : ' '} ${p.name.padEnd(16)} ${state}${trust}  ${ANSI.dim}${p.source} · ${p.manifest.eventTypes.length} event type(s) · ${p.manifest.description}${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'info') {
    if (!name) { console.error('maddu plugin info: <name> required'); process.exit(2); }
    const p = await plugins.getPlugin(repoRoot, name);
    if (!p) { console.error(`maddu plugin info: no plugin "${name}"`); process.exit(1); }
    if (p.error) { console.error(`maddu plugin info: ${p.name}: ${p.error}`); process.exit(1); }
    if (flags.json) { process.stdout.write(JSON.stringify(p, null, 2) + '\n'); return; }
    const m = p.manifest;
    console.log(`${ANSI.bold}${m.name}${ANSI.reset} v${m.version}  ${ANSI.dim}(${p.source}, ${p.enabled ? 'enabled' : 'disabled'}, ${p.trusted ? 'trusted' : 'untrusted'})${ANSI.reset}`);
    console.log(`  ${m.description}`);
    if (m.madduVersionMin) console.log(`  requires Máddu >= ${m.madduVersionMin}`);
    console.log(`  contributes: ${m.eventTypes.length} event type(s)${m.server ? ', server endpoints' : ''}${m.boot ? ', boot loop' : ''}${m.cockpit ? ', cockpit panel' : ''}`);
    if (m.libs.length) console.log(`  libs: ${m.libs.join(', ')}`);
    if (m.eventTypes.length) console.log(`  event types: ${m.eventTypes.join(', ')}`);
    return;
  }

  // enable / disable
  if (!name) { console.error(`maddu plugin ${sub}: <name> required`); process.exit(2); }
  const p = await plugins.getPlugin(repoRoot, name);
  if (!p) { console.error(`maddu plugin ${sub}: no plugin "${name}"`); process.exit(1); }
  if (p.error) { console.error(`maddu plugin ${sub}: ${p.name}: ${p.error}`); process.exit(1); }

  const state = await plugins.readEnableState(repoRoot);
  const set = new Set(state.enabled);

  if (sub === 'enable') {
    if (!p.trusted && !flags.trust) {
      const sha = await plugins.hashPlugin(p.dir);
      console.error(`maddu plugin enable: "${name}" is a user-added (untrusted) plugin.`);
      console.error(`Plugins run framework code. Re-run with --trust to accept it. Current sha256: ${sha}`);
      process.exit(1);
    }
    set.add(name);
    await plugins.writeEnableState(repoRoot, { enabled: [...set] });
    const note = (!p.trusted && flags.trust) ? ` ${ANSI.dim}(trusted via --trust; sha256 ${await plugins.hashPlugin(p.dir)})${ANSI.reset}` : '';
    console.log(`${ANSI.on}enabled${ANSI.reset} ${name}${note}`);
    console.log(`${ANSI.dim}Restart the bridge (\`maddu stop && maddu start\`) for server/boot hooks to take effect.${ANSI.reset}`);
    return;
  }

  if (sub === 'disable') {
    if (!set.has(name)) { console.log(`${name} is already disabled`); return; }
    set.delete(name);
    await plugins.writeEnableState(repoRoot, { enabled: [...set] });
    console.log(`${ANSI.off}disabled${ANSI.reset} ${name}`);
    console.log(`${ANSI.dim}Restart the bridge for the change to take effect.${ANSI.reset}`);
    return;
  }
}
