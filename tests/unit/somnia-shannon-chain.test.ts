import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CHAIN_CONFIG,
  getRpcUrlByChainId,
  getWssUrl,
} from "@/lib/rpc/rpc-config";
import { EvmChainAdapter } from "@/lib/web3/chain-adapter/evm";
import { getChainAdapter } from "@/lib/web3/chain-adapter/registry";
import { BLOCKSCOUT_INSTANCES } from "@/plugins/blockscout/chains";
import { DEFAULT_CHAINS, getExplorerConfigs } from "@/scripts/seed/seed-chains";

const SHANNON_CHAIN_ID = 50_312;

describe("Somnia Shannon chain onboarding", () => {
  it("resolves the accepted RPC and official event WebSocket", () => {
    expect(CHAIN_CONFIG[SHANNON_CHAIN_ID].jsonKey).toBe("somnia-shannon");
    expect(getRpcUrlByChainId(SHANNON_CHAIN_ID)).toBe(
      "https://dream-rpc.somnia.network"
    );
    expect(
      getWssUrl({
        rpcConfig: {},
        jsonKey: "somnia-shannon",
        type: "primary",
      })
    ).toBe("wss://dream-rpc.somnia.network/ws");
  });

  it("seeds an enabled EVM testnet with STT and stable aliases", () => {
    const shannon = DEFAULT_CHAINS.find(
      (chain) => chain.chainId === SHANNON_CHAIN_ID
    );

    expect(shannon).toMatchObject({
      name: "Somnia Shannon Testnet",
      symbol: "STT",
      chainType: "evm",
      defaultPrimaryRpc: "https://dream-rpc.somnia.network",
      defaultPrimaryWss: "wss://dream-rpc.somnia.network/ws",
      isTestnet: true,
      isEnabled: true,
      aliases: ["somnia", "somnia-shannon", "shannon"],
    });
    expect(
      DEFAULT_CHAINS.filter((chain) => chain.chainId === SHANNON_CHAIN_ID)
    ).toHaveLength(1);
  });

  it("uses the generic EVM execution adapter", () => {
    expect(getChainAdapter(SHANNON_CHAIN_ID)).toBeInstanceOf(EvmChainAdapter);
  });

  it("constructs a Blockscout explorer config for every seeded chain", () => {
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
