/**
 * POST .../disbursement-legs/[runKey]/[legIndex]/resolve against a real
 * Postgres. Auth, scope and audit are mocked (the shape is the same as
 * execution-digest's route, covered elsewhere); resolveLeg runs its real SQL.
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disbursementLegs,
  member,
  organization,
  users,
} from "../../lib/db/schema";

vi.mock("server-only", () => ({}));
vi.unmock("@/lib/db");

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  context: null as unknown,
}));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: () => Promise.resolve(auth.context),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: () => null,
}));

const audit = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@/lib/security/audit-log", () => ({
  buildAuditMetadata: () => ({}),
  recordAuditEvent: (event: unknown) => {
    audit.events.push(event);
    return Promise.resolve();
  },
}));

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const queryClient = postgres(DATABASE_URL, { max: 2 });
const testDb = drizzle(queryClient);

const PREFIX = "test_resolveroute_";
const USER = `${PREFIX}user`;
const PLAIN_MEMBER_USER = `${PREFIX}plain_member`;
const NON_MEMBER_USER = `${PREFIX}non_member`;
const ORG = `${PREFIX}org`;
const OTHER_ORG = `${PREFIX}org_other`;

async function post(
  runKey: string,
  legIndex: string,
  body: unknown,
  orgId = ORG
) {
  const { POST } = await import(
    "../../app/api/organizations/[organizationId]/disbursement-legs/[runKey]/[legIndex]/resolve/route"
  );
  const req = new Request(
    `http://localhost/api/organizations/${orgId}/disbursement-legs/${runKey}/${legIndex}/resolve`,
    { method: "POST", body: JSON.stringify(body) }
  );
  const res = await POST(req, {
    params: Promise.resolve({ organizationId: orgId, runKey, legIndex }),
  });
  return { status: res.status, body: await res.json() };
}

async function seed(): Promise<void> {
  for (const id of [USER, PLAIN_MEMBER_USER, NON_MEMBER_USER]) {
    await testDb
      .insert(users)
      .values({
        id,
        name: "t",
        email: `${id}@test.local`,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
  }
  for (const org of [ORG, OTHER_ORG]) {
    await testDb
      .insert(organization)
      .values({ id: org, name: "t", slug: org, createdAt: new Date() })
      .onConflictDoNothing();
  }
  // USER is an owner of ORG -- the bar this route now requires, matching
  // execution-digest exactly. PLAIN_MEMBER_USER is a member of ORG with the
  // default "member" role, which is now refused: resolving a leg decides
  // between two payment bugs, so it gets the owner/admin bar, not "any
  // member" as an earlier version of this route claimed without enforcing.
  // NON_MEMBER_USER has no membership row in ORG at all.
  await testDb
    .insert(member)
    .values([
      {
        id: `${USER}-membership`,
        organizationId: ORG,
        userId: USER,
        role: "owner",
        createdAt: new Date(),
      },
      {
        id: `${PLAIN_MEMBER_USER}-membership`,
        organizationId: ORG,
        userId: PLAIN_MEMBER_USER,
        role: "member",
        createdAt: new Date(),
      },
    ])
    .onConflictDoNothing();
  await testDb.insert(disbursementLegs).values({
    organizationId: ORG,
    runKey: "run-1",
    legIndex: 0,
    chainId: 84_532,
    asset: "native",
    recipient: "0x106175f175b940cca1816d75eb19937a88be7720",
    amount: "1",
    status: "unknown",
    claimToken: "t",
  });
}

async function clear(): Promise<void> {
  await testDb
    .delete(disbursementLegs)
    .where(eq(disbursementLegs.organizationId, ORG));
}

beforeEach(async () => {
  await clear();
  await seed();
  audit.events = [];
  auth.context = {
    userId: USER,
    organizationId: ORG,
    authMethod: "api-key",
    apiKeyId: "key-1",
    scope: "mcp:write",
    isAnonymous: false,
  };
});

afterAll(async () => {
  await clear();
  await testDb.delete(member).where(eq(member.organizationId, ORG));
  await testDb.delete(organization).where(eq(organization.id, ORG));
  await testDb.delete(organization).where(eq(organization.id, OTHER_ORG));
  for (const id of [USER, PLAIN_MEMBER_USER, NON_MEMBER_USER]) {
    await testDb.delete(users).where(eq(users.id, id));
  }
  await queryClient.end();
});

describe("POST disbursement-legs resolve route (real database)", () => {
  const VALID_EVM_TX_HASH = `0x${"a".repeat(64)}`;

  it("resolves an unknown leg as paid and audits it", async () => {
    const { status, body } = await post("run-1", "0", {
      outcome: "paid",
      transactionHash: VALID_EVM_TX_HASH,
      note: "Found the transfer on Basescan",
    });

    expect(status).toBe(200);
    expect(body.leg).toMatchObject({
      status: "settled",
      transactionHash: VALID_EVM_TX_HASH,
    });
    expect(audit.events).toEqual([
      expect.objectContaining({
        action: "disburse.leg.resolve",
        resourceId: `${ORG}:run-1:0`,
      }),
    ]);
  });

  it("400s on a missing note, and does not audit", async () => {
    const { status, body } = await post("run-1", "0", { outcome: "paid" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/paid.*note|note/i);
    expect(audit.events).toEqual([]);
  });

  it("409s on a leg that is not resolvable", async () => {
    await testDb
      .update(disbursementLegs)
      .set({ status: "settled" })
      .where(eq(disbursementLegs.runKey, "run-1"));
    const { status } = await post("run-1", "0", {
      outcome: "not_paid",
      note: "n",
    });
    expect(status).toBe(409);
  });

  it("404s on an unknown run or leg", async () => {
    const { status } = await post("no-such-run", "0", {
      outcome: "not_paid",
      note: "n",
    });
    expect(status).toBe(404);
  });

  it("400s on a negative or non-numeric leg index, before touching the database", async () => {
    for (const bad of ["-1", "abc", "1.5"]) {
      const { status } = await post("run-1", bad, {
        outcome: "not_paid",
        note: "n",
      });
      expect(status).toBe(400);
    }
  });

  it("refuses an API key resolving a leg in a different organization", async () => {
    const { status } = await post(
      "run-1",
      "0",
      { outcome: "not_paid", note: "n" },
      OTHER_ORG
    );
    expect(status).toBe(403);
  });

  it("resolves 'self' to the credential's own org for an API-key caller", async () => {
    const { status, body } = await post(
      "run-1",
      "0",
      { outcome: "not_paid", note: "n" },
      "self"
    );
    expect(status).toBe(200);
    expect(body.leg.organizationId).toBe(ORG);
  });

  it("refuses 'self' for a session caller", async () => {
    auth.context = {
      userId: USER,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      scope: undefined,
      isAnonymous: false,
    };
    const { status } = await post(
      "run-1",
      "0",
      { outcome: "not_paid", note: "n" },
      "self"
    );
    expect(status).toBe(400);
  });

  it("401s when authentication fails", async () => {
    auth.context = { error: "Unauthorized", status: 401 };
    const { status } = await post("run-1", "0", {
      outcome: "not_paid",
      note: "n",
    });
    expect(status).toBe(401);
  });

  // The authorization hole a maintainer review found: this route never
  // checked organization membership at all, so any authenticated session
  // user of any organization could resolve another organization's leg.
  // Fixed to require owner or admin, matching execution-digest exactly.

  it("refuses a session caller with no membership in the named organization", async () => {
    auth.context = {
      userId: NON_MEMBER_USER,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      scope: undefined,
      isAnonymous: false,
    };
    const { status } = await post("run-1", "0", {
      outcome: "not_paid",
      note: "n",
    });
    expect(status).toBe(403);
  });

  it("refuses a plain member (not owner or admin) of the named organization", async () => {
    auth.context = {
      userId: PLAIN_MEMBER_USER,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      scope: undefined,
      isAnonymous: false,
    };
    const { status } = await post("run-1", "0", {
      outcome: "not_paid",
      note: "n",
    });
    expect(status).toBe(403);
  });

  it("allows a session caller who is an owner of the named organization", async () => {
    auth.context = {
      userId: USER,
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
      scope: undefined,
      isAnonymous: false,
    };
    const { status } = await post("run-1", "0", {
      outcome: "not_paid",
      note: "checked on chain",
    });
    expect(status).toBe(200);
  });

  it("400s on an empty or over-length run key, before touching the database", async () => {
    const tooLong = "k".repeat(201);
    for (const bad of ["", "   ", tooLong]) {
      const { status } = await post(bad, "0", {
        outcome: "not_paid",
        note: "n",
      });
      expect(status).toBe(400);
    }
  });

  it("400s on a malformed transaction hash on the paid branch, and writes nothing", async () => {
    for (const bad of ["not-a-hash", "0xabc", "0x", ""]) {
      const { status, body } = await post("run-1", "0", {
        outcome: "paid",
        transactionHash: bad,
        note: "Found the transfer on Basescan",
      });
      // An empty hash is refused as missing evidence (existing check); a
      // non-empty malformed one is refused as an invalid hash (new check).
      // Both are 400.
      expect(status).toBe(400);
      expect(body.error).toMatch(/hash/i);
    }
    // Nothing above wrote anything: the leg is still unknown and still
    // resolvable, which a leg the "paid" attempts had actually settled would
    // not be.
    const { status } = await post("run-1", "0", {
      outcome: "not_paid",
      note: "n",
    });
    expect(status).toBe(200);
  });
});
