/**
 * Core Turnkey operations.
 *
 * This module intentionally does NOT include `import "server-only"` so it
 * can be loaded from standalone scripts (e.g. the Para → Turnkey provisioning
 * script run in the deploy init container). Next.js callers should import
 * from `./turnkey-client` instead, which re-exports these same symbols and
 * carries the client-component guard.
 */
import { decryptExportBundle, generateP256KeyPair } from "@turnkey/crypto";
import { Turnkey } from "@turnkey/sdk-server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { isSolanaWalletProvisioningEnabled } from "@/lib/turnkey/solana-provisioning-flag";
import { TURNKEY_API_BASE_URL } from "./api-base-url";

let turnkeyInstance: Turnkey | undefined;

function getTurnkeyClient(): Turnkey {
  if (turnkeyInstance) {
    return turnkeyInstance;
  }

  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;

  if (!(apiPublicKey && apiPrivateKey && organizationId)) {
    throw new Error(
      "TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID must be set"
    );
  }

  turnkeyInstance = new Turnkey({
    apiBaseUrl: TURNKEY_API_BASE_URL,
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  });

  return turnkeyInstance;
}

const EVM_AND_SOLANA_ACCOUNTS = [
  {
    curve: "CURVE_SECP256K1" as const,
    pathFormat: "PATH_FORMAT_BIP32" as const,
    path: "m/44'/60'/0'/0/0",
    addressFormat: "ADDRESS_FORMAT_ETHEREUM" as const,
  },
  {
    curve: "CURVE_ED25519" as const,
    pathFormat: "PATH_FORMAT_BIP32" as const,
    path: "m/44'/501'/0'/0'",
    addressFormat: "ADDRESS_FORMAT_SOLANA" as const,
  },
];

const EVM_ONLY_ACCOUNTS = [
  {
    curve: "CURVE_SECP256K1" as const,
    pathFormat: "PATH_FORMAT_BIP32" as const,
    path: "m/44'/60'/0'/0/0",
    addressFormat: "ADDRESS_FORMAT_ETHEREUM" as const,
  },
];

// Single-element array reused by both EVM_AND_SOLANA_ACCOUNTS and the B5
// reconciliation path — one source of truth for the ED25519 derivation shape.
export const SOLANA_ONLY_ACCOUNT = [
  {
    curve: "CURVE_ED25519" as const,
    pathFormat: "PATH_FORMAT_BIP32" as const,
    path: "m/44'/501'/0'/0'",
    addressFormat: "ADDRESS_FORMAT_SOLANA" as const,
  },
];

type SubOrgAccount =
  | (typeof EVM_AND_SOLANA_ACCOUNTS)[number]
  | (typeof EVM_ONLY_ACCOUNTS)[number]
  | (typeof SOLANA_ONLY_ACCOUNT)[number];

function buildSubOrgRequest(
  organizationId: string,
  organizationName: string,
  email: string,
  apiPublicKey: string,
  accounts: readonly SubOrgAccount[]
) {
  return {
    organizationId,
    subOrganizationName: `keeperhub-${organizationName}`,
    rootQuorumThreshold: 1,
    rootUsers: [
      {
        userName: "keeperhub-admin",
        userEmail: email,
        apiKeys: [
          {
            apiKeyName: "keeperhub-server",
            publicKey: apiPublicKey,
            curveType: "API_KEY_CURVE_P256" as const,
          },
        ],
        authenticators: [],
        oauthProviders: [],
      },
    ],
    wallet: {
      walletName: "Default Wallet",
      accounts: [...accounts],
    },
  };
}

export type TurnkeyWalletResult = {
  subOrgId: string;
  walletId: string;
  privateKeyId: string;
  walletAddress: string; // EVM
  solanaAddress: string | null; // NEW
};

