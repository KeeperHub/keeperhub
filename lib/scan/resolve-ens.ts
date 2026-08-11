import "server-only";

import { ethers } from "ethers";
import { getRpcProvider } from "@/lib/rpc/provider-factory";

/**
 * Name-shaped input guard: at least one dot, no whitespace, does not start
 * with "0x". Deliberately permissive (accepts `.eth` and any DNS-style ENS
 * name) — the resolver returns null for anything that does not actually
 * resolve, so a loose shape check just decides whether an RPC lookup is worth
 * attempting.
 */
export const ENS_NAME_REGEX = /^(?!0x)[^\s.]+(?:\.[^\s.]+)+$/i;

/** Bounded so a slow/hung ENS lookup cannot stall the scan request. */
const ENS_RESOLVE_TIMEOUT_MS = 3000;

/**
 * Resolve an ENS name to a checksummed EVM address via the Ethereum mainnet
 * RPC (ENS is an L1 registry). Returns null on any failure — an unresolvable
 * name, an RPC error, or a timeout — so callers degrade to a 400 rather than
 * hanging or leaking RPC detail.
 */
export async function resolveEnsName(name: string): Promise<string | null> {
  try {
    const rpc = await getRpcProvider({ chainId: 1 });
    const resolved = await Promise.race([
      rpc.executeWithFailover((provider: ethers.JsonRpcProvider) =>
        provider.resolveName(name)
      ),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), ENS_RESOLVE_TIMEOUT_MS);
      }),
    ]);
    if (resolved && ethers.isAddress(resolved)) {
      return ethers.getAddress(resolved);
    }
    return null;
  } catch {
    return null;
  }
}
