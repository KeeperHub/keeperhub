import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CONNECTION =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/keeperhub_test";

vi.mock("@/lib/db", async () => {
  const { drizzle: realDrizzle } = await import("drizzle-orm/postgres-js");
  const pg = (await import("postgres")).default;
  const connection =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/keeperhub_test";
  return { db: realDrizzle(pg(connection, { max: 2, idle_timeout: 1 })) };
});

// The oracle is the one thing stubbed: pricing is a network read, and this is
// about whether a dollar ceiling counts a token at all, not about the feed.
vi.mock("@/lib/scan/price", () => ({
  resolveUsdPrice: vi.fn(() => Promise.resolve(1)),
}));

import { supportedTokens } from "@/lib/db/schema";
import { FactProvenance, FactState } from "@/lib/policy/constants";
import { withUsdValue } from "@/lib/policy/price";
import type { PolicyFacts } from "@/lib/policy/types";

const CHAIN = 8453;
const USDC = "0x0000000000000000000000000000000000009999";
const U = { state: FactState.UNKNOWN } as const;

function factsWith(amount: string, address: string): PolicyFacts {
  return {
    capability: "asset.transfer.token",
    resource: U,
    chainId: U,
    contractAddress: U,
    selector: U,
    protocolSlug: U,
    assets: {
      state: FactState.KNOWN,
      value: [{ address, amount }],
      provenance: FactProvenance.WORKFLOW_DERIVED,
    },
    counterparties: U,
    nativeValueWei: U,
    usdValue: U,
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
  } as unknown as PolicyFacts;
}

describe("what a dollar ceiling can see", () => {
  let client: ReturnType<typeof postgres>;
  let testDb: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    client = postgres(CONNECTION, { max: 4 });
    testDb = drizzle(client);
    await testDb
      .insert(supportedTokens)
      .values({
        id: `tok-${crypto.randomUUID()}`,
        chainId: CHAIN,
        tokenAddress: USDC,
        symbol: "TUSD",
        name: "Test USD",
        decimals: 6,
        isStablecoin: true,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await testDb
      .delete(supportedTokens)
      .where(
        and(
          eq(supportedTokens.chainId, CHAIN),
          eq(supportedTokens.tokenAddress, USDC)
        )
      );
    await client.end();
  });

  it("prices a token transfer, so a dollar cap counts it", async () => {
    // 250 TUSD at six decimals. Before this a dollar ceiling only ever saw
    // native value, so a workflow moving stablecoins never touched the cap.
    const priced = await withUsdValue(factsWith("250000000", USDC), CHAIN);

    expect(priced.usdValue.state).toBe(FactState.KNOWN);
    expect(Number((priced.usdValue as { value: string }).value)).toBeCloseTo(
      250,
      6
    );
  });

  it("marks the figure authoritative, never workflow-derived", async () => {
    const priced = await withUsdValue(factsWith("1000000", USDC), CHAIN);

    // The asset fact itself is workflow-derived. The dollar figure is not: it
    // comes from our token table and an oracle, which is what stops a ceiling
    // being set by whoever controls an upstream node.
    expect((priced.usdValue as { provenance: string }).provenance).toBe(
      FactProvenance.AUTHORITATIVE
    );
  });

  it("leaves the value unknown for a token it does not carry", async () => {
    const priced = await withUsdValue(
      factsWith("250000000", "0x000000000000000000000000000000000000dead"),
      CHAIN
    );

    // Pricing from decimals nobody established would be a confident wrong
    // number. Unknown is what makes the limit refuse rather than undercount.
    expect(priced.usdValue.state).toBe(FactState.UNKNOWN);
  });
});
