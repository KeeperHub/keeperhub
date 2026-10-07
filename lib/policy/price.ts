import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { supportedTokens } from "@/lib/db/schema";
import { logWarn } from "@/lib/logging";
import { FactProvenance, FactState } from "@/lib/policy/constants";
import type { AssetFact, PolicyFacts } from "@/lib/policy/types";
import { weiToUsd } from "@/lib/safe/price-oracle";
import { resolveUsdPrice } from "@/lib/scan/price";

/**
 * Price the native value a node moves, in dollars.
 *
 * Kept out of `extractFacts` because that is a pure function and pricing is a
 * network read. The result is marked authoritative: it comes from the oracle,
 * never from anything the workflow said about itself, which is what stops a
 * dollar ceiling being set by whoever controls an upstream node's output.
 *
 * When no price is available the fact stays unknown, so a dollar limit refuses
 * rather than passing on a number nobody established.
 */
/**
 * What a token amount is worth, from the token's own decimals and a price.
 *
 * Decimals come from the supported-token table rather than from the workflow,
 * for the same reason the price does: a figure the caller supplies is a figure
 * the caller controls. A token we do not carry, or one nothing will price,
 * yields nothing, and the dollar limit that needed it refuses.
 */
async function priceAssets(
  assets: readonly AssetFact[],
  chainId: number
): Promise<string | null> {
  const addresses = assets
    .map((a) => a.address?.toLowerCase())
    .filter((a): a is string => Boolean(a));
  if (addresses.length === 0) {
    return null;
  }

  const rows = await db
    .select({
      tokenAddress: supportedTokens.tokenAddress,
      symbol: supportedTokens.symbol,
      decimals: supportedTokens.decimals,
    })
    .from(supportedTokens)
    .where(
      and(
        eq(supportedTokens.chainId, chainId),
        inArray(supportedTokens.tokenAddress, addresses)
      )
    );

  const known = new Map(rows.map((r) => [r.tokenAddress.toLowerCase(), r]));

  let total = 0;
  for (const asset of assets) {
    const address = asset.address?.toLowerCase();
    if (!(address && asset.amount)) {
      return null;
    }
    const meta = known.get(address);
    if (!meta) {
      // Priced from a decimals figure we did not establish would be a
      // confident wrong number, which is worse than refusing.
      return null;
    }
    const price = await resolveUsdPrice(chainId, address, meta.symbol);
    if (price === null) {
      return null;
    }
    total += (Number(asset.amount) / 10 ** meta.decimals) * price;
  }
  return total.toString();
}

export async function withUsdValue(
  facts: PolicyFacts,
  chainId: number | undefined
): Promise<PolicyFacts> {
  if (chainId === undefined) {
    return facts;
  }

  // A token amount is the ordinary case. Pricing only native value left every
  // dollar limit counting ether and ignoring the stablecoin beside it.
  if (facts.assets.state === FactState.KNOWN) {
    try {
      const usd = await priceAssets(facts.assets.value, chainId);
      if (usd !== null) {
        return {
          ...facts,
          usdValue: {
            state: FactState.KNOWN,
            value: usd,
            provenance: FactProvenance.AUTHORITATIVE,
          },
        };
      }
    } catch (error) {
      logWarn("[PolicyPrice] Could not price a token amount", {
        chainId: String(chainId),
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  const native = facts.nativeValueWei;
  if (native.state !== FactState.KNOWN) {
    return facts;
  }

  try {
    const usd = await weiToUsd({
      chainId,
      amountWei: BigInt(native.value),
    });
    if (usd === null) {
      return facts;
    }
    return {
      ...facts,
      usdValue: {
        state: FactState.KNOWN,
        value: usd.toString(),
        provenance: FactProvenance.AUTHORITATIVE,
      },
    };
  } catch (error) {
    logWarn("[PolicyPrice] Could not price a native amount", {
      chainId: String(chainId),
      reason: error instanceof Error ? error.message : "unknown",
    });
    return facts;
  }
}
