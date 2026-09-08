"use client";

import { useState } from "react";
import { PoliciesTab } from "@/components/overlays/wallet/account-detail/policies-tab";
import { SolanaAssets } from "@/components/overlays/wallet/account-detail/solana-assets";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { SafeSigningToggle } from "@/components/safe/safe-signing-toggle";
import { useAccountDetail } from "@/lib/wallet/use-account-detail";
import type { OrgWalletState } from "@/lib/wallet/use-org-wallet";
import { accountSlug } from "@/lib/wallet/use-wallet-accounts";
import { EmptyState, SettingsCard } from "../section";
import { useSettingsContext } from "../settings-context";
import { RowsSkeleton, StatTilesSkeleton } from "../skeletons";
import { AccountSettingsCard } from "./account-settings-card";
import { AccountStats } from "./account-stats";
import { AddAssetPanel } from "./add-asset-panel";
import { AssetFilters, networksOf, useNetworkFilter } from "./asset-filters";
import { AssetsTable } from "./assets-table";
import { useAccountAssets } from "./use-account-assets";

/**
 * The per-account view, rendered inline on its own route: a flat asset table
 * instead of the modal's nested per-chain accordion.
 */
export function AccountDetailPanel({
  account,
  state,
}: {
  account: WalletAccountKind;
  state: OrgWalletState;
}): React.ReactElement {
  const { isAdmin, isOwner } = useSettingsContext();
  const detail = useAccountDetail(account, state);
  const [showZero, setShowZero] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [network, setNetwork] = useNetworkFilter(accountSlug(account));
  const { rows, funded, all, hiddenCount } = useAccountAssets(
    account,
    detail,
    state.chains,
    showZero
  );
  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (network.length > 0 && !network.includes(String(row.chainId))) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return [row.symbol, row.name, row.chainName].some((field) =>
      field.toLowerCase().includes(needle)
    );
  });

  const isSafe = account.kind === "safe";
  // The Solana signer has its own balance source; the EVM chain feed does not
  // describe it, so it gets the dedicated view the wallet modal also uses.
  const isSolana = account.kind === "turnkey" && account.family === "solana";

  return (
    <>
      {detail.isLoadingBalances && !isSolana ? (
        <StatTilesSkeleton tiles={3} />
      ) : (
        <AccountStats
          account={account}
          funded={funded}
          solanaIsTestnet={state.solanaIsTestnet}
        />
      )}

      <SettingsCard
        action={
          !isSolana && (
            <AssetFilters
              hiddenCount={hiddenCount}
              network={network}
              networks={networksOf(all)}
              onNetworkChange={setNetwork}
              onQueryChange={setQuery}
              onToggleZero={() => setShowZero((v) => !v)}
              query={query}
              showZero={showZero}
            />
          )
        }
        bodyClassName="p-2"
        description={
          isSolana
            ? "Native SOL held by this signer."
            : "Everything this account can move. Withdraw sends from this address."
        }
        title="Assets"
      >
        {adding && !isSolana && (
          <AddAssetPanel
            chains={state.chains}
            defaultChainId={network.length === 1 ? network[0] : undefined}
            onAdd={detail.addToken}
            onCancel={() => setAdding(false)}
          />
        )}
        {isSolana && (
          <div className="p-3">
            <SolanaAssets address={account.address} />
          </div>
        )}
        {!isSolana && detail.isLoadingBalances && <RowsSkeleton rows={4} />}
        {!(isSolana || detail.isLoadingBalances) && visible.length === 0 && (
          <EmptyState>
            {rows.length === 0
              ? "No balances yet. Send funds to the address below to get started."
              : "No assets match that."}
          </EmptyState>
        )}
        {!(isSolana || detail.isLoadingBalances) && visible.length > 0 && (
          // Withdrawing is the owner's alone, and the endpoint enforces that:
          // offering it to an admin only walks them into a refusal.
          <AssetsTable
            canAdd={isAdmin && !adding}
            canWithdraw={isOwner}
            onAdd={() => setAdding(true)}
            onWithdraw={detail.withdraw}
            rows={visible}
          />
        )}
      </SettingsCard>

      {isSafe && (
        <SettingsCard
          description="What this Safe is allowed to do on chain, and who can propose it."
          title="Policies"
        >
          <PoliciesTab
            chainId={account.chainId}
            isAdmin={isAdmin}
            isOwner={isOwner}
            safeAddress={account.address}
            safeId={account.safeId}
          />
        </SettingsCard>
      )}

      {isSafe && (
        <SettingsCard
          description="Workflow transactions are sent from this Safe when it is on. The managed signer signs either way; this only decides which account the transaction comes from."
          title="Send from this Safe"
        >
          <SafeSigningToggle
            chainLabel={account.chainName}
            isActive={account.isSigningActive}
            isAdmin={isAdmin}
            onChange={(next) =>
              state.setSafes((current) =>
                current.map((s) =>
                  s.id === account.safeId ? { ...s, isSigningActive: next } : s
                )
              )
            }
            safeId={account.safeId}
          />
        </SettingsCard>
      )}

      <AccountSettingsCard
        account={account}
        canExportKey={!!state.walletData?.canExportKey}
        email={state.walletData?.email}
        isOwner={isOwner}
        solanaAddress={state.walletData?.solanaAddress}
      />
    </>
  );
}
