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

  it("configures verified RPC contract addresses across all 8 EVM chains", () => {
    const oracle = pythProtocol.contracts.oracle;
    const customOracle = pythProtocol.contracts.customOracle;

    const expectedAddresses = {
      "1": "0x4305FB66699C3B2702D4d05CF36551390A4c69C6",
      "8453": "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
      "42161": "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
      "10": "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
      "137": "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
      "56": "0x4D7E825f80bDf85e913E0DD2A2D54927e9dE1594",
      "43114": "0x4305FB66699C3B2702D4d05CF36551390A4c69C6",
      "11155111": "0xDd24F84d36BF92C65F92307595335bdFab5Bbd21",
    };

    for (const [chainId, expectedAddr] of Object.entries(expectedAddresses)) {
      expect(oracle.addresses[chainId]).toBe(expectedAddr);
      expect(customOracle.addresses[chainId]).toBe(expectedAddr);
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

  it("derives 4 separate named outputs for price tuples", () => {
    const getPriceUnsafeAction = pythProtocol.actions.find(
      (a) => a.slug === "get-price-unsafe"
    );
    expect(getPriceUnsafeAction).toBeDefined();
    expect(getPriceUnsafeAction?.outputs).toBeDefined();

    const outputNames = getPriceUnsafeAction?.outputs?.map((o) => o.name);
    expect(outputNames).toEqual(["price", "conf", "expo", "publishTime"]);
  });
});
