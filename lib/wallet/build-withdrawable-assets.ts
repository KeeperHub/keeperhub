import type {
  ChainBalance,
  ChainData,
  SupportedToken,
  SupportedTokenBalance,
  TokenBalance,
  TokenData,
} from "./types";

export type WithdrawableAsset = {
  type: "native" | "token";
  chainId: number;
  chainName: string;
  symbol: string;
  balance: string;
  tokenAddress?: string;
  decimals: number;
  explorerUrl: string | null;
};

export type BuildWithdrawableAssetsInput = {
  balances: ChainBalance[];
  chains: ChainData[];
  supportedTokenBalances: SupportedTokenBalance[];
  supportedTokens: SupportedToken[];
  tokenBalances: TokenBalance[];
  tokens: TokenData[];
};

const TEMPO_CHAIN_IDS: ReadonlySet<number> = new Set([42_431, 4217]);

/**
 * True for chains that use stablecoins for gas and so never show a native
 * row at all. Categorical: unlike `nativeMirrorsSupportedToken` below, this
 * does not depend on whether a token feed has loaded -- there is no native
 * balance to reconcile against, just none to show.
 */
export function isTempoChain(chainId: number): boolean {
  return TEMPO_CHAIN_IDS.has(chainId);
}

// Chains where the native gas balance and a supported_tokens row represent
// the same underlying balance at two different decimal precisions (e.g.
// Arc's native USDC at 18 decimals vs. its ERC-20 interface at 6 decimals).
// This is the double-count set only -- Tempo is deliberately excluded (see
// `isTempoChain`): Tempo hides its native row unconditionally because it has
// no native gas token, not because two rows would double-count one balance.
// This is the single source of truth for the set; other wallet modules
// import it (or the helper) from here rather than re-declaring it.
export const NATIVE_MIRRORS_TOKEN_CHAIN_IDS: ReadonlySet<number> = new Set([
  5_042_002, // Arc Testnet (Circle)
]);

const DEFAULT_STABLECOIN_DECIMALS = 6;

function hasPositiveBalance(raw: string): boolean {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * Shape-agnostic: true when at least one row in a pre-filtered (already
 * scoped to one chain) list carries a funded balance. Callers with a
 * `chainId` field filter first; callers whose rows are already nested under
 * a chain (no `chainId` field of their own) pass them straight through. This
 * is the one place "funded" is decided so the withdraw path and the wallet
 * digest can't drift on what counts as a real row.
 */
export function hasFundedMirrorRow(
  rows: readonly { balance: string }[]
): boolean {
  return rows.some((row) => hasPositiveBalance(row.balance));
}

/**
 * True when `chainId`'s native balance should be treated as already
 * represented by a supported-token row -- i.e. it's a candidate chain AND a
 * supported-token row for it actually exists in `supportedTokenBalances`
 * and carries a positive balance. A row that exists only because a
 * partial balanceOf failure pushed a "0" placeholder must not suppress the
 * native asset -- that would hide and strip withdrawal from a real balance.
 * Callers pass whatever supported-token feed they have on hand; a chain
 * whose token seed failed or hasn't loaded yet keeps its native row visible
 * and withdrawable rather than disappearing.
 */
export function nativeMirrorsSupportedToken(
  chainId: number,
  supportedTokenBalances: readonly { chainId: number; balance: string }[]
): boolean {
  return (
    NATIVE_MIRRORS_TOKEN_CHAIN_IDS.has(chainId) &&
    hasFundedMirrorRow(
      supportedTokenBalances.filter((t) => t.chainId === chainId)
    )
  );
}

function collectNativeAssets(
  input: BuildWithdrawableAssetsInput
): WithdrawableAsset[] {
  const assets: WithdrawableAsset[] = [];
  for (const balance of input.balances) {
    if (
      isTempoChain(balance.chainId) ||
      nativeMirrorsSupportedToken(balance.chainId, input.supportedTokenBalances)
    ) {
      continue;
    }
    const chain = input.chains.find((c) => c.chainId === balance.chainId);
    if (!(chain && hasPositiveBalance(balance.balance))) {
      continue;
    }
    assets.push({
      type: "native",
      chainId: balance.chainId,
      chainName: balance.name,
      symbol: balance.symbol,
      balance: balance.balance,
      decimals: 18,
      explorerUrl: balance.explorerUrl,
    });
  }
  return assets;
}

function collectSupportedTokenAssets(
  input: BuildWithdrawableAssetsInput
): WithdrawableAsset[] {
  const assets: WithdrawableAsset[] = [];
  for (const token of input.supportedTokenBalances) {
    if (!hasPositiveBalance(token.balance)) {
      continue;
    }
    const chain = input.chains.find((c) => c.chainId === token.chainId);
    if (!chain) {
      continue;
    }
    const tokenMeta = input.supportedTokens.find(
      (t) =>
        t.chainId === token.chainId && t.tokenAddress === token.tokenAddress
    );
    const nativeBalance = input.balances.find(
      (b) => b.chainId === token.chainId
    );
    assets.push({
      type: "token",
      chainId: token.chainId,
      chainName: chain.name,
      symbol: token.symbol,
      balance: token.balance,
      tokenAddress: token.tokenAddress,
      decimals: tokenMeta?.decimals ?? DEFAULT_STABLECOIN_DECIMALS,
      explorerUrl: nativeBalance?.explorerUrl ?? null,
    });
  }
  return assets;
}

function collectCustomTokenAssets(
  input: BuildWithdrawableAssetsInput
): WithdrawableAsset[] {
  const assets: WithdrawableAsset[] = [];
  for (const token of input.tokenBalances) {
    if (!hasPositiveBalance(token.balance)) {
      continue;
    }
    const chain = input.chains.find((c) => c.chainId === token.chainId);
    if (!chain) {
      continue;
    }
    const tokenMeta = input.tokens.find(
      (t) =>
        t.chainId === token.chainId && t.tokenAddress === token.tokenAddress
    );
    if (!tokenMeta) {
      continue;
    }
    const nativeBalance = input.balances.find(
      (b) => b.chainId === token.chainId
    );
    assets.push({
      type: "token",
      chainId: token.chainId,
      chainName: chain.name,
      symbol: token.symbol,
      balance: token.balance,
      tokenAddress: token.tokenAddress,
      decimals: tokenMeta.decimals,
      explorerUrl: nativeBalance?.explorerUrl ?? null,
    });
  }
  return assets;
}

export function buildWithdrawableAssets(
  input: BuildWithdrawableAssetsInput
): WithdrawableAsset[] {
  return [
    ...collectNativeAssets(input),
    ...collectSupportedTokenAssets(input),
    ...collectCustomTokenAssets(input),
  ];
}
