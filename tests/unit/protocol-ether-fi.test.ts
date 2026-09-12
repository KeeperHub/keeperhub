import { getAddress } from "ethers";
import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import etherFiDef from "@/protocols/ether-fi";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("ether.fi Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(etherFiDef).toBeDefined();
    expect(etherFiDef.name).toBe("ether.fi");
    expect(etherFiDef.slug).toBe("ether-fi");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(etherFiDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of etherFiDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(etherFiDef.contracts));
    for (const action of etherFiDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = etherFiDef.actions.map((a) => a.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  it("all read actions define outputs", () => {
    const readActions = etherFiDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(action.outputs?.length).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(etherFiDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be valid hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("has three contracts (liquidityPool, weeth, eeth)", () => {
    expect(Object.keys(etherFiDef.contracts).sort()).toEqual([
      "eeth",
      "liquidityPool",
      "weeth",
    ]);
    expect(etherFiDef.contracts.liquidityPool.label).toBe(
      "ether.fi Liquidity Pool"
    );
    expect(etherFiDef.contracts.weeth.label).toBe("weETH Token");
    expect(etherFiDef.contracts.eeth.label).toBe("eETH Token");
  });

  it("has 13 actions: 3 writes and 10 reads", () => {
    expect(etherFiDef.actions).toHaveLength(13);
    const reads = etherFiDef.actions.filter((a) => a.type === "read");
    const writes = etherFiDef.actions.filter((a) => a.type === "write");
    expect(reads).toHaveLength(10);
    expect(writes).toHaveLength(3);
  });

  it("exposes the expected action slugs", () => {
    const slugs = etherFiDef.actions.map((a) => a.slug).sort();
    expect(slugs).toEqual(
      [
        "amount-for-share",
        "eeth-balance-of",
        "eeth-total-shares",
        "get-eeth-by-weeth",
        "get-rate",
        "get-total-pooled-ether",
        "get-weeth-by-eeth",
        "shares-for-amount",
        "stake",
        "unwrap",
        "weeth-balance-of",
        "weeth-total-supply",
        "wrap",
      ].sort()
    );
  });

  it("stake is a payable write with no inputs and a uint256 output", () => {
    const stake = etherFiDef.actions.find((a) => a.slug === "stake");
    expect(stake).toBeDefined();
    expect(stake?.type).toBe("write");
    expect(stake?.payable).toBe(true);
    expect(stake?.inputs).toHaveLength(0);
    expect(stake?.contract).toBe("liquidityPool");
    expect(stake?.function).toBe("deposit");
    expect(stake?.label).toBe("Stake ETH for eETH");
    expect(stake?.outputs).toHaveLength(1);
    expect(stake?.outputs?.[0].type).toBe("uint256");
  });

  it("wrap is a non-payable write with one uint256 input and output", () => {
    const wrap = etherFiDef.actions.find((a) => a.slug === "wrap");
    expect(wrap).toBeDefined();
    expect(wrap?.type).toBe("write");
    expect(wrap?.payable).toBeUndefined();
    expect(wrap?.contract).toBe("weeth");
    expect(wrap?.function).toBe("wrap");
    expect(wrap?.inputs).toHaveLength(1);
    expect(wrap?.inputs[0].name).toBe("amount");
    expect(wrap?.inputs[0].type).toBe("uint256");
    expect(wrap?.inputs[0].decimals).toBe(18);
    expect(wrap?.inputs[0].helpTip).toBeTruthy();
    expect(wrap?.outputs?.[0].name).toBe("weETHReceived");
    expect(wrap?.outputs?.[0].decimals).toBe(18);
  });

  it("unwrap is a non-payable write returning eETH", () => {
    const unwrap = etherFiDef.actions.find((a) => a.slug === "unwrap");
    expect(unwrap).toBeDefined();
    expect(unwrap?.type).toBe("write");
    expect(unwrap?.payable).toBeUndefined();
    expect(unwrap?.contract).toBe("weeth");
    expect(unwrap?.function).toBe("unwrap");
    expect(unwrap?.inputs).toHaveLength(1);
    expect(unwrap?.outputs?.[0].name).toBe("eETHReceived");
  });

  it("get-rate is a read returning an 18-decimal rate", () => {
    const getRate = etherFiDef.actions.find((a) => a.slug === "get-rate");
    expect(getRate).toBeDefined();
    expect(getRate?.type).toBe("read");
    expect(getRate?.payable).toBeUndefined();
    expect(getRate?.inputs).toHaveLength(0);
    expect(getRate?.function).toBe("getRate");
    expect(getRate?.outputs?.[0].name).toBe("rate");
    expect(getRate?.outputs?.[0].decimals).toBe(18);
  });

  it("eeth-total-shares reads from the eETH contract", () => {
    const shares = etherFiDef.actions.find(
      (a) => a.slug === "eeth-total-shares"
    );
    expect(shares).toBeDefined();
    expect(shares?.type).toBe("read");
    expect(shares?.contract).toBe("eeth");
    expect(shares?.function).toBe("totalShares");
    expect(shares?.outputs?.[0].name).toBe("totalShares");
  });

  it("every contract is Ethereum mainnet only (chain 1)", () => {
    for (const contract of Object.values(etherFiDef.contracts)) {
      expect(Object.keys(contract.addresses)).toEqual(["1"]);
    }
  });

  it("excludes the testnets and the L2 weETH chains", () => {
    // Minting settles on the beacon chain so there is no testnet deployment,
    // and the L2 weETH tokens are LayerZero OFT representations rather than
    // another address on these contracts.
    const excluded = {
      "11155111": "Sepolia",
      "17000": "Holesky",
      "5": "Goerli",
      "42161": "Arbitrum",
      "8453": "Base",
      "10": "Optimism",
    };
    for (const [key, contract] of Object.entries(etherFiDef.contracts)) {
      for (const [chainId, label] of Object.entries(excluded)) {
        expect(
          contract.addresses[chainId],
          `contract "${key}" must not declare ${label} (${chainId})`
        ).toBeUndefined();
      }
    }
  });

  it("all contract addresses are EIP-55 checksummed", () => {
    for (const [key, contract] of Object.entries(etherFiDef.contracts)) {
      const address = contract.addresses["1"];
      expect(getAddress(address), `contract "${key}" must be checksummed`).toBe(
        address
      );
    }
  });

  it("testData binds every action by its declared input names", () => {
    // The overrides rename the raw ABI parameters, and a binding keyed to the
    // old name is dropped silently: the encoder then falls back to a
    // type-derived default, so a 1e18 fixture becomes 1 wei with no error.
    // This pins the binding keys to the action input names.
    const chainOne = etherFiDef.testData?.["1"];
    expect(chainOne).toBeDefined();
    const bound = chainOne?.actions ?? {};
    const skipped = chainOne?.skipped ?? {};

    // Every action is either bound or explicitly skipped with a reason.
    for (const action of etherFiDef.actions) {
      expect(
        action.slug in bound || action.slug in skipped,
        `action "${action.slug}" is neither bound nor skipped`
      ).toBe(true);
    }

    // Every binding key that is not a builder directive names a real input.
    const DIRECTIVES = new Set(["ethValue"]);
    for (const [slug, bindings] of Object.entries(bound)) {
      const action = etherFiDef.actions.find((a) => a.slug === slug);
      expect(
        action,
        `testData references unknown action "${slug}"`
      ).toBeDefined();
      const inputNames = new Set(action?.inputs.map((i) => i.name));
      for (const key of Object.keys(bindings as Record<string, unknown>)) {
        if (DIRECTIVES.has(key)) {
          continue;
        }
        expect(
          inputNames.has(key),
          `"${slug}" binds "${key}", which is not one of its inputs (${[...inputNames].join(", ") || "none"})`
        ).toBe(true);
      }
    }
  });

  it("expectation field names match the declared outputs", () => {
    // structureAbiOutputs keys the step result off the ABI output name, so an
    // expectation naming a field the action does not declare cannot resolve.
    const chainOne = etherFiDef.testData?.["1"];
    for (const [slug, checks] of Object.entries(chainOne?.expectations ?? {})) {
      const action = etherFiDef.actions.find((a) => a.slug === slug);
      expect(action, `expectation for unknown action "${slug}"`).toBeDefined();
      const outputNames = new Set(action?.outputs?.map((o) => o.name));
      for (const check of checks as Array<{ field?: string }>) {
        if (check.field === undefined) {
          continue;
        }
        expect(
          outputNames.has(check.field),
          `"${slug}" expects field "${check.field}", not in outputs (${[...outputNames].join(", ")})`
        ).toBe(true);
      }
    }
  });

  it("contract addresses match the verified mainnet deployments", () => {
    // Verified on-chain 2026-09-10: name/symbol/decimals plus weETH.eETH()
    // linking to the eETH address, and weETH.getRate() equal to the pool's
    // amountForShare(1e18).
    expect(etherFiDef.contracts.liquidityPool.addresses["1"]).toBe(
      "0x308861A430be4cce5502d0A12724771Fc6DaF216"
    );
    expect(etherFiDef.contracts.weeth.addresses["1"]).toBe(
      "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee"
    );
    expect(etherFiDef.contracts.eeth.addresses["1"]).toBe(
      "0x35fA164735182de50811E8e2E824cFb9B6118ac2"
    );
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(etherFiDef);
    const retrieved = getProtocol("ether-fi");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("ether-fi");
    expect(retrieved?.name).toBe("ether.fi");
  });
});
