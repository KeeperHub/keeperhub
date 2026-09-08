import "server-only";

import { resolveExplorerLink } from "@/lib/web3/explorer-link";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import type {
  ApproveTokenCoreInput,
  ApproveTokenResult,
} from "./approve-token-core";
import { approveTokenCore } from "./approve-token-core";

export type {
  ApproveTokenCoreInput,
  ApproveTokenResult,
} from "./approve-token-core";

export type ApproveTokenInput = StepInput & ApproveTokenCoreInput;

/**
 * Approve Token Step
 * Calls ERC20 approve(spender, amount) to grant spending permission on the selected token
 */
export async function approveTokenStep(
  input: ApproveTokenInput
): Promise<ApproveTokenResult> {
  "use step";

  const spenderAddressLink = await resolveExplorerLink(
    input.network,
    input.spenderAddress
  );
  const enrichedInput: ApproveTokenInput & { spenderAddressLink?: string } =
    spenderAddressLink ? { ...input, spenderAddressLink } : input;

  return withStepLogging(enrichedInput, () => approveTokenCore(input));
}

approveTokenStep.maxRetries = 0;

export const _integrationType = "web3";
