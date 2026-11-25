import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import type { TriggerBlock } from "@/lib/web3/next-block-limits";

/**
 * The trigger block of an EVM Block-triggered run. Only for runs the block
 * scheduler started: run input from callers is never trusted for it.
 */
export function triggerBlockOf(
  fromBlockScheduler: boolean | undefined,
  triggerConfig: Record<string, unknown> | undefined,
  triggerInput: Record<string, unknown> | undefined
): TriggerBlock | undefined {
  if (
    fromBlockScheduler !== true ||
    triggerConfig?.triggerType !== "Block" ||
    !triggerInput
  ) {
    return;
  }
  const { blockNumber } = triggerInput;
  const network = triggerConfig.network;
  if (
    typeof blockNumber !== "number" ||
    !Number.isSafeInteger(blockNumber) ||
    blockNumber <= 0 ||
    (typeof network !== "string" && typeof network !== "number")
  ) {
    return;
  }
  try {
    return { chainId: getChainIdFromNetwork(network), number: blockNumber };
  } catch {
    return;
  }
}
