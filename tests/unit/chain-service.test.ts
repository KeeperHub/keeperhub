import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the database before importing the service
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "@/lib/db";
import {
  createChain,
  getAllChains,
  getChainByChainId,
  getChainById,
  getEnabledChains,
  setChainEnabled,
  updateChain,
} from "@/lib/rpc/chain-service";

describe("chain-service", () => {
  const mockChain = {
    id: "chain_123",
    chainId: 1,
    name: "Ethereum Mainnet",
    symbol: "ETH",
    chainType: "evm",
    defaultPrimaryRpc: "https://eth.example.com",
    defaultFallbackRpc: "https://eth-backup.example.com",
    defaultPrimaryWss: null,
    defaultFallbackWss: null,
    isTestnet: false,
    isEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getEnabledChains", () => {
    it("should return only enabled chains", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockChain]),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await getEnabledChains();

      expect(result).toEqual([mockChain]);
      expect(db.select).toHaveBeenCalled();
    });
  });

  describe("getAllChains", () => {
    it("should return all chains including disabled", async () => {
      const disabledChain = { ...mockChain, isEnabled: false };
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([mockChain, disabledChain]),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await getAllChains();

      expect(result).toHaveLength(2);
    });
  });

  describe("getChainByChainId", () => {
    it("should return chain when found", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockChain]),
          }),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await getChainByChainId(1);

      expect(result).toEqual(mockChain);
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

      const result = await getChainByChainId(999);

      expect(result).toBeNull();
    });
  });

  describe("getChainById", () => {
    it("should return chain when found by internal ID", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockChain]),
          }),
        }),
      });
      vi.mocked(db.select).mockImplementation(mockSelect);

      const result = await getChainById("chain_123");

      expect(result).toEqual(mockChain);
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

      const result = await getChainById("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("createChain", () => {
    it("should create and return new chain", async () => {
      const newChain = {
        chainId: 8453,
        name: "Base",
        symbol: "ETH",
        defaultPrimaryRpc: "https://base.example.com",
      };

      const mockInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([{ ...newChain, id: "chain_456" }]),
        }),
      });
      vi.mocked(db.insert).mockImplementation(mockInsert);

      const result = await createChain(newChain);

      expect(result).toHaveProperty("id", "chain_456");
      expect(result).toHaveProperty("chainId", 8453);
    });
  });

  describe("updateChain", () => {
    it("should update chain and return updated record", async () => {
      const updatedChain = { ...mockChain, name: "Ethereum (Updated)" };

      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedChain]),
          }),
        }),
      });
      vi.mocked(db.update).mockImplementation(mockUpdate);

      const result = await updateChain(1, { name: "Ethereum (Updated)" });

      expect(result).toEqual(updatedChain);
    });

    it("should return null when chain not found", async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      vi.mocked(db.update).mockImplementation(mockUpdate);

      const result = await updateChain(999, { name: "Nonexistent" });

      expect(result).toBeNull();
    });
  });

  describe("setChainEnabled", () => {
    it("should enable a chain", async () => {
      const enabledChain = { ...mockChain, isEnabled: true };

      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([enabledChain]),
          }),
        }),
      });
      vi.mocked(db.update).mockImplementation(mockUpdate);

      const result = await setChainEnabled(1, true);

      expect(result?.isEnabled).toBe(true);
    });

    it("should disable a chain", async () => {
      const disabledChain = { ...mockChain, isEnabled: false };

      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([disabledChain]),
          }),
        }),
      });
      vi.mocked(db.update).mockImplementation(mockUpdate);

      const result = await setChainEnabled(1, false);

      expect(result?.isEnabled).toBe(false);
    });
  });
});
