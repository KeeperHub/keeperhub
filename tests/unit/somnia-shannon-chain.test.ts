import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCKSCOUT_INSTANCES } from "@/plugins/blockscout/chains";

vi.mock("server-only", () => ({}));

const SHANNON_CHAIN_ID = 50_312;
const PUBLIC_RPC = "https://dream-rpc.somnia.network";
const seedChainsSource = readFileSync(
  path.join(process.cwd(), "scripts/seed/seed-chains.ts"),
  "utf8"
);

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

    expect(CHAIN_CONFIG[SHANNON_CHAIN_ID].jsonKey).toBe("somnia-shannon");
    expect(getRpcUrlByChainId(SHANNON_CHAIN_ID)).toBe(PUBLIC_RPC);
    expect(
      getWssUrl({ rpcConfig: {}, jsonKey: "somnia-shannon", type: "primary" })
    ).toBe("wss://dream-rpc.somnia.network/ws");
  });

  it("uses a configured primary RPC instead of the public default", async () => {
    const override = "https://example-internal.invalid/rpc";
    vi.stubEnv("CHAIN_SOMNIA_SHANNON_PRIMARY_RPC", override);
    vi.resetModules();
    const { getRpcUrlByChainId } = await import("@/lib/rpc/rpc-config");

    expect(getRpcUrlByChainId(SHANNON_CHAIN_ID)).toBe(override);
  });

  it("defines Shannon in the executable seed with its reviewed settings", () => {
    expect(seedChainsSource).toMatch(
      /chainId: getChainConfigValue\("somnia-shannon", "chainId", 50_312\)[\s\S]*?name: "Somnia Shannon"[\s\S]*?symbol: getChainConfigValue\("somnia-shannon", "symbol", "STT"\)[\s\S]*?chainType: "evm"[\s\S]*?defaultPrimaryWss: getWssUrl\([\s\S]*?isTestnet: getChainConfigValue\("somnia-shannon", "isTestnet", true\)[\s\S]*?isEnabled: getChainConfigValue\("somnia-shannon", "isEnabled", true\)[\s\S]*?status: "experimental"[\s\S]*?aliases: \[\]/
    );
    expect(seedChainsSource).toMatch(
      /50312: \{[\s\S]*?explorerUrl: "https:\/\/shannon-explorer\.somnia\.network"[\s\S]*?explorerApiType: "blockscout"[\s\S]*?explorerApiUrl: "https:\/\/shannon-explorer\.somnia\.network\/api"/
    );
    expect(seedChainsSource).toContain('"Somnia Shannon": 50_312');
  });

  it("registers Shannon, Robinhood Chain, and Arc Testnet Blockscout instances", () => {
    expect(BLOCKSCOUT_INSTANCES).toMatchObject({
      4663: "https://robinhoodchain.blockscout.com",
      50312: "https://shannon-explorer.somnia.network",
      5042002: "https://explorer.testnet.arc.io",
    });
  });
});
