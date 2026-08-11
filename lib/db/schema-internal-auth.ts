/**
 * Versioned, encrypted-at-rest HMAC secrets for internal-service-to-service auth.
 *
 * One row per (caller, key_version). Rotation creates a new row at version+1
 * and stamps the previous row's `expires_at = now() + 24h` for grace, so
 * existing consumers keep verifying while they pick up the new secret.
 *
 * `secret_ciphertext` envelope shape is identical to
 * `agentic_wallet_hmac_secrets`: AES-256-GCM with a 12-byte IV, encoded as
 *   `${base64(iv)}:${base64(authTag)}:${base64(ciphertext)}`
 * AAD = `${caller}:${keyVersion}` so a row copied into a different
 * (caller, key_version) cell by a DB-level attacker fails the GCM tag check
 * instead of silently decrypting. The encryption key is read from
 * process.env.AGENTIC_WALLET_HMAC_KMS_KEY (32 bytes b64); see
 * lib/agentic-wallet/hmac-secret-store.ts for the helpers we reuse.
 *
 * Valid `caller` values are the InternalCaller union in
 * lib/internal-service-auth.ts (executor, scheduler, events, mcp, hub, reaper)
 * plus the sentinel "*shared*" used while every producer still sends a single
 * shared signing secret. Application code is the source of truth for the set;
 * the column is plain text to avoid coupling rotation cadence to a pgEnum
 * migration.
 *
 * No foreign key: callers are external services, not rows in another table.
 */
import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const internalServiceHmacSecrets = pgTable(
  "internal_service_hmac_secrets",
  {
    caller: text("caller").notNull(),
    keyVersion: integer("key_version").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
  },
  (table) => [primaryKey({ columns: [table.caller, table.keyVersion] })]
);

export type InternalServiceHmacSecret =
  typeof internalServiceHmacSecrets.$inferSelect;
export type NewInternalServiceHmacSecret =
  typeof internalServiceHmacSecrets.$inferInsert;
