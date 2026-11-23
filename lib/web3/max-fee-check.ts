import "server-only";

import { ethers } from "ethers";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import type { getRpcProvider } from "@/lib/rpc/provider-factory";

type RpcManager = Awaited<ReturnType<typeof getRpcProvider>>;

/**
 * Refuse a max fee cap below the latest block's base fee: a transaction capped
 * there cannot be included and would hold the wallet's nonce until the base
 * fee falls. A failed base-fee read does not block the send; the cap is still
 * applied by the gas strategy.
 */
export async function maxFeeBelowBaseFeeError(
  rpcManager: RpcManager,
  maxFeeWei: bigint
): Promise<string | undefined> {
  let baseFee: bigint | null | undefined;
  try {
    const block = await rpcManager.executeWithFailover((provider) =>
      provider.getBlock("latest")
    );
    baseFee = block?.baseFeePerGas;
  } catch (error) {
    logSystemWarn(
      ErrorCategory.NETWORK_RPC,
      "[Max Fee] Could not read the latest base fee, sending with the cap",
      error
    );
    return;
  }
  if (baseFee === null || baseFee === undefined || maxFeeWei >= baseFee) {
    return;
  }
  return `Max fee ${ethers.formatUnits(maxFeeWei, "gwei")} gwei is below the current base fee of ${ethers.formatUnits(baseFee, "gwei")} gwei, so the transaction could not be included. Raise the max fee or leave it empty.`;
}
