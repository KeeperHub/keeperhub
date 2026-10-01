import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationApiKeys } from "@/lib/db/schema";
import type { ActorCredential } from "@/lib/security/credential-label";

/**
 * Resolve API key ids to their labels so an audited action can say which key
 * was used, not just whose key it was. Returns a map keyed by key id;
 * revoked keys still resolve, deleted ones simply drop out.
 */
export async function loadApiKeyNames(
  apiKeyIds: Array<string | null>
): Promise<Map<string, string>> {
  const ids = [...new Set(apiKeyIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: organizationApiKeys.id, name: organizationApiKeys.name })
    .from(organizationApiKeys)
    .where(inArray(organizationApiKeys.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Build the display credential for one row from a resolved name map. */
export function buildCredential(
  authMethod: string,
  apiKeyId: string | null,
  names: Map<string, string>
): ActorCredential {
  return {
    authMethod,
    apiKeyName: apiKeyId ? (names.get(apiKeyId) ?? null) : null,
  };
}
