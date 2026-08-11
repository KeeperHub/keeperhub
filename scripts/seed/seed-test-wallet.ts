/**
 * Seed script for persistent E2E test account (KEEP-529).
 *
 * Seeds a test user (with login credentials) + organization + Turnkey wallet
 * for write-contract E2E tests and Playwright tests.
 * Idempotent: skips records that already exist.
 *
 * Para has been decommissioned. On first run the script calls Turnkey to
 * provision a fresh sub-org + wallet for the test user; the resulting EVM
 * address is non-deterministic (HSM-generated) and is persisted in
 * `organization_wallets`. Subsequent runs reuse the existing wallet row.
 *
 * Test credentials:
 *   Email:    pr-test-do-not-delete@techops.services
 *   Password: TestPassword123!
 *
 * Environment variables:
 *   DATABASE_URL              - PostgreSQL connection string (required)
 *   TURNKEY_API_PUBLIC_KEY    - parent-org API public key (required for first-time provisioning)
 *   TURNKEY_API_PRIVATE_KEY   - parent-org API private key (required for first-time provisioning)
 *   TURNKEY_ORGANIZATION_ID   - parent-org id (required for first-time provisioning)
 *
 * Run with: pnpm db:seed-test-wallet
 */

import dotenv from "dotenv";
import { expand } from "dotenv-expand";

expand(dotenv.config());

import { hashPassword } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import {
  accounts,
  member,
  organization,
  organizationWallets,
  users,
} from "../../lib/db/schema";
import { createTurnkeyWallet } from "../../lib/turnkey/turnkey-operations";
import { generateId } from "../../lib/utils/id";

const TEST_ORG_SLUG = "e2e-test-org";
const TEST_USER_EMAIL = "pr-test-do-not-delete@techops.services";
const TEST_PASSWORD = "TestPassword123!";

type Db = ReturnType<typeof drizzle>;

