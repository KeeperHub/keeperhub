import "server-only";

import { ethers } from "ethers";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import type { RpcProviderManager } from "@/lib/rpc/providers";

type RpcManager = RpcProviderManager;

type FeeHistory = { baseFeePerGas?: string[] };

/**
 * Refuse a max fee cap below the next block's base fee: a transaction capped
 * there cannot be included in that block and would hold the wallet's nonce
 * until the base fee falls. eth_feeHistory reports the next block's base fee
 * as its last entry, computed by the node with its own chain's rules. A failed
 * read does not block the send; the gas strategy still applies the cap.
 */
export async function maxFeeBelowBaseFeeError(
  rpcManager: RpcManager,
  maxFeeWei: bigint
): Promise<string | undefined> {
  let nextBaseFee: bigint | undefined;
  try {
    const history = await rpcManager.executeWithFailover(
      (provider) =>
        provider.send("eth_feeHistory", [
          "0x1",
          "latest",
          [],
        ]) as Promise<FeeHistory | null>
    );
    const last = history?.baseFeePerGas?.at(-1);
    nextBaseFee = last === undefined ? undefined : BigInt(last);
  } catch (error) {
    logSystemWarn(
      ErrorCategory.NETWORK_RPC,
      "[Max Fee] Could not read the next base fee, sending with the cap",
      error
    );
    return;
  }
  if (nextBaseFee === undefined || maxFeeWei >= nextBaseFee) {
    return;
  }
  return `Max fee ${ethers.formatUnits(maxFeeWei, "gwei")} gwei is below the next block's base fee of ${ethers.formatUnits(nextBaseFee, "gwei")} gwei, so the transaction could not be included. Raise the max fee or leave it empty.`;
}