export async function createTurnkeyWallet(
  email: string,
  organizationName: string
): Promise<TurnkeyWalletResult> {
  const turnkey = getTurnkeyClient();
  const client = turnkey.apiClient();

  // Gate Solana account creation behind an env flag so wallets can be
  // provisioned EVM-only until a Solana RPC is configured (CHAIN_RPC_CONFIG).
  const solanaEnabled = isSolanaWalletProvisioningEnabled();

  let subOrgId: string | undefined;
  let walletId: string | undefined;

  try {
    const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY ?? "";

    // 1. Primary path: create the sub-org with EVM (+ Solana when enabled).
    const subOrg = await client.createSubOrganization(
      buildSubOrgRequest(
        process.env.TURNKEY_ORGANIZATION_ID ?? "",
        organizationName,
        email,
        apiPublicKey,
        solanaEnabled ? EVM_AND_SOLANA_ACCOUNTS : EVM_ONLY_ACCOUNTS
      )
    );

    walletId = subOrg.wallet?.walletId;
    subOrgId = subOrg.subOrganizationId;

    if (!(walletId && subOrgId)) {
      throw new Error(
        "Turnkey sub-organization creation returned incomplete data"
      );
    }

    // Query both accounts to identify which is EVM and which is Solana
    const walletAccounts = await client.getWalletAccounts({
      organizationId: subOrgId,
      walletId,
    });

    const evmAccount = walletAccounts.accounts?.find(
      (a) => a.addressFormat === "ADDRESS_FORMAT_ETHEREUM"
    );
    const solanaAccount = walletAccounts.accounts?.find(
      (a) => a.addressFormat === "ADDRESS_FORMAT_SOLANA"
    );

    // Resolve the EVM address strictly by addressFormat. Do NOT fall back to
    // subOrg.wallet.addresses[0] by index: with dual EVM+Solana accounts that
    // slot is order-dependent and could yield the Solana address, corrupting
    // the EVM column. A missing EVM account throws below instead of guessing.
    const walletAddress = evmAccount?.address;
    const solanaAddress = solanaAccount?.address ?? null;

    if (!walletAddress) {
      throw new Error("EVM wallet address not found after sub-org creation");
    }

    if (!solanaAddress) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Turnkey] Solana account not found in wallet after creation; solanaAddress will be null",
        undefined,
        { service: "turnkey", subOrgId }
      );
    }

    return {
      subOrgId,
      walletId,
      privateKeyId: "",
      walletAddress,
      solanaAddress,
    };
  } catch (error) {
    // If the two-account creation failed, try to fallback safely.
    // If subOrgId was already created/assigned, we shouldn't orphan it without logging.
    if (subOrgId && walletId) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Turnkey] Two-account sub-org creation partially succeeded but failed on post-creation check",
        error,
        { service: "turnkey", subOrgId, walletId }
      );
      throw error;
    }

    // 2. Fallback path: Try creating single EVM account first, then create Solana account separately
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Turnkey] Two-account sub-org creation failed. Retrying with EVM-only, then createWalletAccounts",
      error,
      { service: "turnkey" }
    );

    // B5: Before creating a new sub-org on the fallback path, check if the primary path
    // partially succeeded server-side (leaving a sub-org with our name but no locally captured subOrgId).
    const orgName = `keeperhub-${organizationName}`;
    let existingSubOrgId: string | undefined;
    let existingWalletId: string | undefined;

    try {
      const subOrgs = await client.getSubOrgIds({
        organizationId: process.env.TURNKEY_ORGANIZATION_ID ?? "",
        filterType: "NAME",
        filterValue: orgName,
      });
      const match = subOrgs.organizationIds?.[0];
      if (match) {
        existingSubOrgId = match;
        const wallets = await client.getWallets({ organizationId: match });
        existingWalletId = wallets.wallets?.[0]?.walletId;
      }
    } catch (reconcileError) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Turnkey] Failed to reconcile existing sub-org by name; proceeding with new sub-org creation",
        reconcileError,
        { service: "turnkey", orgName }
      );
    }

    if (existingSubOrgId && existingWalletId) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Turnkey] Reconciled existing sub-org by name after partial primary creation",
        undefined,
        { service: "turnkey", existingSubOrgId, orgName }
      );

      let solanaAddress: string | null = null;
      if (solanaEnabled) {
        try {
          solanaAddress = await fetchOrCreateSolanaWalletAddress(
            client,
            existingSubOrgId,
            existingWalletId
          );
        } catch (solanaError) {
          logSystemError(
            ErrorCategory.EXTERNAL_SERVICE,
            "[Turnkey] Solana account add failed on reconciled sub-org",
            solanaError,
            { service: "turnkey", existingSubOrgId }
          );
        }
      }

      const walletAccounts = await client.getWalletAccounts({
        organizationId: existingSubOrgId,
        walletId: existingWalletId,
      });
      const evmAccount = walletAccounts.accounts?.find(
        (a) => a.addressFormat === "ADDRESS_FORMAT_ETHEREUM"
      );
      const walletAddress = evmAccount?.address;
      if (!walletAddress) {
        throw new Error("EVM address not found in reconciled sub-org");
      }

      if (solanaEnabled && !solanaAddress) {
        solanaAddress = findSolanaWalletAddress(walletAccounts.accounts);
      }

      return {
        subOrgId: existingSubOrgId,
        walletId: existingWalletId,
        // privateKeyId is hardcoded "" on ALL return paths of createTurnkeyWallet
        // (both the primary and the original fallback path). The DB column
        // turnkey_private_key_id is write-only — no signing code ever reads it back;
        // signing uses turnkeySubOrgId + walletAddress via getTurnkeySignerConfig.
        // Leaving it blank here is intentional, not a bug.
        privateKeyId: "",
        walletAddress,
        solanaAddress,
      };
    }

    try {
      const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY ?? "";
      const subOrg = await client.createSubOrganization(
        buildSubOrgRequest(
          process.env.TURNKEY_ORGANIZATION_ID ?? "",
          organizationName,
          email,
          apiPublicKey,
          EVM_ONLY_ACCOUNTS
        )
      );

      walletId = subOrg.wallet?.walletId;
      subOrgId = subOrg.subOrganizationId;
      const walletAddress = subOrg.wallet?.addresses?.[0];

      if (!(walletId && subOrgId && walletAddress)) {
        throw new Error(
          "Fallback Turnkey sub-organization creation returned incomplete data"
        );
      }

      // Try adding Solana account separately (when enabled)
      let solanaAddress: string | null = null;
      if (solanaEnabled) {
        try {
          solanaAddress = await fetchOrCreateSolanaWalletAddress(
            client,
            subOrgId,
            walletId
          );
        } catch (solanaError) {
          logSystemError(
            ErrorCategory.EXTERNAL_SERVICE,
            "[Turnkey] Fallback Solana account creation failed via createWalletAccounts",
            solanaError,
            { service: "turnkey", subOrgId }
          );
        }
      }

      return {
        subOrgId,
        walletId,
        privateKeyId: "",
        walletAddress,
        solanaAddress,
      };
    } catch (fallbackError) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Turnkey] Fallback EVM-only sub-org creation failed",
        fallbackError,
        { service: "turnkey" }
      );
      throw fallbackError;
    }
  }
}

