/**
 * @security Versioned, encrypted-at-rest HMAC secret access helper.
 *
 * Phase 37: secrets live in agentic_wallet_hmac_secrets keyed on
 * (sub_org_id, key_version). Stored as AES-256-GCM ciphertext encoded as
 *   base64(iv) + ":" + base64(authTag) + ":" + base64(ciphertext)
 *
 * AAD binding: each envelope is authenticated against
 *   AAD = `${subOrgId}:${keyVersion}` (utf-8)
 * so a ciphertext copied into a different (sub_org_id, key_version) row by a
 * DB-level attacker fails the GCM tag check instead of silently decrypting
 * as if it belonged to that row.
 *
 * Encryption key: process.env.AGENTIC_WALLET_HMAC_KMS_KEY (base64, 32 bytes).
 * Boot fails loudly if missing or wrong size.
 *
 * Backfill compat: rows inserted by migration 0057 carry the prefix
 * "__PLAINTEXT_BACKFILL__:" before the original plaintext. decryptSecret
 * strips the prefix BEFORE touching AES-GCM (so AAD is irrelevant for those
 * rows) and lookupHmacSecret performs an in-place re-encrypt with AAD bound
 * so the marker disappears after first read.
 *
 * NEVER log secret material. Log only sub-org id and key version.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { agenticWalletHmacSecrets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

const PLAINTEXT_BACKFILL_PREFIX = "__PLAINTEXT_BACKFILL__:";

function getKey(): Buffer {
  const b64 = process.env.AGENTIC_WALLET_HMAC_KMS_KEY;
  if (!b64) {
    throw new Error(
      "AGENTIC_WALLET_HMAC_KMS_KEY not set — refusing to start. Provision a 32-byte base64 key."
    );
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `AGENTIC_WALLET_HMAC_KMS_KEY must decode to 32 bytes, got ${buf.length}`
    );
  }
  return buf;
}

function buildAad(subOrgId: string, keyVersion: number): Buffer {
  return Buffer.from(`${subOrgId}:${keyVersion}`, "utf8");
}

export function encryptSecret(
  plaintext: string,
  subOrgId: string,
  keyVersion: number
): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(buildAad(subOrgId, keyVersion));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

export function decryptSecret(
  envelope: string,
  subOrgId: string,
  keyVersion: number
): string {
  if (envelope.startsWith(PLAINTEXT_BACKFILL_PREFIX)) {
    return envelope.slice(PLAINTEXT_BACKFILL_PREFIX.length);
  }
  const parts = envelope.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext envelope");
  }
  const [ivB64, tagB64, bodyB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const body = Buffer.from(bodyB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(buildAad(subOrgId, keyVersion));
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(body), decipher.final()]);
  return dec.toString("utf8");
}

export type LookupResult = {
  secret: string;
  keyVersion: number;
} | null;

/**
 * Look up an HMAC secret. If keyVersion is given, return that exact version
 * (for clients that pin); otherwise return the highest active version
 * (active = expires_at IS NULL OR expires_at > now()).
 *
 * Lazy backfill: if the row's ciphertext starts with the plaintext-backfill
 * prefix, re-encrypt (with AAD bound to this row's identity) and write back
 * before returning.
 */
export async function lookupHmacSecret(
  subOrgId: string,
  keyVersion?: number
): Promise<LookupResult> {
  const now = new Date();
  const activeFilter = or(
    isNull(agenticWalletHmacSecrets.expiresAt),
    gt(agenticWalletHmacSecrets.expiresAt, now)
  );
  const where =
    keyVersion === undefined
      ? and(eq(agenticWalletHmacSecrets.subOrgId, subOrgId), activeFilter)
      : and(
          eq(agenticWalletHmacSecrets.subOrgId, subOrgId),
          eq(agenticWalletHmacSecrets.keyVersion, keyVersion),
          activeFilter
        );

  const rows = await db
    .select({
      keyVersion: agenticWalletHmacSecrets.keyVersion,
      secretCiphertext: agenticWalletHmacSecrets.secretCiphertext,
    })
    .from(agenticWalletHmacSecrets)
    .where(where)
    .orderBy(agenticWalletHmacSecrets.keyVersion);

  if (rows.length === 0) {
    return null;
  }
  // Highest active version wins (rows are ordered ascending by key_version).
  // rows.at(-1) is non-null given the length check above.
  const row = rows.at(-1) as {
    keyVersion: number;
    secretCiphertext: string;
  };

  let plaintext: string;
  try {
    plaintext = decryptSecret(row.secretCiphertext, subOrgId, row.keyVersion);
  } catch (error) {
    logSystemError(ErrorCategory.AUTH, "[Agentic] hmac decrypt failed", error, {
      subOrgId,
      keyVersion: String(row.keyVersion),
    });
    return null;
  }

  // Lazy backfill: re-encrypt and update if the row was a plaintext backfill.
  if (row.secretCiphertext.startsWith(PLAINTEXT_BACKFILL_PREFIX)) {
    const reEncrypted = encryptSecret(plaintext, subOrgId, row.keyVersion);
    await db
      .update(agenticWalletHmacSecrets)
      .set({ secretCiphertext: reEncrypted })
      .where(
        and(
          eq(agenticWalletHmacSecrets.subOrgId, subOrgId),
          eq(agenticWalletHmacSecrets.keyVersion, row.keyVersion)
        )
      );
  }

  return { secret: plaintext, keyVersion: row.keyVersion };
}

