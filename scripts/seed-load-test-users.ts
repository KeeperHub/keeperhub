import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  member,
  organization,
  organizationSubscriptions,
  users,
} from "@/lib/db/schema";

const COUNT = Number(process.env.SEED_COUNT ?? "50");
const EMAIL_PREFIX = "k6-loadtest-vu";
const EMAIL_DOMAIN = "@techops.services";

async function seedUser(vuId: number, password: string): Promise<"created" | "skipped"> {
  const email = `${EMAIL_PREFIX}${vuId}${EMAIL_DOMAIN}`;
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    return "skipped";
  }

  const userId = randomUUID();
  const orgId = randomUUID();
  const memberId = randomUUID();
  const accountId = randomUUID();
  const subscriptionId = randomUUID();
  const now = new Date();
  const slug = `k6-loadtest-vu${vuId}-${randomUUID().slice(0, 6)}`;

  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      name: `K6 LoadTest VU${vuId}`,
      email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      twoFactorEnabled: false,
    });
    await tx.insert(accounts).values({
      id: accountId,
      accountId: email,
      providerId: "credential",
      userId,
      password,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(organization).values({
      id: orgId,
      name: `K6 LoadTest VU${vuId} Org`,
      slug,
      createdAt: now,
    });
    await tx.insert(member).values({
      id: memberId,
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: now,
    });
    await tx.insert(organizationSubscriptions).values({
      id: subscriptionId,
      organizationId: orgId,
      plan: "pro",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });

  return "created";
}

async function main(): Promise<void> {
  const password = process.env.LOAD_TEST_USER_PASSWORD;
  if (!password) {
    throw new Error("LOAD_TEST_USER_PASSWORD env var is required");
  }
  const hashed = await hashPassword(password);

  let created = 0;
  let skipped = 0;
  for (let v = 1; v <= COUNT; v++) {
    const result = await seedUser(v, hashed);
    if (result === "created") {
      created++;
    } else {
      skipped++;
    }
  }

  console.log(`seed-load-test-users: created=${created} skipped=${skipped} total=${COUNT}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("seed-load-test-users failed:", err);
  process.exit(1);
});
