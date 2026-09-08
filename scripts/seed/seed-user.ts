/**
 * Seed a local dev user with email/password auth.
 * Uses Better Auth's hashPassword so the credentials work with sign-in.
 *
 * Usage: pnpm tsx scripts/seed-user.ts
 *
 * Default credentials:
 *   Email:    dev@techops.services
 *   Password: Test1234!
 *
 * Override via env:
 *   SEED_EMAIL=dev@keeperhub.com SEED_PASSWORD=secret pnpm tsx scripts/seed-user.ts
 *
 * Note: SEED_EMAIL must match the public.block_user_signup_security trigger
 * allowlist (techops.services or keeperhub.com), otherwise the INSERT fails.
 */

import "dotenv/config";

import { randomBytes, scrypt } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CREDENTIAL_ACCOUNT_ISSUER } from "../../lib/auth/account-issuer";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { accounts, users } from "../../lib/db/schema";
import { generateId } from "../../lib/utils/id";

const EMAIL = process.env.SEED_EMAIL ?? "dev@techops.services";
const PASSWORD = process.env.SEED_PASSWORD ?? "Test1234!";
const NAME = process.env.SEED_NAME ?? "Dev User";

const SCRYPT_CONFIG = { N: 16_384, r: 16, p: 1, dkLen: 64 } as const;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function scryptAsync(
  password: string,
  salt: string,
  keylen: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      {
        N: SCRYPT_CONFIG.N,
        r: SCRYPT_CONFIG.r,
        p: SCRYPT_CONFIG.p,
        maxmem: 128 * SCRYPT_CONFIG.N * SCRYPT_CONFIG.r * 2,
      },
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey);
        }
      }
    );
  });
}

async function hashPassword(password: string): Promise<string> {
  const saltBytes = randomBytes(16);
  const salt = bytesToHex(saltBytes);
  const key = await scryptAsync(
    password.normalize("NFKC"),
    salt,
    SCRYPT_CONFIG.dkLen
  );
  return `${salt}:${bytesToHex(key)}`;
}

async function main(): Promise<void> {
  const connectionString = getDatabaseUrl();
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  try {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, EMAIL))
      .limit(1);

    if (existing.length > 0) {
      const userId = existing[0].id;
      const hash = await hashPassword(PASSWORD);

      await db
        .update(accounts)
        .set({ password: hash, updatedAt: new Date() })
        .where(eq(accounts.userId, userId));

      await db
        .update(users)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, userId));

      console.log(`Updated existing user: ${EMAIL}`);
      console.log(`  Password reset to: ${PASSWORD}`);
    } else {
      const userId = generateId();
      const accountId = generateId();
      const hash = await hashPassword(PASSWORD);
      const now = new Date();

      await db.insert(users).values({
        id: userId,
        name: NAME,
        email: EMAIL,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
        isAnonymous: false,
      });

      await db.insert(accounts).values({
        id: accountId,
        accountId: userId,
        providerId: "credential",
        issuer: CREDENTIAL_ACCOUNT_ISSUER,
        userId,
        password: hash,
        createdAt: now,
        updatedAt: now,
      });

      console.log(`Created user: ${EMAIL}`);
      console.log(`  Password: ${PASSWORD}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Failed to seed user:", error);
  process.exit(1);
});
