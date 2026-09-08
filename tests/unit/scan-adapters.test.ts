/**
 * Scan adapter unit tests — Lido staking adapter (SCAN-04) and
 * stablecoin balance adapter (SCAN-02).
 *
 * Both adapters encode ERC20 balanceOf calls for Multicall3 aggregate3
 * batching. A failed sub-call (success: false) is a soft miss — it drops
 * only that token and does not throw.
 *
 * TDD: tests were written first (RED), implementation added after (GREEN).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ethers } from "ethers";
import { buildLidoCalls, decodeLidoResults } from "@/lib/scan/adapters/lido";
import {
  buildStablecoinCalls,
  decodeStablecoinResults,
} from "@/lib/scan/adapters/stablecoins";

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** ABI-encode a uint256 as ERC20 balanceOf return data. */
function encodeBalance(amount: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [amount]);
}

const TEST_USER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// ─── Lido adapter ─────────────────────────────────────────────────────────────

describe("lido adapter", () => {
  it("lido: Ethereum (chainId 1) builds 2 balanceOf calls — stETH and wstETH", () => {
    const calls = buildLidoCalls(TEST_USER, 1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.allowFailure).toBe(true);
    expect(calls[1]?.allowFailure).toBe(true);
  });

  it("lido: Arbitrum (chainId 42161) builds 1 balanceOf call — wstETH only", () => {
    const calls = buildLidoCalls(TEST_USER, 42_161);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.allowFailure).toBe(true);
  });

  it("lido: chainId 1 decode emits 2 suppliedAssets with stringified bigint amounts", () => {
    const stEthBalance = BigInt("500000000000000000"); // 0.5 stETH in wei
    const wstEthBalance = BigInt("300000000000000000"); // 0.3 wstETH in wei

    const results = [
      { success: true, returnData: encodeBalance(stEthBalance) },
      { success: true, returnData: encodeBalance(wstEthBalance) },
    ];

    const positions = decodeLidoResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.protocol).toBe("lido");
    expect(pos?.chainId).toBe(1);
    expect(pos?.suppliedAssets).toHaveLength(2);
    expect(pos?.borrowedAssets).toHaveLength(0);
    expect(pos?.healthFactor).toBeNull();
    expect(pos?.totalCollateralUsd).toBeNull();
    expect(pos?.totalDebtUsd).toBeNull();

    const [stAsset, wstAsset] = pos?.suppliedAssets ?? [];
    expect(stAsset?.symbol).toBe("stETH");
    expect(stAsset?.amount).toBe(String(stEthBalance));
    expect(stAsset?.decimals).toBe(18);
    expect(stAsset?.usdValue).toBeNull();

    expect(wstAsset?.symbol).toBe("wstETH");
    expect(wstAsset?.amount).toBe(String(wstEthBalance));
    expect(wstAsset?.decimals).toBe(18);
    expect(wstAsset?.usdValue).toBeNull();
  });

  it("lido: chainId 42161 decode emits 1 wstETH asset (raw balance, no conversion call)", () => {
    const wstEthBalance = BigInt("200000000000000000"); // 0.2 wstETH

    const results = [
      { success: true, returnData: encodeBalance(wstEthBalance) },
    ];

    const positions = decodeLidoResults(results, TEST_USER, 42_161);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.suppliedAssets).toHaveLength(1);
    expect(pos?.suppliedAssets[0]?.symbol).toBe("wstETH");
    expect(pos?.suppliedAssets[0]?.amount).toBe(String(wstEthBalance));
    expect(pos?.suppliedAssets[0]?.decimals).toBe(18);
  });

  it("lido: failed sub-call (success: false) skips that token, does not drop others", () => {
    // stETH call fails; wstETH call succeeds.
    const wstEthBalance = BigInt("100000000000000000"); // 0.1 wstETH
    const results = [
      { success: false, returnData: "0x" },
      { success: true, returnData: encodeBalance(wstEthBalance) },
    ];

    const positions = decodeLidoResults(results, TEST_USER, 1);
    expect(positions).toHaveLength(1);

    const pos = positions[0];
    expect(pos?.suppliedAssets).toHaveLength(1);
    expect(pos?.suppliedAssets[0]?.symbol).toBe("wstETH");
    expect(pos?.suppliedAssets[0]?.amount).toBe(String(wstEthBalance));
  });

  it("lido: returns empty array when all balances are zero or failed", () => {
    const results = [
      { success: true, returnData: encodeBalance(BigInt(0)) },
      { success: true, returnData: encodeBalance(BigInt(0)) },
    ];
    expect(decodeLidoResults(results, TEST_USER, 1)).toHaveLength(0);
  });

  it("lido: returns empty array for unsupported chainId", () => {
    const results = [
      { success: true, returnData: encodeBalance(BigInt("1000")) },
    ];
    expect(decodeLidoResults(results, TEST_USER, 99)).toHaveLength(0);
  });
});

