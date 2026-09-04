import { randomUUID } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// This spec drives the real reset handler against a real Postgres so it proves
// the credential rows are actually gone after a reset, not merely that a delete
// was issued (which the mocked tests/integration spec already covers). Only the
// non-DB collaborators are stubbed; @/lib/db is restored to the real
// postgres-backed singleton (tests/setup.ts globally replaces it with an
// in-memory stub).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "AUTH", CONFIGURATION: "CONFIGURATION" },
  logSystemError: vi.fn(),
}));
vi.mock("@/lib/email", () => ({
  sendOAuthPasswordResetEmail: vi.fn(),
  sendVerificationOTP: vi.fn(),
}));
vi.mock("@/lib/security/trusted-proxies", () => ({
  resolveTrustedClientIp: vi.fn(() => "203.0.113.10"),
}));
vi.mock("@/lib/db", async () => await vi.importActual("@/lib/db"));

import { POST } from "@/app/api/user/forgot-password/route";
import { CREDENTIAL_ACCOUNT_ISSUER } from "@/lib/auth/account-issuer";
import { db } from "@/lib/db";
import {
  accounts,
  apiKeys,
  deviceCode,
  mcpOauthAuthCodes,
  mcpOauthRefreshTokens,
  organization,
  organizationApiKeys,
  sessions,
  users,
  verifications,
} from "@/lib/db/schema";

const SKIP = process.env.SKIP_INFRA_TESTS === "true";
const SECRET = "test-better-auth-secret-0123456789abcdef";
const OTP = "123456";
const NEW_PASSWORD = "new-password-123";

function future(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

type Seeded = {
  userId: string;
  orgId: string;
  email: string;
  accountId: string;
  verificationId: string;
};

async function seedUserWithCredentials(): Promise<Seeded> {
  const suffix = randomUUID();
  const userId = `u-${suffix}`;
  const orgId = `o-${suffix}`;
  const email = `reset-${suffix}@example.test`;
  const accountId = `acc-${suffix}`;
  const verificationId = `ver-${suffix}`;
  const now = new Date();

  await db.insert(users).values({
    id: userId,
    email,
    emailVerified: true,
    twoFactorEnabled: false,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(organization).values({
    id: orgId,
    name: `Org ${suffix}`,
    slug: `slug-${suffix}`,
    createdAt: now,
  });
  await db.insert(accounts).values({
    id: accountId,
    accountId: userId,
    providerId: "credential",
    issuer: CREDENTIAL_ACCOUNT_ISSUER,
    userId,
    password: "pre-reset-hash",
    createdAt: now,
    updatedAt: now,
  });
  // Encrypted reset code matching the handler's `${ciphertext}:0` format.
  const value = `${await symmetricEncrypt({ key: SECRET, data: OTP })}:0`;
  await db.insert(verifications).values({
    id: verificationId,
    identifier: email,
    value,
    expiresAt: future(5),
    createdAt: now,
    updatedAt: now,
  });

  // One row in every user-scoped credential class the reset must revoke.
  await db.insert(sessions).values({
    id: `sess-${suffix}`,
    token: `tok-${suffix}`,
    userId,
    expiresAt: future(60),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(apiKeys).values({
    id: `ak-${suffix}`,
    userId,
    keyHash: `akhash-${suffix}`,
    keyPrefix: "wfb_test",
    createdAt: now,
  });
  await db.insert(mcpOauthRefreshTokens).values({
    id: `mr-${suffix}`,
    tokenHash: `mrhash-${suffix}`,
    clientId: "test-client",
    userId,
    organizationId: orgId,
    scope: "read",
    expiresAt: future(60),
  });
  await db.insert(mcpOauthAuthCodes).values({
    id: `mc-${suffix}`,
    code: `code-${suffix}`,
    clientId: "test-client",
    redirectUri: "https://example.test/cb",
    scope: "read",
    userId,
    organizationId: orgId,
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    expiresAt: future(60),
  });
  await db.insert(deviceCode).values({
    id: `dc-${suffix}`,
    deviceCode: `devc-${suffix}`,
    userCode: `uc-${suffix}`,
    userId,
    status: "pending",
    expiresAt: future(60),
  });
  // Org-owned key created by this user: must survive the reset.
  await db.insert(organizationApiKeys).values({
    id: `oak-${suffix}`,
    organizationId: orgId,
    name: "team-integration",
    keyHash: `oakhash-${suffix}`,
    keyPrefix: "kh_test",
    createdBy: userId,
    createdAt: now,
  });

  return { userId, orgId, email, accountId, verificationId };
}

async function rowCount(
  table: typeof sessions | typeof apiKeys | typeof deviceCode,
  userId: string
): Promise<number> {
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.userId, userId));
  return rows.length;
}

function resetRequest(email: string): Request {
  return new Request("http://localhost/api/user/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "reset",
      email,
      otp: OTP,
      newPassword: NEW_PASSWORD,
    }),
  });
}

