import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { getAddressUrl, getTransactionUrl } from "@/lib/explorer";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";

/**
 * Enrich trigger data with block explorer links for transaction hashes
 * and addresses. Returns the mutated triggerData object with
 * `transactionLink` and/or `addressLink` fields added when available.
 */
export async function enrichExplorerLinks(
  triggerData: Record<string, unknown>,
  network: string | number
): Promise<void> {
  "use step";
  const chainId = getChainIdFromNetwork(network);
  const explorerConfig = await db.query.explorerConfigs.findFirst({
    where: eq(explorerConfigs.chainId, chainId),
  });

  if (!explorerConfig) {
    return;
  }

  if (typeof triggerData.transactionHash === "string") {
    triggerData.transactionLink = getTransactionUrl(
      explorerConfig,
      triggerData.transactionHash
    );
  }
  if (typeof triggerData.address === "string") {
    triggerData.addressLink = getAddressUrl(
      explorerConfig,
      triggerData.address
    );
  }
}

enrichExplorerLinks.maxRetries = 0;