export async function exportTurnkeyPrivateKey(
  subOrgId: string,
  address: string,
  keyType: "evm" | "solana" = "evm"
): Promise<string> {
  const turnkey = getTurnkeyClient();
  const client = turnkey.apiClient();

  try {
    const keyPair = generateP256KeyPair();

    const exportResult = await client.exportWalletAccount({
      organizationId: subOrgId,
      address,
      targetPublicKey: keyPair.publicKeyUncompressed,
    });

    if (!exportResult.exportBundle) {
      throw new Error("Turnkey returned empty export bundle");
    }

    // Solana wallets import base58 in the ed25519 layout Turnkey's SOLANA
    // format produces. Hex is what an EVM wallet wants, and handing it to
    // Phantom or Solflare gives the user a key none of them will accept -
    // which defeats the point of an export.
    const privateKey = await decryptExportBundle({
      exportBundle: exportResult.exportBundle,
      embeddedKey: keyPair.privateKey,
      organizationId: subOrgId,
      keyFormat: keyType === "solana" ? "SOLANA" : "HEXADECIMAL",
      returnMnemonic: false,
    });

    if (keyType === "solana") {
      return privateKey;
    }

    return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Turnkey] Failed to export private key",
      error,
      { service: "turnkey", key_type: keyType }
    );
    throw error;
  }
}

export function getTurnkeySignerConfig(
  subOrgId: string,
  walletAddress: string
): {
  client: ReturnType<Turnkey["apiClient"]>;
  organizationId: string;
  signWith: string;
} {
  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;

  if (!(apiPublicKey && apiPrivateKey)) {
    throw new Error(
      "TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY must be set"
    );
  }

  const turnkey = new Turnkey({
    apiBaseUrl: TURNKEY_API_BASE_URL,
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: subOrgId,
  });

  return {
    client: turnkey.apiClient(),
    organizationId: subOrgId,
    signWith: walletAddress,
  };
}

type TurnkeyWalletAccount = {
  address?: string;
  addressFormat?: string;
};

export function findSolanaWalletAddress(
  accounts: TurnkeyWalletAccount[] | undefined
): string | null {
  return (
    accounts?.find((a) => a.addressFormat === "ADDRESS_FORMAT_SOLANA")
      ?.address ?? null
  );
}

export function getTurnkeyApiClient(): ReturnType<Turnkey["apiClient"]> {
  return getTurnkeyClient().apiClient();
}

export async function fetchOrCreateSolanaWalletAddress(
  client: ReturnType<Turnkey["apiClient"]>,
  subOrgId: string,
  walletId: string
): Promise<string> {
  const existing = await client.getWalletAccounts({
    organizationId: subOrgId,
    walletId,
  });
  const found = findSolanaWalletAddress(existing.accounts);
  if (found) {
    return found;
  }

  // Nothing serialises provisioning, so two steps for the same organization can
  // reach this point together and both try to create. The account derives from
  // a fixed path, so whoever wins produces the same address: treat a create
  // failure as "another caller got there first" and settle it by re-reading,
  // rather than failing a step for which a usable address now exists.
  let createError: unknown;
  try {
    await client.createWalletAccounts({
      organizationId: subOrgId,
      walletId,
      accounts: SOLANA_ONLY_ACCOUNT,
    });
  } catch (error) {
    createError = error;
  }

  const refreshed = await client.getWalletAccounts({
    organizationId: subOrgId,
    walletId,
  });
  const created = findSolanaWalletAddress(refreshed.accounts);
  if (created) {
    return created;
  }
  if (createError) {
    throw createError;
  }
  throw new Error(
    "No Solana address available from Turnkey (create/getWalletAccounts)"
  );
}
