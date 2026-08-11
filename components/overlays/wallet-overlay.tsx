"use client";

import { Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { AccountDetailOverlay } from "@/components/overlays/wallet/account-detail/account-detail-overlay";
import {
  AccountRow,
  type WalletAccountKind,
} from "@/components/overlays/wallet/account-row";
import {
  getChainOrderIndex,
  getDisplayChainName,
} from "@/components/overlays/wallet/chain-utils";
import { NoWalletSection } from "@/components/overlays/wallet/no-wallet-section";
import { DeploySafeFlow } from "@/components/safe/deploy-safe-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { buildWithdrawableAssets } from "@/lib/wallet/build-withdrawable-assets";
import type {
  ChainData,
  SupportedToken,
  TokenData,
  WalletData,
} from "@/lib/wallet/types";
import { useWalletBalances } from "@/lib/wallet/use-wallet-balances";
import { useInvalidateWalletInfo } from "@/lib/wallet/use-wallet-info";
import { type WithdrawableAsset, WithdrawModal } from "./withdraw-modal";

type SafeRow = {
  id: string;
  chainId: number;
  safeAddress: string;
  status: string;
  isSigningActive: boolean;
};

type SafeListResponse = {
  safes?: SafeRow[];
};

type WalletOverlayProps = {
  overlayId: string;
};

function DeploySafeOverlay({
  overlayId,
  isOwner,
  onChanged,
}: {
  overlayId: string;
  isOwner: boolean;
  onChanged: () => void;
}): React.ReactElement {
  const { pop } = useOverlay();
  const close = (): void => {
    onChanged();
    pop();
  };

  return (
    <Overlay overlayId={overlayId} title="Deploy a Safe">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Safe smart account</h3>
        </div>
        <p className="text-muted-foreground text-xs">
          Deploy a Safe smart wallet on-chain per network. Safes can hold funds
          and sign workflow transactions independently from the Turnkey EOA.
        </p>
        {isOwner ? (
          <DeploySafeFlow onCancel={close} onComplete={close} />
        ) : (
          <p className="text-muted-foreground text-xs">
            Only the organization owner can deploy a Safe.
          </p>
        )}
      </div>
    </Overlay>
  );
}

export function WalletOverlay({ overlayId }: WalletOverlayProps) {
  const { closeAll, push } = useOverlay();
  const { data: session } = useSession();
  const { isAdmin } = useActiveMember();
  const invalidateWalletInfo = useInvalidateWalletInfo();

  const [walletLoading, setWalletLoading] = useState(true);
  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [chains, setChains] = useState<ChainData[]>([]);
  const [solanaIsTestnet, setSolanaIsTestnet] = useState(false);
  const [tokens, setTokens] = useState<TokenData[]>([]);
  const [supportedTokens, setSupportedTokens] = useState<SupportedToken[]>([]);
  const [safes, setSafes] = useState<SafeRow[]>([]);
  const [reconcilingFromChain, setReconcilingFromChain] = useState(false);

  const {
    balances,
    tokenBalances,
    supportedTokenBalances,
    loading: isLoadingBalances,
    fetchBalances,
  } = useWalletBalances();

  const fetchChains = useCallback(async (): Promise<ChainData[]> => {
    try {
      const response = await fetch("/api/chains");
      const data: ChainData[] = await response.json();
      // The Solana account row links to the cluster the org actually uses:
      // devnet when no mainnet Solana chain is enabled.
      const solanaChains = data.filter(
        (chain) => chain.chainType === "solana" && chain.isEnabled
      );
      setSolanaIsTestnet(
        solanaChains.length > 0 && !solanaChains.some((c) => !c.isTestnet)
      );
      const evmChains = data.filter((chain) => chain.chainType === "evm");
      setChains(evmChains);
      return evmChains;
    } catch {
      return [];
    }
  }, []);

  const fetchTokens = useCallback(async (): Promise<TokenData[]> => {
    try {
      const response = await fetch("/api/user/wallet/tokens");
      const data = await response.json();
      setTokens(data.tokens ?? []);
      return data.tokens ?? [];
    } catch {
      return [];
    }
  }, []);

  const fetchSupportedTokensData = useCallback(async (): Promise<
    SupportedToken[]
  > => {
    try {
      const response = await fetch("/api/supported-tokens");
      const data = await response.json();
      const tokenList = data.tokens ?? [];
      setSupportedTokens(tokenList);
      return tokenList;
    } catch {
      return [];
    }
  }, []);

  const fetchSafes = useCallback(async (): Promise<SafeRow[]> => {
    try {
      const response = await fetch("/api/user/safe");
      if (!response.ok) {
        return [];
      }
      const data = (await response.json()) as SafeListResponse;
      const rows = (data.safes ?? []).filter((s) => s.status === "deployed");
      setSafes(rows);
      return rows;
    } catch {
      return [];
    }
  }, []);

  const loadWallet = useCallback(async () => {
    setWalletLoading(true);
    try {
      const walletResponse = await fetch("/api/user/wallet");
      const data = await walletResponse.json();

      if (!data.hasWallet) {
        setWalletData({ hasWallet: false });
        setWalletLoading(false);
        return;
      }

      setWalletData(data);
      setWalletLoading(false);

      const [chainList] = await Promise.all([
        fetchChains(),
        fetchTokens(),
        fetchSupportedTokensData(),
        fetchSafes(),
      ]);

      if (data.walletAddress && chainList.length > 0) {
        fetchBalances(data.walletAddress, chainList);
      }
    } catch (error) {
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "Failed to load wallet",
        error,
        { component: "WalletOverlay" }
      );
      setWalletData({ hasWallet: false });
      setWalletLoading(false);
    }
  }, [
    fetchChains,
    fetchTokens,
    fetchSupportedTokensData,
    fetchSafes,
    fetchBalances,
  ]);

  const handleAddToken = async (
    chainId: number,
    tokenAddress: string
  ): Promise<void> => {
    const response = await fetch("/api/user/wallet/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId, tokenAddress }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Failed to add token");
    }
    toast.success(`Added ${data.token.symbol} to tracked tokens`);
    await loadWallet();
  };

  const handleRemoveToken = async (
    tokenId: string,
    symbol: string
  ): Promise<void> => {
    try {
      const response = await fetch("/api/user/wallet/tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? "Failed to remove token");
      }
      toast.success(`Removed ${symbol} from tracked tokens`);
      await loadWallet();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove token"
      );
    }
  };

  const handleCreateWallet = async (email: string): Promise<void> => {
    const response = await fetch("/api/user/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data: { error?: string } = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Failed to create wallet");
    }
    toast.success("Wallet created successfully!");
    await loadWallet();
    invalidateWalletInfo();
  };

  const buildAssets = useCallback(
    (): WithdrawableAsset[] =>
      buildWithdrawableAssets({
        balances,
        chains,
        supportedTokenBalances,
        supportedTokens,
        tokenBalances,
        tokens,
      }),
    [
      balances,
      chains,
      supportedTokenBalances,
      supportedTokens,
      tokenBalances,
      tokens,
    ]
  );

  const findAssetIndex = useCallback(
    (
      assets: WithdrawableAsset[],
      chainId: number,
      tokenAddress?: string
    ): number => {
      if (tokenAddress) {
        const idx = assets.findIndex(
          (a) => a.chainId === chainId && a.tokenAddress === tokenAddress
        );
        return idx >= 0 ? idx : 0;
      }
      const idx = assets.findIndex(
        (a) => a.chainId === chainId && a.type === "native"
      );
      return idx >= 0 ? idx : 0;
    },
    []
  );

  const handleWithdraw = useCallback(
    (chainId: number, tokenAddress?: string): void => {
      if (!walletData?.walletAddress) {
        return;
      }
      const assets = buildAssets();
      if (assets.length === 0) {
        toast.error("No assets available for withdrawal");
        return;
      }
      const initialIndex = findAssetIndex(assets, chainId, tokenAddress);
      push(WithdrawModal, {
        assets,
        walletAddress: walletData.walletAddress,
        initialAssetIndex: initialIndex,
      });
    },
    [walletData?.walletAddress, buildAssets, findAssetIndex, push]
  );

  const sessionUserId = session?.user?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionUserId triggers re-fetch on sign-in
  useEffect(() => {
    loadWallet();
  }, [loadWallet, sessionUserId]);

  const openAccountDetail = (account: WalletAccountKind): void => {
    if (!walletData?.walletAddress) {
      return;
    }
    push(AccountDetailOverlay, {
      account,
      balances,
      canExportKey: !!walletData.canExportKey,
      chains,
      email: walletData.email,
      isAdmin,
      isLoadingBalances,
      isOwner: !!walletData.isOwner,
      solanaAddress: walletData.solanaAddress,
      onAddToken: handleAddToken,
      onRemoveToken: handleRemoveToken,
      onSigningChange: () => {
        loadWallet();
      },
      onWithdraw: handleWithdraw,
      supportedTokenBalances,
      supportedTokens,
      tokenBalances,
      tokens,
    });
  };

  const openDeploySafe = (): void => {
    push(DeploySafeOverlay, {
      isOwner: !!walletData?.isOwner,
      onChanged: loadWallet,
    });
  };

  const handleReconcileFromChain = async (): Promise<void> => {
    if (reconcilingFromChain) {
      return;
    }
    setReconcilingFromChain(true);
    try {
      const res = await fetch("/api/user/safe/reconcile-all", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        summary?: {
          adopted: number;
          alreadyInDb: number;
          noOnchainSafe: number;
          failed: number;
          rolesSynced: number;
          rolesNotInstalled: number;
          rolesFailed: number;
        };
      };
      if (!(res.ok && data.success && data.summary)) {
        toast.error(data.error ?? "Sync from chain failed");
        return;
      }
      const { adopted, alreadyInDb, failed, rolesSynced, rolesFailed } =
        data.summary;
      // Refresh the in-memory Safe list whenever anything changed on chain,
      // either a new adoption OR a policy update on an existing Safe.
      if (adopted > 0 || rolesSynced > 0) {
        await fetchSafes();
      }
      const parts: string[] = [];
      if (adopted > 0) {
        parts.push(`adopted ${adopted} Safe${adopted === 1 ? "" : "s"}`);
      }
      if (rolesSynced > 0) {
        parts.push(
          `refreshed ${rolesSynced} policy set${rolesSynced === 1 ? "" : "s"}`
        );
      }
      if (parts.length > 0) {
        toast.success(`Sync from chain: ${parts.join(", ")}.`);
      } else if (failed > 0 || rolesFailed > 0) {
        toast.warning(
          `Sync completed with ${failed + rolesFailed} chain operation${failed + rolesFailed === 1 ? "" : "s"} that failed; nothing new adopted.`
        );
      } else {
        toast.info(
          `Sync complete. ${alreadyInDb} Safe${alreadyInDb === 1 ? "" : "s"} already in sync with chain.`
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync from chain failed");
    } finally {
      setReconcilingFromChain(false);
    }
  };

  const turnkeyAccount: WalletAccountKind | null = walletData?.walletAddress
    ? { kind: "turnkey", address: walletData.walletAddress, family: "evm" }
    : null;

  const turnkeySolanaAccount: WalletAccountKind | null =
    walletData?.solanaAddress
      ? {
          kind: "turnkey",
          address: walletData.solanaAddress,
          family: "solana",
          solanaIsTestnet,
        }
      : null;

  const safeAccounts: WalletAccountKind[] = safes
    .slice()
    .sort((a, b) => getChainOrderIndex(a.chainId) - getChainOrderIndex(b.chainId))
    .map((s) => {
      const chain = chains.find((c) => c.chainId === s.chainId);
      const baseName = chain?.name ?? `Chain ${s.chainId}`;
      return {
        address: s.safeAddress,
        chainId: s.chainId,
        chainName: getDisplayChainName(baseName),
        isSigningActive: s.isSigningActive,
        kind: "safe",
        safeId: s.id,
      };
    });

  return (
    <Overlay
      actions={[{ label: "Done", onClick: closeAll }]}
      // Match the detail overlay's locked height so the slide-in transition
      // doesn't pop the parent's height around when stacked.
      className="min-h-[80vh] max-h-[80vh]"
      overlayId={overlayId}
      title="Organization Wallet"
    >
      {walletLoading && (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      )}

      {!walletLoading && walletData?.hasWallet && (
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Pick an account to manage. Click an entry to view its assets,
            policies, and settings.
          </p>

          <div className="space-y-2">
            {turnkeyAccount && (
              <AccountRow
                account={turnkeyAccount}
                onClick={() => openAccountDetail(turnkeyAccount)}
                subtitle="Multi-chain"
              />
            )}
            {turnkeySolanaAccount && (
              <AccountRow
                account={turnkeySolanaAccount}
                onClick={() => openAccountDetail(turnkeySolanaAccount)}
                subtitle="Solana"
              />
            )}
            {safeAccounts.map((acc) => (
              <AccountRow
                account={acc}
                isAdmin={isAdmin}
                key={acc.kind === "safe" ? acc.safeId : acc.address}
                onClick={() => openAccountDetail(acc)}
                onSigningChange={(safeId, next) => {
                  setSafes((current) =>
                    current.map((s) =>
                      s.id === safeId ? { ...s, isSigningActive: next } : s
                    )
                  );
                }}
              />
            ))}
          </div>

          {isAdmin && (
            <div className="flex gap-2">
              <Button
                className="flex-1 justify-center gap-2"
                onClick={openDeploySafe}
                type="button"
                variant="outline"
              >
                <Plus className="h-4 w-4" />
                Deploy a Safe
              </Button>
              <Button
                aria-label="Sync Safe wallets from chain"
                className="gap-2"
                disabled={reconcilingFromChain}
                onClick={() => {
                  handleReconcileFromChain().catch(() => {
                    // toast already fired
                  });
                }}
                title="Adopt any Safe that exists on chain at this org's deterministic address but isn't yet tracked here. Use after a failed deploy attempt."
                type="button"
                variant="outline"
              >
                {reconcilingFromChain ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Sync from chain
              </Button>
            </div>
          )}
        </div>
      )}

      {!(walletLoading || walletData?.hasWallet) && (
        <NoWalletSection
          initialEmail={session?.user?.email ?? ""}
          isAdmin={isAdmin}
          onCreateWallet={handleCreateWallet}
        />
      )}
    </Overlay>
  );
}
