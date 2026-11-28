import "server-only";
import type { RevertKind } from "@/lib/web3/decode-revert-error";
import { isGasLimitError } from "@/lib/web3/gas-limit-error";
import { failedNextBlockCheck } from "@/lib/web3/next-block-simulation";
import { isPreBroadcastNetworkError } from "@/lib/web3/submit-signed";

/**
 * True for a failure known to come before anything was sent: a refused
 * connection, a failed next-block check, or a Gas Limit the check refused.
 */
function isDefinitelyPreSend(error: unknown): boolean {
  return (
    isPreBroadcastNetworkError(error) ||
    failedNextBlockCheck(error) ||
    isGasLimitError(error)
  );
}

/**
 * A failed write's `broadcastAttempted`: true with a hash; otherwise true only
 * when the revert is unclassified and nothing shows the failure came before sending.
 */
export function broadcastAttemptedOf(
  error: unknown,
  broadcastHash: string | null | undefined,
  rejection: RevertKind
): boolean {
  if (broadcastHash) {
    return true;
  }
  return rejection.kind === "unknown" && !isDefinitelyPreSend(error);
}
