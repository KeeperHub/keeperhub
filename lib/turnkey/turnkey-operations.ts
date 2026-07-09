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
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  });

  return turnkeyInstance;
}

export type TurnkeyWalletResult = {
  subOrgId: string;
  walletId: string;
  privateKeyId: string;
  walletAddress: string;          // EVM
  solanaAddress: string | null;   // NEW
};

export async function createTurnkeyWallet(
  email: string,
  organizationName: string
): Promise<TurnkeyWalletResult> {
  const turnkey = getTurnkeyClient();
  const client = turnkey.apiClient();

  let subOrgId: string | undefined;
  let walletId: string | undefined;

  try {
    const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY ?? "";

    // 1. Primary path: try creating both EVM and Solana accounts in createSubOrganization
    const subOrg = await client.createSubOrganization({
      organizationId: process.env.TURNKEY_ORGANIZATION_ID ?? "",
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
        accounts: [
          {
            curve: "CURVE_SECP256K1",
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/44'/60'/0'/0/0",
            addressFormat: "ADDRESS_FORMAT_ETHEREUM",
          },
          {
            curve: "CURVE_ED25519",
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/44'/501'/0'/0'",
            addressFormat: "ADDRESS_FORMAT_SOLANA",
          },
        ],
      },
    });

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

    const walletAddress = evmAccount?.address ?? subOrg.wallet?.addresses?.[0];
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

    try {
      const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY ?? "";
      const subOrg = await client.createSubOrganization({
        organizationId: process.env.TURNKEY_ORGANIZATION_ID ?? "",
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
          accounts: [
            {
              curve: "CURVE_SECP256K1",
              pathFormat: "PATH_FORMAT_BIP32",
              path: "m/44'/60'/0'/0/0",
              addressFormat: "ADDRESS_FORMAT_ETHEREUM",
            },
          ],
        },
      });

      walletId = subOrg.wallet?.walletId;
      subOrgId = subOrg.subOrganizationId;
      const walletAddress = subOrg.wallet?.addresses?.[0];

      if (!(walletId && subOrgId && walletAddress)) {
        throw new Error(
          "Fallback Turnkey sub-organization creation returned incomplete data"
        );
      }

      // Try adding Solana account separately
      let solanaAddress: string | null = null;
      try {
        const solanaAccountResult = await client.createWalletAccounts({
          organizationId: subOrgId,
          walletId,
          accounts: [
            {
              curve: "CURVE_ED25519",
              pathFormat: "PATH_FORMAT_BIP32",
              path: "m/44'/501'/0'/0'",
              addressFormat: "ADDRESS_FORMAT_SOLANA",
            },
          ],
        });
        solanaAddress = solanaAccountResult.addresses?.[0] ?? null;
      } catch (solanaError) {
        logSystemError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[Turnkey] Fallback Solana account creation failed via createWalletAccounts",
          solanaError,
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
  walletAddress: string
): Promise<string> {
  const turnkey = getTurnkeyClient();
  const client = turnkey.apiClient();

  try {
    const keyPair = generateP256KeyPair();

    const exportResult = await client.exportWalletAccount({
      organizationId: subOrgId,
      address: walletAddress,
      targetPublicKey: keyPair.publicKeyUncompressed,
    });

    if (!exportResult.exportBundle) {
      throw new Error("Turnkey returned empty export bundle");
    }

    const privateKey = await decryptExportBundle({
      exportBundle: exportResult.exportBundle,
      embeddedKey: keyPair.privateKey,
      organizationId: subOrgId,
      keyFormat: "HEXADECIMAL",
      returnMnemonic: false,
    });

    return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Turnkey] Failed to export private key",
      error,
      { service: "turnkey" }
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
    apiBaseUrl: "https://api.turnkey.com",
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
