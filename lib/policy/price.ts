import "server-only";

import { logWarn } from "@/lib/logging";
import { FactProvenance, FactState } from "@/lib/policy/constants";
import type { PolicyFacts } from "@/lib/policy/types";
import { weiToUsd } from "@/lib/safe/price-oracle";

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
export async function withUsdValue(
  facts: PolicyFacts,
  chainId: number | undefined
): Promise<PolicyFacts> {
  const native = facts.nativeValueWei;
  if (native.state !== FactState.KNOWN || chainId === undefined) {
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
