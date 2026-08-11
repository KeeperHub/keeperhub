/**
 * RPC Config Service - Resolves RPC configuration for users
 *
 * Priority: User preferences > Chain defaults
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  chains,
  type NewUserRpcPreference,
  type UserRpcPreference,
  userRpcPreferences,
} from "@/lib/db/schema";
import { logWarn } from "@/lib/logging";
import type { ResolvedRpcConfig } from "./types";

/**
 * Options for resolveRpcConfig.
 *
 * KEEP-137: Per-node Private Mempool toggle. When `usePrivateMempool=true` and
 * the chain supports private mempool routing (`chains.usePrivateMempoolRpc=true`
 * with a populated `defaultPrivateRpcUrl`), the primary URL is swapped to the
 * private endpoint. If `strict=true` (the default), the fallback URL is cleared so a failing
 * private endpoint does NOT silently fall back to the public mempool.
 */
export type ResolveRpcConfigOptions = {
  usePrivateMempool?: boolean;
  strict?: boolean;
};

/**
 * Resolve the RPC configuration for a specific chain and user.
 *
 * Priority: user preferences > chain defaults. When the private-mempool option
 * is set and supported, the resulting primary URL is the chain's private RPC.
 */
export async function resolveRpcConfig(
  chainId: number,
  userId?: string,
  options: ResolveRpcConfigOptions = {}
): Promise<ResolvedRpcConfig | null> {
  // Get chain defaults first
  const chainResults = await db
    .select()
    .from(chains)
    .where(and(eq(chains.chainId, chainId), eq(chains.isEnabled, true)))
    .limit(1);

  const chain = chainResults[0];
  if (!chain) {
    return null; // Chain not found or disabled
  }

  const chainCapabilities = {
    usePrivateMempoolRpc: chain.usePrivateMempoolRpc ?? false,
    privateRpcUrl: chain.defaultPrivateRpcUrl || undefined,
  };

  let baseConfig: ResolvedRpcConfig;

  // Check for user preferences if userId provided
  if (userId) {
    const prefResults = await db
      .select()
      .from(userRpcPreferences)
      .where(
        and(
          eq(userRpcPreferences.userId, userId),
          eq(userRpcPreferences.chainId, chainId)
        )
      )
      .limit(1);

    const userPref = prefResults[0];
    if (userPref) {
      baseConfig = {
        chainId: chain.chainId,
        chainName: chain.name,
        primaryRpcUrl: userPref.primaryRpcUrl,
        fallbackRpcUrl: userPref.fallbackRpcUrl || undefined,
        primaryWssUrl:
          userPref.primaryWssUrl || chain.defaultPrimaryWss || undefined,
        fallbackWssUrl:
          userPref.fallbackWssUrl || chain.defaultFallbackWss || undefined,
        ...chainCapabilities,
        source: "user",
      };
    } else {
      baseConfig = buildDefaultConfig(chain, chainCapabilities);
    }
  } else {
    baseConfig = buildDefaultConfig(chain, chainCapabilities);
  }

  return applyPrivateMempoolSwap(baseConfig, options);
}

type ChainRow = typeof chains.$inferSelect;
type ChainCapabilities = {
  usePrivateMempoolRpc: boolean;
  privateRpcUrl?: string;
};

function buildDefaultConfig(
  chain: ChainRow,
  capabilities: ChainCapabilities
): ResolvedRpcConfig {
  return {
    chainId: chain.chainId,
    chainName: chain.name,
    primaryRpcUrl: chain.defaultPrimaryRpc,
    fallbackRpcUrl: chain.defaultFallbackRpc || undefined,
    primaryWssUrl: chain.defaultPrimaryWss || undefined,
    fallbackWssUrl: chain.defaultFallbackWss || undefined,
    ...capabilities,
    source: "default",
  };
}

/**
 * Apply the private-mempool URL swap when requested and supported.
 *
 * When the chain does not support private mempool but the flag is set, we log
 * a warning and proceed with the public mempool URL. This is a defense-in-depth
 * path: the UI is expected to hide the toggle on unsupported chains, so reaching
 * this branch usually indicates config drift (e.g. the flag was disabled on the
 * chain row after a workflow was saved).
 */
