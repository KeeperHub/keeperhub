/**
 * Agentic-wallet provisioning pipeline.
 *
 * Full flow (ONBOARD-01 / ONBOARD-02 / ONBOARD-03 / GUARD-06):
 *   1. Turnkey createSubOrganization (KeeperHub-operator, single root user,
 *      anonymous disable* flags = true, single EVM derivation path per
 *      CONTEXT Resolution #1)
 *   2. Apply 3 baseline Turnkey policies via applyBaselinePolicies (parallelized
 *      inside that helper)
 *   3. DB transaction: insert agentic_wallets row (without the legacy
 *      hmac_secret column — Phase 37 moved the secret to
 *      agentic_wallet_hmac_secrets) + insert the ONBOARD-03 $0.50 seed
 *      credit against the same transaction handle (atomic: both land or
 *      neither does).
 *   4. Outside the transaction, call insertHmacSecret(subOrgId, 1, hmacSecret):
 *      the secret store owns its own at-rest encryption boundary and a
 *      partial failure here is recoverable by a rotation rather than
 *      requiring the wallet row to roll back. If it still fails we log
 *      AGENTIC_WALLET_HMAC_INSERT_FAILED (distinct from the txn-failure
 *      AGENTIC_WALLET_LEAKED_SUBORG path) so ops can tell "wallet + credit
 *      persisted, sub-org can deposit but cannot sign" from the outer
 *      Turnkey / DB failure modes.
 *   5. Return { subOrgId, walletAddress, hmacSecret } — single wallet address
 *      per CONTEXT Resolution #1 (Base + Tempo share the same EVM address)
 *
 * T-33-02 (Information Disclosure): hmacSecret NEVER surfaces in logs or
 * errors. The return value is the only channel. logSystemError metadata
 * carries only service name + subOrgId.
 *
 * T-33-leaked-suborg (Repudiation): if sub-org creation succeeds but the
 * wallet/credit transaction fails, log AGENTIC_WALLET_LEAKED_SUBORG with
 * the sub-org id so ops can clean up manually (RESEARCH Pitfall 6).
 */
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { agenticWalletCredits, agenticWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getTurnkeyClientForOrg,
  getTurnkeyParentClient,
} from "@/lib/turnkey/agentic-wallet";
import { generateId } from "@/lib/utils/id";
import { ONBOARD_INITIAL_CREDIT_CENTS } from "./credit";
import { insertHmacSecret } from "./hmac-secret-store";
import { applyBaselinePolicies, PolicyIncompleteError } from "./policy";

export type ProvisionAgenticWalletResult = {
  subOrgId: string;
  walletAddress: string;
  hmacSecret: string;
};

