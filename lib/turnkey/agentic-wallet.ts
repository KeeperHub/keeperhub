/**
 * Agentic Wallet Turnkey module.
 *
 * MODULE BOUNDARY (v1.8 custody isolation):
 * This file MUST NOT import from `./turnkey-operations`. Creator wallets
 * (org-scoped, user-authenticated) and agentic wallets (KeeperHub-owned
 * sub-orgs, server-proxied signing) are separate custody models. Entangling
 * them re-introduces the coupling v1.8 was designed to prevent.
 *
 * If you are about to import a creator-wallet helper (wallet creation,
 * private-key export, or signer config) from `./turnkey-operations` -- stop.
 * Add the primitive you need to this file instead, or use the low-level
 * @turnkey/sdk-server client directly.
 *
 * Enforced by: tests/unit/agentic-wallet-boundary.test.ts (static string check)
 * and code review.
 */
import { Turnkey } from "@turnkey/sdk-server";
import { provisionAgenticWallet } from "@/lib/agentic-wallet/provision";

/**
 * Passkey Relying Party ID for agentic-wallet passkey enrollment.
 *
 * Apex domain (NOT the `app.` subdomain) so credentials registered via the
 * webapp can be used by future subdomains without re-enrollment (ONBOARD-05).
 *
 * This is the ONLY definition of the agentic-wallet RPID in the codebase.
 */
export const AGENTIC_RPID = "keeperhub.com";

export type CreateAgenticWalletResult = {
  subOrgId: string;
  walletAddressBase: string;
  walletAddressTempo: string;
};

function readTurnkeyEnv(): {
  apiPublicKey: string;
  apiPrivateKey: string;
  organizationId: string;
} {
  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;
  if (!(apiPublicKey && apiPrivateKey && organizationId)) {
    throw new Error(
      "TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID must be set"
    );
  }
  return { apiPublicKey, apiPrivateKey, organizationId };
}

/**
 * Parent-org-scoped Turnkey client. Used for `createSubOrganization` which
 * must execute in the KeeperHub parent-org context. The resulting sub-org
 * inherits its own policy scope; do NOT reuse this instance for per-sub-org
 * calls (policies would not apply).
 */
export function getTurnkeyParentClient(): Turnkey {
  const { apiPublicKey, apiPrivateKey, organizationId } = readTurnkeyEnv();
  return new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  });
}

/**
 * Sub-org-scoped Turnkey client. Used for per-sub-org calls: `createPolicy`,
 * `signRawPayload`, wallet reads.
 *
 * CRITICAL: must instantiate a NEW Turnkey client with `defaultOrganizationId:
 * subOrgId`. Reusing a parent-scoped instance signs with the parent org
 * context and policies do NOT apply. See 33-RESEARCH.md Anti-Patterns.
 */
export function getTurnkeyClientForOrg(subOrgId: string): Turnkey {
  const { apiPublicKey, apiPrivateKey } = readTurnkeyEnv();
  return new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: subOrgId,
  });
}

/**
 * Create a KeeperHub-owned Turnkey sub-org for an agentic wallet.
 *
 * The implementation lives in lib/agentic-wallet/provision.ts (Plan 33-01a).
 * This wrapper preserves the Phase-32-published `{subOrgId, walletAddressBase,
 * walletAddressTempo}` shape by mirroring the single EVM address onto both
 * Base and Tempo columns (CONTEXT Resolution #1 — single derivation path).
 */
export async function createAgenticWallet(): Promise<CreateAgenticWalletResult> {
  const { subOrgId, walletAddress } = await provisionAgenticWallet();
  return {
    subOrgId,
    walletAddressBase: walletAddress,
    walletAddressTempo: walletAddress,
  };
}
