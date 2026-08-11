import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.unmock("@/lib/db");
vi.mock("server-only", () => ({}));

import {
  hashSessionToken,
  wrapWithSessionTokenHash,
} from "@/lib/auth-session-token-hash";
import { sessions, users } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * KEEP-239 integration: exercise the session-token-hashing adapter wrapper
 * against the real drizzleAdapter and a real Postgres database. This catches
 * the failure mode the unit tests cannot: better-auth's drizzle adapter
 * silently changing the call shape (e.g. `field: "token"` → `field: "tokenHash"`)
 * would let unit tests pass while production auth quietly breaks.
 *
 * Skipped when no DATABASE_URL is configured.
 */

const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

describe.skipIf(shouldSkip)("wrapWithSessionTokenHash (integration)", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let testUserId: string;
  // The wrapped adapter we exercise. better-auth's drizzleAdapter returns
  // a factory `(options) => DBAdapter`; calling it with a minimal options
  // object is enough for the operations we use here.
  let adapter: ReturnType<ReturnType<typeof drizzleAdapter>>;

  beforeAll(async () => {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/keeperhub";
    client = postgres(connectionString, { max: 2 });
    db = drizzle(client);

    const factory = wrapWithSessionTokenHash(
      drizzleAdapter(db, {
        provider: "pg",
        schema: { user: users, session: sessions },
      })
    );
    // better-auth options shape is internal; the adapter only needs a
    // non-null object for the operations we use here.
    adapter = factory({} as Parameters<typeof factory>[0]);

    testUserId = `test-${generateId()}`;
    const now = new Date();
    await db.insert(users).values({
      id: testUserId,
      email: `${testUserId}@techops.services`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    if (!client) {
      return;
    }
    // Sweep by userId rather than tracking individual tokens. sessions.userId
    // has no ON DELETE CASCADE, so any session row that leaked past test-level
    // cleanup would block the user delete with an FK violation. This sweep
    // catches all rows the test created, even when an assertion fails between
    // create and per-test cleanup.
    if (testUserId) {
      await db.delete(sessions).where(eq(sessions.userId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    }
    await client.end({ timeout: 2 });
  });

  it("stores sha256(token) in the DB and round-trips lookups via raw token", async () => {
    const rawToken = `raw-token-${generateId()}`;
    const expiresAt = new Date(Date.now() + 60_000);

    const created = await adapter.create<Record<string, unknown>>({
      model: "session",
      data: {
        id: `sess-${generateId()}`,
        token: rawToken,
        userId: testUserId,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Wrapper restores the raw token in the create return so better-auth
    // can sign the cookie / bearer header with it.
    expect(created.token).toBe(rawToken);

    // The DB column holds the hash, not the raw token.
    const [row] = await db
      .select({ token: sessions.token })
      .from(sessions)
      .where(eq(sessions.id, created.id as string));
    expect(row.token).toBe(hashSessionToken(rawToken));
    expect(row.token).not.toBe(rawToken);

    // findOne via the wrapper, presenting the raw token, finds the row and
    // hands the raw token back so callers can reuse it for further token-
    // keyed queries (the setActiveOrganization flow depends on this).
    const found = await adapter.findOne<{ id: string; token: string }>({
      model: "session",
      where: [{ field: "token", value: rawToken }],
    });
    expect(found?.id).toBe(created.id);
    expect(found?.token).toBe(rawToken);

    // A wrong token finds nothing.
    const missing = await adapter.findOne({
      model: "session",
      where: [{ field: "token", value: "not-the-token" }],
    });
    expect(missing).toBeNull();
  });

  it("supports the setActiveOrganization flow: load session, then update by the loaded token", async () => {
    // Reproduces the exact better-auth call sequence that broke ORG-1:
    //   1. orgSessionMiddleware: findOne(session, where token = cookieToken)
    //   2. setActiveOrganization endpoint:
    //      updateSession(session.token, { activeOrganizationId })
    //      -> update(session, where token = sessionFromStep1.token, update: {...})
    // Without round-trip restoration, step 2 hashes an already-hashed value
    // and the update silently misses, returning null.
    const rawToken = `set-active-${generateId()}`;
    const expiresAt = new Date(Date.now() + 60_000);

    // The drizzle adapter ignores caller-supplied ids and generates its own,
    // so we capture the id from the create return rather than asserting on
    // ours.
    const created = await adapter.create<{ id: string }>({
      model: "session",
      data: {
        id: `sess-${generateId()}`,
        token: rawToken,
        userId: testUserId,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const loaded = await adapter.findOne<{ id: string; token: string }>({
      model: "session",
      where: [{ field: "token", value: rawToken }],
    });
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(created.id);

    // Use a field the base session schema knows about so the test exercises
    // round-trip behaviour without depending on plugin-extended fields.
    const newExpiresAt = new Date(Date.now() + 120_000);
    const updated = await adapter.update<{ id: string }>({
      model: "session",
      // Use the loaded session's token field, exactly as better-auth does.
      where: [{ field: "token", value: loaded?.token as string }],
      update: { expiresAt: newExpiresAt },
    });

    // The pre-fix bug returned null here. With the round-trip wrapper the
    // update reaches the row keyed by hash(rawToken).
    expect(updated).not.toBeNull();
    expect(updated?.id).toBe(created.id);

    // Confirm the column was actually written, independently of the adapter's
    // return shape.
    const [row] = await db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, created.id));
    expect(row.expiresAt.getTime()).toBe(newExpiresAt.getTime());
  });

  it("findMany with operator: in returns the raw tokens the caller looked up with", async () => {
    const tokenA = `multi-a-${generateId()}`;
    const tokenB = `multi-b-${generateId()}`;
    const expiresAt = new Date(Date.now() + 60_000);

    for (const token of [tokenA, tokenB]) {
      await adapter.create({
        model: "session",
        data: {
          id: `sess-${generateId()}`,
          token,
          userId: testUserId,
          expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }

    // Verify the column holds hashes, not raw tokens.
    const dbRows = await db
      .select({ token: sessions.token })
      .from(sessions)
      .where(eq(sessions.userId, testUserId));
    const dbTokens = dbRows.map((r) => r.token);
    expect(dbTokens).toContain(hashSessionToken(tokenA));
    expect(dbTokens).toContain(hashSessionToken(tokenB));

    const rows = await adapter.findMany<{ token: string }>({
      model: "session",
      where: [{ field: "token", value: [tokenA, tokenB], operator: "in" }],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.token).sort()).toEqual([tokenA, tokenB].sort());
  });

  it("findMany with operator: ne / not_in returns rows with the stored hash", async () => {
    // ne / not_in describe which raw tokens are absent from the result, not
    // which are present, so the wrapper has no basis to map a returned hash
    // back to a raw value. Returned rows keep their stored hashes; callers
    // must not feed those tokens back into a token-keyed query.
    const present = `ne-present-${generateId()}`;
    const excluded = `ne-excluded-${generateId()}`;
    const expiresAt = new Date(Date.now() + 60_000);

    for (const token of [present, excluded]) {
      await adapter.create({
        model: "session",
        data: {
          id: `sess-${generateId()}`,
          token,
          userId: testUserId,
          expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }

    const neRows = await adapter.findMany<{ token: string }>({
      model: "session",
      where: [
        { field: "userId", value: testUserId },
        { field: "token", value: excluded, operator: "ne" },
      ],
    });
    const neTokens = neRows.map((r) => r.token);
    expect(neTokens).toContain(hashSessionToken(present));
    expect(neTokens).not.toContain(present);
    expect(neTokens).not.toContain(hashSessionToken(excluded));

    const notInRows = await adapter.findMany<{ token: string }>({
      model: "session",
      where: [
        { field: "userId", value: testUserId },
        { field: "token", value: [excluded], operator: "not_in" },
      ],
    });
    const notInTokens = notInRows.map((r) => r.token);
    expect(notInTokens).toContain(hashSessionToken(present));
    expect(notInTokens).not.toContain(present);
    expect(notInTokens).not.toContain(hashSessionToken(excluded));
  });

  it("delete by raw token removes the row", async () => {
    const rawToken = `delete-me-${generateId()}`;
    const expiresAt = new Date(Date.now() + 60_000);
    const created = await adapter.create<{ id: string }>({
      model: "session",
      data: {
        id: `sess-${generateId()}`,
        token: rawToken,
        userId: testUserId,
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await adapter.delete({
      model: "session",
      where: [{ field: "token", value: rawToken }],
    });

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, created.id));
    expect(row).toBeUndefined();
  });
});
