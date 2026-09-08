"use client";

import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { AccountDetailOverlay } from "@/components/overlays/wallet/account-detail/account-detail-overlay";
import { WalletAccountsPanel } from "@/components/overlays/wallet/accounts-panel";
import { DeploySafeOverlay } from "@/components/overlays/wallet/deploy-safe-overlay";
import { NoWalletSection } from "@/components/overlays/wallet/no-wallet-section";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth-client";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { useOrgWallet } from "@/lib/wallet/use-org-wallet";

type WalletOverlayProps = {
  overlayId: string;
};

/**
 * The header wallet surface. Accounts drill in as stacked overlays here; the
 * settings hub renders the same accounts as routed pages instead. Both read
 * the shared useOrgWallet state.
 */
export function WalletOverlay({
  overlayId,
}: WalletOverlayProps): React.ReactElement {
  const { closeAll, push } = useOverlay();
  const { data: session } = useSession();
  const { isAdmin } = useActiveMember();
  const state = useOrgWallet();

  return (
    <Overlay
      actions={[{ label: "Done", onClick: closeAll }]}
      // Match the detail overlay's locked height so the slide-in transition
      // doesn't pop the parent's height around when stacked.
      className="min-h-[80vh] max-h-[80vh]"
      overlayId={overlayId}
      title="Organization Wallet"
    >
      {state.walletLoading && (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      )}

      {!state.walletLoading && state.walletData?.hasWallet && (
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Pick an account to manage. Click an entry to view its assets,
            policies, and settings.
          </p>
          <WalletAccountsPanel
            onDeploySafe={() =>
              push(DeploySafeOverlay, {
                isOwner: !!state.walletData?.isOwner,
                onChanged: state.loadWallet,
              })
            }
            onSelectAccount={(account) => {
              if (!state.walletData?.walletAddress) {
                return;
              }
              push(AccountDetailOverlay, {
                account,
                balances: state.balances,
                canExportKey: !!state.walletData.canExportKey,
                chains: state.chains,
                email: state.walletData.email,
                isAdmin,
                isLoadingBalances: state.isLoadingBalances,
                isOwner: !!state.walletData.isOwner,
                onAddToken: state.handleAddToken,
                onRemoveToken: state.handleRemoveToken,
                onSigningChange: () => {
                  state.loadWallet();
                },
                onWithdraw: state.handleWithdraw,
                solanaAddress: state.walletData.solanaAddress,
                supportedTokenBalances: state.supportedTokenBalances,
                supportedTokens: state.supportedTokens,
                tokenBalances: state.tokenBalances,
                tokens: state.tokens,
              });
            }}
            state={state}
          />
        </div>
      )}

      {!(state.walletLoading || state.walletData?.hasWallet) && (
        <NoWalletSection
          initialEmail={session?.user?.email ?? ""}
          isAdmin={isAdmin}
          onCreateWallet={state.handleCreateWallet}
        />
      )}
    </Overlay>
  );
}
