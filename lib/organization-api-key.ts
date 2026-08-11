import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { organizationApiKeys } from "@/lib/db/schema";
import { notifyApiKeyChange } from "@/lib/security/api-key-notification";
import { recordAuditEvent } from "@/lib/security/audit-log";

/**
 * The label given to keys minted by the CLI device-authorization flow, so they
 * are distinguishable from keys a user created by hand in the dashboard.
 */
export const CLI_DEVICE_KEY_NAME = "kh CLI";

/**
 * Mint an organization API key.
 *
 * The plaintext key is returned to the caller and never stored - only its
 * SHA-256 hash goes to the database, which is why a key can be shown exactly
 * once and why an existing key can never be re-issued.
 */
export function generateOrganizationApiKey(): {
  key: string;
  hash: string;
  prefix: string;
} {
  const randomPart = randomBytes(24).toString("base64url");
  const key = `kh_${randomPart}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 8); // "kh_" + first 5 chars
  return { key, hash, prefix };
}

/**
 * Issue an API key for a CLI device login and record it the same way a
 * dashboard-created key is recorded.
 *
 * The device flow's own credential is a Better Auth session token, which no
 * server auth path accepts from a CLI: `lib/api-key-auth.ts` requires a `kh_`
 * prefix, and session tokens are only usable as cookies. Rather than widen
 * bearer auth to cover session tokens - deliberately closed off in the
 * `bearer()` plugin removal to keep the MFA and IP step-up gates intact - the
 * device grant hands back the credential shape the API already accepts.
 *
 * Emits the same notification and audit event as the dashboard path: this
 * creates a real org credential and must be as visible and revocable as any
 * other.
 */
export async function issueCliDeviceApiKey(params: {
  userId: string;
  userEmail: string | null;
  organizationId: string;
  auditMetadata?: Record<string, unknown>;
}): Promise<string> {
  const { key, hash, prefix } = generateOrganizationApiKey();

  const [newKey] = await db
    .insert(organizationApiKeys)
    .values({
      organizationId: params.organizationId,
      name: CLI_DEVICE_KEY_NAME,
      keyHash: hash,
      keyPrefix: prefix,
      createdBy: params.userId,
      expiresAt: null,
      scope: null,
    })
    .returning({
      id: organizationApiKeys.id,
      name: organizationApiKeys.name,
      keyPrefix: organizationApiKeys.keyPrefix,
      createdAt: organizationApiKeys.createdAt,
    });

  notifyApiKeyChange({
    userId: params.userId,
    loginEmail: params.userEmail ?? "",
    action: "created",
    tokenName: newKey.name,
    keyPrefix: newKey.keyPrefix,
    when: newKey.createdAt,
  });
  await recordAuditEvent({
    actor: {
      userId: params.userId,
      organizationId: params.organizationId,
      authMethod: "session",
    },
    action: "org_api_key.created",
    resourceType: "org_api_key",
    resourceId: newKey.id,
    after: { name: newKey.name, keyPrefix: newKey.keyPrefix },
    metadata: params.auditMetadata,
  });

  return key;
}
