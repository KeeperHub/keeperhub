"use client";

import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { StatTile } from "../section";
import type { AssetRow } from "./use-account-assets";

export function AccountStats({
  account,
  funded,
  solanaIsTestnet,
}: {
  account: WalletAccountKind;
  /** Only balances that are not zero: what the account holds, whatever the
   * table is currently filtered to show. */
  funded: AssetRow[];
  solanaIsTestnet: boolean;
}): React.ReactElement {
  const isSafe = account.kind === "safe";
  const isSolana = account.kind === "turnkey" && account.family === "solana";

  // The Solana signer is not an EVM address, so the EVM balance feed that
  // powers the other tiles says nothing about it.
  if (isSolana) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile hint="Managed signer" label="Account type" value="EOA" />
        <StatTile
          hint={solanaIsTestnet ? "Devnet cluster" : "Mainnet cluster"}
          label="Network"
          value="Solana"
        />
        <StatTile
          hint="Shares the org's wallet"
          label="Key material"
          value="Managed"
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <StatTile
        hint="Networks with a balance here"
        label="Funded networks"
        value={String(new Set(funded.map((r) => r.chainId)).size)}
      />
      <StatTile
        hint="Native and token balances"
        label="Assets held"
        value={String(funded.length)}
      />
      <StatTile
        hint={isSafe ? "Safe smart account" : "Managed signer"}
        label="Account type"
        value={isSafe ? "Safe" : "EOA"}
      />
    </div>
  );
}
