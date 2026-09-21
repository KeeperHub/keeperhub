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
import {
  L2_RENAMED_ACTIONS,
  resolveRenamedAction,
} from "@/lib/protocol-action-aliases";
import {
  getProtocol,
  type ProtocolAction,
  type ProtocolDefinition,
  protocolActionToPluginAction,
} from "@/lib/protocol-registry";
import { resolveProtocolMeta } from "@/plugins/protocol/steps/resolve-protocol-meta";

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

      // Same argument names, in the same order. protocol-read.ts builds the
      // call args by reading `input[inp.name]` off the node config for each
      // input of the resolved action, so a renamed parameter binds "" and the
      // read silently queries the zero address instead of the user's wallet.
      // The redirect is only argument-compatible because both sides call the
      // parameter `account`; nothing but this assertion keeps it that way.
      expect(to.inputs.map((i) => i.name)).toEqual(
        from.inputs.map((i) => i.name)
      );
      // Same output names: the redirected node's downstream template
      // references ({{@node.balance}}) resolve by name, so a renamed output
      // breaks every consumer of an aliased node.
      expect(toOutputs.map((o) => o.name)).toEqual(
        fromOutputs.map((o) => o.name)
      );

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

      // Completeness, not just correctness. The loop above only inspects the
      // chains the entry already lists, so adding an Optimism address to
      // sUsdsL2 would leave sky/vault-balance broken there with this suite
      // green. chainIds must be the whole derived set: every chain the
      // replacement contract covers and the declared one does not.
      const derived = Object.keys(
        protocol.contracts[to.contract]?.addresses ?? {}
      ).filter(
        (chainId) =>
          protocol.contracts[from.contract]?.addresses[chainId] === undefined
      );
      expect(
        [...rename.chainIds].sort(),
        `${actionType} is aliased on some chains but not every chain where ${to.contract} resolves and ${from.contract} does not`
      ).toEqual(derived.sort());
    });
  }
});

describe("resolveRenamedAction refuses a table entry it cannot honour", () => {
  // The module has to be safe on its own terms. Step ROUTING is chosen from
  // the requested slug (lib/step-registry.ts registers a read step and a write
  // step per slug) while the contract and function come from the resolved one,
  // so an entry that changed read to write would have protocolReadStep
  // eth_call a state-changer, or hand protocolWriteStep a view function to
  // broadcast. Every entry is read to read today; nothing but this guard keeps
  // a future one from being otherwise.
  const declared = {
    slug: "vault-balance",
    contract: "sUsds",
    type: "read",
    function: "balanceOf",
    inputs: [],
  } as unknown as ProtocolAction;
  const replacement = {
    slug: "get-susds-balance-l2",
    contract: "sUsdsL2",
    type: "write",
    function: "balanceOf",
    inputs: [],
  } as unknown as ProtocolAction;
  const protocol = {
    contracts: {
      sUsds: { addresses: { "1": "0x1" } },
      sUsdsL2: { addresses: { "8453": "0x2" } },
    },
    actions: [declared, replacement],
  } as unknown as ProtocolDefinition;

  it("returns the declared action when the replacement flips read to write", () => {
    expect(
      resolveRenamedAction(protocol, "sky/vault-balance", declared, "8453")
    ).toBe(declared);
  });

  it("does not throw on an action type that names an inherited property", () => {
    // The table is a plain object literal and actionType is request-derived,
    // so a key like "constructor" would otherwise answer with a function and
    // throw on `.chainIds`.
    const sky = getProtocol("sky");
    const action = sky?.actions.find((a) => a.slug === "vault-balance");
    if (!(sky && action)) {
      throw new Error("sky/vault-balance is not registered");
    }
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(resolveRenamedAction(sky, key, action, "8453")).toBe(action);
    }
  });
});

describe("the Network field offers the chains the alias covers", () => {
  // buildConfigFieldsFromAction derives allowedChainIds from the declared
  // contract's addresses, which after the split lists mainnet alone. That
  // list is what lib/workflow/validation/action-config.ts checks a stored
  // node's network against on save, and what chain-select-field.tsx filters
  // the dropdown by - so leaving the aliased chains out makes a Base
  // workflow that still executes correctly fail to save with a 422 and
  // render an empty Network field.
  for (const [actionType, rename] of Object.entries(L2_RENAMED_ACTIONS)) {
    it(`${actionType} offers ${rename.chainIds.join("/")}`, () => {
      const [protocolSlug, oldSlug] = actionType.split("/");
      const protocol = getProtocol(protocolSlug ?? "");
      if (!protocol) {
        throw new Error(`${actionType} names no registered protocol`);
      }
      const action = protocol.actions.find((a) => a.slug === oldSlug);
      if (!action) {
        throw new Error(`${actionType} names no registered action`);
      }

      const networkField = protocolActionToPluginAction(
        protocol,
        action
      ).configFields?.find((f) => "key" in f && f.key === "network");
      const allowed =
        networkField && "allowedChainIds" in networkField
          ? (networkField.allowedChainIds ?? [])
          : [];

      for (const chainId of rename.chainIds) {
        expect(
          allowed,
          `${actionType} resolves on chain ${chainId} through the alias, so the Network field must offer it`
        ).toContain(chainId);
      }
      // The chains the declared contract carries stay offered: the union
      // adds to the list, it does not replace it.
      for (const chainId of Object.keys(
        protocol.contracts[action.contract]?.addresses ?? {}
      )) {
        expect(allowed).toContain(chainId);
      }
    });
  }

  it("leaves an unaliased action's chain list untouched", () => {
    const protocol = getProtocol("sky");
    const action = protocol?.actions.find((a) => a.slug === "vault-deposit");
    if (!(protocol && action)) {
      throw new Error("sky/vault-deposit is not registered");
    }
    const networkField = protocolActionToPluginAction(
      protocol,
      action
    ).configFields?.find((f) => "key" in f && f.key === "network");
    const allowed =
      networkField && "allowedChainIds" in networkField
        ? (networkField.allowedChainIds ?? [])
        : [];
    expect(allowed).toEqual(
      Object.keys(protocol.contracts[action.contract]?.addresses ?? {})
    );
  });
});
