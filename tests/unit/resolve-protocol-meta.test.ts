/**
 * resolveProtocolMeta, with the chain-scoped aliases for the action slugs the
 * wstETH/sUSDS L2 split renamed.
 *
 * The split moved the two working ERC-20 reads on each bridged token from the
 * full-ABI contract key to a read-only `*L2` key under a `-l2` slug, because
 * the bridged tokens implement the ERC-20 surface only. A workflow saved
 * against an old slug would otherwise fail its next run on the L2 with
 * `contract "sUsds" is not deployed on network "8453"` - the capability
 * survives, the identifier does not. These cases pin both halves of that: the
 * old slug resolves to the L2 contract on the renamed chains, and it still
 * resolves to the mainnet contract everywhere the full ABI is implemented.
 */
import { describe, expect, it } from "vitest";
import "@/protocols";
import { getProtocol } from "@/lib/protocol-registry";
import {
  L2_RENAMED_ACTIONS,
  resolveProtocolMeta,
} from "@/plugins/protocol/steps/resolve-protocol-meta";

describe("resolveProtocolMeta: L2 slug aliases", () => {
  const cases = [
    {
      actionType: "sky/vault-balance",
      network: "8453",
      contractKey: "sUsdsL2",
      functionName: "balanceOf",
    },
    {
      actionType: "sky/vault-balance",
      network: "42161",
      contractKey: "sUsdsL2",
      functionName: "balanceOf",
    },
    {
      actionType: "sky/vault-total-supply",
      network: "8453",
      contractKey: "sUsdsL2",
      functionName: "totalSupply",
    },
    {
      actionType: "sky/vault-total-supply",
      network: "42161",
      contractKey: "sUsdsL2",
      functionName: "totalSupply",
    },
    {
      actionType: "lido/get-wsteth-balance",
      network: "8453",
      contractKey: "wstethL2",
      functionName: "balanceOf",
    },
    {
      actionType: "lido/get-wsteth-total-supply",
      network: "8453",
      contractKey: "wstethL2",
      functionName: "totalSupply",
    },
  ] as const;

  for (const c of cases) {
    it(`${c.actionType} on ${c.network} resolves to ${c.contractKey}`, () => {
      expect(
        resolveProtocolMeta({ _actionType: c.actionType, network: c.network })
      ).toEqual({
        protocolSlug: c.actionType.split("/")[0],
        contractKey: c.contractKey,
        functionName: c.functionName,
        actionType: "read",
      });
    });
  }

  // The old slugs are not dead: they name the full-ABI contract, which is
  // implemented on mainnet and (for wstETH) Sepolia. An alias that fired
  // there would silently re-point working mainnet workflows at a contract
  // key that carries no mainnet address.
  const unaliased = [
    { actionType: "sky/vault-balance", network: "1", contractKey: "sUsds" },
    {
      actionType: "sky/vault-total-supply",
      network: "1",
      contractKey: "sUsds",
    },
    {
      actionType: "lido/get-wsteth-balance",
      network: "1",
      contractKey: "wsteth",
    },
    {
      actionType: "lido/get-wsteth-balance",
      network: "11155111",
      contractKey: "wsteth",
    },
    {
      actionType: "lido/get-wsteth-total-supply",
      network: "11155111",
      contractKey: "wsteth",
    },
    // Arbitrum is not one of wstETH's renamed chains: no wstethL2 address
    // exists there, so the old slug must stay on the mainnet key and fail
    // loudly rather than be redirected to a contract with no address either.
    {
      actionType: "lido/get-wsteth-balance",
      network: "42161",
      contractKey: "wsteth",
    },
  ] as const;

  for (const c of unaliased) {
    it(`${c.actionType} on ${c.network} stays on ${c.contractKey}`, () => {
      expect(
        resolveProtocolMeta({ _actionType: c.actionType, network: c.network })
          ?.contractKey
      ).toBe(c.contractKey);
    });
  }

  it("leaves slugs the split did not rename alone on the renamed chains", () => {
    // Only the two ERC-20 reads moved. The ERC-4626 slugs revert on the
    // bridged contract, so they must keep naming the mainnet key and keep
    // failing on Base instead of being quietly redirected.
    expect(
      resolveProtocolMeta({ _actionType: "sky/vault-deposit", network: "8453" })
        ?.contractKey
    ).toBe("sUsds");
    expect(
      resolveProtocolMeta({ _actionType: "lido/wrap", network: "8453" })
        ?.contractKey
    ).toBe("wsteth");
  });

  it("applies no alias when the caller passes no network", () => {
    // Callers that only need the action's identity (workflow-server's
    // write-node classification) have no chain in hand.
    expect(resolveProtocolMeta({ _actionType: "sky/vault-balance" })).toEqual({
      protocolSlug: "sky",
      contractKey: "sUsds",
      functionName: "balanceOf",
      actionType: "read",
    });
  });

  it("falls back to _protocolMeta for an unregistered action type", () => {
    expect(
      resolveProtocolMeta({
        _actionType: "sky/no-such-action",
        network: "8453",
        _protocolMeta: JSON.stringify({
          protocolSlug: "sky",
          contractKey: "sUsds",
          functionName: "balanceOf",
          actionType: "read",
        }),
      })
    ).toEqual({
      protocolSlug: "sky",
      contractKey: "sUsds",
      functionName: "balanceOf",
      actionType: "read",
    });
  });
});

describe("resolveProtocolMeta: the alias table matches the registry", () => {
  // The table is prose about the registry, the same class of claim as a
  // testData skip reason. Pin it: an entry that outlives the rename it
  // describes, or names a chain the replacement does not cover, fails here
  // rather than silently redirecting to a contract with no address.
  for (const [actionType, rename] of Object.entries(L2_RENAMED_ACTIONS)) {
    it(`${actionType} -> ${rename.slug} on ${rename.chainIds.join("/")}`, () => {
      const [protocolSlug, oldSlug] = actionType.split("/");
      const protocol = getProtocol(protocolSlug ?? "");
      if (!protocol) {
        throw new Error(`${actionType} names no registered protocol`);
      }
      const from = protocol.actions.find((a) => a.slug === oldSlug);
      const to = protocol.actions.find((a) => a.slug === rename.slug);
      if (!from) {
        throw new Error(`${actionType} names no registered action`);
      }
      if (!to) {
        throw new Error(
          `${protocolSlug}/${rename.slug} names no registered action`
        );
      }

      // Same selector, same direction, same scaling: the alias is a rename,
      // so a redirected workflow must read exactly what it read before.
      // Asserted on a non-empty decimals list, so an action that lost its
      // outputs cannot satisfy this by comparing two empty arrays.
      expect(to.function).toBe(from.function);
      expect(to.type).toBe(from.type);
      const fromOutputs = from.outputs ?? [];
      const toOutputs = to.outputs ?? [];
      const fromDecimals = fromOutputs.map((o) => o.decimals);
      expect(fromDecimals).toEqual([18]);
      expect(toOutputs.map((o) => o.decimals)).toEqual(fromDecimals);

      for (const chainId of rename.chainIds) {
        expect(
          protocol.contracts[from.contract]?.addresses[chainId],
          `${actionType} is aliased on chain ${chainId}, but ${from.contract} resolves there - the old slug works and the alias must go`
        ).toBeUndefined();
        expect(
          protocol.contracts[to.contract]?.addresses[chainId],
          `${protocolSlug}/${rename.slug} has no address on chain ${chainId}, so the alias redirects to another dead end`
        ).toBeDefined();
      }
    });
  }
});
