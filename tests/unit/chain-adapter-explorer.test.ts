import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { query: { explorerConfigs: { findFirst: vi.fn() } } },
}));
vi.mock("@/lib/db/schema", () => ({ explorerConfigs: {} }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@/lib/explorer", () => ({
  getAddressUrl: vi.fn(
    (config, address) => `${config.explorerUrl}/account/${address}`
  ),
  getTransactionUrl: vi.fn(
    (config, txHash) => `${config.explorerUrl}/tx/${txHash}`
  ),
}));

import { db } from "@/lib/db";
import {
  buildChainAddressUrl,
  buildChainTransactionUrl,
  clearExplorerConfigCache,
  getExplorerConfigForChain,
} from "@/lib/web3/chain-adapter/explorer";

const DEVNET_CHAIN_ID = 103;
const MOCK_CONFIG = {
  chainId: DEVNET_CHAIN_ID,
  explorerUrl: "https://solscan.io",
  explorerTxPath: "/tx/{hash}",
  explorerAddressPath: "/account/{address}",
};

describe("chain-adapter/explorer shared helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearExplorerConfigCache();
  });

  afterEach(() => {
    clearExplorerConfigCache();
  });

  describe("getExplorerConfigForChain", () => {
    it("fetches from DB on first call", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst).mockResolvedValue(
        MOCK_CONFIG as never
      );

      const config = await getExplorerConfigForChain(DEVNET_CHAIN_ID);

      expect(config).toEqual(MOCK_CONFIG);
      expect(db.query.explorerConfigs.findFirst).toHaveBeenCalledTimes(1);
    });

    it("returns undefined when DB has no config for chainId", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst).mockResolvedValue(
        undefined
      );

      const config = await getExplorerConfigForChain(DEVNET_CHAIN_ID);

      expect(config).toBeUndefined();
    });

    it("caches the result so DB is not queried again for the same chainId", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst).mockResolvedValue(
        MOCK_CONFIG as never
      );

      await getExplorerConfigForChain(DEVNET_CHAIN_ID);
      await getExplorerConfigForChain(DEVNET_CHAIN_ID);
      await getExplorerConfigForChain(DEVNET_CHAIN_ID);

      expect(db.query.explorerConfigs.findFirst).toHaveBeenCalledTimes(1);
    });

    it("caches a null result (no config) so DB is not queried again", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst).mockResolvedValue(
        undefined
      );

      await getExplorerConfigForChain(DEVNET_CHAIN_ID);
      await getExplorerConfigForChain(DEVNET_CHAIN_ID);

      expect(db.query.explorerConfigs.findFirst).toHaveBeenCalledTimes(1);
    });

    it("caches independently per chainId", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst)
        .mockResolvedValueOnce(MOCK_CONFIG as never)
        .mockResolvedValueOnce(undefined);

      await getExplorerConfigForChain(101); // mainnet
      await getExplorerConfigForChain(103); // devnet
      // Second call for each should use cache
      await getExplorerConfigForChain(101);
      await getExplorerConfigForChain(103);

      // One DB call per distinct chainId
      expect(db.query.explorerConfigs.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe("clearExplorerConfigCache", () => {
    it("forces re-fetch from DB after cache is cleared", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst).mockResolvedValue(
        MOCK_CONFIG as never
      );

      await getExplorerConfigForChain(DEVNET_CHAIN_ID);
      clearExplorerConfigCache();
      await getExplorerConfigForChain(DEVNET_CHAIN_ID);

      expect(db.query.explorerConfigs.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe("buildChainTransactionUrl", () => {
    it("returns formatted transaction URL when config exists", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst).mockResolvedValue(
        MOCK_CONFIG as never
      );

      const url = await buildChainTransactionUrl(DEVNET_CHAIN_ID, "abc123");

      expect(url).toBe("https://solscan.io/tx/abc123");
    });

    it("returns empty string when no config found for chainId", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst).mockResolvedValue(
        undefined
      );

      const url = await buildChainTransactionUrl(DEVNET_CHAIN_ID, "abc123");

      expect(url).toBe("");
    });
  });

  describe("buildChainAddressUrl", () => {
    it("returns formatted address URL when config exists", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst).mockResolvedValue(
        MOCK_CONFIG as never
      );

      const url = await buildChainAddressUrl(
        DEVNET_CHAIN_ID,
        "11111111111111111111111111111111"
      );

      expect(url).toBe(
        "https://solscan.io/account/11111111111111111111111111111111"
      );
    });

    it("returns empty string when no config found for chainId", async () => {
      vi.mocked(db.query.explorerConfigs.findFirst).mockResolvedValue(
        undefined
      );

      const url = await buildChainAddressUrl(
        DEVNET_CHAIN_ID,
        "11111111111111111111111111111111"
      );

      expect(url).toBe("");
    });
  });
});
