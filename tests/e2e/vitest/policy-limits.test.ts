import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The ledger's whole promise is about concurrency, which a stubbed database
// cannot demonstrate: two racing increments have to reach real Postgres.
vi.mock("@/lib/db", async () => {
  const { drizzle: realDrizzle } = await import("drizzle-orm/postgres-js");
  const pg = (await import("postgres")).default;
  const connection =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/keeperhub";
  return { db: realDrizzle(pg(connection, { max: 8, idle_timeout: 1 })) };
});

import {
  organization,
  policyLimitReservations,
  policyLimitUsage,
  users,
} from "@/lib/db/schema";
import { FactProvenance, FactState } from "@/lib/policy/constants";
import {
  releaseExpiredReservations,
  releaseReservations,
  reserveLimits,
  settleReservations,
} from "@/lib/policy/limits";
import type { PolicyFacts, PolicyLimit } from "@/lib/policy/types";

const CONNECTION =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/keeperhub";
const sql = postgres(CONNECTION, { max: 2, idle_timeout: 1 });
const db = drizzle(sql);

const ORG_ID = `limits-test-${crypto.randomUUID()}`;
const USER_ID = `limits-user-${crypto.randomUUID()}`;
const U = { state: FactState.UNKNOWN } as const;

function facts(usdValue: string): PolicyFacts {
  return {
    capability: "asset.transfer.token",
    resource: U,
    chainId: U,
    contractAddress: U,
    selector: U,
    protocolSlug: U,
    assets: U,
    counterparties: U,
    nativeValueWei: U,
    usdValue: {
      state: FactState.KNOWN,
      value: usdValue,
      provenance: FactProvenance.AUTHORITATIVE,
    },
    unbounded: U,
    gasPriceGwei: U,
    gasLimit: U,
    signerMode: U,
    triggerType: U,
    workflowId: U,
    workflowTags: U,
    projectId: U,
    sourceIp: U,
    httpHost: U,
    httpUrl: U,
    httpMethod: U,
    resourceId: U,
  } as PolicyFacts;
}

const DAILY_100K: PolicyLimit = {
  metric: "usd",
  window: "1d",
  max: "100000",
  scope: "organization",
};

function limitsFor(sid: string) {
  return [{ policyId: `policy-${ORG_ID}`, sid, limit: DAILY_100K }];
}

async function usedFor(sid: string): Promise<string> {
  const rows = await db
    .select({ used: policyLimitUsage.used })
    .from(policyLimitUsage)
    .where(eq(policyLimitUsage.sid, sid));
  return rows[0]?.used ?? "0";
}

const CHECKSUMMED = "0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48";

function tokenFacts(amount: string, address: string): PolicyFacts {
  return {
    ...facts("0"),
    assets: {
      state: FactState.KNOWN,
      value: [{ address, symbol: "USDC", amount }],
      provenance: FactProvenance.AUTHORITATIVE,
    },
  } as PolicyFacts;
}

function tokenLimit(sid: string, asset: string) {
  return [
    {
      policyId: `policy-${ORG_ID}`,
      sid,
      limit: {
        metric: "token",
        window: "1d",
        max: "1000",
        scope: "organization",
        asset,
      } as PolicyLimit,
    },
  ];
}

function principalLimit(sid: string) {
  return [
    {
      policyId: `policy-${ORG_ID}`,
      sid,
      limit: {
        metric: "usd",
        window: "1d",
        max: "100",
        scope: "principal",
      } as PolicyLimit,
    },
  ];
}

const member = (userId: string) =>
  ({
    kind: "member",
    userId,
    organizationId: ORG_ID,
    role: "member",
  }) as never;