export async function insertHmacSecret(
  subOrgId: string,
  keyVersion: number,
  plaintext: string,
  expiresAt: Date | null = null
): Promise<void> {
  await db.insert(agenticWalletHmacSecrets).values({
    subOrgId,
    keyVersion,
    secretCiphertext: encryptSecret(plaintext, subOrgId, keyVersion),
    expiresAt,
  });
}

/**
 * Maximum number of active HMAC secrets returned per sub-org. Fix-pack-3 N-3:
 * /rotate-hmac has no rate limit today, so without a bound, an attacker with
 * a valid HMAC could spam rotations to inflate the active-version set and
 * force every subsequent /sign (without X-KH-Key-Version) to do O(N) HMAC
 * computes. Bounding at 8 keeps the grace iteration cheap and well above any
 * legitimate rotation cadence (one every 24h at the 24h grace TTL).
 */
const MAX_ACTIVE_HMAC_CANDIDATES = 8;

/**
 * Return ALL active (non-expired) HMAC secrets for a sub-org, newest version
 * first. Fix-pack-2 R3: the 24-hour rotation grace window only works if the
 * verifier tries every active version when the client doesn't pin one via
 * X-KH-Key-Version. Without this, `lookupHmacSecret`'s highest-version-only
 * behaviour makes rotation immediately break every legacy client that hasn't
 * been retrofitted to send the version header — turning the grace window into
 * a grace mirage.
 *
 * Fix-pack-3 N-3: capped at MAX_ACTIVE_HMAC_CANDIDATES rows (newest first) so
 * the /sign iteration cost is bounded regardless of rotation rate.
 *
 * Decrypt failures on individual rows are logged and skipped (not fatal) so
 * one corrupted row doesn't lock out an otherwise-valid sub-org.
 */
export async function listActiveHmacSecrets(
  subOrgId: string
): Promise<{ secret: string; keyVersion: number }[]> {
  const now = new Date();
  const rows = await db
    .select({
      keyVersion: agenticWalletHmacSecrets.keyVersion,
      secretCiphertext: agenticWalletHmacSecrets.secretCiphertext,
    })
    .from(agenticWalletHmacSecrets)
    .where(
      and(
        eq(agenticWalletHmacSecrets.subOrgId, subOrgId),
        or(
          isNull(agenticWalletHmacSecrets.expiresAt),
          gt(agenticWalletHmacSecrets.expiresAt, now)
        )
      )
    )
    .orderBy(desc(agenticWalletHmacSecrets.keyVersion))
    .limit(MAX_ACTIVE_HMAC_CANDIDATES);

  const out: { secret: string; keyVersion: number }[] = [];
  // Query orders desc(keyVersion) so rows are already newest-first: the
  // verifier tries the current secret before any still-active prior versions
  // in the grace window.
  for (const row of rows) {
    try {
      const plaintext = decryptSecret(
        row.secretCiphertext,
        subOrgId,
        row.keyVersion
      );
      out.push({ secret: plaintext, keyVersion: row.keyVersion });
    } catch (error) {
      logSystemError(
        ErrorCategory.AUTH,
        "[Agentic] hmac decrypt failed (list)",
        error,
        { subOrgId, keyVersion: String(row.keyVersion) }
      );
    }
  }
  return out;
}
