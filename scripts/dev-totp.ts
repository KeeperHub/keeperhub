/**
 * Print the local dev user's MFA codes: the current TOTP code and the latest
 * pending email OTP (email verification / email sign-in). There's no dev
 * mailbox, so the email code is read straight from the verifications table.
 * If the latest email OTP has expired it is refreshed in place (re-encrypted
 * with a fresh code + expiry on the same row) so you always get a usable code.
 *
 * The TOTP code is computed with the identical algorithm Better Auth verifies
 * with (HMAC-SHA1, 30s period, 6 digits) over the secret decrypted with
 * BETTER_AUTH_SECRET.
 *
 * Usage: pnpm dev:totp   (run pnpm db:seed-dev-user first)
 * Override the target user with SEED_EMAIL.
 */

import "dotenv/config";

import { createHmac, randomInt } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { desc, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../lib/db/connection-utils";
import { twoFactor, users, verifications } from "../lib/db/schema";

const EMAIL = process.env.SEED_EMAIL ?? "dev@techops.services";
const PERIOD = 30;
const DIGITS = 6;
// Better Auth's emailOTP expiresIn is 300s (lib/auth.ts); match it on refresh.
const OTP_TTL_MS = 5 * 60 * 1000;

// Mirrors @better-auth/utils createOTP(secret).totp(): HMAC-SHA1 over the
// 8-byte big-endian time counter, with the secret string used directly as the
// (UTF-8) HMAC key. Kept dependency-free since @better-auth/utils is not a
// direct dependency.
function totp(secret: string): string {
  const counter = Math.floor(Date.now() / (PERIOD * 1000));
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", Buffer.from(secret, "utf8"))
    .update(counterBytes)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return (truncated % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

type Db = ReturnType<typeof drizzle>;

async function printTotp(db: Db, authSecret: string): Promise<void> {
  const [row] = await db
    .select({ secret: twoFactor.secret })
    .from(twoFactor)
    .innerJoin(users, eq(twoFactor.userId, users.id))
    .where(eq(users.email, EMAIL))
    .limit(1);

  if (!row) {
    console.log(`TOTP:      not enrolled (run "pnpm db:seed-dev-user")`);
    return;
  }

  const secret = await symmetricDecrypt({ key: authSecret, data: row.secret });
  const code = totp(secret);
  const remaining = PERIOD - (Math.floor(Date.now() / 1000) % PERIOD);
  console.log(`TOTP:      ${code}  (valid ~${remaining}s)`);
}

async function printEmailOtp(db: Db, authSecret: string): Promise<void> {
  // Email OTP identifiers are "<type>-otp-<email>" (email-verification, sign-in,
  // forget-password). The stored value is "<encrypted>:<attempts>" - Better
  // Auth encrypts the OTP with BETTER_AUTH_SECRET and appends the attempt count
  // (lib/auth.ts storeOTP: "encrypted", KEEP-625).
  const [row] = await db
    .select({
      id: verifications.id,
      value: verifications.value,
      expiresAt: verifications.expiresAt,
    })
    .from(verifications)
    .where(like(verifications.identifier, `%otp-${EMAIL}`))
    .orderBy(desc(verifications.createdAt))
    .limit(1);

  if (!row) {
    console.log("Email OTP: none pending (trigger one in the app first)");
    return;
  }

  // Expired codes are useless - refresh in place. Same row/identifier and the
  // same encryption Better Auth uses, so the app's verify for the in-progress
  // flow accepts the new code.
  if (row.expiresAt.getTime() < Date.now()) {
    const otp = String(randomInt(0, 10 ** DIGITS)).padStart(DIGITS, "0");
    const encrypted = await symmetricEncrypt({ key: authSecret, data: otp });
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await db
      .update(verifications)
      .set({ value: `${encrypted}:0`, expiresAt, updatedAt: new Date() })
      .where(eq(verifications.id, row.id));
    console.log(
      `Email OTP: ${otp}  (refreshed, valid until ${expiresAt.toISOString()})`
    );
    return;
  }

  const lastColon = row.value.lastIndexOf(":");
  const encrypted = lastColon > 0 ? row.value.slice(0, lastColon) : row.value;
  let code: string;
  try {
    code = await symmetricDecrypt({ key: authSecret, data: encrypted });
  } catch {
    console.log("Email OTP: present but could not decrypt the stored value");
    return;
  }
  console.log(`Email OTP: ${code}  (valid until ${row.expiresAt.toISOString()})`);
}

async function main(): Promise<void> {
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) {
    throw new Error("BETTER_AUTH_SECRET is required to decrypt the TOTP secret");
  }

  const client = postgres(getDatabaseUrl(), { max: 1 });
  const db = drizzle(client);

  try {
    console.log(`MFA codes for ${EMAIL}:`);
    await printTotp(db, authSecret);
    await printEmailOtp(db, authSecret);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Failed to read MFA codes:", error);
  process.exit(1);
});
