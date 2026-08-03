// materializeSliceStop — the ONE shared post-SLICE_STOP projection path.
//
// v1.115.0 (memory-recall track, Phase 1). Before this module, the CLI ritual
// ran hindsight only and the bridge route ran hindsight + wiki — so every
// CLI/headless slice-stop silently produced a drifted or missing wiki page
// (355 of 619 live stops at the time of the fix). Both transports now call
// this composition seam, mirroring the session-lifecycle.mjs precedent:
// testable shared function, thin per-transport callers. The CLI stays
// independent of the bridge (the bridge is optional).
//
// Error law: NEVER throws. Each projection is isolated — a wiki write failure
// must not block memory extraction, and neither may break the slice-stop
// itself (the spine event is already appended before this runs). Both
// component functions are idempotent (deterministic fact ids; wiki page-scan
// event guard), so replays are safe from any path including `wiki sync`.

import { extractEvent } from './hindsight.mjs';
import { appendSliceStop } from './wiki.mjs';

export async function materializeSliceStop(repoRoot, ev) {
  if (!ev || ev.type !== 'SLICE_STOP') return null;
  const out = {
    ok: true,
    memory: { added: 0, error: null },
    wiki: { page: null, appended: false, skipped: null, error: null },
  };
  try {
    out.memory.added = await extractEvent(repoRoot, ev);
  } catch (err) {
    out.memory.error = err.message || String(err);
    out.ok = false;
  }
  try {
    const w = await appendSliceStop(repoRoot, ev);
    if (w) {
      out.wiki.page = w.page;
      out.wiki.appended = !!w.appended;
      out.wiki.skipped = w.skipped || null;
    }
  } catch (err) {
    out.wiki.error = err.message || String(err);
    out.ok = false;
  }
  return out;
}
