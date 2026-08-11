import "server-only";
import { and, eq } from "drizzle-orm";
import { recordWalletInAddressBook } from "@/lib/address-book/record-wallet";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { db } from "@/lib/db";
import {
  buildWalletIntegrationPayload,
  createIntegration,
} from "@/lib/db/integrations";
import { type OrganizationWallet, organizationWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { createTurnkeyWallet } from "@/lib/turnkey/turnkey-client";

export type ProvisionWalletInput = {
  userId: string;
  organizationId: string;
  email: string;
};

export type ProvisionWalletResult = {
  // true when this call created the wallet; false when an active wallet
  // already existed (idempotent no-op, including the lost side of a race).
  created: boolean;
  walletAddress: string;
  solanaAddress: string | null; // NEW
  walletId: string | null;
  subOrgId: string | null;
};

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "23505"
  );
}

async function getActiveWallet(
  organizationId: string
): Promise<OrganizationWallet | null> {
  const rows = await db
    .select()
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

function toResult(
  wallet: OrganizationWallet,
  created: boolean
): ProvisionWalletResult {
  return {
    created,
    walletAddress: wallet.walletAddress,
    solanaAddress: wallet.solanaAddress ?? null,
    walletId: wallet.turnkeyWalletId,
    subOrgId: wallet.turnkeySubOrgId,
  };
}

/**
 * Idempotently provision an organization's non-custodial Turnkey wallet.
 *
 * Returns the existing wallet untouched if one is already active for the org
 * (so it is safe to call from multiple places - the signup hook, the session
 * backstop, and the manual POST /api/user/wallet route). A concurrent caller
 * that loses the partial-unique-index race (organization_wallets_org_active_unique)
 * is also treated as a no-op rather than an error.
 *
 * Note: the Turnkey sub-org creation is not transactional with the DB insert,
 * so the race loser can leave an orphaned (unused) Turnkey sub-org. This
 * matches the pre-existing behaviour of the wallet route and is accepted.
 */
export async function provisionOrganizationWallet(
  input: ProvisionWalletInput
): Promise<ProvisionWalletResult> {
  const { userId, organizationId, email } = input;

  const existing = await getActiveWallet(organizationId);
  if (existing) {
    return toResult(existing, false);
  }

  const orgName = `org-${organizationId.slice(0, 8)}`;
  const turnkeyResult = await createTurnkeyWallet(email, orgName);
  const normalizedWalletAddress = normalizeAddressForStorage(
    turnkeyResult.walletAddress
  );

  try {
    await db.insert(organizationWallets).values({
      userId,
      organizationId,
      email,
      walletAddress: normalizedWalletAddress,
      solanaAddress: turnkeyResult.solanaAddress ?? null, // NEW — raw base58
      turnkeySubOrgId: turnkeyResult.subOrgId,
      turnkeyWalletId: turnkeyResult.walletId,
      turnkeyPrivateKeyId: turnkeyResult.privateKeyId,
    });
  } catch (error) {
    // A concurrent caller won the race and inserted first. The Turnkey
    // sub-org we just created is orphaned; return the wallet that won.
    if (isUniqueViolation(error)) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Wallet] Provisioning race: another caller created the wallet first; orphaned Turnkey sub-org",
        error,
        {
          organizationId,
          orphanedSubOrgId: turnkeyResult.subOrgId,
          orphanedSolanaAddress: turnkeyResult.solanaAddress ?? "none",
        }
      );
      const winner = await getActiveWallet(organizationId);
      if (winner) {
        return toResult(winner, false);
      }
    }
    throw error;
  }

  await createIntegration(
    buildWalletIntegrationPayload(
      userId,
      organizationId,
      normalizedWalletAddress
    )
  );

  await recordWalletInAddressBook({
    organizationId,
    address: normalizedWalletAddress,
    label: "Org Wallet",
    createdBy: userId,
  });

  return {
    created: true,
    walletAddress: normalizedWalletAddress,
    solanaAddress: turnkeyResult.solanaAddress ?? null, // NEW
    walletId: turnkeyResult.walletId,
    subOrgId: turnkeyResult.subOrgId,
  };
}
