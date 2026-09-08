"use client";

import { ExportPrivateKeyButton } from "./export-private-key-button";

export function SecurityCard({
  solanaAddress,
}: {
  solanaAddress?: string | null;
}): React.ReactElement {
  return (
    <section>
      <div className="mb-1 font-medium text-sm">Security</div>
      <p className="mb-3 text-muted-foreground text-xs">
        Export the private key to move funds to another wallet or access your
        wallet outside KeeperHub. Keep it secret. Anyone with the key controls
        the wallet.
      </p>
      <ExportPrivateKeyButton solanaAddress={solanaAddress} />
    </section>
  );
}
