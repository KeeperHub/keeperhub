import "server-only";

import { logWarn } from "@/lib/logging";
import type { Capability } from "@/lib/policy/capabilities";
import { getContractCatalog } from "@/lib/policy/catalog/store";
import { FactState } from "@/lib/policy/constants";
import type { PolicyFacts } from "@/lib/policy/types";
import { getNetworkName } from "@/lib/rpc/network-utils";

function known<T>(fact: { state: string; value?: T } | undefined): T | null {
  return fact?.state === FactState.KNOWN ? ((fact.value as T) ?? null) : null;
}

export type ResolveCallCapabilityInput = {
  chainId: number | undefined;
  facts: PolicyFacts;
  /** Used when the call resolves to nothing the catalog can describe. */
  fallback: Capability;
};

/**
 * The capability a call actually exercises, read from the contract's own ABI.
 *
 * The alternative is to trust the action-type slug, which the workflow author
 * chose. That makes a semantic rule avoidable: "deny borrowing from a lending
 * market" binds to a node called `aave-v3/borrow` and not to a raw contract
 * write carrying the same selector, because the raw node's slug names no verb.
 *
 * Falls back rather than failing: an unverified contract, or one whose selector
 * is not in its ABI, keeps whatever the caller derived. Denying here would stop
 * work on every contract we cannot describe, which is not the guard's job.
 */
export async function resolveCallCapability(
  input: ResolveCallCapabilityInput
): Promise<Capability> {
  const address = known<string>(input.facts.contractAddress);
  const selector = known<string>(input.facts.selector);
  if (!(input.chainId && address && selector)) {
    return input.fallback;
  }

  try {
    const catalog = await getContractCatalog({
      chainId: input.chainId,
      address,
      network: getNetworkName(input.chainId),
    });
    const entry = catalog.entries.find(
      (candidate) => candidate.selector === selector.toLowerCase()
    );
    return (entry?.capability as Capability) ?? input.fallback;
  } catch (error) {
    logWarn("[PolicyCatalog] Could not resolve a capability for a call", {
      chainId: String(input.chainId),
      address,
      selector,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return input.fallback;
  }
}
