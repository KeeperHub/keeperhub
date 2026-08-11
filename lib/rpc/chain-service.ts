/**
 * Chain Service - CRUD operations for blockchain chains
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { type Chain, chains, type NewChain } from "@/lib/db/schema";

/**
 * Get all enabled chains
 */
export async function getEnabledChains(): Promise<Chain[]> {
  return await db.select().from(chains).where(eq(chains.isEnabled, true));
}

/**
 * Get all chains (including disabled)
 */
export async function getAllChains(): Promise<Chain[]> {
  return await db.select().from(chains);
}

/**
 * Get a chain by its numeric chain ID
 */
export async function getChainByChainId(
  chainId: number
): Promise<Chain | null> {
  const results = await db
    .select()
    .from(chains)
    .where(eq(chains.chainId, chainId))
    .limit(1);

  return results[0] || null;
}

/**
 * Get a chain by its internal ID
 */
export async function getChainById(id: string): Promise<Chain | null> {
  const results = await db
    .select()
    .from(chains)
    .where(eq(chains.id, id))
    .limit(1);

  return results[0] || null;
}

/**
 * Create a new chain (admin only)
 */
export async function createChain(chain: NewChain): Promise<Chain> {
  const results = await db.insert(chains).values(chain).returning();
  return results[0];
}

/**
 * Update a chain (admin only)
 */
export async function updateChain(
  chainId: number,
  updates: Partial<Omit<NewChain, "chainId">>
): Promise<Chain | null> {
  const results = await db
    .update(chains)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(chains.chainId, chainId))
    .returning();

  return results[0] || null;
}

/**
 * Enable or disable a chain
 */
export async function setChainEnabled(
  chainId: number,
  enabled: boolean
): Promise<Chain | null> {
  return await updateChain(chainId, { isEnabled: enabled });
}
