import { describe, expect, it } from "vitest";
import { createChainDisplay } from "@/lib/hooks/use-chain-display";

const REGISTRY = [
  { chainId: 1, name: "Ethereum Mainnet", symbol: "ETH" },
  { chainId: 101, name: "Solana", symbol: "SOL" },
  { chainId: 8453, name: "Base", symbol: "BASE" },
  { chainId: 42_431, name: "Tempo Testnet", symbol: "TEMPO" },
  { chainId: 43_114, name: "Avalanche", symbol: "AVAX" },
];

describe("createChainDisplay", () => {
  it("names a chain the sponsorship table does not cover", () => {
    const chains = createChainDisplay(REGISTRY);
    expect(chains.name("101")).toBe("Solana");
    expect(chains.name("43114")).toBe("Avalanche");
  });

  it("falls back to the sponsorship name before the registry arrives", () => {
    expect(createChainDisplay(undefined).name("137")).toBe("Polygon");
  });

  it("shows the id for a chain no source knows", () => {
    expect(createChainDisplay(REGISTRY).name("999999")).toBe("999999");
  });

  it("denominates gas in the registry ticker for an unsponsored chain", () => {
    const chains = createChainDisplay(REGISTRY);
    expect(chains.gasSymbol("101")).toBe("SOL");
    expect(chains.gasSymbol("43114")).toBe("AVAX");
  });

  it("keeps the gas token where it differs from the chain ticker", () => {
    expect(createChainDisplay(REGISTRY).gasSymbol("8453")).toBe("ETH");
  });

  it("names no token for a chain no source knows", () => {
    expect(createChainDisplay(REGISTRY).gasSymbol("999999")).toBe("");
    expect(createChainDisplay(REGISTRY).gasSymbol(null)).toBe("");
  });

  it("names a chain a step recorded as a slug", () => {
    const chains = createChainDisplay(REGISTRY);
    expect(chains.name("tempo-testnet")).toBe("Tempo Testnet");
    expect(chains.name("base-sepolia")).toBe("Base Sepolia");
  });

  it("keeps a slug it cannot resolve rather than showing a bare id", () => {
    expect(createChainDisplay(REGISTRY).name("some-chain")).toBe("some-chain");
  });
});
