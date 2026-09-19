import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import uniswapDef from "@/protocols/uniswap-v3";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

describe("Uniswap Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(uniswapDef).toBeDefined();
    expect(uniswapDef.name).toBe("Uniswap V3");
    expect(uniswapDef.slug).toBe("uniswap");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(uniswapDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of uniswapDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid 42-character hex strings", () => {
    for (const [contractKey, contract] of Object.entries(
      uniswapDef.contracts
    )) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(address, `${contractKey} on chain ${chain}`).toMatch(
          HEX_ADDRESS_REGEX
        );
        expect(address, `${contractKey} on chain ${chain} length`).toHaveLength(
          42
        );
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(uniswapDef.contracts));
    for (const action of uniswapDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = uniswapDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = uniswapDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(
        action.outputs?.length,
        `read action "${action.slug}" must have at least one output`
      ).toBeGreaterThan(0);
    }
  });

  it("each action's contract has at least one chain address", () => {
    for (const action of uniswapDef.actions) {
      const contract = uniswapDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 14 actions", () => {
    expect(uniswapDef.actions).toHaveLength(14);
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(uniswapDef);
    const retrieved = getProtocol("uniswap");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("uniswap");
    expect(retrieved?.name).toBe("Uniswap V3");
  });

  it("has 6 read actions and 8 write actions", () => {
    const readActions = uniswapDef.actions.filter((a) => a.type === "read");
    const writeActions = uniswapDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(6);
    expect(writeActions).toHaveLength(8);
  });

  it("has 4 contracts", () => {
    expect(Object.keys(uniswapDef.contracts)).toHaveLength(4);
  });

  it("all contracts are available on 5 chains", () => {
    for (const [key, contract] of Object.entries(uniswapDef.contracts)) {
      const chains = Object.keys(contract.addresses);
      expect(chains, `${key} should have 5 chains`).toHaveLength(5);
      expect(contract.addresses["1"]).toBeDefined();
      expect(contract.addresses["8453"]).toBeDefined();
      expect(contract.addresses["42161"]).toBeDefined();
      expect(contract.addresses["10"]).toBeDefined();
      expect(contract.addresses["11155111"]).toBeDefined();
    }
  });

  it("get-position action returns 12 output fields", () => {
    const getPosition = uniswapDef.actions.find(
      (a) => a.slug === "get-position"
    );
    expect(getPosition).toBeDefined();
    expect(getPosition?.outputs).toHaveLength(12);
  });
});

describe("Uniswap position lifecycle actions", () => {
  const UINT128_MAX = "340282366920938463463374607431768211455";
  const action = (slug: string) => {
    const found = uniswapDef.actions.find((a) => a.slug === slug);
    expect(found, `action "${slug}"`).toBeDefined();
    return found as NonNullable<typeof found>;
  };
  const inputNames = (slug: string) => action(slug).inputs.map((i) => i.name);
  const outputNames = (slug: string) =>
    (action(slug).outputs ?? []).map((o) => o.name);

  // The selector hashes the function name and the exact tuple component
  // types, so a wrong component type in the ABI fails here rather than
  // on-chain. Values read from the deployed NonfungiblePositionManager's
  // dispatcher on Base and mainnet.
  it("encodes the selectors the deployed position manager dispatches on", () => {
    const iface = new ethers.Interface(
      JSON.parse(uniswapDef.contracts.positionManager.abi as string)
    );
    expect(iface.getFunction("collect")?.selector).toBe("0xfc6f7865");
    expect(iface.getFunction("decreaseLiquidity")?.selector).toBe("0x0c49ccbe");
    expect(iface.getFunction("increaseLiquidity")?.selector).toBe("0x219f5d17");
  });

  it("flattens CollectParams and defaults both max amounts to collect everything", () => {
    const collect = action("collect-fees");
    expect(collect.type).toBe("write");
    expect(collect.function).toBe("collect");
    expect(inputNames("collect-fees")).toEqual([
      "tokenId",
      "recipient",
      "amount0Max",
      "amount1Max",
    ]);
    const defaults = Object.fromEntries(
      collect.inputs.map((i) => [i.name, i.default])
    );
    expect(defaults.amount0Max).toBe(UINT128_MAX);
    expect(defaults.amount1Max).toBe(UINT128_MAX);
    expect(defaults.tokenId).toBeUndefined();
    expect(defaults.recipient).toBeUndefined();
    expect(outputNames("collect-fees")).toEqual(["amount0", "amount1"]);
  });

  it("flattens DecreaseLiquidityParams with the unix-timestamp deadline label", () => {
    expect(action("decrease-liquidity").type).toBe("write");
    expect(inputNames("decrease-liquidity")).toEqual([
      "tokenId",
      "liquidity",
      "amount0Min",
      "amount1Min",
      "deadline",
    ]);
    const deadline = action("decrease-liquidity").inputs.find(
      (i) => i.name === "deadline"
    );
    expect(deadline?.label).toBe("Deadline (unix timestamp)");
    expect(outputNames("decrease-liquidity")).toEqual(["amount0", "amount1"]);
  });

  it("flattens IncreaseLiquidityParams and returns the liquidity added", () => {
    expect(action("increase-liquidity").type).toBe("write");
    expect(inputNames("increase-liquidity")).toEqual([
      "tokenId",
      "amount0Desired",
      "amount1Desired",
      "amount0Min",
      "amount1Min",
      "deadline",
    ]);
    expect(outputNames("increase-liquidity")).toEqual([
      "liquidity",
      "amount0",
      "amount1",
    ]);
  });

  // Called directly rather than inside multicall, ETH sent to any of these
  // stays in the position manager for anyone to sweep with refundETH(), so
  // none may offer an ETH Value field. burn carried the same hazard and is
  // included.
  it("makes no position-manager write payable", () => {
    for (const slug of [
      "collect-fees",
      "decrease-liquidity",
      "increase-liquidity",
      "burn-position",
    ]) {
      expect(action(slug).payable, `${slug} must not be payable`).toBeFalsy();
    }
  });

  // Slippage and deadline must stay required with no default. A default of
  // "0" on the minimums would make every run a zero-slippage withdrawal, and a
  // default deadline would do the same for expiry - the builder, the route and
  // the encoder all reject a blank only because there is nothing to fall back
  // to.
  it("leaves slippage and deadline required with no default", () => {
    const cases: [string, string[]][] = [
      ["decrease-liquidity", ["amount0Min", "amount1Min", "deadline"]],
      ["increase-liquidity", ["amount0Min", "amount1Min", "deadline"]],
    ];
    for (const [slug, names] of cases) {
      for (const name of names) {
        const input = action(slug).inputs.find((i) => i.name === name);
        expect(input, `${slug}.${name}`).toBeDefined();
        expect(
          input?.default,
          `${slug}.${name} must have no default`
        ).toBeUndefined();
        expect(
          input?.required,
          `${slug}.${name} must not be optional`
        ).not.toBe(false);
      }
    }
  });

  // The recipient decides where the money goes and was the one input without
  // guidance; every input on these actions carries a tip now.
  it("gives every lifecycle input a help tip", () => {
    for (const slug of [
      "collect-fees",
      "decrease-liquidity",
      "increase-liquidity",
    ]) {
      for (const input of action(slug).inputs) {
        expect(
          input.helpTip,
          `${slug}.${input.name} needs a helpTip`
        ).toBeTruthy();
      }
    }
  });
});
