// config-dir.mjs — the ONE derivation of Máddu's device-local config directory.
//
//   Windows:     %APPDATA%\maddu            (APPDATA, else ~/AppData/Roaming)
//   Linux/macOS: $XDG_CONFIG_HOME/maddu     (else ~/.config/maddu)
//
// v1.139.0 (audit register E3): this lived, byte-identical, in
// bridges-registry.mjs, workspaces.mjs and auth.mjs — three copies of a
// platform rule that must agree, with nothing making them agree. The three
// now import it; global.mjs and bridge-auth.mjs keep reaching it through the
// registries' re-exports. `ensureConfigDir(...segments)` creates a
// subdirectory under it with the 0o700 mode the registries always applied
// (chmod is a no-op on Windows and is never allowed to throw).

import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

export function configDir() {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'maddu');
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'maddu');
}

export async function ensureConfigDir(...segments) {
  const d = join(configDir(), ...segments);
  await mkdir(d, { recursive: true });
  if (platform() !== 'win32') {
    try { await chmod(d, 0o700); } catch {}
  }
  return d;
}
