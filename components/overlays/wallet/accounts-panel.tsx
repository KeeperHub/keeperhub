"use client";

import { Plus, RefreshCw } from "lucide-react";
import {
  AccountRow,
  type WalletAccountKind,
} from "@/components/overlays/wallet/account-row";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useActiveMember } from "@/lib/hooks/use-organization";
import type { OrgWalletState } from "@/lib/wallet/use-org-wallet";
import { useSafeReconcile } from "@/lib/wallet/use-safe-reconcile";
import {
  accountSlug,
  useWalletAccounts,
} from "@/lib/wallet/use-wallet-accounts";

const SYNC_HINT =
  "Adopt any Safe that exists on chain at this org's deterministic address but isn't yet tracked here. Use after a failed deploy attempt.";

/**
 * Account list shared by the header wallet surface and the settings hub. The
 * host decides where selecting an account goes, so neither has to open a
 * stacked modal to show the detail.
 */
export function WalletAccountsPanel({
  state,
  onSelectAccount,
  onDeploySafe,
}: {
  state: OrgWalletState;
  onSelectAccount: (account: WalletAccountKind) => void;
  onDeploySafe?: () => void;
}): React.ReactElement {
  const { isAdmin } = useActiveMember();
  const { reconciling, reconcile } = useSafeReconcile(state.fetchSafes);
  const { all } = useWalletAccounts({
    chains: state.chains,
    safes: state.safes,
    solanaAddress: state.walletData?.solanaAddress,
    solanaIsTestnet: state.solanaIsTestnet,
    walletAddress: state.walletData?.walletAddress,
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {all.map((account) => (
          <AccountRow
            account={account}
            isAdmin={account.kind === "safe" ? isAdmin : undefined}
            key={accountSlug(account)}
            onClick={() => onSelectAccount(account)}
            onSigningChange={(safeId, next) => {
              state.setSafes((current) =>
                current.map((s) =>
                  s.id === safeId ? { ...s, isSigningActive: next } : s
                )
              );
            }}
            subtitle={
              account.kind === "turnkey"
                ? (account.family === "solana" ? "Solana" : "Multi-chain")
                : undefined
            }
          />
        ))}
      </div>

      {isAdmin && (
        <div className="flex gap-2">
          {onDeploySafe && (
            <Button
              className="flex-1 justify-center gap-2"
              onClick={onDeploySafe}
              type="button"
              variant="outline"
            >
              <Plus className="h-4 w-4" />
              Deploy a Safe
            </Button>
          )}
          <Button
            aria-label="Sync Safe wallets from chain"
            className="gap-2"
            disabled={reconciling}
            onClick={() => {
              reconcile().catch(() => {
                // toast already fired inside the hook
              });
            }}
            title={SYNC_HINT}
            type="button"
            variant="outline"
          >
            {reconciling ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Sync from chain
          </Button>
        </div>
      )}
    </div>
  );
}
