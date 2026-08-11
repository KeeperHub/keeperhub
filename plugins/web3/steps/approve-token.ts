import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { getAddressUrl } from "@/lib/explorer";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
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

  let enrichedInput: ApproveTokenInput & { spenderAddressLink?: string } =
    input;
  try {
    const chainId = getChainIdFromNetwork(input.network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    if (explorerConfig) {
      const spenderAddressLink = getAddressUrl(
        explorerConfig,
        input.spenderAddress
      );
      if (spenderAddressLink) {
        enrichedInput = { ...input, spenderAddressLink };
      }
    }
  } catch {
    // Non-critical: if lookup fails, input logs without the link
  }

  return withStepLogging(enrichedInput, () => approveTokenCore(input));
}

approveTokenStep.maxRetries = 0;

export const _integrationType = "web3";
