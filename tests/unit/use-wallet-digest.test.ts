import { describe, expect, it } from "vitest";
import {
  __fundedAssetsForTesting as fundedAssets,
  type ServerChainBalance,
} from "@/lib/wallet/use-wallet-digest";

const ARC_CHAIN_ID = 5_042_002;
const TEMPO_CHAIN_ID = 4217;
const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

function arcChain(
  overrides: Partial<ServerChainBalance> = {}
): ServerChainBalance {
  return {
    chainId: ARC_CHAIN_ID,
    chainName: "Arc Testnet",
    symbol: "USDC",
    isTestnet: true,
    nativeBalance: "0",
    ...overrides,
  };
}

describe("fundedAssets", () => {
  it("hides Arc's native row once its mirror USDC row is funded", () => {
    const assets = fundedAssets([
      arcChain({
        nativeBalance: "0.083134",
        supportedTokens: [
          {
            balance: "0.083134",
            name: "USD Coin",
            symbol: "USDC",
            tokenAddress: ARC_USDC_ADDRESS,
          },
        ],
      }),
    ]);
    expect(assets.filter((a) => a.kind === "native")).toEqual([]);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: "token", symbol: "USDC" });
  });

  it("keeps Arc's native row visible when the USDC row is an unfunded placeholder", () => {
    // A partial balanceOf failure pushes a "0" row rather than omitting one;
    // that must not be read as "the mirror is funded".
    const assets = fundedAssets([
      arcChain({
        nativeBalance: "378.263571",
        supportedTokens: [
          {
            balance: "0",
            name: "USD Coin",
            symbol: "USDC",
            tokenAddress: ARC_USDC_ADDRESS,
          },
        ],
      }),
    ]);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: "native", symbol: "USDC" });
  });

  it("keeps Arc's native row visible when no supported-token row has loaded yet", () => {
    const assets = fundedAssets([arcChain({ nativeBalance: "0.083134" })]);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: "native", symbol: "USDC" });
  });

  it("keeps Arc's native row visible when a different funded token (EURC) shares the chain but USDC's own row is unfunded", () => {
    const assets = fundedAssets([
      arcChain({
        nativeBalance: "378.263571",
        supportedTokens: [
          {
            balance: "0",
            name: "USD Coin",
            symbol: "USDC",
            tokenAddress: ARC_USDC_ADDRESS,
          },
          {
            balance: "12.5",
            name: "EURC",
            symbol: "EURC",
            tokenAddress: "0x89b50855aa3be2f677cd6303cec089b5f319d72a",
          },
        ],
      }),
    ]);
    expect(assets.filter((a) => a.kind === "native")).toHaveLength(1);
    expect(assets.find((a) => a.kind === "native")).toMatchObject({
      balance: "378.263571",
      symbol: "USDC",
    });
    expect(
      assets.find((a) => a.kind === "token" && a.symbol === "EURC")
    ).toMatchObject({
      balance: "12.5",
    });
  });

  it("hides Tempo's native row unconditionally, even with no supported-token row", () => {
    const assets = fundedAssets([
      {
        chainId: TEMPO_CHAIN_ID,
        chainName: "Tempo",
        isTestnet: false,
        nativeBalance: "5",
        symbol: "TEMPO",
      },
    ]);
    expect(assets.filter((a) => a.kind === "native")).toEqual([]);
  });

  it("includes a plain chain's native and token balances when funded", () => {
    const assets = fundedAssets([
      {
        chainId: 1,
        chainName: "Ethereum Mainnet",
        isTestnet: false,
        nativeBalance: "1.5",
        supportedTokens: [
          {
            balance: "100",
            name: "USD Coin",
            symbol: "USDC",
            tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          },
        ],
        symbol: "ETH",
      },
    ]);
    expect(assets).toHaveLength(2);
    expect(assets.find((a) => a.kind === "native")).toMatchObject({
      balance: "1.5",
      symbol: "ETH",
    });
    expect(assets.find((a) => a.kind === "token")).toMatchObject({
      balance: "100",
      symbol: "USDC",
    });
  });
});