const cleanup: Seeded[] = [];

async function purge(s: Seeded): Promise<void> {
  // Deleting the user drives the security_audit_log FK to null actor_user_id,
  // which the append-only trigger rejects. Teardown runs as the postgres
  // superuser, so disable replication-role triggers for this transaction to
  // remove test data without tripping the guard.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx
      .delete(organizationApiKeys)
      .where(eq(organizationApiKeys.organizationId, s.orgId));
    await tx
      .delete(mcpOauthAuthCodes)
      .where(eq(mcpOauthAuthCodes.userId, s.userId));
    await tx
      .delete(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.userId, s.userId));
    await tx.delete(deviceCode).where(eq(deviceCode.userId, s.userId));
    await tx.delete(apiKeys).where(eq(apiKeys.userId, s.userId));
    await tx.delete(sessions).where(eq(sessions.userId, s.userId));
    await tx.delete(accounts).where(eq(accounts.userId, s.userId));
    await tx.delete(verifications).where(eq(verifications.identifier, s.email));
    await tx.delete(organization).where(eq(organization.id, s.orgId));
    await tx.delete(users).where(eq(users.id, s.userId));
  });
}

describe.skipIf(SKIP)(
  "POST /api/user/forgot-password reset (real Postgres)",
  () => {
    beforeAll(async () => {
      process.env.BETTER_AUTH_SECRET = SECRET;
      try {
        await db.execute(sql`select 1`);
      } catch (error) {
        throw new Error(
          `This spec needs a migrated Postgres at DATABASE_URL. Set SKIP_INFRA_TESTS=true to skip. Cause: ${String(error)}`
        );
      }
    });

    afterEach(async () => {
      while (cleanup.length > 0) {
        const s = cleanup.pop();
        if (s) {
          await purge(s);
        }
      }
    });

    it("revokes every user-scoped credential and keeps org keys", async () => {
      const s = await seedUserWithCredentials();
      cleanup.push(s);

      const response = await POST(resetRequest(s.email));
      expect(response.status).toBe(200);

      // Password was rotated to a fresh hash.
      const [account] = await db
        .select({ password: accounts.password })
        .from(accounts)
        .where(eq(accounts.id, s.accountId));
      expect(account?.password).toBeTruthy();
      expect(account?.password).not.toBe("pre-reset-hash");

      // Every user-scoped credential row is gone.
      expect(await rowCount(sessions, s.userId)).toBe(0);
      expect(await rowCount(apiKeys, s.userId)).toBe(0);
      expect(await rowCount(deviceCode, s.userId)).toBe(0);
      const mcpRefresh = await db
        .select({ id: mcpOauthRefreshTokens.id })
        .from(mcpOauthRefreshTokens)
        .where(eq(mcpOauthRefreshTokens.userId, s.userId));
      expect(mcpRefresh).toHaveLength(0);
      const mcpCodes = await db
        .select({ id: mcpOauthAuthCodes.id })
        .from(mcpOauthAuthCodes)
        .where(eq(mcpOauthAuthCodes.userId, s.userId));
      expect(mcpCodes).toHaveLength(0);

      // The consumed reset code is deleted.
      const leftoverVerification = await db
        .select({ id: verifications.id })
        .from(verifications)
        .where(eq(verifications.id, s.verificationId));
      expect(leftoverVerification).toHaveLength(0);

      // The org-owned API key is untouched: present and not revoked.
      const [orgKey] = await db
        .select({ revokedAt: organizationApiKeys.revokedAt })
        .from(organizationApiKeys)
        .where(eq(organizationApiKeys.createdBy, s.userId));
      expect(orgKey).toBeDefined();
      expect(orgKey?.revokedAt).toBeNull();
    });

    it("leaves all credentials intact when the OTP is wrong", async () => {
      const s = await seedUserWithCredentials();
      cleanup.push(s);

      const badRequest = new Request(
        "http://localhost/api/user/forgot-password",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "reset",
            email: s.email,
            otp: "000000",
            newPassword: NEW_PASSWORD,
          }),
        }
      );
      const response = await POST(badRequest);
      expect(response.status).toBe(400);

      expect(await rowCount(sessions, s.userId)).toBe(1);
      expect(await rowCount(apiKeys, s.userId)).toBe(1);
      const [account] = await db
        .select({ password: accounts.password })
        .from(accounts)
        .where(eq(accounts.id, s.accountId));
      expect(account?.password).toBe("pre-reset-hash");
    });
  }
);
