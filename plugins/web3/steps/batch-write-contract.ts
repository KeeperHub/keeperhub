import "server-only";

import { resolveExplorerLink } from "@/lib/web3/explorer-link";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { MULTICALL3_ADDRESS } from "@/lib/contracts/multicall3";
import {
  applyBatchFailOnError,
  type BatchWriteContractCoreInput,
  type BatchWriteContractResult,
  batchWriteContractCore,
} from "./batch-write-contract-core";

export type BatchWriteContractInput = StepInput &
  BatchWriteContractCoreInput & {
    // Mirrors write-contract's failOnError. Defaults to true. See
    // applyBatchFailOnError in batch-write-contract-core.ts for exactly
    // which failures qualify to be softened.
    failOnError?: boolean;
  };

/**
 * Batch Write Contract Step
 * Sends multiple state-changing calls as a single atomic transaction via
 * Multicall3's aggregate3
 */
export async function batchWriteContractStep(
  input: BatchWriteContractInput
): Promise<BatchWriteContractResult> {
  "use step";

  // Enrich input with the Multicall3 explorer link for the execution log.
  // There is no single per-node contractAddress in this action (each call
  // targets a different contract), so the resolved chain's Multicall3
  // address is the only address worth linking here.
  const multicallAddressLink = await resolveExplorerLink(
    input.network,
    MULTICALL3_ADDRESS
  );
  const enrichedInput: BatchWriteContractInput & { multicallAddressLink?: string } =
    multicallAddressLink ? { ...input, multicallAddressLink } : input;

  return runPluginStep(
    { pluginName: "web3", actionName: "batch-write-contract" },
    enrichedInput,
    async () => {
      const result = await batchWriteContractCore(input);
      return applyBatchFailOnError(result, input.failOnError);
    }
  );
}

batchWriteContractStep.maxRetries = 0;

export const _integrationType = "web3";
