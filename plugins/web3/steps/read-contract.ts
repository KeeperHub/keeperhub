import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { getAddressUrl } from "@/lib/explorer";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import {
  type ReadContractCoreInput,
  type ReadContractResult,
  readContractCore,
} from "./read-contract-core";

export type ReadContractInput = StepInput & ReadContractCoreInput;

/**
 * Read Contract Step
 * Reads data from a smart contract using view/pure functions
 */
export async function readContractStep(
  input: ReadContractInput
): Promise<ReadContractResult> {
  "use step";

  // Enrich input with contract address explorer link for the execution log
  let enrichedInput: ReadContractInput & { contractAddressLink?: string } =
    input;
  try {
    const chainId = getChainIdFromNetwork(input.network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    if (explorerConfig) {
      const contractAddressLink = getAddressUrl(
        explorerConfig,
        input.contractAddress
      );
      if (contractAddressLink) {
        enrichedInput = { ...input, contractAddressLink };
      }
    }
  } catch {
    // Non-critical: if lookup fails, input logs without the link
  }

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "read-contract",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(enrichedInput, () => readContractCore(input))
  );
}

readContractStep.maxRetries = 0;

export const _integrationType = "web3";