function applyPrivateMempoolSwap(
  baseConfig: ResolvedRpcConfig,
  options: ResolveRpcConfigOptions
): ResolvedRpcConfig {
  if (!options.usePrivateMempool) {
    return baseConfig;
  }

  if (!(baseConfig.usePrivateMempoolRpc && baseConfig.privateRpcUrl)) {
    logWarn(
      `[rpc-config] Private mempool requested for chain ${baseConfig.chainId} ` +
        "but chain does not support it; proceeding with public mempool"
    );
    return baseConfig;
  }

  // Strict (default): clear the fallback entirely so a failing private RPC
  // does NOT silently fall back to the public mempool, preserving MEV protection.
  // Non-strict: keep the public primary as fallback (user accepts MEV risk on failure).
  const strict = options.strict ?? true;
  return {
    ...baseConfig,
    primaryRpcUrl: baseConfig.privateRpcUrl,
    fallbackRpcUrl: strict ? undefined : baseConfig.primaryRpcUrl,
    // Only reached when the swap actually happened: the node asked for the
    // private mempool and the chain had a relay to route to. We configure that
    // pointer but do not run the node behind it.
    primaryIsPrivateRelay: true,
  };
}

/**
 * Get all RPC configs for a user (with defaults for chains without preferences)
 */
export async function resolveAllRpcConfigs(
  userId?: string
): Promise<ResolvedRpcConfig[]> {
  // Get all enabled chains
  const enabledChains = await db
    .select()
    .from(chains)
    .where(eq(chains.isEnabled, true));

  // Get user preferences if userId provided
  const userPrefs: UserRpcPreference[] = userId
    ? await db
        .select()
        .from(userRpcPreferences)
        .where(eq(userRpcPreferences.userId, userId))
    : [];

  // Build a map of user preferences by chainId
  const prefsByChain = new Map(userPrefs.map((p) => [p.chainId, p]));

  // Resolve configs for all chains
  return enabledChains.map((chain) => {
    const userPref = prefsByChain.get(chain.chainId);
    const capabilities = {
      usePrivateMempoolRpc: chain.usePrivateMempoolRpc ?? false,
      privateRpcUrl: chain.defaultPrivateRpcUrl || undefined,
    };

    if (userPref) {
      return {
        chainId: chain.chainId,
        chainName: chain.name,
        primaryRpcUrl: userPref.primaryRpcUrl,
        fallbackRpcUrl: userPref.fallbackRpcUrl || undefined,
        primaryWssUrl:
          userPref.primaryWssUrl || chain.defaultPrimaryWss || undefined,
        fallbackWssUrl:
          userPref.fallbackWssUrl || chain.defaultFallbackWss || undefined,
        ...capabilities,
        source: "user" as const,
      };
    }

    return {
      chainId: chain.chainId,
      chainName: chain.name,
      primaryRpcUrl: chain.defaultPrimaryRpc,
      fallbackRpcUrl: chain.defaultFallbackRpc || undefined,
      primaryWssUrl: chain.defaultPrimaryWss || undefined,
      fallbackWssUrl: chain.defaultFallbackWss || undefined,
      ...capabilities,
      source: "default" as const,
    };
  });
}

/**
 * Get user's RPC preferences
 */
export async function getUserRpcPreferences(
  userId: string
): Promise<UserRpcPreference[]> {
  return await db
    .select()
    .from(userRpcPreferences)
    .where(eq(userRpcPreferences.userId, userId));
}

/**
 * Set or update user's RPC preference for a chain
 */
export async function setUserRpcPreference(
  userId: string,
  chainId: number,
  primaryRpcUrl: string,
  fallbackRpcUrl?: string
): Promise<UserRpcPreference> {
  // Check if preference already exists
  const existing = await db
    .select()
    .from(userRpcPreferences)
    .where(
      and(
        eq(userRpcPreferences.userId, userId),
        eq(userRpcPreferences.chainId, chainId)
      )
    )
    .limit(1);

  if (existing[0]) {
    // Update existing
    const results = await db
      .update(userRpcPreferences)
      .set({
        primaryRpcUrl,
        fallbackRpcUrl: fallbackRpcUrl || null,
        updatedAt: new Date(),
      })
      .where(eq(userRpcPreferences.id, existing[0].id))
      .returning();

    return results[0];
  }

  // Insert new
  const values: NewUserRpcPreference = {
    userId,
    chainId,
    primaryRpcUrl,
    fallbackRpcUrl: fallbackRpcUrl || null,
  };

  const results = await db
    .insert(userRpcPreferences)
    .values(values)
    .returning();

  return results[0];
}

/**
 * Delete user's RPC preference for a chain (reverts to defaults)
 */
export async function deleteUserRpcPreference(
  userId: string,
  chainId: number
): Promise<boolean> {
  const result = await db
    .delete(userRpcPreferences)
    .where(
      and(
        eq(userRpcPreferences.userId, userId),
        eq(userRpcPreferences.chainId, chainId)
      )
    )
    .returning();

  return result.length > 0;
}
