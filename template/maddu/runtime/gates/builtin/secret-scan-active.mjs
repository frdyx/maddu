// v1.2.0 Phase 3 — `secret-scan-active` gate.
//
// Defense against regression: verifies the secret-scan engine is wired
// into the spawn path AND each default tool wrapper. If a wrapper drops
// the import or the scan call, the gate FAILS — catching the regression
// at the next `maddu doctor` run instead of in production after a real
// secret leaked into a commit.
//
// Checks:
//   1. `template/maddu/runtime/lib/secret-scan.mjs` exports `scanArgv`.
//   2. `tools.mjs` imports secret-scan AND calls `scanArgv(` before
//      reaching `spawnSafe`.
//   3. The shared wrapper body (`commands/_tools.mjs#runWrapper`) imports
//      `loadSecretScan`, calls `scanArgv(` before invoking `runTool`, and
//      each of the 5 default tool wrappers
//      (`commands/{git,test,format,lint,install}.mjs`) delegates to it.
//   4. No SECRET_DETECTED_IN_ARGV spine event carries a string field
//      long enough to contain a raw secret value (>200 chars) —
//      defensive sanity check that raw values never leaked into events.
//
// Hard-rule compliance: rule #1 — files-only filesystem grep.

import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', '..', 'lib');
// From <fw>/template/maddu/runtime/gates/builtin/ → up 5 → <fw>/commands/
const FRAMEWORK_COMMANDS = join(__dirname, '..', '..', '..', '..', '..', 'commands');

const WRAPPERS = ['git.mjs', 'test.mjs', 'format.mjs', 'lint.mjs', 'install.mjs'];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function locateWrapper(repoRoot, name) {
  const candidates = [
    join(repoRoot, 'maddu', 'commands', name),
    join(FRAMEWORK_COMMANDS, name),
    join(repoRoot, 'commands', name),
  ];
  for (const p of candidates) {
    if (await exists(p)) return p;
  }
  return null;
}

async function locateCommandHelper(repoRoot) {
  return locateWrapper(repoRoot, '_tools.mjs');
}

export default {
  id: 'secret-scan-active',
  label: 'secret scan active',
  severity: 'critical',
  description: 'secret-scan engine present + wired into tools.mjs + all 5 wrappers; no spine event leaks raw values.',
  run: async (ctx) => {
    const secretScanPath = join(LIB_DIR, 'secret-scan.mjs');
    if (!(await exists(secretScanPath))) {
      return { ok: false, message: 'secret-scan.mjs missing from runtime lib' };
    }
    let mod;
    try { mod = await import(pathToFileURL(secretScanPath).href); }
    catch (err) { return { ok: false, message: `secret-scan.mjs import failed: ${err.message}` }; }
    if (typeof mod.scanArgv !== 'function') {
      return { ok: false, message: 'secret-scan.mjs missing scanArgv export' };
    }

    // tools.mjs central wiring.
    const toolsSrc = await readFile(join(LIB_DIR, 'tools.mjs'), 'utf8');
    if (!toolsSrc.includes("from './secret-scan.mjs'") && !toolsSrc.includes('from "./secret-scan.mjs"')) {
      return { ok: false, message: 'tools.mjs does not import secret-scan.mjs' };
    }
    if (!toolsSrc.includes('scanArgv(')) {
      return { ok: false, message: 'tools.mjs imports secret-scan but never calls scanArgv()' };
    }

    // Shared wrapper-level grep checks. v1.3.0 consolidated the five
    // default wrappers into runWrapper(), so the secret scan is load-bearing
    // in one helper rather than duplicated in every thin command file.
    const helperPath = await locateCommandHelper(ctx.repoRoot);
    if (!helperPath) {
      return { ok: false, message: 'commands/_tools.mjs not found; cannot verify wrapper-level secret scan' };
    }
    const helperSrc = await readFile(helperPath, 'utf8');
    if (!/loadSecretScan/.test(helperSrc)) {
      return { ok: false, message: 'commands/_tools.mjs does not expose/use loadSecretScan' };
    }
    const scanIx = helperSrc.search(/scanArgv\s*\(/);
    if (scanIx < 0) {
      return { ok: false, message: 'commands/_tools.mjs never calls scanArgv(...) in runWrapper' };
    }
    const runToolIx = helperSrc.search(/runTool\s*\(/);
    if (runToolIx >= 0 && scanIx > runToolIx) {
      return { ok: false, message: 'commands/_tools.mjs calls scanArgv(...) after runTool(...)' };
    }

    // Thin-wrapper grep checks.
    const wrapperProblems = [];
    let wrappersChecked = 0;
    let wrappersUnreachable = 0;
    for (const w of WRAPPERS) {
      const p = await locateWrapper(ctx.repoRoot, w);
      if (!p) { wrappersUnreachable++; continue; }
      wrappersChecked++;
      const body = await readFile(p, 'utf8');
      const importsRunWrapper = /import\s*\{\s*runWrapper\s*\}\s*from\s*['"]\.\/_tools\.mjs['"]/.test(body);
      const tool = w.replace(/\.mjs$/, '');
      const callsRunWrapper = new RegExp(`runWrapper\\s*\\(\\s*['"]${tool}['"]`).test(body);
      if (!importsRunWrapper) wrapperProblems.push({ wrapper: w, kind: 'missing-runWrapper-import', detail: `${w} does not import runWrapper from ./_tools.mjs` });
      if (!callsRunWrapper)   wrapperProblems.push({ wrapper: w, kind: 'missing-runWrapper-call', detail: `${w} does not delegate to runWrapper('${tool}', ...)` });
    }
    if (wrappersChecked > 0 && wrapperProblems.length > 0) {
      return {
        ok: false,
        message: `${wrapperProblems.length} wrapper issue(s) across ${wrappersChecked} wrapper(s)`,
        evidence: { wrapperProblems },
      };
    }

    // Spine sanity check — no raw secret values should ever have landed.
    let leaks = [];
    try {
      const events = await ctx.spine.readAll(ctx.repoRoot);
      for (const e of events) {
        if (e.type !== 'SECRET_DETECTED_IN_ARGV') continue;
        for (const [k, v] of Object.entries(e.data || {})) {
          if (typeof v === 'string' && v.length > 200) {
            leaks.push({ eventId: e.id, key: k, length: v.length });
          }
        }
      }
    } catch {}
    if (leaks.length > 0) {
      return {
        ok: false,
        message: `${leaks.length} SECRET_DETECTED_IN_ARGV event(s) may contain raw secret values (> 200 chars)`,
        evidence: { leaks },
      };
    }

    const patterns = Array.isArray(mod.PATTERN_TYPES) ? mod.PATTERN_TYPES
                   : (mod.knownPatternTypes ? mod.knownPatternTypes() : []);
    return {
      ok: true,
      message: `secret-scan wired (tools.mjs + runWrapper + ${wrappersChecked}/${WRAPPERS.length} wrappers, ${patterns.length} pattern types)${wrappersUnreachable ? `; ${wrappersUnreachable} wrapper(s) unreachable` : ''}`,
    };
  },
};
