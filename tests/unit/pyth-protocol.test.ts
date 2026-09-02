import { describe, expect, it } from "vitest";
import pythProtocol from "@/protocols/pyth";

describe("Pyth Network Protocol Definition", () => {
  it("has correct protocol metadata", () => {
    expect(pythProtocol.name).toBe("Pyth Network");
    expect(pythProtocol.slug).toBe("pyth");
    expect(pythProtocol.contracts.oracle).toBeDefined();
    expect(pythProtocol.contracts.customOracle).toBeDefined();
  });

  it("configures expected contract addresses across chains", () => {
    const oracle = pythProtocol.contracts.oracle;
    expect(oracle.addresses["1"]).toBe(
      "0x4305FB66699C3B2702D4d05CF36551390A4c69C6"
    );
    expect(oracle.addresses["8453"]).toBe(
      "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a"
    );
    expect(oracle.addresses["42161"]).toBe(
      "0xff1a0f4744e8582DF1aE519577d3E054501020E0"
    );
    expect(oracle.addresses["11155111"]).toBe(
      "0xDd24F84d36BF92C65F92307595335bdFab5Bbd21"
    );
  });

  it("defines expected actions for Pyth on-chain reads", () => {
    const actionSlugs = pythProtocol.actions.map((a) => a.slug);
    expect(actionSlugs).toContain("get-price");
    expect(actionSlugs).toContain("get-price-no-older-than");
    expect(actionSlugs).toContain("get-ema-price");
    expect(actionSlugs).toContain("get-ema-price-no-older-than");
    expect(actionSlugs).toContain("custom-get-price");
  });
});
