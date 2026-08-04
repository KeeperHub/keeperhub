"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { WithdrawModal } from "@/components/overlays/withdraw-modal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildWithdrawableAssets } from "@/lib/wallet/build-withdrawable-assets";
import type {
  ChainBalance,
  ChainData,
  SupportedToken,
  SupportedTokenBalance,
  TokenBalance,
  TokenData,
} from "@/lib/wallet/types";
import { useWalletBalances } from "@/lib/wallet/use-wallet-balances";
import { AssetsTab } from "./assets-tab";
import { PoliciesTab } from "./policies-tab";
import { SettingsTab } from "./settings-tab";

type DetailTab = "assets" | "policies" | "settings";

type AccountDetailOverlayProps = {
  overlayId: string;
  account: WalletAccountKind;
  /** Wallet-overlay-supplied data so we share the same fetch state. */
  chains: ChainData[];
  balances: ChainBalance[];
  tokenBalances: TokenBalance[];
  supportedTokenBalances: SupportedTokenBalance[];
  /** Catalogs needed to build WithdrawableAsset[] inside the Safe withdraw
   *  path. The Turnkey path still routes through the parent's onWithdraw. */
  supportedTokens: SupportedToken[];
  tokens: TokenData[];
  isLoadingBalances: boolean;
  email?: string;
  isOwner: boolean;
  isAdmin: boolean;
  canExportKey: boolean;
  solanaAddress?: string | null;
  onAddToken: (chainId: number, tokenAddress: string) => Promise<void>;
  onRemoveToken: (tokenId: string, symbol: string) => void;
  /** Parent's withdraw handler. Used directly when account.kind === "turnkey";
   *  for Safe accounts we override and push WithdrawModal locally with the
   *  Safe source so funds come from the Safe address. */
  onWithdraw: (chainId: number, tokenAddress?: string) => void;
  /** Triggered after a Safe signing toggle flip so the parent can refresh. */
  onSigningChange?: (next: boolean) => void;
};

function defaultTab(account: WalletAccountKind): DetailTab {
  return account.kind === "safe" ? "assets" : "assets";
}

function detailTitle(account: WalletAccountKind): string {
  if (account.kind === "turnkey") {
    return account.family === "solana"
      ? "Turnkey EOA (SVM Compatible)"
      : "Turnkey EOA (EVM Compatible)";
  }
  return `Safe · ${account.chainName}`;
}

/**
 * Per-account detail view. Stacked above the WalletOverlay via
 * `push(AccountDetailOverlay, ...)`. The overlay container handles the
 * slide-in/out animation; we just render the tab body.
 */
