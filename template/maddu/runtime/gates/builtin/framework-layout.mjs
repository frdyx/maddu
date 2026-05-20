// Framework layout gate (v0.17.1).
//
// Surfaces the detected framework layout in doctor output so an operator
// running `maddu doctor` always knows which CLI surface they are on:
//
//   source     — clone of frdyx/maddu or npm-extracted package. init / upgrade
//                from here scaffolds consumer repos. Has template/maddu/.
//   installed  — consumer's own maddu/ directory. Bridge / doctor / brief /
//                register / status work. init / upgrade refuse (v0.17.1+).
//   unknown    — broken or partially-extracted checkout.
//
// `source` and `installed` both PASS. `unknown` FAILs the gate (critical) —
// the bridge cannot operate from an unknown layout.

import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

export default {
  id: 'framework-layout',
  label: 'framework layout',
  severity: 'critical',
  description: 'Detects framework layout (source / installed) and refuses to operate from an unknown layout.',
  run: async (ctx) => {
    // The gate file lives at one of two locations:
    //   installed:  <consumer>/maddu/runtime/gates/builtin/framework-layout.mjs
    //   source:     <repo>/template/maddu/runtime/gates/builtin/framework-layout.mjs
    //
    // Differentiate by path string: the source layout contains
    // `/template/maddu/runtime/gates/` as a sub-path. Path-string detection is
    // deterministic — a consumer install cannot accidentally have
    // `/template/maddu/` in its gate path because the install flattened that
    // prefix.
    const normalized = __dirname.replace(/\\/g, '/');
    const isSource = normalized.includes('/template/maddu/runtime/gates/');

    if (isSource) {
      // <source>/template/maddu/runtime/gates/builtin/ → framework root is 5 up.
      const sourceFr = join(__dirname, '..', '..', '..', '..', '..');
      const templatePath = join(sourceFr, 'template', 'maddu');
      if (!(await exists(templatePath))) {
        return {
          ok: false,
          message: `framework layout unknown — gate path looks like source but ${templatePath} is missing`,
          evidence: { gateDir: __dirname, expectedTemplate: templatePath },
        };
      }
      return {
        ok: true,
        message: 'framework layout: source',
        evidence: { layout: 'source', root: sourceFr },
      };
    }

    // installed: <consumer>/maddu/runtime/gates/builtin/ → framework root is 3 up.
    const installedFr = join(__dirname, '..', '..', '..');
    const runtimePath = join(installedFr, 'runtime');
    if (!(await exists(runtimePath))) {
      return {
        ok: false,
        message: `framework layout unknown — gate path doesn't match source pattern and ${runtimePath} is missing`,
        evidence: { gateDir: __dirname, expectedRuntime: runtimePath },
      };
    }
    return {
      ok: true,
      message: 'framework layout: installed',
      evidence: { layout: 'installed', root: installedFr },
    };
  },
};
