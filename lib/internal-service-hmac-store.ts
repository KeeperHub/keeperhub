/**
 * @security Versioned, encrypted-at-rest HMAC secret access for internal
 * service-to-service auth. Modelled on lib/agentic-wallet/hmac-secret-store.ts.
 *
 * Rows live in internal_service_hmac_secrets keyed on (caller, key_version).
 * Stored as AES-256-GCM ciphertext using the shared envelope helpers from
 * lib/agentic-wallet/hmac-secret-store.ts:
 *   `${base64(iv)}:${base64(authTag)}:${base64(ciphertext)}`
 *
 * AAD = `${caller}:${keyVersion}`. Even though we share the encryption helpers
 * with agentic-wallet, the ciphertext is bound to its (table, caller, version)
 * by the AAD; a DB-level attacker who copied a row into the wrong cell would
 * fail the GCM tag check on decrypt.
 *
 * The shared helpers read process.env.AGENTIC_WALLET_HMAC_KMS_KEY. Reusing
 * the same key keeps the hotfix's provisioning critical path short; a
 * dedicated key for the internal-service domain is a follow-up.
 *
 * NEVER log secret material. Log only caller and key version.
 */
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  decryptSecret,
  encryptSecret,
} from "@/lib/agentic-wallet/hmac-secret-store";
import { db } from "@/lib/db";
import { internalServiceHmacSecrets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export type InternalHmacLookupResult = {
  secret: string;
  keyVersion: number;
} | null;

/**
 * Look up an HMAC secret for `caller`. If `keyVersion` is given, return that
 * exact version (for callers that pin via X-KH-Key-Version); otherwise return
 * the highest active version (active = expires_at IS NULL OR expires_at > now()).
 */
export async function lookupHmacSecret(
  caller: string,
  keyVersion?: number
): Promise<InternalHmacLookupResult> {
  const now = new Date();
  const activeFilter = or(
    isNull(internalServiceHmacSecrets.expiresAt),
    gt(internalServiceHmacSecrets.expiresAt, now)
  );
  const where =
    keyVersion === undefined
      ? and(eq(internalServiceHmacSecrets.caller, caller), activeFilter)
      : and(
          eq(internalServiceHmacSecrets.caller, caller),
          eq(internalServiceHmacSecrets.keyVersion, keyVersion),
          activeFilter
        );

  const rows = await db
    .select({
      keyVersion: internalServiceHmacSecrets.keyVersion,
      secretCiphertext: internalServiceHmacSecrets.secretCiphertext,
    })
    .from(internalServiceHmacSecrets)
    .where(where)
    .orderBy(internalServiceHmacSecrets.keyVersion);

  if (rows.length === 0) {
    return null;
  }
  // Highest active version wins (ascending order; take the last row).
  const row = rows.at(-1) as {
    keyVersion: number;
    secretCiphertext: string;
  };

  let plaintext: string;
  try {
    plaintext = decryptSecret(row.secretCiphertext, caller, row.keyVersion);
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[InternalAuth] hmac decrypt failed",
      error,
      { caller, keyVersion: String(row.keyVersion) }
    );
    return null;
  }

  return { secret: plaintext, keyVersion: row.keyVersion };
}

export async function insertHmacSecret(
  caller: string,
  keyVersion: number,
  plaintext: string,
  expiresAt: Date | null = null
): Promise<void> {
  await db.insert(internalServiceHmacSecrets).values({
    caller,
    keyVersion,
    secretCiphertext: encryptSecret(plaintext, caller, keyVersion),
    expiresAt,
  });
}

/**
 * Maximum number of active HMAC secrets returned per caller. Mirrors the
 * agentic-wallet bound: caps the verifier's per-request work at O(8) HMAC
 * computes regardless of rotation cadence.
 */
const MAX_ACTIVE_HMAC_CANDIDATES = 8;

/**
 * Return ALL active (non-expired) HMAC secrets for a caller, newest version
 * first. The unpinned-version verifier path iterates this list so the 24-hour
 * rotation grace window actually lets in-flight consumers verify against the
 * previous secret while they pick up the new one.
 *
 * Decrypt failures on individual rows are logged and skipped (not fatal): one
 * corrupted row must not lock out an otherwise-valid caller.
 */
export async function listActiveHmacSecrets(
  caller: string
): Promise<{ secret: string; keyVersion: number }[]> {
  const now = new Date();
  const rows = await db
    .select({
      keyVersion: internalServiceHmacSecrets.keyVersion,
      secretCiphertext: internalServiceHmacSecrets.secretCiphertext,
    })
    .from(internalServiceHmacSecrets)
    .where(
      and(
        eq(internalServiceHmacSecrets.caller, caller),
        or(
          isNull(internalServiceHmacSecrets.expiresAt),
          gt(internalServiceHmacSecrets.expiresAt, now)
        )
      )
    )
    .orderBy(desc(internalServiceHmacSecrets.keyVersion))
    .limit(MAX_ACTIVE_HMAC_CANDIDATES);

  const out: { secret: string; keyVersion: number }[] = [];
  for (const row of rows) {
    try {
      const plaintext = decryptSecret(
        row.secretCiphertext,
        caller,
        row.keyVersion
      );
      out.push({ secret: plaintext, keyVersion: row.keyVersion });
    } catch (error) {
      logSystemError(
        ErrorCategory.AUTH,
        "[InternalAuth] hmac decrypt failed (list)",
        error,
        { caller, keyVersion: String(row.keyVersion) }
      );
    }
  }
  return out;
}