export function AccountDetailOverlay({
  overlayId,
  account,
  chains,
  balances,
  tokenBalances,
  supportedTokenBalances,
  supportedTokens,
  tokens,
  isLoadingBalances,
  email,
  isOwner,
  isAdmin,
  canExportKey,
  solanaAddress,
  onAddToken,
  onRemoveToken,
  onWithdraw,
  onSigningChange,
}: AccountDetailOverlayProps): React.ReactElement {
  const { pop, push } = useOverlay();
  const [tab, setTab] = useState<DetailTab>(defaultTab(account));

  const isSafe = account.kind === "safe";

  // Safe accounts hold their own on-chain balances at a different address
  // from the org's Turnkey EOA. Spawn a dedicated fetch keyed to the
  // Safe's address so the Assets tab reflects Safe-owned funds rather than
  // the EOA's funds filtered by chain.
  const safeBalances = useWalletBalances();
  const safeId = isSafe ? account.safeId : null;
  const safeAddress = isSafe ? account.address : null;
  const safeChainId = isSafe ? account.chainId : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable hook fns from useWalletBalances; we intentionally re-fetch only on identity change of safeId
  useEffect(() => {
    if (!(safeId && safeAddress && safeChainId !== null)) {
      return;
    }
    const safeChain = chains.find((c) => c.chainId === safeChainId);
    if (!safeChain) {
      return;
    }
    safeBalances
      .fetchBalances(safeAddress, [safeChain], { safeId })
      .catch(() => {
        // useWalletBalances already logs and tweets toasts on failure.
      });
  }, [safeId, safeAddress, safeChainId, chains]);

  const assetsBalances = isSafe ? safeBalances.balances : balances;
  const assetsTokenBalances = isSafe
    ? safeBalances.tokenBalances
    : tokenBalances;
  const assetsSupportedTokenBalances = isSafe
    ? safeBalances.supportedTokenBalances
    : supportedTokenBalances;
  const assetsLoading = isSafe ? safeBalances.loading : isLoadingBalances;

  // Safe-aware withdraw click: rebuild the WithdrawableAsset list from the
  // Safe's own balances and push WithdrawModal with `source: { kind: "safe" }`
  // so the POST carries safeId and the server routes through
  // `safe.execTransaction`. Turnkey accounts keep using the parent handler.
  const safeWithdraw = useCallback(
    (chainId: number, tokenAddress?: string): void => {
      if (account.kind !== "safe") {
        return;
      }
      const assets = buildWithdrawableAssets({
        balances: safeBalances.balances,
        chains,
        supportedTokenBalances: safeBalances.supportedTokenBalances,
        supportedTokens,
        tokenBalances: safeBalances.tokenBalances,
        tokens,
      });
      if (assets.length === 0) {
        return;
      }
      const initialIndex = tokenAddress
        ? Math.max(
            0,
            assets.findIndex(
              (a) => a.chainId === chainId && a.tokenAddress === tokenAddress
            )
          )
        : Math.max(
            0,
            assets.findIndex(
              (a) => a.chainId === chainId && a.type === "native"
            )
          );
      push(WithdrawModal, {
        assets,
        initialAssetIndex: initialIndex,
        source: {
          kind: "safe" as const,
          safeId: account.safeId,
          safeAddress: account.address,
          chainName: account.chainName,
        },
        walletAddress: account.address,
      });
    },
    [
      account,
      chains,
      push,
      safeBalances.balances,
      safeBalances.supportedTokenBalances,
      safeBalances.tokenBalances,
      supportedTokens,
      tokens,
    ]
  );

  const withdrawHandler = isSafe ? safeWithdraw : onWithdraw;

  // Safe-scoped Add token: POSTs `safeId` so the row is tagged to this
  // Safe instead of the org/EOA, then refetches the Safe balances so the
  // newly tracked token appears with its balance in the Assets tab.
  const safeAddToken = useCallback(
    async (chainId: number, tokenAddress: string): Promise<void> => {
      if (account.kind !== "safe") {
        return;
      }
      const res = await fetch("/api/user/wallet/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId,
          tokenAddress,
          safeId: account.safeId,
        }),
      });
      const data = (await res.json()) as {
        token?: { symbol: string };
        error?: string;
      };
      if (!(res.ok && data.token)) {
        throw new Error(data.error ?? "Failed to add token");
      }
      toast.success(`Added ${data.token.symbol} to ${account.chainName}`);
      const safeChain = chains.find((c) => c.chainId === account.chainId);
      if (safeChain) {
        await safeBalances.refreshBalances(
          account.address,
          [safeChain],
          { safeId: account.safeId }
        );
      }
    },
    [account, chains, safeBalances]
  );

  // Safe-scoped remove: the existing DELETE already validates the row's
  // organization_id; the only additional thing we need on the Safe side
  // is to refresh the Safe balances so the row disappears immediately.
  const safeRemoveToken = useCallback(
    async (tokenId: string, symbol: string): Promise<void> => {
      if (account.kind !== "safe") {
        return;
      }
      try {
        const res = await fetch("/api/user/wallet/tokens", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenId }),
        });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          throw new Error(data.error ?? "Failed to remove token");
        }
        toast.success(`Removed ${symbol} from ${account.chainName}`);
        const safeChain = chains.find((c) => c.chainId === account.chainId);
        if (safeChain) {
          await safeBalances.refreshBalances(
            account.address,
            [safeChain],
            { safeId: account.safeId }
          );
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to remove token"
        );
      }
    },
    [account, chains, safeBalances]
  );

  const addTokenHandler = isSafe ? safeAddToken : onAddToken;
  const removeTokenHandler = isSafe ? safeRemoveToken : onRemoveToken;

  return (
    <Overlay
      actions={[{ label: "Back", onClick: pop, variant: "outline" }]}
      // Lock height so switching between Assets / Policies / Settings doesn't
      // make the modal jump as content reflows.
      className="min-h-[80vh] max-h-[80vh]"
      overlayId={overlayId}
      title={detailTitle(account)}
    >
      <Tabs
        className="w-full"
        onValueChange={(v) => setTab(v as DetailTab)}
        value={tab}
      >
        <TabsList className="w-full">
          <TabsTrigger value="assets">Assets</TabsTrigger>
          {isSafe && <TabsTrigger value="policies">Policies</TabsTrigger>}
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4" value="assets">
          <AssetsTab
            account={account}
            balances={assetsBalances}
            chains={chains}
            isAdmin={isAdmin}
            isLoadingBalances={assetsLoading}
            onAddToken={addTokenHandler}
            onRemoveToken={removeTokenHandler}
            onWithdraw={withdrawHandler}
            supportedTokenBalances={assetsSupportedTokenBalances}
            tokenBalances={assetsTokenBalances}
          />
        </TabsContent>

        {isSafe && (
          <TabsContent className="mt-4" value="policies">
            <PoliciesTab
              chainId={account.chainId}
              isAdmin={isAdmin}
              isOwner={isOwner}
              safeAddress={account.address}
              safeId={account.safeId}
            />
          </TabsContent>
        )}

        <TabsContent className="mt-4" value="settings">
          <SettingsTab
            account={account}
            canExportKey={canExportKey}
            email={email}
            isOwner={isOwner}
            solanaAddress={solanaAddress}
          />
        </TabsContent>
      </Tabs>
    </Overlay>
  );
}
