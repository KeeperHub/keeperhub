import "server-only";
import { and, eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { createPublicClient, http } from "viem";
import { db } from "@/lib/db";
import { gasSponsorshipDelegations } from "@/lib/db/schema-extensions";
import { getSimpleAccount7702Address } from "@/lib/web3/pimlico-config";

/**
 * Check if an EOA already has EIP-7702 delegation active on a given chain.
 * Looks at on-chain code at the EOA address -- if bytecode exists,
 * the delegation is already in place.
 */
async function checkOnChainDelegation(
  rpcUrl: string,
  walletAddress: Address
): Promise<boolean> {
  const client = createPublicClient({
    transport: http(rpcUrl),
  });

  const code = await client.getCode({ address: walletAddress });
  // EIP-7702 delegated EOAs have a small delegation designator bytecode
  return code !== undefined && code !== "0x";
}

/**
 * Check if we have a DB record of a successful delegation for this org+chain.
 */
async function checkDbDelegation(
  organizationId: string,
  chainId: number
): Promise<boolean> {
  const records = await db
    .select()
    .from(gasSponsorshipDelegations)
    .where(
      and(
        eq(gasSponsorshipDelegations.organizationId, organizationId),
        eq(gasSponsorshipDelegations.chainId, chainId),
        eq(gasSponsorshipDelegations.status, "active")
      )
    )
    .limit(1);

  return records.length > 0;
}

/**
 * Record the EIP-7702 delegation in the database if not already tracked.
 *
 * EIP-7702 delegation is handled inline by permissionless.js -- it attaches
 * the authorization to the first UserOperation when the account isn't yet
 * delegated. This function checks on-chain state after the fact and records
 * it in our DB for fast lookups.
 *
 * This is safe to call concurrently and non-blocking (fire-and-forget).
 */
export async function recordDelegationIfNeeded(
  organizationId: string,
  chainId: number,
  rpcUrl: string,
  walletAddress: Address
): Promise<void> {
  const hasDbRecord = await checkDbDelegation(organizationId, chainId);
  if (hasDbRecord) {
    return;
  }

  const hasOnChainDelegation = await checkOnChainDelegation(
    rpcUrl,
    walletAddress
  );

  if (hasOnChainDelegation) {
    await recordDelegation(
      organizationId,
      walletAddress,
      chainId,
      "0x" as Hex,
      "active"
    );
  }
}

async function recordDelegation(
  organizationId: string,
  walletAddress: Address,
  chainId: number,
  delegationTxHash: Hex,
  status: string
): Promise<void> {
  await db
    .insert(gasSponsorshipDelegations)
    .values({
      organizationId,
      walletAddress,
      chainId,
      delegationTxHash,
      implementationAddress: getSimpleAccount7702Address(),
      status,
      delegatedAt: new Date(),
    })
    .onConflictDoNothing();
}
