import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCKSCOUT_INSTANCES } from "@/plugins/blockscout/chains";

const SHANNON_CHAIN_ID = 50_312;
const PRIMARY_RPC = "https://dream-rpc.somnia.network";
const FALLBACK_RPC = "https://rpc.ankr.com/somnia_testnet";
const PRIMARY_WSS = "wss://dream-rpc.somnia.network/ws";
const MAINNET_CHAIN_ID = 5031;
const MAINNET_PRIMARY_RPC = "https://api.infra.mainnet.somnia.network";
const MAINNET_FALLBACK_RPC = "https://somnia-rpc.publicnode.com";
const MAINNET_PRIMARY_WSS = "wss://api.infra.mainnet.somnia.network/ws";

beforeEach(() => {
  vi.stubEnv("CHAIN_RPC_CONFIG", "");
  vi.stubEnv("CHAIN_SOMNIA_SHANNON_PRIMARY_RPC", "");
  vi.stubEnv("CHAIN_SOMNIA_SHANNON_FALLBACK_RPC", "");
  vi.stubEnv("CHAIN_SOMNIA_MAINNET_PRIMARY_RPC", "");
  vi.stubEnv("CHAIN_SOMNIA_MAINNET_FALLBACK_RPC", "");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Somnia Shannon chain onboarding", () => {
  it("resolves independent public RPCs and the official event WebSocket", async () => {
    const { CHAIN_CONFIG, getRpcUrlByChainId, getWssUrl } = await import(
      "@/lib/rpc/rpc-config"
    );

    expect(CHAIN_CONFIG[SHANNON_CHAIN_ID]).toMatchObject({
      jsonKey: "somnia-shannon",
      publicDefault: PRIMARY_RPC,
      publicFallback: FALLBACK_RPC,
      publicWssDefault: PRIMARY_WSS,
    });
    expect(getRpcUrlByChainId(SHANNON_CHAIN_ID)).toBe(PRIMARY_RPC);
    expect(getRpcUrlByChainId(SHANNON_CHAIN_ID, "fallback")).toBe(FALLBACK_RPC);
    expect(
      getWssUrl({ rpcConfig: {}, jsonKey: "somnia-shannon", type: "primary" })
    ).toBe(PRIMARY_WSS);
  });

  it("uses a configured primary RPC instead of the public default", async () => {
    const override = "https://example-internal.invalid/rpc";
    vi.stubEnv("CHAIN_SOMNIA_SHANNON_PRIMARY_RPC", override);
    vi.resetModules();
    const { getRpcUrlByChainId } = await import("@/lib/rpc/rpc-config");

    expect(getRpcUrlByChainId(SHANNON_CHAIN_ID)).toBe(override);
  });

  it("defines Shannon in the seed with its reviewed settings", async () => {
    const {
      buildExplorerConfigs,
      CHAIN_TO_DEFAULT_ID,
      DEFAULT_CHAINS,
      EXPLORER_CONFIG_TEMPLATES,
    } = await import("@/scripts/seed/seed-chains");
    const shannon = DEFAULT_CHAINS.find(
      (chain) => chain.chainId === SHANNON_CHAIN_ID
    );

    expect(shannon).toMatchObject({
      chainId: SHANNON_CHAIN_ID,
      name: "Somnia Shannon",
      symbol: "STT",
      chainType: "evm",
      defaultPrimaryRpc: PRIMARY_RPC,
      defaultFallbackRpc: FALLBACK_RPC,
      defaultPrimaryWss: PRIMARY_WSS,
      isTestnet: true,
      isEnabled: true,
      status: "experimental",
      aliases: [],
    });
    expect(shannon?.defaultPrimaryRpc).not.toBe(shannon?.defaultFallbackRpc);
    // The explorer row the seed would write, built by the same function the
    // seed calls, so no database connection is needed.
    expect(
      buildExplorerConfigs(
        DEFAULT_CHAINS,
        CHAIN_TO_DEFAULT_ID,
        EXPLORER_CONFIG_TEMPLATES
      )
    ).toContainEqual(
      expect.objectContaining({
        chainId: SHANNON_CHAIN_ID,
        chainType: "evm",
        explorerUrl: "https://shannon-explorer.somnia.network",
        explorerApiType: "blockscout",
        explorerApiUrl: "https://shannon-explorer.somnia.network/api",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: "/address/{address}?tab=contract",
      })
    );
  });

  it("registers Shannon, Robinhood Chain, and Arc Testnet Blockscout instances", () => {
    expect(BLOCKSCOUT_INSTANCES).toMatchObject({
      4663: "https://robinhoodchain.blockscout.com",
      5031: "https://explorer.somnia.network",
      50312: "https://shannon-explorer.somnia.network",
      5042002: "https://explorer.testnet.arc.io",
    });
  });
});

describe("Somnia Mainnet chain onboarding", () => {
  it("resolves independent public RPCs and the official event WebSocket", async () => {
    const { CHAIN_CONFIG, getRpcUrlByChainId, getWssUrl } = await import(
      "@/lib/rpc/rpc-config"
    );

    expect(CHAIN_CONFIG[MAINNET_CHAIN_ID]).toMatchObject({
      jsonKey: "somnia-mainnet",
      publicDefault: MAINNET_PRIMARY_RPC,
      publicFallback: MAINNET_FALLBACK_RPC,
      publicWssDefault: MAINNET_PRIMARY_WSS,
    });
    expect(getRpcUrlByChainId(MAINNET_CHAIN_ID)).toBe(MAINNET_PRIMARY_RPC);
    expect(getRpcUrlByChainId(MAINNET_CHAIN_ID, "fallback")).toBe(
      MAINNET_FALLBACK_RPC
    );
    expect(
      getWssUrl({ rpcConfig: {}, jsonKey: "somnia-mainnet", type: "primary" })
    ).toBe(MAINNET_PRIMARY_WSS);
  });

  it("defines Somnia Mainnet in the seed with its explorer", async () => {
    const {
      buildExplorerConfigs,
      CHAIN_TO_DEFAULT_ID,
      DEFAULT_CHAINS,
      EXPLORER_CONFIG_TEMPLATES,
    } = await import("@/scripts/seed/seed-chains");
    const mainnet = DEFAULT_CHAINS.find(
      (chain) => chain.chainId === MAINNET_CHAIN_ID
    );

    expect(mainnet).toMatchObject({
      chainId: MAINNET_CHAIN_ID,
      name: "Somnia",
      symbol: "SOMI",
      chainType: "evm",
      defaultPrimaryRpc: MAINNET_PRIMARY_RPC,
      defaultFallbackRpc: MAINNET_FALLBACK_RPC,
      defaultPrimaryWss: MAINNET_PRIMARY_WSS,
      isTestnet: false,
      isEnabled: true,
      status: "experimental",
      aliases: ["somnia"],
    });
    expect(
      buildExplorerConfigs(
        DEFAULT_CHAINS,
        CHAIN_TO_DEFAULT_ID,
        EXPLORER_CONFIG_TEMPLATES
      )
    ).toContainEqual(
      expect.objectContaining({
        chainId: MAINNET_CHAIN_ID,
        chainType: "evm",
        explorerUrl: "https://explorer.somnia.network",
        explorerApiType: "blockscout",
        explorerApiUrl: "https://explorer.somnia.network/api/",
        explorerTxPath: "/tx/{hash}",
        explorerAddressPath: "/address/{address}",
        explorerContractPath: "/address/{address}?tab=contract",
      })
    );
  });
});
