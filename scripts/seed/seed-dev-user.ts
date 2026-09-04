/**
 * Seed a complete local dev user via direct DB writes: credential account,
 * TOTP (two-factor), and an organization with owner membership. Idempotent.
 *
 * Bypasses the email-verification + emailed-OTP flow that a pure-API seed can't
 * complete locally (no dev mailbox), so it writes emailVerified/2FA/org directly.
 *
 * Usage: pnpm db:seed-dev-user   (DB must be up)
 * Then sign in at the dev server with the printed credentials; get a TOTP code
 * for the MFA step with: pnpm dev:totp
 *
 * Override via env: SEED_EMAIL, SEED_PASSWORD, SEED_NAME,
 *   SEED_DEV_ORG_SLUG, SEED_DEV_ORG_NAME.
 * Note: SEED_EMAIL must satisfy the block_user_signup_security trigger allowlist
 * (techops.services or keeperhub.com).
 */

import "dotenv/config";

import { randomBytes, scrypt } from "node:crypto";
import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CREDENTIAL_ACCOUNT_ISSUER } from "../../lib/auth/account-issuer";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import {
  accounts,
  member,
  organization,
  twoFactor,
  users,
} from "../../lib/db/schema";
import { generateId } from "../../lib/utils/id";

const EMAIL = process.env.SEED_EMAIL ?? "dev@techops.services";
const PASSWORD = process.env.SEED_PASSWORD ?? "Test1234!";
const NAME = process.env.SEED_NAME ?? "Dev User";
const ORG_SLUG = process.env.SEED_DEV_ORG_SLUG ?? "dev-org";
const ORG_NAME = process.env.SEED_DEV_ORG_NAME ?? "Dev Org";

// Matches Better Auth's scrypt password format (salt:hash) so the seeded
// credential works with the sign-in endpoint.
const SCRYPT_CONFIG = { N: 16_384, r: 16, p: 1, dkLen: 64 } as const;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
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
  const salt = bytesToHex(randomBytes(16));
  const key = await scryptAsync(
    password.normalize("NFKC"),
    salt,
    SCRYPT_CONFIG.dkLen
  );
  return `${salt}:${bytesToHex(key)}`;
}

async function main(): Promise<void> {
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) {
    throw new Error("BETTER_AUTH_SECRET is required to encrypt the TOTP secret");
  }

  const client = postgres(getDatabaseUrl(), { max: 1 });
  const db = drizzle(client);
  const now = new Date();

  try {
    // 1. User + credential account (email-verified, 2FA flag on).
    const passwordHash = await hashPassword(PASSWORD);
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, EMAIL))
      .limit(1);

    let userId: string;
    if (existingUser) {
      userId = existingUser.id;
      await db
        .update(users)
        .set({
          emailVerified: true,
          twoFactorEnabled: true,
          isAnonymous: false,
          updatedAt: now,
        })
        .where(eq(users.id, userId));
    } else {
      userId = generateId();
      await db.insert(users).values({
        id: userId,
        name: NAME,
        email: EMAIL,
        emailVerified: true,
        twoFactorEnabled: true,
        isAnonymous: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    const [credential] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
      .limit(1);

    if (credential) {
      await db
        .update(accounts)
        .set({ password: passwordHash, updatedAt: now })
        .where(eq(accounts.id, credential.id));
    } else {
      await db.insert(accounts).values({
        id: generateId(),
        accountId: userId,
        providerId: "credential",
        issuer: CREDENTIAL_ACCOUNT_ISSUER,
        userId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 2. TOTP: encrypted secret stored exactly as Better Auth's two-factor
    // plugin does, so the MFA prompt works and pnpm dev:totp can mint codes.
    const [existingTotp] = await db
      .select({ id: twoFactor.id })
      .from(twoFactor)
      .where(eq(twoFactor.userId, userId))
      .limit(1);

    if (existingTotp) {
      await db
        .update(twoFactor)
        .set({ verified: true })
        .where(eq(twoFactor.id, existingTotp.id));
    } else {
      const totpSecret = generateRandomString(32);
      const encryptedSecret = await symmetricEncrypt({
        key: authSecret,
        data: totpSecret,
      });
      await db.insert(twoFactor).values({
        id: generateId(),
        userId,
        secret: encryptedSecret,
        verified: true,
      });
    }

    // 3. Organization + owner membership (active org is set on next sign-in).
    const [existingOrg] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, ORG_SLUG))
      .limit(1);

    let orgId: string;
    if (existingOrg) {
      orgId = existingOrg.id;
    } else {
      orgId = generateId();
      await db.insert(organization).values({
        id: orgId,
        name: ORG_NAME,
        slug: ORG_SLUG,
        createdAt: now,
      });
    }

    const [existingMember] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
      .limit(1);

    if (!existingMember) {
      await db.insert(member).values({
        id: generateId(),
        organizationId: orgId,
        userId,
        role: "owner",
        createdAt: now,
      });
    }

    console.log("Dev user ready:");
    console.log(`  Email:    ${EMAIL}`);
    console.log(`  Password: ${PASSWORD}`);
    console.log(`  Org:      ${ORG_NAME} (${ORG_SLUG}) - owner`);
    console.log(
      "  MFA:      TOTP enrolled - get TOTP + email OTP codes with: pnpm dev:totp"
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Failed to seed dev user:", error);
  process.exit(1);
});
