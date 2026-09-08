"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { ExportPrivateKeyButton } from "@/components/overlays/wallet/export-private-key-button";
import { Button } from "@/components/ui/button";
import { toChecksumAddress } from "@/lib/address-utils";
import { SettingsCard } from "../section";

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0 last:pb-0 first:pt-0">
      <div className="flex min-w-0 flex-col">
        <span className="font-medium text-sm">{label}</span>
        {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function AccountSettingsCard({
  account,
  email,
  isOwner,
  canExportKey,
  solanaAddress,
}: {
  account: WalletAccountKind;
  email?: string;
  isOwner: boolean;
  canExportKey: boolean;
  solanaAddress?: string | null;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  // toChecksumAddress is a no-op for non-EVM (Solana) addresses, so every
  // address in the hub can go through it unconditionally.
  const address = toChecksumAddress(account.address);
  const showKeyTools = account.kind === "turnkey" && account.family === "evm";

  const copy = (): void => {
    navigator.clipboard.writeText(address);
    toast.success("Address copied");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SettingsCard
      description="Where this account lives and how its key material is handled."
      title="Account settings"
    >
      <div className="flex flex-col">
        <Row
          hint="Funds sent here are controlled by this account."
          label="Address"
        >
          <div className="flex items-center gap-2">
            <code className="max-w-[340px] truncate rounded bg-muted px-2 py-1 font-mono text-xs">
              {address}
            </code>
            <Button
              aria-label="Copy address"
              onClick={copy}
              size="icon"
              variant="ghost"
            >
              {copied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
          </div>
        </Row>

        {showKeyTools && email && (
          <Row
            hint="Used to verify a private-key export. Contact support to change it."
            label="Recovery email"
          >
            <span className="text-sm">{email}</span>
          </Row>
        )}

        {showKeyTools && isOwner && canExportKey && (
          <Row
            hint="Exporting reveals the raw key. Requires both factors."
            label="Private key"
          >
            <ExportPrivateKeyButton solanaAddress={solanaAddress} />
          </Row>
        )}
      </div>
    </SettingsCard>
  );
}
