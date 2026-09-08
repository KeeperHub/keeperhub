import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { withStepValueCap } from "@/lib/execute/value-ledger";
import { resolveExplorerLink } from "@/lib/web3/explorer-link";
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
  const recipientAddressLink = await resolveExplorerLink(
    input.network,
    input.recipientAddress
  );
  const enrichedInput: TransferFundsInput & { recipientAddressLink?: string } =
    recipientAddressLink ? { ...input, recipientAddressLink } : input;

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