export async function provisionAgenticWallet(): Promise<ProvisionAgenticWalletResult> {
  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;
  if (!(apiPublicKey && organizationId)) {
    throw new Error(
      "TURNKEY_API_PUBLIC_KEY and TURNKEY_ORGANIZATION_ID must be set"
    );
  }

  const parentClient = getTurnkeyParentClient().apiClient();

  let subOrgId: string | undefined;
  let walletAddress: string | undefined;

  try {
    const subOrg = await parentClient.createSubOrganization({
      organizationId,
      subOrganizationName: `keeperhub-agentic-${generateId()}`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: "keeperhub-operator",
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
      disableEmailAuth: true,
      disableEmailRecovery: true,
      disableSmsAuth: true,
      disableOtpEmailAuth: true,
      wallet: {
        walletName: "Default Wallet",
        accounts: [
          {
            curve: "CURVE_SECP256K1" as const,
            pathFormat: "PATH_FORMAT_BIP32" as const,
            path: "m/44'/60'/0'/0/0",
            addressFormat: "ADDRESS_FORMAT_ETHEREUM" as const,
          },
        ],
      },
    });

    subOrgId = subOrg.subOrganizationId;
    walletAddress = subOrg.wallet?.addresses?.[0];

    if (!(subOrgId && walletAddress)) {
      throw new Error("Turnkey sub-org creation returned incomplete data");
    }

    // T-33-02: never log this value. 32 random bytes -> 64 hex chars.
    const hmacSecret = randomBytes(32).toString("hex");

    // Apply the three baseline DENY policies to the newly-created sub-org
    // before returning the secret to the caller. Parallelized inside
    // applyBaselinePolicies (RESEARCH Pitfall 1 latency mitigation).
    //
    // REVIEW HI-04: applyBaselinePolicies now throws PolicyIncompleteError
    // on any partial failure. We log the orphaned sub-org distinctly so ops
    // can clean it up manually; the DB insert is skipped (the outer catch
    // re-throws) so the wallet is never returned to the caller. GUARD-06
    // requires the Turnkey policy to be the hard limit, so a sub-org with
    // partial coverage must be treated as unusable.
    try {
      await applyBaselinePolicies(
        getTurnkeyClientForOrg(subOrgId).apiClient(),
        subOrgId
      );
    } catch (policyError) {
      if (policyError instanceof PolicyIncompleteError) {
        logSystemError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[Agentic] AGENTIC_WALLET_ORPHANED_SUBORG — policies incomplete, sub-org abandoned",
          policyError,
          {
            service: "agentic-wallet",
            subOrgId,
            failures: policyError.failures.join(","),
          }
        );
      }
      throw policyError;
    }

    // Phase 37 Wave 4 Task 19: the wallet + credit inserts run inside a
    // single db.transaction so that a failing credit insert rolls the
    // wallet row back (atomic). Previously these were serialised (after
    // REVIEW ME-06) but not transactional — a credit FK / UNIQUE failure
    // could leave an orphaned wallet row with no credit ledger entry.
    //
    // The legacy agentic_wallets.hmac_secret column is intentionally not
    // written: migration 0057 deferred the drop (see SPEC.md line 117) so
    // older rows still carry their plaintext, but new rows leave the
    // column NULL and the secret lives in agentic_wallet_hmac_secrets.
    const subOrgIdStable: string = subOrgId;
    const walletAddressStable: string = walletAddress;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(agenticWallets).values({
          subOrgId: subOrgIdStable,
          // CONTEXT Resolution #1: single path => same address on both chains.
          walletAddressBase: walletAddressStable,
          walletAddressTempo: walletAddressStable,
        });
        await tx.insert(agenticWalletCredits).values({
          subOrgId: subOrgIdStable,
          amountUsdcCents: ONBOARD_INITIAL_CREDIT_CENTS,
          allocationReason: "onboard_initial",
        });
      });
    } catch (dbError) {
      logSystemError(
        ErrorCategory.DATABASE,
        "[Agentic] AGENTIC_WALLET_LEAKED_SUBORG — Turnkey sub-org created but DB insert failed",
        dbError,
        { service: "agentic-wallet", subOrgId: subOrgIdStable }
      );
      throw dbError;
    }

    // HMAC secret insert lives OUTSIDE the wallet/credit txn (plan Task 19):
    // the store has its own at-rest encryption boundary, and a failure here
    // leaves a usable-for-deposit wallet that cannot sign. We log with a
    // distinct prefix so ops can distinguish this recoverable failure mode
    // (wallet row exists; retry rotation surfaces the issue) from the
    // leaked-sub-org mode above (no wallet row, sub-org orphaned in Turnkey).
    try {
      await insertHmacSecret(subOrgIdStable, 1, hmacSecret);
    } catch (hmacError) {
      logSystemError(
        ErrorCategory.DATABASE,
        "[Agentic] AGENTIC_WALLET_HMAC_INSERT_FAILED — wallet + credit committed but HMAC secret insert failed; sub-org can deposit but cannot sign until a rotation lands a v1 row",
        hmacError,
        { service: "agentic-wallet", subOrgId: subOrgIdStable, keyVersion: "1" }
      );
      throw hmacError;
    }

    return { subOrgId, walletAddress, hmacSecret };
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Agentic] Failed to provision agentic wallet",
      error,
      { service: "agentic-wallet", subOrgId: subOrgId ?? "unknown" }
    );
    throw error;
  }
}
