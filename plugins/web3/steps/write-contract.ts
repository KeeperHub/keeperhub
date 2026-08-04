import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { getAddressUrl } from "@/lib/explorer";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { withStepValueCap } from "@/lib/execute/value-ledger";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import {
  type WriteContractCoreInput,
  type WriteContractResult,
  writeContractCore,
} from "./write-contract-core";

export type WriteContractInput = StepInput & WriteContractCoreInput;

/**
 * Write Contract Step
 * Writes data to a smart contract using state-changing functions
 */
export async function writeContractStep(
  input: WriteContractInput
): Promise<WriteContractResult> {
  "use step";

  // Enrich input with contract address explorer link for the execution log
  let enrichedInput: WriteContractInput & { contractAddressLink?: string } =
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
      actionName: "write-contract",
      executionId: input._context?.executionId,
    },
    () =>
      withStepLogging(enrichedInput, () =>
        withStepValueCap(
          {
            organizationId: input._context?.organizationId,
            stepFunction: "writeContractStep",
            config: { ethValue: input.ethValue },
            executionId: input._context?.executionId,
            valueCapReserved: input._context?.valueCapReserved,
          },
          () => writeContractCore(input)
        )
      )
  );
}

writeContractStep.maxRetries = 0;

export const _integrationType = "web3";
