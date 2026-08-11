import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the database before importing the service
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { db } from "@/lib/db";
import {
  deleteUserRpcPreference,
  getUserRpcPreferences,
  resolveAllRpcConfigs,
  resolveRpcConfig,
  setUserRpcPreference,
} from "@/lib/rpc/config-service";

describe("config-service", () => {
  const mockChain = {
    id: "chain_1",
    chainId: 1,
    name: "Ethereum Mainnet",
    symbol: "ETH",
    defaultPrimaryRpc: "https://default-eth.example.com",
    defaultFallbackRpc: "https://default-eth-backup.example.com",
    isEnabled: true,
  };

  const mockUserPref = {
    id: "pref_1",
    userId: "user_123",
    chainId: 1,
    primaryRpcUrl: "https://user-eth.example.com",
    fallbackRpcUrl: "https://user-eth-backup.example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function mockChainQuery(chain: Record<string, unknown>): void {
    vi.mocked(db.select).mockImplementation(
      vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([chain]),
          }),
        }),
      })
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveRpcConfig", () => {
    it("should return chain defaults when no userId provided", async () => {
      // Mock chain query
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockChain]),
          }),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await resolveRpcConfig(1);

      expect(result).toEqual({
        chainId: 1,
        chainName: "Ethereum Mainnet",
        primaryRpcUrl: "https://default-eth.example.com",
        fallbackRpcUrl: "https://default-eth-backup.example.com",
        primaryWssUrl: undefined,
        fallbackWssUrl: undefined,
        usePrivateMempoolRpc: false,
        privateRpcUrl: undefined,
        source: "default",
      });
    });

    it("should return user preferences when user has custom config", async () => {
      // Mock chain query (first call)
      // Mock user pref query (second call)
      let callCount = 0;
      const mockSelect = vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          // Chain query
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([mockChain]),
              }),
            }),
          };
        }
        // User pref query
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockUserPref]),
            }),
          }),
        };
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await resolveRpcConfig(1, "user_123");

      expect(result).toEqual({
        chainId: 1,
        chainName: "Ethereum Mainnet",
        primaryRpcUrl: "https://user-eth.example.com",
        fallbackRpcUrl: "https://user-eth-backup.example.com",
        primaryWssUrl: undefined,
        fallbackWssUrl: undefined,
        usePrivateMempoolRpc: false,
        privateRpcUrl: undefined,
        source: "user",
      });
    });

    it("should return chain defaults when user has no custom config", async () => {
      let callCount = 0;
      const mockSelect = vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([mockChain]),
              }),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        };
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await resolveRpcConfig(1, "user_456");

      expect(result?.source).toBe("default");
    });

    it("should return null when chain not found", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await resolveRpcConfig(999);

      expect(result).toBeNull();
    });

    it("should return null when chain is disabled", async () => {
      const _disabledChain = { ...mockChain, isEnabled: false };
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await resolveRpcConfig(1);

      expect(result).toBeNull();
    });

    it("flags the primary as the private relay when the swap applies", async () => {
      mockChainQuery({
        ...mockChain,
        usePrivateMempoolRpc: true,
        defaultPrivateRpcUrl: "https://rpc.flashbots.example.com",
      });

      const result = await resolveRpcConfig(1, undefined, {
        usePrivateMempool: true,
      });

      expect(result?.primaryRpcUrl).toBe("https://rpc.flashbots.example.com");
      expect(result?.primaryIsPrivateRelay).toBe(true);
      // Strict by default: no fallback, so the relay is the only endpoint in
      // the round and a transport failure is attributable to it alone.
      expect(result?.fallbackRpcUrl).toBeUndefined();
    });

    it("keeps our own endpoint as the fallback when the swap is not strict", async () => {
      mockChainQuery({
        ...mockChain,
        usePrivateMempoolRpc: true,
        defaultPrivateRpcUrl: "https://rpc.flashbots.example.com",
      });

      const result = await resolveRpcConfig(1, undefined, {
        usePrivateMempool: true,
        strict: false,
      });

      expect(result?.primaryIsPrivateRelay).toBe(true);
      expect(result?.fallbackRpcUrl).toBe("https://default-eth.example.com");
    });

    it("does not flag the relay when the chain does not support private mempool", async () => {
      mockChainQuery(mockChain);

      const result = await resolveRpcConfig(1, undefined, {
        usePrivateMempool: true,
      });

      expect(result?.primaryRpcUrl).toBe("https://default-eth.example.com");
      expect(result?.primaryIsPrivateRelay).toBeUndefined();
    });

    it("does not flag the relay when the node did not ask for the private mempool", async () => {
      mockChainQuery({
        ...mockChain,
        usePrivateMempoolRpc: true,
        defaultPrivateRpcUrl: "https://rpc.flashbots.example.com",
      });

      const result = await resolveRpcConfig(1);

      expect(result?.primaryRpcUrl).toBe("https://default-eth.example.com");
      expect(result?.primaryIsPrivateRelay).toBeUndefined();
    });
  });

  describe("resolveAllRpcConfigs", () => {
    it("should return configs for all enabled chains", async () => {
      const sepoliaChain = {
        ...mockChain,
        id: "chain_2",
        chainId: 11_155_111,
        name: "Sepolia",
        defaultPrimaryRpc: "https://sepolia.example.com",
        defaultFallbackRpc: null,
      };

      let callCount = 0;
      const mockSelect = vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          // Get all enabled chains
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([mockChain, sepoliaChain]),
            }),
          };
        }
        // Get user prefs (empty for no userId)
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await resolveAllRpcConfigs();

      expect(result).toHaveLength(2);
      expect(result[0].chainId).toBe(1);
      expect(result[0].source).toBe("default");
      expect(result[1].chainId).toBe(11_155_111);
    });

    it("should include user preferences when userId provided", async () => {
      let callCount = 0;
      const mockSelect = vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([mockChain]),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([mockUserPref]),
          }),
        };
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await resolveAllRpcConfigs("user_123");

      expect(result[0].source).toBe("user");
      expect(result[0].primaryRpcUrl).toBe("https://user-eth.example.com");
    });
  });

  describe("getUserRpcPreferences", () => {
    it("should return all preferences for a user", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockUserPref]),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await getUserRpcPreferences("user_123");

      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe("user_123");
    });

    it("should return empty array when user has no preferences", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await getUserRpcPreferences("user_456");

      expect(result).toHaveLength(0);
    });
  });

  describe("setUserRpcPreference", () => {
    it("should create new preference when none exists", async () => {
      // Mock check for existing (returns empty)
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      // Mock insert
      const newPref = { ...mockUserPref, id: "pref_new" };
      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newPref]),
        }),
      });
      vi.mocked(db.insert).mockImplementation(mockInsert);

      const result = await setUserRpcPreference(
        "user_123",
        1,
        "https://new-rpc.example.com",
        "https://new-backup.example.com"
      );

      expect(db.insert).toHaveBeenCalled();
      expect(result.id).toBe("pref_new");
    });

    it("should update existing preference", async () => {
      // Mock check for existing (returns existing pref)
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockUserPref]),
          }),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      // Mock update
      const updatedPref = {
        ...mockUserPref,
        primaryRpcUrl: "https://updated-rpc.example.com",
      };
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedPref]),
          }),
        }),
      });
      vi.mocked(db.update).mockImplementation(mockUpdate);

      const result = await setUserRpcPreference(
        "user_123",
        1,
        "https://updated-rpc.example.com"
      );

      expect(db.update).toHaveBeenCalled();
      expect(result.primaryRpcUrl).toBe("https://updated-rpc.example.com");
    });
  });

  describe("deleteUserRpcPreference", () => {
    it("should delete preference and return true", async () => {
      const mockDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockUserPref]),
        }),
      });
      vi.mocked(db.delete).mockImplementation(mockDelete);

      const result = await deleteUserRpcPreference("user_123", 1);

      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it("should return false when preference not found", async () => {
      const mockDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });
      vi.mocked(db.delete).mockImplementation(mockDelete);

      const result = await deleteUserRpcPreference("user_456", 999);

      expect(result).toBe(false);
    });
  });
});
