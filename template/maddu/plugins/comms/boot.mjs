// comms plugin — background poll/send loop.
//
// Loaded by the bridge ONLY when the comms plugin is enabled. Replaces the
// formerly-static `telegramLoop` in server.js. Each per-workspace tick is cheap
// when the subsystem's state.enabled is false, so an enabled-but-unconfigured
// comms plugin costs almost nothing.
//
// Contract: export start(ctx) -> { stop }. ctx: { workspaces } (Map id->repoRoot).

import * as telegram from './telegram.mjs';
import * as discord from './discord.mjs';
import * as emailBridge from './email.mjs';

export function start(ctx) {
  const { workspaces } = ctx;
  let stopping = false;
  let timer = null;

  async function loop() {
    if (stopping) return;
    for (const [workspaceId, repoRoot] of workspaces) {
      try { await telegram.tickPoll(repoRoot); } catch (err) { console.error(`[${workspaceId}] telegram poll`, err.message); }
      try { await telegram.tickSend(repoRoot); } catch (err) { console.error(`[${workspaceId}] telegram send`, err.message); }
      try { await discord.tickSend(repoRoot); } catch (err) { console.error(`[${workspaceId}] discord send`, err.message); }
      try { await emailBridge.tickSend(repoRoot); } catch (err) { console.error(`[${workspaceId}] email send`, err.message); }
    }
    if (stopping) return;
    timer = setTimeout(loop, 1500);
  }
  timer = setTimeout(loop, 1000);

  return {
    stop() { stopping = true; if (timer) clearTimeout(timer); },
  };
}
