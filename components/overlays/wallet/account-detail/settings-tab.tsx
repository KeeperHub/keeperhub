"use client";

import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { RecoveryEmailCard } from "@/components/overlays/wallet/recovery-email-card";
import { SecurityCard } from "@/components/overlays/wallet/security-card";
import { WalletAddressCard } from "@/components/overlays/wallet/wallet-address-card";

type SettingsTabProps = {
  account: WalletAccountKind;
  email?: string;
  isOwner: boolean;
  canExportKey: boolean;
  solanaAddress?: string | null;
};

/**
 * Per-account settings.
 *
 * - Turnkey EOA: address card, recovery email, key-export button (owners
 *   with the entitlement). These all act on the org's single Turnkey
 *   wallet so they're not duplicated per chain.
 * - Safe: just the address card. The signing toggle is surfaced inline on
 *   the parent account row's "Sender" switch so it's discoverable without
 *   a drill-in.
 */
export function SettingsTab({
  account,
  email,
  isOwner,
  canExportKey,
  solanaAddress,
}: SettingsTabProps): React.ReactElement {
  if (account.kind === "turnkey") {
    // The Solana account shares the same Turnkey wallet as the EVM EOA, so the
    // org-level recovery email and key export are surfaced once on the EVM
    // view. The Solana view just shows its own address.
    if (account.family === "solana") {
      return (
        <div className="space-y-4">
          <WalletAddressCard walletAddress={account.address} />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <WalletAddressCard walletAddress={account.address} />
        {email && <RecoveryEmailCard email={email} />}
        {isOwner && canExportKey && (
          <SecurityCard solanaAddress={solanaAddress} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <WalletAddressCard walletAddress={account.address} />
    </div>
  );
}
