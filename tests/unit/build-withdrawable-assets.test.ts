import { describe, expect, it } from "vitest";
import {
  type BuildWithdrawableAssetsInput,
  buildWithdrawableAssets,
} from "@/lib/wallet/build-withdrawable-assets";
import type {
  ChainBalance,
  ChainData,
  SupportedToken,
  SupportedTokenBalance,
  TokenBalance,
  TokenData,
} from "@/lib/wallet/types";

const MAINNET: ChainData = {
  id: "eth-mainnet",
  chainId: 1,
  name: "Ethereum Mainnet",
  symbol: "ETH",
  chainType: "evm",
  explorerUrl: null,
  explorerAddressPath: null,
  isTestnet: false,
  isEnabled: true,
};

const SEPOLIA: ChainData = {
  ...MAINNET,
  id: "eth-sepolia",
  chainId: 11_155_111,
  name: "Ethereum Sepolia",
  isTestnet: true,
};

const TEMPO: ChainData = {
  ...MAINNET,
  id: "tempo",
  chainId: 4217,
  name: "Tempo",
};

function nativeBalance(overrides: Partial<ChainBalance> = {}): ChainBalance {
  return {
    chainId: 1,
    name: "Ethereum Mainnet",
    symbol: "ETH",
    balance: "1.000000",
    loading: false,
    isTestnet: false,
    explorerUrl: "https://etherscan.io/address/0x0",
    ...overrides,
  };
}

function supportedTokenBalance(
  overrides: Partial<SupportedTokenBalance> = {}
): SupportedTokenBalance {
  return {
    chainId: 1,
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    symbol: "USDC",
    name: "USD Coin",
    logoUrl: null,
    balance: "10.000000",
    loading: false,
    ...overrides,
  };
}

function supportedToken(
  overrides: Partial<SupportedToken> = {}
): SupportedToken {
  return {
    id: "stk_usdc_mainnet",
    chainId: 1,
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    logoUrl: null,
    ...overrides,
  };
}

function customTokenBalance(
  overrides: Partial<TokenBalance> = {}
): TokenBalance {
  return {
    tokenId: "tok_sky",
    chainId: 1,
    tokenAddress: "0x56072c95faa701256059aa122697b133aded9279",
    symbol: "SKY",
    name: "SKY Governance Token",
    balance: "0.671051",
    loading: false,
    ...overrides,
  };
}

function customToken(overrides: Partial<TokenData> = {}): TokenData {
  return {
    id: "tok_sky",
    chainId: 1,
    tokenAddress: "0x56072c95faa701256059aa122697b133aded9279",
    symbol: "SKY",
    name: "SKY Governance Token",
    decimals: 18,
    logoUrl: null,
    ...overrides,
  };
}

function emptyInput(
  overrides: Partial<BuildWithdrawableAssetsInput> = {}
): BuildWithdrawableAssetsInput {
  return {
    balances: [],
    chains: [MAINNET],
    supportedTokenBalances: [],
    supportedTokens: [],
    tokenBalances: [],
    tokens: [],
    ...overrides,
  };
}

describe("buildWithdrawableAssets", () => {
  it("returns empty array when nothing is funded", () => {
    expect(buildWithdrawableAssets(emptyInput())).toEqual([]);
  });

  it("includes native balances with positive amount", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({ balances: [nativeBalance({ balance: "0.5" })] })
    );
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      type: "native",
      chainId: 1,
      symbol: "ETH",
      balance: "0.5",
      decimals: 18,
    });
  });

  it("skips native balances that are zero or negative", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({
        balances: [
          nativeBalance({ balance: "0" }),
          nativeBalance({ balance: "0.0" }),
          nativeBalance({ balance: "-1" }),
        ],
      })
    );
    expect(assets).toEqual([]);
  });

  it("skips native balances whose chain is missing from the chains list", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({
        chains: [],
        balances: [nativeBalance({ balance: "1" })],
      })
    );
    expect(assets).toEqual([]);
  });

  it("skips TEMPO native balances (TEMPO uses stablecoins only)", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({
        chains: [TEMPO],
        balances: [
          nativeBalance({
            chainId: TEMPO.chainId,
            name: TEMPO.name,
            balance: "5",
          }),
        ],
      })
    );
    expect(assets).toEqual([]);
  });

  it("includes supported tokens with positive balance and metadata decimals", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({
        supportedTokenBalances: [
          supportedTokenBalance({ symbol: "USDS", balance: "3.5" }),
        ],
        supportedTokens: [supportedToken({ symbol: "USDS", decimals: 18 })],
      })
    );
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      type: "token",
      symbol: "USDS",
      balance: "3.5",
      decimals: 18,
    });
  });

  it("falls back to 6 decimals when supported token metadata is missing", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({
        supportedTokenBalances: [supportedTokenBalance({ balance: "7" })],
        supportedTokens: [],
      })
    );
    expect(assets).toHaveLength(1);
    expect(assets[0].decimals).toBe(6);
  });

  it("skips supported tokens with zero balance", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({
        supportedTokenBalances: [
          supportedTokenBalance({ balance: "0.000000" }),
        ],
        supportedTokens: [supportedToken()],
      })
    );
    expect(assets).toEqual([]);
  });

  it("includes custom tokens with positive balance and real decimals", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({
        tokenBalances: [customTokenBalance()],
        tokens: [customToken()],
      })
    );
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      type: "token",
      symbol: "SKY",
      balance: "0.671051",
      decimals: 18,
      tokenAddress: "0x56072c95faa701256059aa122697b133aded9279",
    });
  });

  it("skips custom tokens when metadata is missing", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({
        tokenBalances: [customTokenBalance()],
        tokens: [],
      })
    );
    expect(assets).toEqual([]);
  });

  it("skips custom tokens with zero balance", () => {
    const assets = buildWithdrawableAssets(
      emptyInput({
        tokenBalances: [customTokenBalance({ balance: "0" })],
        tokens: [customToken()],
      })
    );
    expect(assets).toEqual([]);
  });

  it("orders assets as native, supported tokens, custom tokens", () => {
    const assets = buildWithdrawableAssets({
      chains: [MAINNET, SEPOLIA],
      balances: [
        nativeBalance({
          chainId: SEPOLIA.chainId,
          name: SEPOLIA.name,
          balance: "0.01",
        }),
      ],
      supportedTokenBalances: [supportedTokenBalance({ balance: "2" })],
      supportedTokens: [supportedToken()],
      tokenBalances: [customTokenBalance()],
      tokens: [customToken()],
    });
    expect(assets.map((a) => `${a.type}:${a.symbol}`)).toEqual([
      "native:ETH",
      "token:USDC",
      "token:SKY",
    ]);
  });

  it("propagates native chain explorerUrl onto token assets", () => {
    const nativeExplorer = "https://etherscan.io/address/0xabc";
    const assets = buildWithdrawableAssets(
      emptyInput({
        balances: [nativeBalance({ explorerUrl: nativeExplorer })],
        supportedTokenBalances: [supportedTokenBalance()],
        supportedTokens: [supportedToken()],
        tokenBalances: [customTokenBalance()],
        tokens: [customToken()],
      })
    );
    const tokenAssets = assets.filter((a) => a.type === "token");
    expect(tokenAssets.every((a) => a.explorerUrl === nativeExplorer)).toBe(
      true
    );
  });
});
