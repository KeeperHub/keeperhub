"use client";

import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { ChainBalanceItem } from "@/components/overlays/wallet/chain-balance-item";
import {
  getChainOrderIndex,
  hasPositiveBalance,
} from "@/components/overlays/wallet/chain-utils";
import type {
  ChainBalance,
  ChainData,
  SupportedTokenBalance,
  TokenBalance,
} from "@/lib/wallet/types";
import { SolanaAssets } from "./solana-assets";

type AssetsTabProps = {
  account: WalletAccountKind;
  chains: ChainData[];
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  supportedTokenBalances: SupportedTokenBalance[];
  isLoadingBalances: boolean;
  isAdmin: boolean;
  onAddToken: (chainId: number, tokenAddress: string) => Promise<void>;
  onRemoveToken: (tokenId: string, symbol: string) => void;
  onWithdraw: (chainId: number, tokenAddress?: string) => void;
};

/**
 * Per-account assets list. For Turnkey EOA we show every chain row (the EOA
 * is the same address on every chain). For a Safe we restrict to the Safe's
 * single chain so the user sees only the funds that are actually movable
 * from this account.
 */
export function AssetsTab({
  account,
  chains,
  balances,
  tokenBalances,
  supportedTokenBalances,
  isLoadingBalances,
  isAdmin,
  onAddToken,
  onRemoveToken,
  onWithdraw,
}: AssetsTabProps): React.ReactElement {
  // The Solana Turnkey EOA is not an EVM address, so the EVM balance/token
  // machinery (chain rows, withdraw, add-token) does not apply. Render the
  // dedicated Solana view, which fetches live native SOL balances.
  if (account.kind === "turnkey" && account.family === "solana") {
    return <SolanaAssets address={account.address} />;
  }

  const visibleBalances = (
    account.kind === "safe"
      ? balances.filter((b) => b.chainId === account.chainId)
      : balances
  )
    .slice()
    .sort(
      (a, b) => getChainOrderIndex(a.chainId) - getChainOrderIndex(b.chainId)
    );

  if (visibleBalances.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 p-4 text-muted-foreground text-sm">
        No chains available for this account yet.
      </div>
    );
  }

  const chainHasBalance = (chainId: number): boolean => {
    const native = balances.find((b) => b.chainId === chainId);
    if (native && hasPositiveBalance(native.balance)) {
      return true;
    }
    const trackedHit = tokenBalances.some(
      (t) => t.chainId === chainId && hasPositiveBalance(t.balance)
    );
    if (trackedHit) {
      return true;
    }
    return supportedTokenBalances.some(
      (t) => t.chainId === chainId && hasPositiveBalance(t.balance)
    );
  };

  const isSafe = account.kind === "safe";

  return (
    <div className="space-y-2">
      {visibleBalances.map((balance) => (
        <ChainBalanceItem
          balance={balance}
          bare={isSafe}
          chain={chains.find((c) => c.chainId === balance.chainId)}
          hasAnyBalance={chainHasBalance(balance.chainId)}
          isAdmin={isAdmin}
          isLoadingBalances={isLoadingBalances}
          key={balance.chainId}
          onAddToken={onAddToken}
          onRemoveToken={onRemoveToken}
          onWithdraw={onWithdraw}
          supportedTokenBalances={supportedTokenBalances}
          tokenBalances={tokenBalances}
        />
      ))}
    </div>
  );
}
