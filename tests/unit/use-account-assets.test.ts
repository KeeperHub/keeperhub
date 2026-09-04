import { describe, expect, it } from "vitest";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { __computeAccountAssetsForTesting as computeAccountAssets } from "@/components/settings/hub/wallets/use-account-assets";
import type {
  ChainBalance,
  ChainData,
  SupportedTokenBalance,
} from "@/lib/wallet/types";
import type { AccountDetailState } from "@/lib/wallet/use-account-detail";

const ARC_CHAIN_ID = 5_042_002;
const TEMPO_CHAIN_ID = 4217;

const TURNKEY_ACCOUNT: WalletAccountKind = {
  kind: "turnkey",
  family: "evm",
  address: "0x1234567890AbcdEF1234567890aBcdef12345678",
};

const ARC_CHAIN: ChainData = {
  id: "arc-testnet",
  chainId: ARC_CHAIN_ID,
  name: "Arc Testnet",
  symbol: "USDC",
  chainType: "evm",
  explorerUrl: null,
  explorerAddressPath: null,
  isTestnet: true,
  isEnabled: true,
};

function nativeBalance(overrides: Partial<ChainBalance> = {}): ChainBalance {
  return {
    chainId: ARC_CHAIN_ID,
    name: "Arc Testnet",
    symbol: "USDC",
    balance: "0",
    loading: false,
    isTestnet: true,
    explorerUrl: null,
    ...overrides,
  };
}

function supportedTokenBalance(
  overrides: Partial<SupportedTokenBalance> = {}
): SupportedTokenBalance {
  return {
    chainId: ARC_CHAIN_ID,
    tokenAddress: "0x2f3363b7ef4a480f78e3fd0c8b3b0e5e2f0f2d1a",
    symbol: "USDC",
    name: "USD Coin",
    logoUrl: null,
    balance: "0",
    loading: false,
    ...overrides,
  };
}

function detailState(
  overrides: Partial<AccountDetailState> = {}
): AccountDetailState {
  return {
    balances: [],
    tokenBalances: [],
    supportedTokenBalances: [],
    isLoadingBalances: false,
    addToken: async () => undefined,
    removeToken: async () => undefined,
    withdraw: () => undefined,
    ...overrides,
  };
}

describe("useAccountAssets / computeAccountAssets", () => {
  it("hides Arc's native row once its supported-token row is funded", () => {
    const result = computeAccountAssets(
      TURNKEY_ACCOUNT,
      detailState({
        balances: [nativeBalance({ balance: "0.083134" })],
        supportedTokenBalances: [
          supportedTokenBalance({ balance: "0.083134" }),
        ],
      }),
      [ARC_CHAIN],
      false
    );
    expect(result.rows.filter((r) => r.kind === "native")).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ kind: "token", symbol: "USDC" });
  });

  it("keeps Arc's native row visible when the token row is an unfunded placeholder", () => {
    // A partial balanceOf failure pushes a "0" row rather than omitting one;
    // that must not be read as "the mirror is funded".
    const result = computeAccountAssets(
      TURNKEY_ACCOUNT,
      detailState({
        balances: [nativeBalance({ balance: "378.263571" })],
        supportedTokenBalances: [supportedTokenBalance({ balance: "0" })],
      }),
      [ARC_CHAIN],
      false
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ kind: "native", symbol: "USDC" });
  });

  it("keeps Arc's native row visible when no supported-token row has loaded yet", () => {
    const result = computeAccountAssets(
      TURNKEY_ACCOUNT,
      detailState({
        balances: [nativeBalance({ balance: "0.083134" })],
        supportedTokenBalances: [],
      }),
      [ARC_CHAIN],
      false
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ kind: "native", symbol: "USDC" });
  });

  it("hides Tempo's native row unconditionally, even with no supported-token row", () => {
    const result = computeAccountAssets(
      TURNKEY_ACCOUNT,
      detailState({
        balances: [nativeBalance({ chainId: TEMPO_CHAIN_ID, balance: "5" })],
        supportedTokenBalances: [],
      }),
      [{ ...ARC_CHAIN, chainId: TEMPO_CHAIN_ID, name: "Tempo" }],
      false
    );
    expect(result.rows.filter((r) => r.kind === "native")).toEqual([]);
  });
});
