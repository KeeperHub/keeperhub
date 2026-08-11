import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.unmock("@/lib/db");
vi.mock("server-only", () => ({}));

import { sessions, users } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * Runtime contract for the 0090 sessions block trigger
 * (drizzle/0090_block_sessions_for_deactivated_users.sql). The trigger is the
 * DB-layer backstop for the deactivated-user auth bypass: it rejects any
 * sessions INSERT whose owning user has deactivated_at set, regardless of which
 * code path attempts the write. This exercises the real migrated database so a
 * dropped/renamed/weakened trigger fails CI rather than silently re-opening the
 * bypass.
 *
 * The rejection raises SQLSTATE 'KH001', which is the signal a future detection
 * layer keys off. drizzle wraps the driver error in DrizzleQueryError and puts
 * the postgres-js PostgresError (carrying the SQLSTATE) on `.cause`, so the
 * assertion reads err.cause.code. Asserting it here locks that contract at
 * runtime.
 *
 * tests/setup.ts sets a default DATABASE_URL, so the no-URL branch below rarely
 * fires in practice; set SKIP_INFRA_TESTS=true to opt out when no Postgres is
 * reachable.
 */

const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(shouldSkip)("sessions deactivated-owner block trigger", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let activeUserId: string;
  let deactivatedUserId: string;

  beforeAll(async () => {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/keeperhub";
    client = postgres(connectionString, { max: 2 });
    db = drizzle(client);

    const now = new Date();
    activeUserId = `test-active-${generateId()}`;
    deactivatedUserId = `test-deactivated-${generateId()}`;

    await db.insert(users).values([
      {
        id: activeUserId,
        email: `${activeUserId}@techops.services`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: deactivatedUserId,
        email: `${deactivatedUserId}@techops.services`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
        deactivatedAt: now,
      },
    ]);
  });

  afterAll(async () => {
    if (!client) {
      return;
    }
    // sessions.userId has no ON DELETE CASCADE, so sweep sessions before users
    // to avoid an FK violation on cleanup.
    for (const userId of [activeUserId, deactivatedUserId]) {
      if (userId) {
        await db.delete(sessions).where(eq(sessions.userId, userId));
        await db.delete(users).where(eq(users.id, userId));
      }
    }
    await client.end({ timeout: 2 });
  });

  it("allows a session insert for an active user", async () => {
    const sessionId = `sess-${generateId()}`;
    await db.insert(sessions).values({
      id: sessionId,
      token: `token-${generateId()}`,
      expiresAt: new Date(Date.now() + ONE_DAY_MS),
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: activeUserId,
    });

    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.id).toBe(sessionId);
  });

  it("rejects a session insert for a deactivated user with SQLSTATE KH001", async () => {
    // drizzle wraps the driver error in DrizzleQueryError and puts the
    // postgres-js PostgresError (carrying the SQLSTATE) on `.cause`. Read from
    // either spot so the assertion survives a change in drizzle's wrapping.
    type SqlError = { code?: string; cause?: { code?: string } };
    let caught: SqlError | undefined;
    try {
      await db.insert(sessions).values({
        id: `sess-${generateId()}`,
        token: `token-${generateId()}`,
        expiresAt: new Date(Date.now() + ONE_DAY_MS),
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: deactivatedUserId,
      });
    } catch (err) {
      caught = err as SqlError;
    }

    expect(caught).toBeDefined();
    expect(caught?.code ?? caught?.cause?.code).toBe("KH001");

    // The row must not exist - the trigger fires BEFORE INSERT.
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, deactivatedUserId));
    expect(rows).toHaveLength(0);
  });

  it("allows a session insert again after the owner is reactivated", async () => {
    // Self-contained: proves the trigger reads the live deactivated_at, not a
    // one-time state. Uses its own user with explicit cleanup so it does not
    // depend on the order of the cases above.
    const userId = `test-reactivated-${generateId()}`;
    const now = new Date();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@techops.services`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
      deactivatedAt: now,
    });
    await db
      .update(users)
      .set({ deactivatedAt: null })
      .where(eq(users.id, userId));

    const sessionId = `sess-${generateId()}`;
    await db.insert(sessions).values({
      id: sessionId,
      token: `token-${generateId()}`,
      expiresAt: new Date(Date.now() + ONE_DAY_MS),
      createdAt: new Date(),
      updatedAt: new Date(),
      userId,
    });

    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.id).toBe(sessionId);

    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });
});
