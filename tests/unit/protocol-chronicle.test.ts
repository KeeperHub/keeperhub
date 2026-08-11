import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import chronicleDef from "@/protocols/chronicle";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

const NAMED_FEEDS = [
  "ethUsd",
  "btcUsd",
  "daiUsd",
  "usdcUsd",
  "usdtUsd",
  "linkUsd",
] as const;

describe("Chronicle Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(chronicleDef).toBeDefined();
    expect(chronicleDef.name).toBe("Chronicle");
    expect(chronicleDef.slug).toBe("chronicle");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(chronicleDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of chronicleDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid Ethereum addresses", () => {
    for (const [key, contract] of Object.entries(chronicleDef.contracts)) {
      for (const [chainId, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chainId}" has invalid address`
        ).toMatch(ETH_ADDRESS_REGEX);
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(chronicleDef.contracts));
    for (const action of chronicleDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = chronicleDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = chronicleDef.actions.filter((a) => a.type === "read");
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
    for (const action of chronicleDef.actions) {
      const contract = chronicleDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  // Structure: 6 named feeds x 2 actions + 4 custom + 1 selfKiss = 17
  it("has 17 actions total", () => {
    expect(chronicleDef.actions).toHaveLength(17);
  });

  it("has 16 read actions and 1 write action", () => {
    const readActions = chronicleDef.actions.filter((a) => a.type === "read");
    const writeActions = chronicleDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(16);
    expect(writeActions).toHaveLength(1);
  });

  // 6 named feeds + customOracle + selfKisser = 8 contracts
  it("has 8 contracts", () => {
    expect(Object.keys(chronicleDef.contracts)).toHaveLength(8);
  });

  it("customOracle contract has userSpecifiedAddress enabled", () => {
    expect(chronicleDef.contracts.customOracle.userSpecifiedAddress).toBe(true);
  });

  it("named feed contracts do not have userSpecifiedAddress", () => {
    for (const key of NAMED_FEEDS) {
      expect(
        chronicleDef.contracts[key].userSpecifiedAddress,
        `named feed "${key}" should not have userSpecifiedAddress`
      ).toBeUndefined();
    }
  });

  it("all named feeds have Sepolia addresses", () => {
    for (const key of NAMED_FEEDS) {
      expect(
        chronicleDef.contracts[key].addresses["11155111"],
        `named feed "${key}" missing Sepolia address`
      ).toBeDefined();
    }
  });

  it("ETH/USD feed has both mainnet and Sepolia addresses", () => {
    const chains = Object.keys(chronicleDef.contracts.ethUsd.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("11155111");
  });

  it("BTC/USD, USDC/USD, and USDT/USD feeds have both mainnet and Sepolia addresses", () => {
    for (const key of ["btcUsd", "usdcUsd", "usdtUsd"] as const) {
      const chains = Object.keys(chronicleDef.contracts[key].addresses);
      expect(chains, `${key} missing mainnet`).toContain("1");
      expect(chains, `${key} missing Sepolia`).toContain("11155111");
    }
  });

  it("customOracle contract is available on Ethereum Mainnet and Sepolia", () => {
    const chains = Object.keys(chronicleDef.contracts.customOracle.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("11155111");
  });

  it("selfKisser contract is available on testnets and Gnosis but not Ethereum Mainnet", () => {
    const chains = Object.keys(chronicleDef.contracts.selfKisser.addresses);
    expect(chains).not.toContain("1");
    expect(chains).toContain("11155111");
    expect(chains).toContain("84532");
    expect(chains).toContain("421614");
    expect(chains).toContain("100");
  });

  it("each named feed has read and read-with-age actions", () => {
    const feedSlugs = [
      "eth-usd",
      "btc-usd",
      "dai-usd",
      "usdc-usd",
      "usdt-usd",
      "link-usd",
    ];
    for (const slug of feedSlugs) {
      const readAction = chronicleDef.actions.find(
        (a) => a.slug === `${slug}-read`
      );
      const readWithAgeAction = chronicleDef.actions.find(
        (a) => a.slug === `${slug}-read-with-age`
      );
      expect(readAction, `missing ${slug}-read action`).toBeDefined();
      expect(
        readWithAgeAction,
        `missing ${slug}-read-with-age action`
      ).toBeDefined();
    }
  });

  it("named feed read actions have 1 output with 18 decimals", () => {
    const feedReadActions = chronicleDef.actions.filter(
      (a) => a.slug.endsWith("-read") && !a.slug.includes("try")
    );
    for (const action of feedReadActions) {
      expect(action.outputs).toHaveLength(1);
      expect(action.outputs?.[0]?.decimals).toBe(18);
    }
  });

  it("named feed read-with-age actions have 2 outputs: value and age", () => {
    const feedAgeActions = chronicleDef.actions.filter(
      (a) => a.slug.endsWith("-read-with-age") && !a.slug.includes("try")
    );
    for (const action of feedAgeActions) {
      expect(action.outputs).toHaveLength(2);
      const names = action.outputs?.map((o) => o.name);
      expect(names).toContain("value");
      expect(names).toContain("age");
    }
  });

  it("custom read action has 1 output: value with 18 decimals", () => {
    const action = chronicleDef.actions.find((a) => a.slug === "read");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    const output = action?.outputs?.[0];
    expect(output?.name).toBe("value");
    expect(output?.decimals).toBe(18);
  });

  it("custom try-read action has 2 outputs: ok and value", () => {
    const action = chronicleDef.actions.find((a) => a.slug === "try-read");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(2);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("ok");
    expect(outputNames).toContain("value");
  });

  it("custom read-with-age action has 2 outputs: value and age", () => {
    const action = chronicleDef.actions.find((a) => a.slug === "read-with-age");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(2);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("value");
    expect(outputNames).toContain("age");
  });

  it("custom read-with-age age output has no decimals (raw Unix timestamp)", () => {
    const action = chronicleDef.actions.find((a) => a.slug === "read-with-age");
    const ageOutput = action?.outputs?.find((o) => o.name === "age");
    expect(ageOutput).toBeDefined();
    expect(ageOutput?.decimals).toBeUndefined();
  });

  it("custom try-read-with-age action has 3 outputs: ok, value, and age", () => {
    const action = chronicleDef.actions.find(
      (a) => a.slug === "try-read-with-age"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(3);
    const outputNames = action?.outputs?.map((o) => o.name);
    expect(outputNames).toContain("ok");
    expect(outputNames).toContain("value");
    expect(outputNames).toContain("age");
  });

  it("self-kiss action is a write action on selfKisser contract", () => {
    const action = chronicleDef.actions.find((a) => a.slug === "self-kiss");
    expect(action).toBeDefined();
    expect(action?.type).toBe("write");
    expect(action?.contract).toBe("selfKisser");
    expect(action?.function).toBe("selfKiss");
  });

  it("self-kiss action has 1 input: oracle address", () => {
    const action = chronicleDef.actions.find((a) => a.slug === "self-kiss");
    expect(action?.inputs).toHaveLength(1);
    expect(action?.inputs[0].name).toBe("oracle");
    expect(action?.inputs[0].type).toBe("address");
  });

  it("all contracts provide inline ABI", () => {
    for (const [key, contract] of Object.entries(chronicleDef.contracts)) {
      expect(contract.abi, `contract "${key}" missing ABI`).toBeDefined();
    }
  });

  it("oracle ABI is valid JSON with 4 functions", () => {
    const abi = JSON.parse(chronicleDef.contracts.customOracle.abi ?? "[]");
    expect(Array.isArray(abi)).toBe(true);
    expect(abi).toHaveLength(4);
    const names = abi.map((entry: { name: string }) => entry.name);
    expect(names).toContain("read");
    expect(names).toContain("tryRead");
    expect(names).toContain("readWithAge");
    expect(names).toContain("tryReadWithAge");
  });

  it("selfKisser ABI is valid JSON with 1 function", () => {
    const abi = JSON.parse(chronicleDef.contracts.selfKisser.abi ?? "[]");
    expect(Array.isArray(abi)).toBe(true);
    expect(abi).toHaveLength(1);
    expect(abi[0].name).toBe("selfKiss");
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(chronicleDef);
    const retrieved = getProtocol("chronicle");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("chronicle");
    expect(retrieved?.name).toBe("Chronicle");
  });
});
