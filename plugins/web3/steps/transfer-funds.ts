import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { getAddressUrl } from "@/lib/explorer";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { withStepValueCap } from "@/lib/execute/value-ledger";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import type {
  TransferFundsCoreInput,
  TransferFundsResult,
} from "./transfer-funds-core";
import { transferFundsCore } from "./transfer-funds-core";

export type {
  TransferFundsCoreInput,
  TransferFundsResult,
} from "./transfer-funds-core";

export type TransferFundsInput = StepInput & TransferFundsCoreInput;

/**
 * Transfer Funds Step
 * Transfers ETH from the user's wallet to a recipient address
 */
export async function transferFundsStep(
  input: TransferFundsInput
): Promise<TransferFundsResult> {
  "use step";

  // Enrich input with recipient address explorer link for the execution log
  let enrichedInput: TransferFundsInput & { recipientAddressLink?: string } =
    input;
  try {
    const chainId = getChainIdFromNetwork(input.network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    if (explorerConfig) {
      const recipientAddressLink = getAddressUrl(
        explorerConfig,
        input.recipientAddress
      );
      if (recipientAddressLink) {
        enrichedInput = { ...input, recipientAddressLink };
      }
    }
  } catch {
    // Non-critical: if lookup fails, input logs without the link
  }

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "transfer-funds",
      executionId: input._context?.executionId,
    },
    () =>
      withStepLogging(enrichedInput, () =>
        withStepValueCap(
          {
            organizationId: input._context?.organizationId,
            stepFunction: "transferFundsStep",
            config: { network: input.network, amount: input.amount },
            executionId: input._context?.executionId,
            valueCapReserved: input._context?.valueCapReserved,
          },
          () => transferFundsCore(input)
        )
      )
  );
}

transferFundsStep.maxRetries = 0;

export const _integrationType = "web3";
