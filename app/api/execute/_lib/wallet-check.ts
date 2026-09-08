import "server-only";

import { NextResponse } from "next/server";
import { organizationHasWallet } from "@/lib/web3/wallet-helpers";

/**
 * Check if the organization has a wallet configured.
 * Returns a 422 response if not, null if the wallet exists.
 */
export async function requireWallet(
  organizationId: string
): Promise<NextResponse | null> {
  const hasWallet = await organizationHasWallet(organizationId);

  if (!hasWallet) {
    return NextResponse.json(
      {
        error:
          "No wallet configured for this organization. Create a wallet in Settings before executing transactions.",
        code: "WALLET_NOT_CONFIGURED",
      },
      { status: 422 }
    );
  }

  return null;
}
