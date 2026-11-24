import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import type { TriggerBlock } from "@/lib/web3/next-block-limits";

const BLOCK_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

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
  const number = wholeNumber(triggerInput.blockNumber);
  const timestamp = wholeNumber(triggerInput.blockTimestamp);
  const { parentHash } = triggerInput;
  const network = triggerConfig.network;
  if (
    number === undefined ||
    timestamp === undefined ||
    typeof parentHash !== "string" ||
    !BLOCK_HASH_PATTERN.test(parentHash) ||
    (typeof network !== "string" && typeof network !== "number")
  ) {
    return;
  }
  try {
    const chainId = getChainIdFromNetwork(network);
    return { chainId, number, timestamp, parentHash };
  } catch {
    return;
  }
}
