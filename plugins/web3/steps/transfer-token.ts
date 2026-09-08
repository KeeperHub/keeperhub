import "server-only";

import { resolveExplorerLink } from "@/lib/web3/explorer-link";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import type {
  TransferTokenCoreInput,
  TransferTokenResult,
} from "./transfer-token-core";
import { transferTokenCore } from "./transfer-token-core";

export type {
  TransferTokenCoreInput,
  TransferTokenResult,
} from "./transfer-token-core";

export type TransferTokenInput = StepInput & TransferTokenCoreInput;

/**
 * Transfer Token Step
 * Transfers ERC20 tokens from the organization wallet to a recipient address
 */
export async function transferTokenStep(
  input: TransferTokenInput
): Promise<TransferTokenResult> {
  "use step";

  const recipientAddressLink = await resolveExplorerLink(
    input.network,
    input.recipientAddress
  );
  const enrichedInput: TransferTokenInput & { recipientAddressLink?: string } =
    recipientAddressLink ? { ...input, recipientAddressLink } : input;

  return withStepLogging(enrichedInput, () => transferTokenCore(input));
}

transferTokenStep.maxRetries = 0;

export const _integrationType = "web3";
