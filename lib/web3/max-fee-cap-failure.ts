import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import type { getRpcProvider } from "@/lib/rpc/provider-factory";
import { maxFeeBelowBaseFeeError } from "@/lib/web3/max-fee-check";

type RpcManager = Awaited<ReturnType<typeof getRpcProvider>>;

/** A write's failure when its Max Fee is below the next base fee, else undefined. */
export async function maxFeeCapFailure(
  rpcManager: RpcManager,
  maxFeeWei: bigint
): Promise<
  { success: false; error: string; errorClass: ExecutionErrorType } | undefined
> {
  const error = await maxFeeBelowBaseFeeError(rpcManager, maxFeeWei);
  if (!error) {
    return;
  }
  // The base fee, not the node's config, decides this, so failOnError=false
  // can carry a run through a gas spike.
  return { success: false, error, errorClass: ExecutionErrorType.EXTERNAL };
}
