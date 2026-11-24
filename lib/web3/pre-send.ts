import "server-only";
import { isGasLimitError } from "@/lib/web3/gas-limit-error";
import { failedNextBlockCheck } from "@/lib/web3/next-block-simulation";
import { isPreBroadcastNetworkError } from "@/lib/web3/submit-signed";

/**
 * True for a failure known to come before anything was sent: a refused
 * connection, a failed next-block check, or a Gas Limit the check refused
 * (too low for the call, or too high for the network). Write cores report these as `broadcastAttempted: false`.
 */
export function isDefinitelyPreSend(error: unknown): boolean {
  return (
    isPreBroadcastNetworkError(error) ||
    failedNextBlockCheck(error) ||
    isGasLimitError(error)
  );
}
