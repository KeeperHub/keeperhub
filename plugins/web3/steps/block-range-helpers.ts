// No "use step" directive: safe to export helpers and import from step files.
//
// Shared block-range resolution for the EVM history-scanning steps
// (query-events, query-transactions).

import type { ethers } from "ethers";

const DEFAULT_BLOCK_LOOKBACK = 6500;

// `toBlockIsLatest` marks a range whose end was resolved by us (from an empty
// or "latest" input) rather than given explicitly by the user. Only that case
// is safe to re-verify/clamp against a fresher head at query time -- an
// explicit user-provided toBlock must surface a real error if it turns out to
// be beyond the chain, not get silently truncated.
export type BlockRange = {
  fromBlock: number;
  toBlock: number;
  toBlockIsLatest: boolean;
};

function parseBlockCount(
  blockCountInput: number | string | undefined
): { success: true; value: number } | { success: false; error: string } | null {
  if (blockCountInput === undefined || blockCountInput === null) {
    return null;
  }

  const strVal =
    typeof blockCountInput === "string" ? blockCountInput.trim() : "";
  if (typeof blockCountInput === "string" && strVal === "") {
    return null;
  }

  const parsed =
    typeof blockCountInput === "number"
      ? blockCountInput
      : Number.parseInt(strVal, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return {
      success: false,
      error: `Invalid blockCount value: ${blockCountInput}`,
    };
  }

  return { success: true, value: parsed };
}

function resolveFromBlock(
  fromBlockInput: string | undefined,
  blockCountInput: number | string | undefined,
  resolvedToBlock: number
): { success: true; value: number } | { success: false; error: string } {
  const fromBlockStr = fromBlockInput?.toString().trim() ?? "";

  if (fromBlockStr !== "") {
    const parsed = Number.parseInt(fromBlockStr, 10);
    if (Number.isNaN(parsed)) {
      return {
        success: false,
        error: `Invalid fromBlock value: ${fromBlockInput}`,
      };
    }
    return { success: true, value: parsed };
  }

  const blockCountResult = parseBlockCount(blockCountInput);
  if (blockCountResult !== null && !blockCountResult.success) {
    return { success: false, error: blockCountResult.error };
  }

  const lookback =
    blockCountResult !== null ? blockCountResult.value : DEFAULT_BLOCK_LOOKBACK;

  return { success: true, value: Math.max(0, resolvedToBlock - lookback) };
}

export async function resolveBlockRange(
  provider: ethers.JsonRpcProvider,
  fromBlockInput: string | undefined,
  toBlockInput: string | undefined,
  blockCountInput: number | string | undefined
): Promise<
  { success: true; range: BlockRange } | { success: false; error: string }
> {
  const toBlockStr = toBlockInput?.toString().trim() ?? "";
  let resolvedToBlock: number;
  const toBlockIsLatest =
    toBlockStr === "" || toBlockStr.toLowerCase() === "latest";

  if (toBlockIsLatest) {
    // This is a planning estimate only -- how many batches to run and where
    // `fromBlock` starts. It is NOT the authoritative bound used for the
    // final eth_getLogs call; see queryBatchWithRetry's tip-batch handling.
    resolvedToBlock = await provider.getBlockNumber();
  } else {
    resolvedToBlock = Number.parseInt(toBlockStr, 10);
    if (Number.isNaN(resolvedToBlock)) {
      return {
        success: false,
        error: `Invalid toBlock value: ${toBlockInput}`,
      };
    }
  }

  const fromBlockResult = resolveFromBlock(
    fromBlockInput,
    blockCountInput,
    resolvedToBlock
  );
  if (!fromBlockResult.success) {
    return { success: false, error: fromBlockResult.error };
  }

  return {
    success: true,
    range: {
      fromBlock: fromBlockResult.value,
      toBlock: resolvedToBlock,
      toBlockIsLatest,
    },
  };
}
