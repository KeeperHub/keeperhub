import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import chainlinkDef from "@/protocols/chainlink";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Chainlink Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(chainlinkDef).toBeDefined();
    expect(chainlinkDef.name).toBe("Chainlink");
    expect(chainlinkDef.slug).toBe("chainlink");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(chainlinkDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of chainlinkDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(chainlinkDef.contracts));
    for (const action of chainlinkDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = chainlinkDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = chainlinkDef.actions.filter((a) => a.type === "read");
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
    for (const action of chainlinkDef.actions) {
      const contract = chainlinkDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(chainlinkDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be 42-char hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("has 31 actions (8 named feeds x 2 + 6 custom feed + 9 CCIP)", () => {
    expect(chainlinkDef.actions).toHaveLength(31);
  });

  it("has 27 read actions and 4 write actions", () => {
    const readActions = chainlinkDef.actions.filter((a) => a.type === "read");
    const writeActions = chainlinkDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(27);
    expect(writeActions).toHaveLength(4);
  });

  it("has 13 contracts (8 named feeds + 1 custom + 4 CCIP)", () => {
    expect(Object.keys(chainlinkDef.contracts)).toHaveLength(13);
  });

  it("customFeed contract has userSpecifiedAddress enabled", () => {
    expect(chainlinkDef.contracts.customFeed.userSpecifiedAddress).toBe(true);
  });

  it("named feed contracts do not have userSpecifiedAddress", () => {
    const namedFeeds = [
      "ethUsd",
      "btcUsd",
      "linkUsd",
      "usdcUsd",
      "daiUsd",
      "usdtUsd",
      "linkEth",
      "btcEth",
    ];
    for (const key of namedFeeds) {
      expect(
        chainlinkDef.contracts[key].userSpecifiedAddress,
        `contract "${key}" should not have userSpecifiedAddress`
      ).toBeUndefined();
    }
  });

  it("ETH/USD feed is available on 5 chains including Sepolia", () => {
    const chains = Object.keys(chainlinkDef.contracts.ethUsd.addresses);
    expect(chains).toHaveLength(5);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
    expect(chains).toContain("42161");
    expect(chains).toContain("10");
    expect(chains).toContain("11155111");
  });

  it("customFeed contract is available on 5 chains", () => {
    const chains = Object.keys(chainlinkDef.contracts.customFeed.addresses);
    expect(chains).toHaveLength(5);
    expect(chains).toContain("1");
    expect(chains).toContain("11155111");
  });

  it("each named feed has a latestRoundData action with 5 outputs", () => {
    const feedSlugs = [
      "eth-usd-latest-round-data",
      "btc-usd-latest-round-data",
      "link-usd-latest-round-data",
      "usdc-usd-latest-round-data",
      "dai-usd-latest-round-data",
      "usdt-usd-latest-round-data",
      "link-eth-latest-round-data",
      "btc-eth-latest-round-data",
    ];
    for (const slug of feedSlugs) {
      const action = chainlinkDef.actions.find((a) => a.slug === slug);
      expect(action, `action "${slug}" should exist`).toBeDefined();
      expect(action?.outputs).toHaveLength(5);
    }
  });

  it("each named feed has a decimals action with 1 output", () => {
    const feedSlugs = [
      "eth-usd-decimals",
      "btc-usd-decimals",
      "link-usd-decimals",
      "usdc-usd-decimals",
      "dai-usd-decimals",
      "usdt-usd-decimals",
      "link-eth-decimals",
      "btc-eth-decimals",
    ];
    for (const slug of feedSlugs) {
      const action = chainlinkDef.actions.find((a) => a.slug === slug);
      expect(action, `action "${slug}" should exist`).toBeDefined();
      expect(action?.outputs).toHaveLength(1);
      expect(action?.function).toBe("decimals");
    }
  });

  it("custom getRoundData action has 1 input and 5 outputs", () => {
    const action = chainlinkDef.actions.find(
      (a) => a.slug === "get-round-data"
    );
    expect(action).toBeDefined();
    expect(action?.inputs).toHaveLength(1);
    expect(action?.outputs).toHaveLength(5);
  });

  it("CCIP router contract is available on all enabled CCIP chains", () => {
    const chains = Object.keys(chainlinkDef.contracts.ccipRouter.addresses);
    const expectedMainnets = ["1", "8453", "42161", "56", "137", "43114"];
    const expectedTestnets = [
      "11155111",
      "84532",
      "97",
      "80002",
      "421614",
      "43113",
    ];
    const expected = [...expectedMainnets, ...expectedTestnets];
    expect(chains).toHaveLength(expected.length);
    for (const id of expected) {
      expect(chains, `missing chain ${id}`).toContain(id);
    }
  });

  it("CCIP-BnM contract is testnet-only (Sepolia + Base Sepolia)", () => {
    const chains = Object.keys(chainlinkDef.contracts.ccipBnM.addresses);
    expect(chains).toHaveLength(2);
    expect(chains).toContain("11155111");
    expect(chains).toContain("84532");
  });

  it("ccip-get-fee action exists and is a read with 6 inputs", () => {
    const action = chainlinkDef.actions.find((a) => a.slug === "ccip-get-fee");
    expect(action).toBeDefined();
    expect(action?.type).toBe("read");
    expect(action?.contract).toBe("ccipRouter");
    expect(action?.inputs).toHaveLength(6);
    expect(action?.outputs).toHaveLength(1);
  });

  it("ccip-send action exists and is a write with 6 inputs", () => {
    const action = chainlinkDef.actions.find((a) => a.slug === "ccip-send");
    expect(action).toBeDefined();
    expect(action?.type).toBe("write");
    expect(action?.contract).toBe("ccipRouter");
    expect(action?.inputs).toHaveLength(6);
    expect(action?.outputs).toHaveLength(1);
  });

  it("ccipBridgeToken and ccipFeeToken contracts have userSpecifiedAddress enabled", () => {
    expect(chainlinkDef.contracts.ccipBridgeToken.userSpecifiedAddress).toBe(
      true
    );
    expect(chainlinkDef.contracts.ccipFeeToken.userSpecifiedAddress).toBe(true);
  });

  it("ccip-approve-bridge-token action exists and is a write with 2 inputs", () => {
    const action = chainlinkDef.actions.find(
      (a) => a.slug === "ccip-approve-bridge-token"
    );
    expect(action).toBeDefined();
    expect(action?.type).toBe("write");
    expect(action?.contract).toBe("ccipBridgeToken");
    expect(action?.function).toBe("approve");
    expect(action?.inputs).toHaveLength(2);
  });

  it("ccip-approve-fee-token action exists and is a write with 2 inputs", () => {
    const action = chainlinkDef.actions.find(
      (a) => a.slug === "ccip-approve-fee-token"
    );
    expect(action).toBeDefined();
    expect(action?.type).toBe("write");
    expect(action?.contract).toBe("ccipFeeToken");
    expect(action?.function).toBe("approve");
    expect(action?.inputs).toHaveLength(2);
  });

  it("ccip-check-bridge-balance and ccip-check-fee-balance actions exist", () => {
    const cases: Array<{ slug: string; contract: string }> = [
      { slug: "ccip-check-bridge-balance", contract: "ccipBridgeToken" },
      { slug: "ccip-check-fee-balance", contract: "ccipFeeToken" },
    ];
    for (const { slug, contract } of cases) {
      const action = chainlinkDef.actions.find((a) => a.slug === slug);
      expect(action, `${slug} should exist`).toBeDefined();
      expect(action?.type).toBe("read");
      expect(action?.contract).toBe(contract);
      expect(action?.function).toBe("balanceOf");
      expect(action?.inputs).toHaveLength(1);
      expect(action?.outputs).toHaveLength(1);
    }
  });

  it("ccip-check-bridge-allowance and ccip-check-fee-allowance actions exist", () => {
    const cases: Array<{ slug: string; contract: string }> = [
      { slug: "ccip-check-bridge-allowance", contract: "ccipBridgeToken" },
      { slug: "ccip-check-fee-allowance", contract: "ccipFeeToken" },
    ];
    for (const { slug, contract } of cases) {
      const action = chainlinkDef.actions.find((a) => a.slug === slug);
      expect(action, `${slug} should exist`).toBeDefined();
      expect(action?.type).toBe("read");
      expect(action?.contract).toBe(contract);
      expect(action?.function).toBe("allowance");
      expect(action?.inputs).toHaveLength(2);
      expect(action?.outputs).toHaveLength(1);
    }
  });

  it("ccip-bnm-drip action exists and is a write targeting ccipBnM", () => {
    const action = chainlinkDef.actions.find((a) => a.slug === "ccip-bnm-drip");
    expect(action).toBeDefined();
    expect(action?.type).toBe("write");
    expect(action?.contract).toBe("ccipBnM");
    expect(action?.inputs).toHaveLength(1);
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(chainlinkDef);
    const retrieved = getProtocol("chainlink");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("chainlink");
    expect(retrieved?.name).toBe("Chainlink");
  });
});
