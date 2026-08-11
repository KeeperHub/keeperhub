"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  ChainBalance,
  ChainData,
  SupportedTokenBalance,
  TokenBalance,
} from "@/lib/wallet/types";
import { ChainBalanceItem } from "./chain-balance-item";
import { getChainOrderIndex, hasPositiveBalance } from "./chain-utils";

export function BalancesTab({
  balances,
  chains,
  isAdmin,
  isLoadingBalances,
  onAddToken,
  onRefresh,
  onRemoveToken,
  onWithdraw,
  refreshing,
  supportedTokenBalances,
  tokenBalances,
}: {
  balances: ChainBalance[];
  chains: ChainData[];
  isAdmin: boolean;
  isLoadingBalances: boolean;
  onAddToken: (chainId: number, tokenAddress: string) => Promise<void>;
  onRefresh: () => void;
  onRemoveToken: (tokenId: string, symbol: string) => void;
  onWithdraw: (chainId: number, tokenAddress?: string) => void;
  refreshing: boolean;
  supportedTokenBalances: SupportedTokenBalance[];
  tokenBalances: TokenBalance[];
}): React.ReactElement {
  const [showTestnets, setShowTestnets] = useState(false);

  const filteredBalances = balances
    .filter((b) => (showTestnets ? b.isTestnet : !b.isTestnet))
    .sort(
      (a, b) => getChainOrderIndex(a.chainId) - getChainOrderIndex(b.chainId)
    );

  const chainHasBalance = (chainId: number): boolean => {
    const native = balances.find((b) => b.chainId === chainId);
    if (native && hasPositiveBalance(native.balance)) {
      return true;
    }
    const hasSupported = supportedTokenBalances.some(
      (t) => t.chainId === chainId && hasPositiveBalance(t.balance)
    );
    if (hasSupported) {
      return true;
    }
    return tokenBalances.some(
      (t) => t.chainId === chainId && hasPositiveBalance(t.balance)
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">Balances</h3>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border">
            <Button
              className="h-7 rounded-r-none border-0 px-3 text-xs"
              onClick={() => setShowTestnets(false)}
              size="sm"
              variant={showTestnets ? "ghost" : "default"}
            >
              Mainnets
            </Button>
            <Button
              className="h-7 rounded-l-none border-0 px-3 text-xs"
              onClick={() => setShowTestnets(true)}
              size="sm"
              variant={showTestnets ? "default" : "ghost"}
            >
              Testnets
            </Button>
          </div>
          <Button
            aria-label="Refresh balances"
            data-testid="wallet-refresh-button"
            disabled={refreshing}
            onClick={onRefresh}
            size="sm"
            variant="ghost"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </div>

      {balances.length === 0 ? (
        <div className="text-muted-foreground text-sm">Loading chains...</div>
      ) : (
        <div className="space-y-2">
          {filteredBalances.map((balance) => (
            <ChainBalanceItem
              balance={balance}
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
          {filteredBalances.length === 0 && (
            <div className="py-4 text-center text-muted-foreground text-sm">
              No {showTestnets ? "testnet" : "mainnet"} chains available
            </div>
          )}
        </div>
      )}
    </div>
  );
}
