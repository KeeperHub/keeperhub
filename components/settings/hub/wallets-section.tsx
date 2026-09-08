"use client";

import { useState } from "react";
import { NoWalletSection } from "@/components/overlays/wallet/no-wallet-section";
import { DeploySafeFlow } from "@/components/safe/deploy-safe-card";
import { useSession } from "@/lib/auth-client";
import { useOrgWallet } from "@/lib/wallet/use-org-wallet";
import { useSafeReconcile } from "@/lib/wallet/use-safe-reconcile";
import { useWalletAccounts } from "@/lib/wallet/use-wallet-accounts";
import { SectionHeader, SettingsCard, StatTile } from "./section";
import { useSettingsContext } from "./settings-context";
import { AccountsTable } from "./wallets/accounts-table";

export function WalletsSection(): React.ReactElement {
  const { data: session } = useSession();
  const { isAdmin, isOwner } = useSettingsContext();
  const [deploying, setDeploying] = useState(false);
  const state = useOrgWallet();
  const accounts = useWalletAccounts({
    chains: state.chains,
    safes: state.safes,
    solanaAddress: state.walletData?.solanaAddress,
    solanaIsTestnet: state.solanaIsTestnet,
    walletAddress: state.walletData?.walletAddress,
  });

  const { reconciling, reconcile } = useSafeReconcile(state.fetchSafes);
  const withdrawable = state.walletLoading ? 0 : state.buildAssets().length;

  const closeDeploy = (): void => {
    setDeploying(false);
    state.loadWallet().catch(() => undefined);
  };

  return (
    <>
      <SectionHeader
        description="Every account this organization can sign with. Open one to see its assets, policies and key settings."
        title="Wallets"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          hint="Managed signer plus any Safes"
          label="Accounts"
          loading={state.walletLoading}
          value={String(accounts.all.length)}
        />
        <StatTile
          hint={state.safes.length > 0 ? "Deployed on chain" : "None deployed"}
          label="Safe smart accounts"
          loading={state.walletLoading}
          value={String(state.safes.length)}
        />
        <StatTile
          hint={
            state.isLoadingBalances ? "Reading balances" : "Ready to withdraw"
          }
          label="Fundable assets"
          loading={state.walletLoading}
          tone={withdrawable > 0 ? "accent" : "neutral"}
          value={String(withdrawable)}
        />
      </div>

      <SettingsCard
        bodyClassName="p-2"
        description="Open an account to see its assets, policies, key export and recovery."
        title="Accounts"
      >
        {(state.walletLoading || state.walletData?.hasWallet) && (
          <AccountsTable
            accounts={accounts}
            canManage={isAdmin}
            finding={reconciling}
            loading={state.walletLoading}
            onAddSafe={() => setDeploying(true)}
            onFindExisting={() => {
              reconcile().catch(() => undefined);
            }}
          />
        )}
        {!(state.walletLoading || state.walletData?.hasWallet) && (
          <NoWalletSection
            initialEmail={session?.user?.email ?? ""}
            isAdmin={isAdmin}
            onCreateWallet={state.handleCreateWallet}
          />
        )}
      </SettingsCard>

      {deploying && (
        <SettingsCard
          description="Deploy a Safe smart wallet per network. Safes hold funds and sign workflow transactions independently from the EVM account."
          title="Deploy a Safe"
        >
          {isOwner ? (
            <DeploySafeFlow onCancel={closeDeploy} onComplete={closeDeploy} />
          ) : (
            <p className="text-muted-foreground text-sm">
              Only the organization owner can deploy a Safe.
            </p>
          )}
        </SettingsCard>
      )}
    </>
  );
}
