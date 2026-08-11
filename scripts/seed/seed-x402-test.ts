import dotenv from "dotenv";
import { expand } from "dotenv-expand";

expand(dotenv.config());

import { hashPassword } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { privateKeyToAccount } from "viem/accounts";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import {
  accounts,
  member,
  organization,
  organizationWallets,
  users,
  workflows,
} from "../../lib/db/schema";
import { generateId } from "../../lib/utils/id";

const TEST_ORG_SLUG = "x402-test-org";
const TEST_USER_EMAIL = "x402-test@techops.services";
const TEST_PASSWORD = "TestPassword123!";
const TEST_PRIVATE_KEY =
  process.env.MPP_TEST_PRIVATE_KEY ?? process.env.X402_TEST_PRIVATE_KEY;
const TEST_WALLET_ADDRESS = TEST_PRIVATE_KEY
  ? privateKeyToAccount(TEST_PRIVATE_KEY as `0x${string}`).address
  : "0x1234567890abcdef1234567890abcdef12345678";
const TEST_WORKFLOW_SLUG = "x402-echo-test";
const TEST_WORKFLOW_PRICE = "0.01";

type Db = ReturnType<typeof drizzle>;

async function ensureUser(db: Db): Promise<string> {
  const existing = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${TEST_USER_EMAIL}`)
    .limit(1);

  if (existing.length > 0) {
    console.log(`Test user already exists (id: ${existing[0].id})`);
    return existing[0].id;
  }

  const userId = generateId();
  await db.insert(users).values({
    id: userId,
    name: "x402 Test User",
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
  console.log("Created credential account");
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

    const existingMember = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
      .limit(1);

    if (existingMember.length === 0) {
      await db.insert(member).values({
        id: generateId(),
        organizationId: orgId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
      console.log("Created missing member record");
    }

    return orgId;
  }

  const orgId = generateId();
  await db.insert(organization).values({
    id: orgId,
    name: "x402 Test Organization",
    slug: TEST_ORG_SLUG,
    createdAt: new Date(),
  });

  await db.insert(member).values({
    id: generateId(),
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  console.log(`Created test org (id: ${orgId})`);
  return orgId;
}

async function ensureWallet(
  db: Db,
  userId: string,
  orgId: string
): Promise<void> {
  const existing = await db
    .select()
    .from(organizationWallets)
    .where(eq(organizationWallets.organizationId, orgId))
    .limit(1);

  if (existing.length > 0) {
    console.log(`Wallet already exists: ${existing[0].walletAddress}`);
    return;
  }

  await db.insert(organizationWallets).values({
    id: generateId(),
    userId,
    organizationId: orgId,
    email: TEST_USER_EMAIL,
    walletAddress: TEST_WALLET_ADDRESS,
    turnkeySubOrgId: "test-sub-org",
    turnkeyWalletId: "test-wallet",
    turnkeyPrivateKeyId: "test-private-key",
  });
  console.log(`Created Turnkey wallet: ${TEST_WALLET_ADDRESS}`);
}

async function ensureListedWorkflow(
  db: Db,
  userId: string,
  orgId: string
): Promise<string> {
  const existing = await db
    .select()
    .from(workflows)
    .where(eq(workflows.listedSlug, TEST_WORKFLOW_SLUG))
    .limit(1);

  if (existing.length > 0) {
    console.log(`Listed workflow already exists (id: ${existing[0].id})`);
    return existing[0].id;
  }

  const workflowId = generateId();
  await db.insert(workflows).values({
    id: workflowId,
    name: "x402 Echo Test",
    description: "Returns the input as output. For testing x402 paid calls.",
    userId,
    organizationId: orgId,
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { triggerType: "manual" },
      },
    ],
    edges: [],
    visibility: "private",
    isListed: true,
    listedSlug: TEST_WORKFLOW_SLUG,
    listedAt: new Date(),
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    priceUsdcPerCall: TEST_WORKFLOW_PRICE,
    chain: "base",
    workflowType: "read",
  });
  console.log(`Created listed workflow (slug: ${TEST_WORKFLOW_SLUG}, price: $${TEST_WORKFLOW_PRICE})`);
  return workflowId;
}

function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV=production");
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

    if (!isLocal) {
      throw new Error(
        `Refusing to seed: DATABASE_URL host "${host}" looks remote`
      );
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  assertNotProduction();

  const connectionString = getDatabaseUrl();
  console.log("Connecting to database...");

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  try {
    const userId = await ensureUser(db);
    await ensureCredentialAccount(db, userId);
    const orgId = await ensureOrganization(db, userId);
    await ensureWallet(db, userId, orgId);
    const workflowId = await ensureListedWorkflow(db, userId, orgId);

    console.log("\nx402 test environment ready:");
    console.log(`  Email:          ${TEST_USER_EMAIL}`);
    console.log(`  Password:       ${TEST_PASSWORD}`);
    console.log(`  Org Slug:       ${TEST_ORG_SLUG}`);
    console.log(`  Wallet:         ${TEST_WALLET_ADDRESS}`);
    console.log(`  Workflow Slug:  ${TEST_WORKFLOW_SLUG}`);
    console.log(`  Workflow ID:    ${workflowId}`);
    console.log(`  Price:          $${TEST_WORKFLOW_PRICE} USDC`);
    console.log(`\nTest call (free workflow first, to verify route works):`);
    console.log(`  curl -X POST http://localhost:3000/api/mcp/workflows/${TEST_WORKFLOW_SLUG}/call \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"message": "hello"}'`);
  } finally {
    await client.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error seeding x402 test data:", err);
    process.exit(1);
  });
