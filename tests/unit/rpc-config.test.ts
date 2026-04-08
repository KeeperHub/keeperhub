/**
 * Unit tests for RPC URL configuration resolution
 *
 * Tests the priority chain: JSON config → individual env vars → public defaults
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConfigValue,
  getRpcUrl,
  getWssUrl,
  PUBLIC_RPCS,
  parseRpcConfig,
  type RpcConfig,
} from "../../lib/rpc/rpc-config";

describe("RPC Config Resolution", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("parseRpcConfig", () => {
    it("should parse valid JSON config", () => {
      const json = JSON.stringify({
        "eth-mainnet": {
          primaryRpcUrl: "https://primary.example.com",
          fallbackRpcUrl: "https://fallback.example.com",
        },
      });

      const config = parseRpcConfig(json);

      expect(config["eth-mainnet"]?.primaryRpcUrl).toBe(
        "https://primary.example.com"
      );
      expect(config["eth-mainnet"]?.fallbackRpcUrl).toBe(
        "https://fallback.example.com"
      );
    });

    it("should return empty object for undefined", () => {
      const config = parseRpcConfig(undefined);
      expect(config).toEqual({});
    });

    it("should return empty object for empty string", () => {
      const config = parseRpcConfig("");
      expect(config).toEqual({});
    });

    it("should return empty object for invalid JSON", () => {
      const config = parseRpcConfig("not valid json {{{");
      expect(config).toEqual({});
    });

    it("should parse config with all chains", () => {
      const json = JSON.stringify({
        "eth-mainnet": { primaryRpcUrl: "https://eth.example.com" },
        sepolia: { primaryRpcUrl: "https://sepolia.example.com" },
        "base-mainnet": { primaryRpcUrl: "https://base.example.com" },
        "solana-mainnet": { primaryRpcUrl: "https://solana.example.com" },
      });

      const config = parseRpcConfig(json);

      expect(Object.keys(config)).toHaveLength(4);
      expect(config["eth-mainnet"]?.primaryRpcUrl).toBe(
        "https://eth.example.com"
      );
      expect(config["solana-mainnet"]?.primaryRpcUrl).toBe(
        "https://solana.example.com"
      );
    });
  });

  describe("getRpcUrl priority", () => {
    it("should prioritize JSON config over env var and public default", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": { primaryRpcUrl: "https://json-primary.example.com" },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-primary.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      expect(result).toBe("https://json-primary.example.com");
    });

    it("should use env var when JSON config missing chain", () => {
      const rpcConfig: RpcConfig = {
        "other-chain": { primaryRpcUrl: "https://other.example.com" },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-primary.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      expect(result).toBe("https://env-primary.example.com");
    });

    it("should use env var when JSON config missing type", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": { fallbackRpcUrl: "https://json-fallback.example.com" },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-primary.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      expect(result).toBe("https://env-primary.example.com");
    });

    it("should use public default when both JSON and env var missing", () => {
      const rpcConfig: RpcConfig = {};

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: undefined,
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      expect(result).toBe(PUBLIC_RPCS.ETH_MAINNET);
    });

    it("should use public default when JSON empty and env var undefined", () => {
      const rpcConfig: RpcConfig = {};

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "solana-mainnet",
        envValue: undefined,
        publicDefault: PUBLIC_RPCS.SOLANA_MAINNET,
        type: "primary",
      });

      expect(result).toBe(PUBLIC_RPCS.SOLANA_MAINNET);
    });

    it("should handle fallback type correctly", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": {
          primaryRpcUrl: "https://json-primary.example.com",
          fallbackRpcUrl: "https://json-fallback.example.com",
        },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-fallback.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "fallback",
      });

      expect(result).toBe("https://json-fallback.example.com");
    });
  });

  describe("mixed configuration scenarios", () => {
    it("should handle partial JSON config with env var fallbacks", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": { primaryRpcUrl: "https://json-eth.example.com" },
        // solana-mainnet not in JSON
      };

      const ethResult = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-eth.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      const solanaResult = getRpcUrl({
        rpcConfig,
        jsonKey: "solana-mainnet",
        envValue: "https://env-solana.example.com",
        publicDefault: PUBLIC_RPCS.SOLANA_MAINNET,
        type: "primary",
      });

      expect(ethResult).toBe("https://json-eth.example.com");
      expect(solanaResult).toBe("https://env-solana.example.com");
    });

    it("should handle JSON with only primary, env var for fallback", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": { primaryRpcUrl: "https://json-primary.example.com" },
      };

      const primaryResult = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-primary.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      const fallbackResult = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-fallback.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "fallback",
      });

      expect(primaryResult).toBe("https://json-primary.example.com");
      expect(fallbackResult).toBe("https://env-fallback.example.com");
    });

    it("should fall through all levels to public default", () => {
      const rpcConfig: RpcConfig = {};

      // No JSON config, no env var, should use public default
      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "tempo-testnet",
        envValue: undefined,
        publicDefault: PUBLIC_RPCS.TEMPO_TESTNET,
        type: "primary",
      });

      expect(result).toBe(PUBLIC_RPCS.TEMPO_TESTNET);
    });
  });

  describe("all chain keys", () => {
    const chainKeys = [
      { json: "eth-mainnet", public: PUBLIC_RPCS.ETH_MAINNET },
      { json: "eth-sepolia", public: PUBLIC_RPCS.SEPOLIA },
      { json: "base-mainnet", public: PUBLIC_RPCS.BASE_MAINNET },
      { json: "base-testnet", public: PUBLIC_RPCS.BASE_SEPOLIA },
      { json: "tempo-testnet", public: PUBLIC_RPCS.TEMPO_TESTNET },
      { json: "tempo-mainnet", public: PUBLIC_RPCS.TEMPO_MAINNET },
      { json: "solana-mainnet", public: PUBLIC_RPCS.SOLANA_MAINNET },
      { json: "solana-testnet", public: PUBLIC_RPCS.SOLANA_DEVNET },
    ];

    it.each(chainKeys)("should resolve $json from JSON config", ({
      json,
      public: publicDefault,
    }) => {
      const rpcConfig: RpcConfig = {
        [json]: { primaryRpcUrl: `https://${json}.json.example.com` },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: json,
        envValue: undefined,
        publicDefault,
        type: "primary",
      });

      expect(result).toBe(`https://${json}.json.example.com`);
    });

    it.each(
      chainKeys
    )("should fall back to public default for $json when no config", ({
      json,
      public: publicDefault,
    }) => {
      const rpcConfig: RpcConfig = {};

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: json,
        envValue: undefined,
        publicDefault,
        type: "primary",
      });

      expect(result).toBe(publicDefault);
    });
  });

  describe("edge cases", () => {
    it("should handle empty string in JSON config as falsy", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": { primaryRpcUrl: "" },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      // Empty string is falsy, should fall through to env var
      expect(result).toBe("https://env.example.com");
    });

    it("should handle null-ish values gracefully", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": { primaryRpcUrl: undefined },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: undefined,
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      expect(result).toBe(PUBLIC_RPCS.ETH_MAINNET);
    });

    it("should handle deeply nested undefined", () => {
      const rpcConfig: RpcConfig = {};

      // Accessing undefined chain then undefined type
      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "nonexistent-chain",
        envValue: undefined,
        publicDefault: "https://default.example.com",
        type: "primary",
      });

      expect(result).toBe("https://default.example.com");
    });
  });

  describe("full integration simulation", () => {
    it("should resolve all chains from complete JSON config", () => {
      const fullConfig: RpcConfig = {
        "eth-mainnet": {
          primaryRpcUrl: "https://eth.primary.com",
          fallbackRpcUrl: "https://eth.fallback.com",
        },
        "eth-sepolia": {
          primaryRpcUrl: "https://sepolia.primary.com",
          fallbackRpcUrl: "https://sepolia.fallback.com",
        },
        "base-mainnet": {
          primaryRpcUrl: "https://base.primary.com",
          fallbackRpcUrl: "https://base.fallback.com",
        },
        "base-testnet": {
          primaryRpcUrl: "https://base-sep.primary.com",
          fallbackRpcUrl: "https://base-sep.fallback.com",
        },
        "tempo-testnet": {
          primaryRpcUrl: "https://tempo-test.primary.com",
          fallbackRpcUrl: "https://tempo-test.fallback.com",
        },
        "tempo-mainnet": {
          primaryRpcUrl: "https://tempo.primary.com",
          fallbackRpcUrl: "https://tempo.fallback.com",
        },
        "solana-mainnet": {
          primaryRpcUrl: "https://solana.primary.com",
          fallbackRpcUrl: "https://solana.fallback.com",
        },
        "solana-testnet": {
          primaryRpcUrl: "https://solana-dev.primary.com",
          fallbackRpcUrl: "https://solana-dev.fallback.com",
        },
      };

      // Verify all chains resolve from JSON
      expect(
        getRpcUrl({
          rpcConfig: fullConfig,
          jsonKey: "eth-mainnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.ETH_MAINNET,
          type: "primary",
        })
      ).toBe("https://eth.primary.com");

      expect(
        getRpcUrl({
          rpcConfig: fullConfig,
          jsonKey: "solana-mainnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.SOLANA_MAINNET,
          type: "fallback",
        })
      ).toBe("https://solana.fallback.com");

      expect(
        getRpcUrl({
          rpcConfig: fullConfig,
          jsonKey: "tempo-testnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.TEMPO_TESTNET,
          type: "primary",
        })
      ).toBe("https://tempo-test.primary.com");
    });

    it("should work with realistic JSON string parsing", () => {
      const jsonString = JSON.stringify({
        "eth-mainnet": {
          primaryRpcUrl: "https://chain.techops.services/eth-mainnet",
          fallbackRpcUrl: "https://1rpc.io/eth",
        },
        "solana-mainnet": {
          primaryRpcUrl: "https://solana-mainnet.g.alchemy.com/v2/key123",
          fallbackRpcUrl: "https://api.mainnet-beta.solana.com",
        },
      });

      const config = parseRpcConfig(jsonString);

      expect(
        getRpcUrl({
          rpcConfig: config,
          jsonKey: "eth-mainnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.ETH_MAINNET,
          type: "primary",
        })
      ).toBe("https://chain.techops.services/eth-mainnet");

      expect(
        getRpcUrl({
          rpcConfig: config,
          jsonKey: "solana-mainnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.SOLANA_MAINNET,
          type: "primary",
        })
      ).toBe("https://solana-mainnet.g.alchemy.com/v2/key123");

      // Chain not in JSON should use public default
      expect(
        getRpcUrl({
          rpcConfig: config,
          jsonKey: "tempo-testnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.TEMPO_TESTNET,
          type: "primary",
        })
      ).toBe(PUBLIC_RPCS.TEMPO_TESTNET);
    });
  });

  describe("AWS Parameter Store schema format", () => {
    it("should parse schema format with all fields", () => {
      const json = JSON.stringify({
        "eth-mainnet": {
          chainId: 1,
          symbol: "ETH",
          primaryRpcUrl: "https://chain.techops.live/eth-mainnet",
          fallbackRpcUrl: "https://eth-mainnet.g.alchemy.com/v2/key",
          primaryWssUrl: "wss://chain.techops.live/eth-mainnet",
          fallbackWssUrl: "wss://eth-mainnet.g.alchemy.com/v2/key",
          isEnabled: true,
          isTestnet: false,
        },
      });

      const config = parseRpcConfig(json);

      expect(config["eth-mainnet"]?.chainId).toBe(1);
      expect(config["eth-mainnet"]?.symbol).toBe("ETH");
      expect(config["eth-mainnet"]?.primaryRpcUrl).toBe(
        "https://chain.techops.live/eth-mainnet"
      );
      expect(config["eth-mainnet"]?.fallbackRpcUrl).toBe(
        "https://eth-mainnet.g.alchemy.com/v2/key"
      );
      expect(config["eth-mainnet"]?.primaryWssUrl).toBe(
        "wss://chain.techops.live/eth-mainnet"
      );
      expect(config["eth-mainnet"]?.fallbackWssUrl).toBe(
        "wss://eth-mainnet.g.alchemy.com/v2/key"
      );
      expect(config["eth-mainnet"]?.isEnabled).toBe(true);
      expect(config["eth-mainnet"]?.isTestnet).toBe(false);
    });

    it("should use primaryRpcUrl from config", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": {
          primaryRpcUrl: "https://new-schema.example.com",
        },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      expect(result).toBe("https://new-schema.example.com");
    });

    it("should use fallbackRpcUrl from config", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": {
          fallbackRpcUrl: "https://new-schema-fallback.example.com",
        },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "fallback",
      });

      expect(result).toBe("https://new-schema-fallback.example.com");
    });

    it("should fall back to env var when RPC URL fields missing", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": {
          chainId: 1,
          symbol: "ETH",
          // No RPC URLs
        },
      };

      const primaryResult = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-primary.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      const fallbackResult = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-fallback.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "fallback",
      });

      expect(primaryResult).toBe("https://env-primary.example.com");
      expect(fallbackResult).toBe("https://env-fallback.example.com");
    });

    it("should fall through to env var when new schema field is missing", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": {
          chainId: 1,
          symbol: "ETH",
          // No primaryRpcUrl or primary
        },
      };

      const result = getRpcUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        envValue: "https://env-fallback.example.com",
        publicDefault: PUBLIC_RPCS.ETH_MAINNET,
        type: "primary",
      });

      expect(result).toBe("https://env-fallback.example.com");
    });

    it("should work with realistic Parameter Store JSON", () => {
      const parameterStoreJson = JSON.stringify({
        "eth-mainnet": {
          chainId: 1,
          symbol: "ETH",
          primaryRpcUrl: "https://chain.techops.live/eth-mainnet",
          fallbackRpcUrl:
            "https://eth-mainnet.g.alchemy.com/v2/s_8VpY02izssHI4yW2uyC1XWkrMCdS7a",
          primaryWssUrl: "wss://chain.techops.live/eth-mainnet",
          fallbackWssUrl:
            "wss://eth-mainnet.g.alchemy.com/v2/s_8VpY02izssHI4yW2uyC1XWkrMCdS7a",
          isEnabled: true,
          isTestnet: false,
        },
        "eth-sepolia": {
          chainId: 11_155_111,
          symbol: "ETH",
          primaryRpcUrl: "https://chain.techops.live/eth-sepolia",
          fallbackRpcUrl: "https://rpc.sepolia.org",
          primaryWssUrl: "wss://chain.techops.live/eth-sepolia",
          fallbackWssUrl: "wss://rpc.sepolia.org",
          isEnabled: true,
          isTestnet: true,
        },
      });

      const config = parseRpcConfig(parameterStoreJson);

      // Verify eth-mainnet
      expect(
        getRpcUrl({
          rpcConfig: config,
          jsonKey: "eth-mainnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.ETH_MAINNET,
          type: "primary",
        })
      ).toBe("https://chain.techops.live/eth-mainnet");

      expect(
        getRpcUrl({
          rpcConfig: config,
          jsonKey: "eth-mainnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.ETH_MAINNET,
          type: "fallback",
        })
      ).toBe(
        "https://eth-mainnet.g.alchemy.com/v2/s_8VpY02izssHI4yW2uyC1XWkrMCdS7a"
      );

      // Verify eth-sepolia
      expect(
        getRpcUrl({
          rpcConfig: config,
          jsonKey: "eth-sepolia",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.SEPOLIA,
          type: "primary",
        })
      ).toBe("https://chain.techops.live/eth-sepolia");
    });
  });

  describe("getWssUrl", () => {
    it("should return primary WSS URL", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": {
          primaryWssUrl: "wss://chain.techops.live/eth-mainnet",
          fallbackWssUrl: "wss://eth.fallback.com",
        },
      };

      const result = getWssUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        type: "primary",
      });

      expect(result).toBe("wss://chain.techops.live/eth-mainnet");
    });

    it("should return fallback WSS URL", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": {
          primaryWssUrl: "wss://chain.techops.live/eth-mainnet",
          fallbackWssUrl: "wss://eth.fallback.com",
        },
      };

      const result = getWssUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        type: "fallback",
      });

      expect(result).toBe("wss://eth.fallback.com");
    });

    it("should return undefined when WSS URL not configured", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": {
          primaryRpcUrl: "https://chain.techops.live/eth-mainnet",
          // No WSS URLs
        },
      };

      const result = getWssUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        type: "primary",
      });

      expect(result).toBeUndefined();
    });

    it("should return undefined when chain not in config", () => {
      const rpcConfig: RpcConfig = {};

      const result = getWssUrl({
        rpcConfig,
        jsonKey: "eth-mainnet",
        type: "primary",
      });

      expect(result).toBeUndefined();
    });
  });

  describe("Full schema integration", () => {
    it("should resolve all field types from complete config", () => {
      const fullConfig: RpcConfig = {
        "eth-mainnet": {
          chainId: 1,
          symbol: "ETH",
          primaryRpcUrl: "https://chain.techops.live/eth-mainnet",
          fallbackRpcUrl: "https://eth.fallback.com",
          primaryWssUrl: "wss://chain.techops.live/eth-mainnet",
          fallbackWssUrl: "wss://eth.fallback.com",
          isEnabled: true,
          isTestnet: false,
        },
      };

      // RPC URLs
      expect(
        getRpcUrl({
          rpcConfig: fullConfig,
          jsonKey: "eth-mainnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.ETH_MAINNET,
          type: "primary",
        })
      ).toBe("https://chain.techops.live/eth-mainnet");

      expect(
        getRpcUrl({
          rpcConfig: fullConfig,
          jsonKey: "eth-mainnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.ETH_MAINNET,
          type: "fallback",
        })
      ).toBe("https://eth.fallback.com");

      // WSS URLs
      expect(
        getWssUrl({
          rpcConfig: fullConfig,
          jsonKey: "eth-mainnet",
          type: "primary",
        })
      ).toBe("wss://chain.techops.live/eth-mainnet");

      expect(
        getWssUrl({
          rpcConfig: fullConfig,
          jsonKey: "eth-mainnet",
          type: "fallback",
        })
      ).toBe("wss://eth.fallback.com");
    });

    it("should handle multiple chains", () => {
      const multiChainConfig: RpcConfig = {
        "eth-mainnet": {
          chainId: 1,
          symbol: "ETH",
          primaryRpcUrl: "https://eth.example.com",
          primaryWssUrl: "wss://eth.example.com",
          isEnabled: true,
          isTestnet: false,
        },
        "eth-sepolia": {
          chainId: 11_155_111,
          symbol: "ETH",
          primaryRpcUrl: "https://sepolia.example.com",
          primaryWssUrl: "wss://sepolia.example.com",
          isEnabled: true,
          isTestnet: true,
        },
      };

      expect(
        getRpcUrl({
          rpcConfig: multiChainConfig,
          jsonKey: "eth-mainnet",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.ETH_MAINNET,
          type: "primary",
        })
      ).toBe("https://eth.example.com");

      expect(
        getRpcUrl({
          rpcConfig: multiChainConfig,
          jsonKey: "eth-sepolia",
          envValue: undefined,
          publicDefault: PUBLIC_RPCS.SEPOLIA,
          type: "primary",
        })
      ).toBe("https://sepolia.example.com");

      expect(
        getWssUrl({
          rpcConfig: multiChainConfig,
          jsonKey: "eth-mainnet",
          type: "primary",
        })
      ).toBe("wss://eth.example.com");

      expect(
        getWssUrl({
          rpcConfig: multiChainConfig,
          jsonKey: "eth-sepolia",
          type: "primary",
        })
      ).toBe("wss://sepolia.example.com");
    });
  });

  describe("getConfigValue", () => {
    it("should return symbol from config when present", () => {
      const rpcConfig: RpcConfig = {
        "base-mainnet": {
          symbol: "BASE",
          chainId: 8453,
        },
      };

      expect(getConfigValue(rpcConfig, "base-mainnet", "symbol", "ETH")).toBe(
        "BASE"
      );
    });

    it("should return default when symbol not in config", () => {
      const rpcConfig: RpcConfig = {
        "base-mainnet": {
          chainId: 8453,
        },
      };

      expect(getConfigValue(rpcConfig, "base-mainnet", "symbol", "ETH")).toBe(
        "ETH"
      );
    });

    it("should return default when chain not in config", () => {
      const rpcConfig: RpcConfig = {};

      expect(getConfigValue(rpcConfig, "base-mainnet", "symbol", "BASE")).toBe(
        "BASE"
      );
    });

    it("should return chainId from config when present", () => {
      const rpcConfig: RpcConfig = {
        "eth-mainnet": {
          chainId: 1,
          symbol: "ETH",
        },
      };

      expect(getConfigValue(rpcConfig, "eth-mainnet", "chainId", 0)).toBe(1);
    });

    it("should return isEnabled from config when present", () => {
      const rpcConfig: RpcConfig = {
        "tempo-mainnet": {
          isEnabled: false,
        },
      };

      expect(
        getConfigValue(rpcConfig, "tempo-mainnet", "isEnabled", true)
      ).toBe(false);
    });

    it("should return isTestnet from config when present", () => {
      const rpcConfig: RpcConfig = {
        "eth-sepolia": {
          isTestnet: true,
        },
      };

      expect(getConfigValue(rpcConfig, "eth-sepolia", "isTestnet", false)).toBe(
        true
      );
    });

    it("should handle undefined value in config by returning default", () => {
      const rpcConfig: RpcConfig = {
        "base-mainnet": {
          symbol: undefined,
        },
      };

      expect(getConfigValue(rpcConfig, "base-mainnet", "symbol", "BASE")).toBe(
        "BASE"
      );
    });

    it("should work with all chain metadata fields", () => {
      const rpcConfig: RpcConfig = {
        "tempo-testnet": {
          chainId: 42_429,
          symbol: "TEMPO",
          isEnabled: true,
          isTestnet: true,
        },
      };

      expect(getConfigValue(rpcConfig, "tempo-testnet", "chainId", 0)).toBe(
        42_429
      );
      expect(getConfigValue(rpcConfig, "tempo-testnet", "symbol", "USD")).toBe(
        "TEMPO"
      );
      expect(
        getConfigValue(rpcConfig, "tempo-testnet", "isEnabled", false)
      ).toBe(true);
      expect(
        getConfigValue(rpcConfig, "tempo-testnet", "isTestnet", false)
      ).toBe(true);
    });

    it("should return false boolean from config (not treat as falsy)", () => {
      const rpcConfig: RpcConfig = {
        "tempo-mainnet": {
          isEnabled: false,
          isTestnet: false,
        },
      };

      expect(
        getConfigValue(rpcConfig, "tempo-mainnet", "isEnabled", true)
      ).toBe(false);
      expect(
        getConfigValue(rpcConfig, "tempo-mainnet", "isTestnet", true)
      ).toBe(false);
    });
  });
});
