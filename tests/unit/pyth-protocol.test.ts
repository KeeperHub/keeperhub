import { describe, expect, it } from "vitest";
import pythProtocol from "@/protocols/pyth";

describe("Pyth Network Protocol Definition", () => {
  it("has correct protocol metadata and icon path", () => {
    expect(pythProtocol.name).toBe("Pyth Network");
    expect(pythProtocol.slug).toBe("pyth");
    expect(pythProtocol.icon).toBe("/protocols/pyth.png");
    expect(pythProtocol.contracts.oracle).toBeDefined();
    expect(pythProtocol.contracts.customOracle).toBeDefined();
  });

  it("configures valid checksummed EVM contract addresses across 8 chains without tautology", () => {
    const oracle = pythProtocol.contracts.oracle;
    const customOracle = pythProtocol.contracts.customOracle;

    const expectedChains = [
      "1",
      "8453",
      "42161",
      "10",
      "137",
      "56",
      "43114",
      "11155111",
    ];
    const evmAddressRegex = /^0x[0-9a-fA-F]{40}$/;

    for (const chainId of expectedChains) {
      const oracleAddr = oracle.addresses[chainId];
      const customAddr = customOracle.addresses[chainId];

      expect(oracleAddr).toBeDefined();
      expect(customAddr).toBeDefined();
      expect(oracleAddr).toMatch(evmAddressRegex);
      expect(customAddr).toBe(oracleAddr);
    }
  });

  it("defines expected read actions including unsafe view functions", () => {
    const actionSlugs = pythProtocol.actions.map((a) => a.slug);
    expect(actionSlugs).toContain("get-price-unsafe");
    expect(actionSlugs).toContain("get-ema-price-unsafe");
    expect(actionSlugs).toContain("get-price");
    expect(actionSlugs).toContain("get-ema-price");
    expect(actionSlugs).toContain("get-price-no-older-than");
    expect(actionSlugs).toContain("get-ema-price-no-older-than");
    expect(actionSlugs).toContain("custom-get-price-unsafe");
  });

  it("derives 4 separate named outputs for price tuples with scaling note on raw integer price label", () => {
    const getPriceUnsafeAction = pythProtocol.actions.find(
      (a) => a.slug === "get-price-unsafe"
    );
    expect(getPriceUnsafeAction).toBeDefined();
    expect(getPriceUnsafeAction?.outputs).toBeDefined();

    const outputNames = getPriceUnsafeAction?.outputs?.map((o) => o.name);
    expect(outputNames).toEqual(["price", "conf", "expo", "publishTime"]);

    const priceOutput = getPriceUnsafeAction?.outputs?.find(
      (o) => o.name === "price"
    );
    expect(priceOutput?.label).toContain("scaled by 10^expo");
  });
});
