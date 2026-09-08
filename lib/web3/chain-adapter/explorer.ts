import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import {
  getAddressUrl as buildAddressUrl,
  getTransactionUrl as buildTransactionUrl,
} from "@/lib/explorer";

// Cache of loaded explorer configurations by chainId
const cache = new Map<number, typeof explorerConfigs.$inferSelect | null>();

/**
 * Reset the static explorer configuration cache. Used primarily for unit tests.
 */
export function clearExplorerConfigCache(): void {
  cache.clear();
}

/**
 * Retrieve explorer configuration for a given chainId. Checks cache first.
 */
export async function getExplorerConfigForChain(
  chainId: number
): Promise<typeof explorerConfigs.$inferSelect | undefined> {
  if (cache.has(chainId)) {
    return cache.get(chainId) ?? undefined;
  }

  const config = await db.query.explorerConfigs.findFirst({
    where: eq(explorerConfigs.chainId, chainId),
  });

  cache.set(chainId, config ?? null);
  return config ?? undefined;
}

/**
 * Format a transaction link for the specified chain.
 */
export async function buildChainTransactionUrl(
  chainId: number,
  txHash: string
): Promise<string> {
  const config = await getExplorerConfigForChain(chainId);
  if (!config) {
    return "";
  }
  return buildTransactionUrl(config, txHash);
}

/**
 * Format an address link for the specified chain.
 */
export async function buildChainAddressUrl(
  chainId: number,
  address: string
): Promise<string> {
  const config = await getExplorerConfigForChain(chainId);
  if (!config) {
    return "";
  }
  return buildAddressUrl(config, address);
}
