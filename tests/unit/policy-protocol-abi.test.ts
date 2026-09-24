import { describe, expect, it, vi } from "vitest";

// The registry lookup is a server module; the stub lets it load under vitest.
vi.mock("server-only", () => ({}));

import "@/protocols";
import { deriveContractCatalog } from "@/lib/policy/catalog/derive";
import { declaredContract } from "@/lib/policy/catalog/protocol-abi";
import { getRegisteredProtocols } from "@/lib/protocol-registry";

type Deployment = { chainId: number; address: string; label: string };

function deployments(): Deployment[] {
  const out: Deployment[] = [];
  for (const protocol of getRegisteredProtocols()) {
    for (const contract of Object.values(protocol.contracts)) {
      for (const [chainId, address] of Object.entries(
        contract.addresses ?? {}
      )) {
        out.push({
          chainId: Number(chainId),
          address,
          label: `${protocol.name} / ${contract.label}`,
        });
      }
    }
  }
  return out;
}

describe("the ABIs this platform already ships", () => {
  const all = deployments();

  it("covers every registered deployment", () => {
    // The explorer answers only for a verified contract, so without this a
    // protocol described here in full would still be reported as having no
    // published ABI and the builder would offer no functions for it.
    const missing = all.filter(
      (d) => declaredContract(d.chainId, d.address) === null
    );
    expect(missing.map((d) => d.label)).toEqual([]);
  });

  it("finds a contract however its address is cased", () => {
    const [first] = all;
    expect(
      declaredContract(first.chainId, first.address.toUpperCase())
    ).not.toBeNull();
    expect(
      declaredContract(first.chainId, first.address.toLowerCase())
    ).not.toBeNull();
  });

  it("does not answer for an address it does not describe", () => {
    expect(
      declaredContract(8453, "0x0000000000000000000000000000000000000001")
    ).toBeNull();
  });

  it("does not answer for the right address on the wrong chain", () => {
    const [first] = all;
    // Chain 1337 is a local devnet id no registry entry uses.
    expect(declaredContract(1337, first.address)).toBeNull();
  });

  it("yields functions the builder can offer", () => {
    let functions = 0;
    for (const deployment of all) {
      const declared = declaredContract(deployment.chainId, deployment.address);
      if (!declared) {
        continue;
      }
      functions += deriveContractCatalog({
        chainId: deployment.chainId,
        address: deployment.address,
        abi: JSON.parse(declared.abi),
      }).entries.length;
    }
    expect(functions).toBeGreaterThan(0);
  });
});
