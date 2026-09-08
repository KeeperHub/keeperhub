import { describe, expect, it } from "vitest";
import { getChainIdFromNetwork, getNetworkName } from "@/lib/rpc/network-utils";
import { SUPPORTED_CHAIN_IDS } from "@/lib/rpc/types";

describe("getChainIdFromNetwork", () => {
  describe("with string network names", () => {
    it("should return chain ID for mainnet", () => {
      expect(getChainIdFromNetwork("mainnet")).toBe(1);
      expect(getChainIdFromNetwork("ethereum-mainnet")).toBe(1);
      expect(getChainIdFromNetwork("ethereum")).toBe(1);
    });

    it("should return chain ID for sepolia", () => {
      expect(getChainIdFromNetwork("sepolia")).toBe(11_155_111);
      expect(getChainIdFromNetwork("sepolia-testnet")).toBe(11_155_111);
    });

    it("should return chain ID for base", () => {
      expect(getChainIdFromNetwork("base")).toBe(8453);
      expect(getChainIdFromNetwork("base-mainnet")).toBe(8453);
    });

    it("should return chain ID for base-sepolia", () => {
      expect(getChainIdFromNetwork("base-sepolia")).toBe(84_532);
    });

    it("should return chain ID for tempo networks", () => {
      expect(getChainIdFromNetwork("tempo-testnet")).toBe(42_431);
      expect(getChainIdFromNetwork("tempo")).toBe(4217);
      expect(getChainIdFromNetwork("tempo-mainnet")).toBe(4217);
    });

    it("should return chain ID for solana networks", () => {
      expect(getChainIdFromNetwork("solana")).toBe(101);
      expect(getChainIdFromNetwork("solana-mainnet")).toBe(101);
      expect(getChainIdFromNetwork("solana-devnet")).toBe(103);
    });

    it("should be case insensitive", () => {
      expect(getChainIdFromNetwork("MAINNET")).toBe(1);
      expect(getChainIdFromNetwork("Sepolia")).toBe(11_155_111);
      expect(getChainIdFromNetwork("BASE")).toBe(8453);
      expect(getChainIdFromNetwork("BASE-SEPOLIA")).toBe(84_532);
    });

    it("should throw for unsupported network", () => {
      expect(() => getChainIdFromNetwork("unsupported")).toThrow(
        "Unsupported network: unsupported"
      );
      expect(() => getChainIdFromNetwork("polygon")).toThrow(
        "Unsupported network: polygon"
      );
    });

    it("should throw with helpful message listing supported networks", () => {
      expect(() => getChainIdFromNetwork("unknown")).toThrow("Supported:");
    });
  });

  describe("with missing network values", () => {
    it("should throw a validation error for undefined", () => {
      expect(() =>
        getChainIdFromNetwork(undefined as unknown as string)
      ).toThrow("Network is required");
    });

    it("should throw a validation error for null", () => {
      expect(() => getChainIdFromNetwork(null as unknown as string)).toThrow(
        "Network is required"
      );
    });

    it("should throw a validation error for empty string", () => {
      expect(() => getChainIdFromNetwork("")).toThrow("Network is required");
    });

    it("should not throw a TypeError for missing values", () => {
      expect(() =>
        getChainIdFromNetwork(undefined as unknown as string)
      ).not.toThrow(TypeError);
    });
  });

  describe("with numeric chain IDs", () => {
    it("should return the same chain ID for numbers", () => {
      expect(getChainIdFromNetwork(1)).toBe(1);
      expect(getChainIdFromNetwork(11_155_111)).toBe(11_155_111);
      expect(getChainIdFromNetwork(8453)).toBe(8453);
    });

    it("should return any numeric chain ID as-is", () => {
      expect(getChainIdFromNetwork(137)).toBe(137); // Polygon
      expect(getChainIdFromNetwork(42_161)).toBe(42_161); // Arbitrum
    });
  });

  describe("with numeric string chain IDs", () => {
    it("should parse numeric strings to chain IDs", () => {
      expect(getChainIdFromNetwork("1")).toBe(1);
      expect(getChainIdFromNetwork("8453")).toBe(8453);
      expect(getChainIdFromNetwork("11155111")).toBe(11_155_111);
      expect(getChainIdFromNetwork("84532")).toBe(84_532);
    });

    it("should handle any valid numeric string", () => {
      expect(getChainIdFromNetwork("137")).toBe(137); // Polygon
      expect(getChainIdFromNetwork("42161")).toBe(42_161); // Arbitrum
    });
  });
});

describe("getNetworkName", () => {
  it("should return name for known chain IDs", () => {
    expect(getNetworkName(1)).toBe("Ethereum Mainnet");
    expect(getNetworkName(11_155_111)).toBe("Ethereum Sepolia");
    expect(getNetworkName(8453)).toBe("Base");
    expect(getNetworkName(84_532)).toBe("Base Sepolia");
    expect(getNetworkName(42_431)).toBe("Tempo Testnet");
    expect(getNetworkName(4217)).toBe("Tempo");
    expect(getNetworkName(101)).toBe("Solana");
    expect(getNetworkName(103)).toBe("Solana Devnet");
  });

  it("should return generic name for unknown chain IDs", () => {
    expect(getNetworkName(137)).toBe("Chain 137");
    expect(getNetworkName(42_161)).toBe("Chain 42161");
    expect(getNetworkName(999_999)).toBe("Chain 999999");
  });
});

describe("SUPPORTED_CHAIN_IDS", () => {
  it("should have correct values for EVM chains", () => {
    expect(SUPPORTED_CHAIN_IDS.MAINNET).toBe(1);
    expect(SUPPORTED_CHAIN_IDS.SEPOLIA).toBe(11_155_111);
    expect(SUPPORTED_CHAIN_IDS.BASE).toBe(8453);
    expect(SUPPORTED_CHAIN_IDS.BASE_SEPOLIA).toBe(84_532);
    expect(SUPPORTED_CHAIN_IDS.TEMPO_TESTNET).toBe(42_431);
    expect(SUPPORTED_CHAIN_IDS.TEMPO_MAINNET).toBe(4217);
  });

  it("should have correct values for Solana chains", () => {
    expect(SUPPORTED_CHAIN_IDS.SOLANA_MAINNET).toBe(101);
    expect(SUPPORTED_CHAIN_IDS.SOLANA_DEVNET).toBe(103);
  });

  it("should have all expected chains", () => {
    // 8 total chains: MAINNET, SEPOLIA, BASE, BASE_SEPOLIA, TEMPO_TESTNET, TEMPO_MAINNET, SOLANA_MAINNET, SOLANA_DEVNET
    expect(Object.keys(SUPPORTED_CHAIN_IDS)).toHaveLength(8);
  });
});
