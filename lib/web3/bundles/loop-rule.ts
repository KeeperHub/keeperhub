// The one rule for bundle steps in loops, shared by save and run time.

/** Loops around a step: 0 at the top level, 1 inside one For Each, 2 nested. */
const MAX_BUNDLE_LOOP_DEPTH = 1;

/** Why a bundle step cannot run at this loop depth (the same text at save and run time), or nothing. */
export function bundleLoopRefusal(loopDepth: number): string | undefined {
  return loopDepth > MAX_BUNDLE_LOOP_DEPTH
    ? 'Send as Bundle cannot run inside a For Each that is inside another For Each yet. Move this step into a single For Each, or set Send as to Normal transaction (sendMode: "transaction").'
    : undefined;
}