async function ensureUser(db: Db): Promise<string> {
  // Case-insensitive lookup: the email was previously seeded as uppercase
  const existing = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${TEST_USER_EMAIL}`)
    .limit(1);

  if (existing.length > 0) {
    // Normalize to lowercase if stored as uppercase
    if (existing[0].email !== TEST_USER_EMAIL) {
      await db
        .update(users)
        .set({ email: TEST_USER_EMAIL })
        .where(eq(users.id, existing[0].id));
      console.log(`Normalized test user email to lowercase (id: ${existing[0].id})`);
    } else {
      console.log(`Test user already exists (id: ${existing[0].id})`);
    }
    return existing[0].id;
  }

  const userId = generateId();
  await db.insert(users).values({
    id: userId,
    name: "E2E Test User",
    email: TEST_USER_EMAIL,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`Created test user (id: ${userId})`);
  return userId;
}

async function ensureCredentialAccount(db: Db, userId: string): Promise<void> {
  const existing = await db
    .select()
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.providerId, "credential"))
    )
    .limit(1);

  if (existing.length > 0) {
    console.log("Credential account already exists");
    return;
  }

  const hashedPassword = await hashPassword(TEST_PASSWORD);
  await db.insert(accounts).values({
    id: generateId(),
    accountId: userId,
    providerId: "credential",
    userId,
    password: hashedPassword,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(`Created credential account (password: ${TEST_PASSWORD})`);
}

async function ensureOrganization(db: Db, userId: string): Promise<string> {
  const existing = await db
    .select()
    .from(organization)
    .where(eq(organization.slug, TEST_ORG_SLUG))
    .limit(1);

  if (existing.length > 0) {
    const orgId = existing[0].id;
    console.log(`Test org already exists (id: ${orgId})`);

    // Ensure member record exists for this user (may be missing if user was re-created)
    const existingMember = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
      .limit(1);

    if (existingMember.length === 0) {
      const memberId = generateId();
      await db.insert(member).values({
        id: memberId,
        organizationId: orgId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
      console.log(`Created missing member record (id: ${memberId})`);
    }

    return orgId;
  }

  const orgId = generateId();
  await db.insert(organization).values({
    id: orgId,
    name: "E2E Test Organization",
    slug: TEST_ORG_SLUG,
    createdAt: new Date(),
  });
  console.log(`Created test org (id: ${orgId})`);

  const memberId = generateId();
  await db.insert(member).values({
    id: memberId,
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  console.log(`Created member record (id: ${memberId})`);
  return orgId;
}

async function ensureTurnkeyWallet(
  db: Db,
  userId: string,
  orgId: string
): Promise<void> {
  const existing = await db
    .select()
    .from(organizationWallets)
    .where(
      and(eq(organizationWallets.organizationId, orgId), eq(organizationWallets.isActive, true))
    )
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    console.log(`Wallet already exists: ${row.walletAddress}`);
    return;
  }

  const missing = [
    "TURNKEY_API_PUBLIC_KEY",
    "TURNKEY_API_PRIVATE_KEY",
    "TURNKEY_ORGANIZATION_ID",
  ].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to seed test wallet: missing required Turnkey env var(s): ${missing.join(", ")}. ` +
        "The persistent E2E test user must own a Turnkey wallet for any signing test to function. " +
        "Set the variables (e.g. from TechOps/.secrets/staging-turnkey.env in local dev, or the " +
        "matching secrets in the CI environment) and re-run."
    );
  }

  console.log("Provisioning Turnkey sub-org and wallet for E2E test user...");
  const result = await createTurnkeyWallet(TEST_USER_EMAIL, TEST_ORG_SLUG);

  await db.insert(organizationWallets).values({
    id: generateId(),
    userId,
    organizationId: orgId,
    email: TEST_USER_EMAIL,
    walletAddress: result.walletAddress,
    turnkeySubOrgId: result.subOrgId,
    turnkeyWalletId: result.walletId,
    turnkeyPrivateKeyId: result.privateKeyId,
  });

  console.log(`Created Turnkey wallet: ${result.walletAddress}`);
  console.log(`  subOrgId:  ${result.subOrgId}`);
  console.log(`  walletId:  ${result.walletId}`);
}

function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed test account: NODE_ENV=production. " +
        "Set ALLOW_SEED_TEST_WALLET=true to override."
    );
  }

  const dbUrl = process.env.DATABASE_URL ?? "";
  try {
    const parsed = new URL(dbUrl);
    const host = parsed.hostname;
    const isLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "" ||
      host.endsWith(".svc.cluster.local") ||
      host.endsWith(".internal");

    if (!isLocal && process.env.ALLOW_SEED_TEST_WALLET !== "true") {
      throw new Error(
        `Refusing to seed test account: DATABASE_URL host "${host}" looks like a remote database. ` +
          "Set ALLOW_SEED_TEST_WALLET=true to override."
      );
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return;
    }
    throw error;
  }
}

async function seedTestWallet(): Promise<void> {
  assertNotProduction();

  const connectionString = getDatabaseUrl();
  console.log("Connecting to database...");

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  try {
    const userId = await ensureUser(db);
    await ensureCredentialAccount(db, userId);
    const orgId = await ensureOrganization(db, userId);
    await ensureTurnkeyWallet(db, userId, orgId);

    const wallet = await db
      .select()
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, orgId))
      .limit(1);

    console.log("\nE2E test account ready:");
    console.log(`  Email:          ${TEST_USER_EMAIL}`);
    console.log(`  Password:       ${TEST_PASSWORD}`);
    console.log(`  Org Slug:       ${TEST_ORG_SLUG}`);
    console.log(`  Org ID:         ${orgId}`);
    console.log(`  User ID:        ${userId}`);
    if (wallet.length > 0) {
      console.log(`  Wallet Address: ${wallet[0].walletAddress}`);
    }
  } finally {
    await client.end();
  }
}

seedTestWallet()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error seeding test wallet:", err);
    process.exit(1);
  });