beforeAll(async () => {
  await db
    .insert(users)
    .values({
      id: USER_ID,
      name: "Limits Test",
      email: `${USER_ID}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await db
    .insert(organization)
    .values({
      id: ORG_ID,
      name: "Limits Test Org",
      slug: ORG_ID,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db
    .delete(policyLimitUsage)
    .where(eq(policyLimitUsage.organizationId, ORG_ID));
  await db.delete(organization).where(eq(organization.id, ORG_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await sql.end({ timeout: 5 });
});

describe("the limit ledger", () => {
  it("permits an action inside the budget and records what it took", async () => {
    const sid = `under-${crypto.randomUUID()}`;
    const outcome = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("25000"),
    });
    expect(outcome.ok).toBe(true);
    expect(await usedFor(sid)).toBe("25000");
  });

  it("refuses the action that would cross the cap", async () => {
    const sid = `over-${crypto.randomUUID()}`;
    await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("90000"),
    });
    const second = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("20000"),
    });
    expect(second.ok).toBe(false);
    // The refused action took nothing, so the budget still shows only the first.
    expect(await usedFor(sid)).toBe("90000");
  });

  it("lets exactly one of two racing actions take the last of a budget", async () => {
    const sid = `race-${crypto.randomUUID()}`;
    await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("60000"),
    });

    // Both would fit on their own and cannot both fit together. Counting after
    // the fact would let both through and discover the overspend afterwards.
    const [a, b] = await Promise.all([
      reserveLimits({
        organizationId: ORG_ID,
        limits: limitsFor(sid),
        facts: facts("30000"),
      }),
      reserveLimits({
        organizationId: ORG_ID,
        limits: limitsFor(sid),
        facts: facts("30000"),
      }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await usedFor(sid)).toBe("90000");
  });

  it("gives the budget back when an action fails", async () => {
    const sid = `release-${crypto.randomUUID()}`;
    const outcome = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("40000"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    await releaseReservations(outcome.reservations);
    expect(await usedFor(sid)).toBe("0");

    // And the budget is genuinely usable again, not merely reported as free.
    const again = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("100000"),
    });
    expect(again.ok).toBe(true);
  });

  it("keeps the budget consumed when an action succeeds", async () => {
    const sid = `settle-${crypto.randomUUID()}`;
    const outcome = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("70000"),
    });
    if (!outcome.ok) {
      throw new Error("the first reservation should have fit");
    }
    await settleReservations(outcome.reservations);
    expect(await usedFor(sid)).toBe("70000");

    // Releasing a settled reservation must not refund it.
    await releaseReservations(outcome.reservations);
    expect(await usedFor(sid)).toBe("70000");
  });

  it("refuses when the action carries no value it can read", async () => {
    const sid = `unreadable-${crypto.randomUUID()}`;
    const outcome = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: { ...facts("1"), usdValue: U } as PolicyFacts,
    });

    // The policy states a ceiling, so being unable to work out what this action
    // spends is not permission to ignore it. Letting it through unmeasured is
    // the cap failing open on exactly the actions it understands least, and it
    // is what a workflow moving an unpriceable token used to do.
    expect(outcome.ok).toBe(false);
    expect(await usedFor(sid)).toBe("0");
  });

  it("counts a token limit when the address is checksummed", async () => {
    // The address on the fact arrives checksummed from the chain while the
    // policy names it in lower case. Lowering only one side skipped the limit
    // entirely, so the cap never counted anything.
    const sid = `token-${crypto.randomUUID()}`;
    const outcome = await reserveLimits({
      organizationId: ORG_ID,
      limits: tokenLimit(sid, CHECKSUMMED.toLowerCase()),
      facts: tokenFacts("400", CHECKSUMMED),
    });
    expect(outcome.ok).toBe(true);
    expect(await usedFor(sid)).toBe("400");
  });

  it("counts a token limit that names the asset by identifier", async () => {
    const sid = `token-arn-${crypto.randomUUID()}`;
    await reserveLimits({
      organizationId: ORG_ID,
      limits: tokenLimit(sid, `kh:chain/1/asset/${CHECKSUMMED.toLowerCase()}`),
      facts: tokenFacts("250", CHECKSUMMED),
    });
    expect(await usedFor(sid)).toBe("250");
  });

  it("gives each principal its own bucket", async () => {
    const sid = `principal-${crypto.randomUUID()}`;
    const first = await reserveLimits({
      organizationId: ORG_ID,
      limits: principalLimit(sid),
      facts: facts("80"),
      principal: member("person-a"),
    });
    // A shared organization bucket would refuse this: 80 + 80 crosses 100.
    const second = await reserveLimits({
      organizationId: ORG_ID,
      limits: principalLimit(sid),
      facts: facts("80"),
      principal: member("person-b"),
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("still stops one principal from crossing their own cap", async () => {
    const sid = `principal-cap-${crypto.randomUUID()}`;
    await reserveLimits({
      organizationId: ORG_ID,
      limits: principalLimit(sid),
      facts: facts("80"),
      principal: member("person-c"),
    });
    const again = await reserveLimits({
      organizationId: ORG_ID,
      limits: principalLimit(sid),
      facts: facts("80"),
      principal: member("person-c"),
    });
    expect(again.ok).toBe(false);
  });

  it("gives back the budget of a reservation nobody ever closed", async () => {
    const sid = `abandoned-${crypto.randomUUID()}`;
    const outcome = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("40000"),
    });
    expect(outcome.ok).toBe(true);
    expect(await usedFor(sid)).toBe("40000");

    // What a dropped reservation looks like once its fifteen minutes are up.
    // Before the sweep this headroom was gone for good: reserving takes it and
    // only an explicit release gives it back.
    if (outcome.ok) {
      await db
        .update(policyLimitReservations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(
            policyLimitReservations.id,
            outcome.reservations[0]?.reservationId ?? ""
          )
        );
    }

    await releaseExpiredReservations(ORG_ID);
    expect(await usedFor(sid)).toBe("0");
  });

  it("leaves a live reservation alone", async () => {
    const sid = `live-${crypto.randomUUID()}`;
    await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("30000"),
    });

    await releaseExpiredReservations(ORG_ID);
    expect(await usedFor(sid)).toBe("30000");
  });

  it("leaves a settled reservation alone, however old", async () => {
    const sid = `settled-${crypto.randomUUID()}`;
    const outcome = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("20000"),
    });
    if (outcome.ok) {
      await settleReservations(outcome.reservations);
      await db
        .update(policyLimitReservations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(
            policyLimitReservations.id,
            outcome.reservations[0]?.reservationId ?? ""
          )
        );
    }

    // Settled means spent. Sweeping it back would refund money that moved.
    await releaseExpiredReservations(ORG_ID);
    expect(await usedFor(sid)).toBe("20000");
  });

  it("reclaims stale headroom on the way in to the next reservation", async () => {
    const sid = `reclaim-${crypto.randomUUID()}`;
    const first = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("90000"),
    });
    if (first.ok) {
      await db
        .update(policyLimitReservations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(
            policyLimitReservations.id,
            first.reservations[0]?.reservationId ?? ""
          )
        );
    }

    // 90k of a 100k cap is abandoned. Without the sweep this second action
    // would be refused for a budget nothing is actually spending.
    const second = await reserveLimits({
      organizationId: ORG_ID,
      limits: limitsFor(sid),
      facts: facts("90000"),
    });
    expect(second.ok).toBe(true);
  });
});
