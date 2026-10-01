import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", async () => {
  const { drizzle: realDrizzle } = await import("drizzle-orm/postgres-js");
  const pg = (await import("postgres")).default;
  const connection =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/keeperhub_test";
  return { db: realDrizzle(pg(connection, { max: 2, idle_timeout: 1 })) };
});

import { verifications } from "@/lib/db/schema";
import {
  closePolicyWriteWindow,
  hasPolicyWriteWindow,
  openPolicyWriteWindow,
  POLICY_WRITE_COOKIE,
  readPolicyWriteCookie,
} from "@/lib/mfa/policy-write-window";

const CONNECTION =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/keeperhub_test";

const id = (): string => crypto.randomUUID();

describe("the policy write window", () => {
  let client: ReturnType<typeof postgres>;
  let testDb: ReturnType<typeof drizzle>;
  const userId = `user-${id()}`;
  const otherUserId = `user-${id()}`;
  const orgId = `org-${id()}`;
  const otherOrgId = `org-${id()}`;

  beforeAll(() => {
    client = postgres(CONNECTION, { max: 4 });
    testDb = drizzle(client);
  });

  afterAll(async () => {
    for (const u of [userId, otherUserId]) {
      for (const o of [orgId, otherOrgId]) {
        await testDb
          .delete(verifications)
          .where(eq(verifications.identifier, `policy_write_window:${u}:${o}`));
      }
    }
    await client.end();
  });

  it("opens a window the holder of the token can use", async () => {
    const { token } = await openPolicyWriteWindow({
      userId,
      organizationId: orgId,
    });

    expect(
      await hasPolicyWriteWindow({ userId, organizationId: orgId, token })
    ).toBe(true);
  });

  it("refuses a request that carries no token", async () => {
    await openPolicyWriteWindow({ userId, organizationId: orgId });

    expect(
      await hasPolicyWriteWindow({
        userId,
        organizationId: orgId,
        token: undefined,
      })
    ).toBe(false);
  });

  it("refuses a token that was not the one issued", async () => {
    await openPolicyWriteWindow({ userId, organizationId: orgId });

    expect(
      await hasPolicyWriteWindow({
        userId,
        organizationId: orgId,
        token: crypto.randomBytes(32).toString("base64url"),
      })
    ).toBe(false);
  });

  it("does not let a window for one organization write another", async () => {
    const { token } = await openPolicyWriteWindow({
      userId,
      organizationId: orgId,
    });

    expect(
      await hasPolicyWriteWindow({
        userId,
        organizationId: otherOrgId,
        token,
      })
    ).toBe(false);
  });

  it("does not let one person's window serve another person", async () => {
    const { token } = await openPolicyWriteWindow({
      userId,
      organizationId: orgId,
    });

    expect(
      await hasPolicyWriteWindow({
        userId: otherUserId,
        organizationId: orgId,
        token,
      })
    ).toBe(false);
  });

  it("replaces the previous window, so an older token stops working", async () => {
    const first = await openPolicyWriteWindow({
      userId,
      organizationId: orgId,
    });
    const second = await openPolicyWriteWindow({
      userId,
      organizationId: orgId,
    });

    expect(
      await hasPolicyWriteWindow({
        userId,
        organizationId: orgId,
        token: first.token,
      })
    ).toBe(false);
    expect(
      await hasPolicyWriteWindow({
        userId,
        organizationId: orgId,
        token: second.token,
      })
    ).toBe(true);
  });

  it("refuses once the window has expired", async () => {
    const { token } = await openPolicyWriteWindow({
      userId,
      organizationId: orgId,
    });

    // Age the row rather than wait ten minutes for it.
    await testDb
      .update(verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        eq(verifications.identifier, `policy_write_window:${userId}:${orgId}`)
      );

    expect(
      await hasPolicyWriteWindow({ userId, organizationId: orgId, token })
    ).toBe(false);
  });

  it("can be ended early, which is what a sign-out needs", async () => {
    const { token } = await openPolicyWriteWindow({
      userId,
      organizationId: orgId,
    });
    await closePolicyWriteWindow({ userId, organizationId: orgId });

    expect(
      await hasPolicyWriteWindow({ userId, organizationId: orgId, token })
    ).toBe(false);
  });

  it("stores the token hashed, so reading the table yields nothing replayable", async () => {
    const { token } = await openPolicyWriteWindow({
      userId,
      organizationId: orgId,
    });

    const [row] = await testDb
      .select({ value: verifications.value })
      .from(verifications)
      .where(
        eq(verifications.identifier, `policy_write_window:${userId}:${orgId}`)
      );

    expect(row?.value).toBeDefined();
    expect(row?.value).not.toBe(token);
    expect(row?.value).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reads the token out of a cookie header", () => {
    const request = new Request("https://test.local/api", {
      headers: { cookie: `other=1; ${POLICY_WRITE_COOKIE}=abc123; last=2` },
    });
    expect(readPolicyWriteCookie(request)).toBe("abc123");
  });

  it("reads the __Host- spelling production sets", () => {
    // The name differs between production and plain http development, so a
    // reader that knew only one of them would reject every live window.
    const request = new Request("https://test.local/api", {
      headers: { cookie: "__Host-kh_policy_write=abc123" },
    });
    expect(readPolicyWriteCookie(request)).toBe("abc123");
  });

  it("reports nothing when the cookie is absent", () => {
    const request = new Request("https://test.local/api", {
      headers: { cookie: "other=1" },
    });
    expect(readPolicyWriteCookie(request)).toBeUndefined();
  });
});
