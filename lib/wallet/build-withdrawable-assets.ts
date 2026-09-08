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
const DEFAULT_STABLECOIN_DECIMALS = 6;

function hasPositiveBalance(raw: string): boolean {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0;
}

function collectNativeAssets(
  input: BuildWithdrawableAssetsInput
): WithdrawableAsset[] {
  const assets: WithdrawableAsset[] = [];
  for (const balance of input.balances) {
    if (TEMPO_CHAIN_IDS.has(balance.chainId)) {
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
