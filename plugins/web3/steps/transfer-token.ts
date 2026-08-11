import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { getAddressUrl } from "@/lib/explorer";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
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

  let enrichedInput: TransferTokenInput & { recipientAddressLink?: string } =
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

  return withStepLogging(enrichedInput, () => transferTokenCore(input));
}

transferTokenStep.maxRetries = 0;

export const _integrationType = "web3";
