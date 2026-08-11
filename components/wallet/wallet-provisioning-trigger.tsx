"use client";

import { useWalletProvisioning } from "@/lib/wallet/use-wallet-provisioning";

/**
 * Invisible global trigger mounted once in the root layout so signup-time
 * wallet provisioning runs no matter where the user lands after email or social
 * signup (the wallet toolbar only exists on workflow pages).
 */
export function WalletProvisioningTrigger(): null {
  useWalletProvisioning();
  return null;
}