// ─── Stablecoin adapter ───────────────────────────────────────────────────────

const MOCK_TOKENS = [
  {
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    symbol: "USDC",
    decimals: 6,
  },
  {
    tokenAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    symbol: "USDT",
    decimals: 6,
  },
];

describe("stablecoin adapter", () => {
  it("stablecoin: buildStablecoinCalls produces one balanceOf call per token", () => {
    const calls = buildStablecoinCalls(TEST_USER, MOCK_TOKENS);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.allowFailure).toBe(true);
    }
    expect(calls[0]?.target).toBe(MOCK_TOKENS[0]?.tokenAddress);
    expect(calls[1]?.target).toBe(MOCK_TOKENS[1]?.tokenAddress);
  });

  it("stablecoin: decodeStablecoinResults returns one StablecoinBalance per non-failed non-zero balance", () => {
    const usdcBalance = BigInt("1000000"); // 1 USDC (6 decimals)

    const results = [
      { success: true, returnData: encodeBalance(usdcBalance) },
      { success: false, returnData: "0x" }, // USDT sub-call failed
    ];

    const stablecoins = decodeStablecoinResults(results, MOCK_TOKENS, 1);
    expect(stablecoins).toHaveLength(1);

    const sc = stablecoins[0];
    expect(sc?.symbol).toBe("USDC");
    expect(sc?.amount).toBe(String(usdcBalance));
    expect(sc?.decimals).toBe(6);
    expect(sc?.chainId).toBe(1);
    expect(sc?.tokenAddress).toBe(MOCK_TOKENS[0]?.tokenAddress);
    expect(sc?.usdValue).toBeNull();
    expect(sc?.priceUsd).toBeNull();
    expect(sc?.depegged).toBe(false);
  });

  it("stablecoin: amount is a stringified bigint, not a JS number", () => {
    const balance = BigInt("999999999999"); // large value to exercise string path
    const results = [
      { success: true, returnData: encodeBalance(balance) },
      { success: false, returnData: "0x" },
    ];

    const stablecoins = decodeStablecoinResults(results, MOCK_TOKENS, 1);
    expect(stablecoins).toHaveLength(1);
    expect(typeof stablecoins[0]?.amount).toBe("string");
    expect(stablecoins[0]?.amount).toBe(String(balance));
  });

  it("stablecoin: failed sub-call drops only that token, does not throw (soft miss)", () => {
    const results = [
      { success: false, returnData: "0x" },
      { success: false, returnData: "0x" },
    ];
    expect(() =>
      decodeStablecoinResults(results, MOCK_TOKENS, 1)
    ).not.toThrow();
    expect(decodeStablecoinResults(results, MOCK_TOKENS, 1)).toHaveLength(0);
  });

  it("stablecoin: zero balance is excluded even when sub-call succeeded", () => {
    const results = [
      { success: true, returnData: encodeBalance(BigInt(0)) },
      { success: true, returnData: encodeBalance(BigInt(0)) },
    ];
    expect(decodeStablecoinResults(results, MOCK_TOKENS, 1)).toHaveLength(0);
  });

  it("stablecoin: buildStablecoinCalls returns empty array for empty token list", () => {
    expect(buildStablecoinCalls(TEST_USER, [])).toHaveLength(0);
  });

  it("stablecoin: decimals from registry are carried through to the result", () => {
    const tokens = [
      {
        tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        decimals: 6,
      },
    ];
    const results = [
      { success: true, returnData: encodeBalance(BigInt("500000")) }, // 0.5 USDC
    ];
    const stablecoins = decodeStablecoinResults(results, tokens, 8453);
    expect(stablecoins[0]?.decimals).toBe(6);
    expect(stablecoins[0]?.chainId).toBe(8453);
  });
});
