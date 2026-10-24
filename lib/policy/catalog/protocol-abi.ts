import "server-only";

import "@/protocols";
import { getRegisteredProtocols } from "@/lib/protocol-registry";

export type DeclaredContract = {
  protocolSlug: string;
  label: string;
  abi: string;
};

let index: Map<string, DeclaredContract> | null = null;

function key(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/**
 * Every contract the protocol registry describes, by chain and address.
 *
 * Built once. The registry is static, so rebuilding it per request would cost
 * the same work for the same answer.
 */
function build(): Map<string, DeclaredContract> {
  const map = new Map<string, DeclaredContract>();
  for (const protocol of getRegisteredProtocols()) {
    for (const contract of Object.values(protocol.contracts)) {
      if (!contract.abi) {
        continue;
      }
      for (const [chainId, address] of Object.entries(
        contract.addresses ?? {}
      )) {
        const id = Number(chainId);
        if (!(Number.isInteger(id) && address)) {
          continue;
        }
        map.set(key(id, address), {
          protocolSlug: protocol.slug,
          label: contract.label,
          abi: contract.abi,
        });
      }
    }
  }
  return map;
}

/**
 * The ABI this platform already ships for a contract, if it ships one.
 *
 * Preferred over the block explorer, and not merely as an optimisation. The
 * explorer answers only for a verified contract, so without this a protocol we
 * describe in full would still be reported as having no published ABI, and the
 * builder would offer no functions for a contract whose functions are the
 * reason it is in the registry at all.
 */
export function declaredContract(
  chainId: number,
  address: string
): DeclaredContract | null {
  if (!index) {
    index = build();
  }
  return index.get(key(chainId, address)) ?? null;
}
