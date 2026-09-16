import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCKSCOUT_INSTANCES } from "@/plugins/blockscout/chains";

vi.mock("server-only", () => ({}));

const SHANNON_CHAIN_ID = 50_312;
const PUBLIC_RPC = "https://dream-rpc.somnia.network";

beforeEach(() => {
  vi.stubEnv("CHAIN_RPC_CONFIG", "");
  vi.stubEnv("CHAIN_SOMNIA_SHANNON_PRIMARY_RPC", "");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Somnia Shannon chain onboarding", () => {
  it("uses the public RPC and official event WebSocket without an override", async () => {
    const { CHAIN_CONFIG, getRpcUrlByChainId, getWssUrl } = await import(
      "@/lib/rpc/rpc-config"
    );
    const { DEFAULT_CHAINS } = await import("@/scripts/seed/seed-chain-data");
    const shannon = DEFAULT_CHAINS.find(
      (chain) => chain.chainId === SHANNON_CHAIN_ID
    );

    expect(CHAIN_CONFIG[SHANNON_CHAIN_ID].jsonKey).toBe("somnia-shannon");
    expect(getRpcUrlByChainId(SHANNON_CHAIN_ID)).toBe(PUBLIC_RPC);
    expect(shannon?.defaultPrimaryRpc).toBe(PUBLIC_RPC);
    expect(
      getWssUrl({ rpcConfig: {}, jsonKey: "somnia-shannon", type: "primary" })
    ).toBe("wss://dream-rpc.somnia.network/ws");
  });

  it("uses a configured primary RPC in the seed instead of the public default", async () => {
    const override = "https://example-internal.invalid/rpc";
    vi.stubEnv("CHAIN_SOMNIA_SHANNON_PRIMARY_RPC", override);
    vi.resetModules();
    const { getRpcUrlByChainId } = await import("@/lib/rpc/rpc-config");
    const { DEFAULT_CHAINS } = await import("@/scripts/seed/seed-chain-data");

    expect(getRpcUrlByChainId(SHANNON_CHAIN_ID)).toBe(override);
    expect(
      DEFAULT_CHAINS.find((chain) => chain.chainId === SHANNON_CHAIN_ID)
        ?.defaultPrimaryRpc
    ).toBe(override);
  });

  it("seeds an enabled experimental EVM testnet without aliases", async () => {
    const { DEFAULT_CHAINS } = await import("@/scripts/seed/seed-chain-data");
    const shannon = DEFAULT_CHAINS.find(
      (chain) => chain.chainId === SHANNON_CHAIN_ID
    );

    expect(shannon).toMatchObject({
      name: "Somnia Shannon Testnet",
      symbol: "STT",
      chainType: "evm",
      defaultPrimaryWss: "wss://dream-rpc.somnia.network/ws",
      isTestnet: true,
      isEnabled: true,
      status: "experimental",
      aliases: [],
    });
    expect(
      DEFAULT_CHAINS.filter((chain) => chain.chainId === SHANNON_CHAIN_ID)
    ).toHaveLength(1);
  });

  it("constructs a Blockscout explorer config for every seeded chain", async () => {
    const { DEFAULT_CHAINS, getExplorerConfigs } = await import(
      "@/scripts/seed/seed-chain-data"
    );
    const explorers = getExplorerConfigs();
    expect(explorers).toHaveLength(DEFAULT_CHAINS.length);

    const shannon = explorers.find(
      (config) => config.chainId === SHANNON_CHAIN_ID
    );
    expect(shannon).toMatchObject({
      explorerUrl: "https://shannon-explorer.somnia.network",
      explorerApiType: "blockscout",
      explorerApiUrl: "https://shannon-explorer.somnia.network/api",
      explorerTxPath: "/tx/{hash}",
      explorerAddressPath: "/address/{address}",
    });
    expect(BLOCKSCOUT_INSTANCES[SHANNON_CHAIN_ID]).toBe(shannon?.explorerUrl);
    expect(
      `${shannon?.explorerUrl}${shannon?.explorerTxPath?.replace("{hash}", "0xabc")}`
    ).toBe("https://shannon-explorer.somnia.network/tx/0xabc");
  });
});
