import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RpcUsageResponse, TimeRange } from "../../../lib/analytics/types";
import { chains, organization } from "../../../lib/db/schema";
import {
  organizationRpcChainPolicy,
  organizationRpcConfigs,
  organizationRpcUsageHourly,
} from "../../../lib/db/schema-rpc";
import { RpcOrigin, RpcTransport } from "../../../lib/rpc/engine/types";

vi.mock("server-only", () => ({}));
// tests/setup.ts stubs @/lib/db; the aggregation under test runs in Postgres.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = `test_rpc_usage_${Date.now().toString(36)}_`;
const ORG_ID = `${PREFIX}org`;
const OTHER_ORG_ID = `${PREFIX}other`;
const CONFIG_ID = `${PREFIX}cfg`;
const REMOVED_CONFIG_ID = `${PREFIX}cfg_removed`;
const NAMED_CHAIN = 990_001;
const UNNAMED_CHAIN = 990_002;

const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours: number): Date {
  const now = Date.now();
  return new Date(Math.floor(now / HOUR_MS) * HOUR_MS - hours * HOUR_MS);
}

type GetRpcUsage = (
  organizationId: string,
  range: TimeRange,
  customStart?: string,
  customEnd?: string,
  timeZone?: string
) => Promise<RpcUsageResponse>;

describe.skipIf(SKIP)("rpc usage analytics", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getRpcUsage: GetRpcUsage;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM chains WHERE id LIKE ${`${PREFIX}%`}`;
  }

  function usageRow(
    organizationId: string,
    configId: string | null,
    chainId: number,
    hour: Date,
    requests: number,
    extra: Partial<typeof organizationRpcUsageHourly.$inferInsert> = {}
  ): typeof organizationRpcUsageHourly.$inferInsert {
    return {
      organizationId,
      configId,
      origin: configId ? RpcOrigin.ORG : RpcOrigin.PLATFORM,
      chainId,
      transport: RpcTransport.HTTP,
      hour,
      requests,
      latencyMsSum: requests * 10,
      latencyMsMax: 50,
      ...extra,
    };
  }

  beforeAll(async () => {
    process.env.ANALYTICS_CACHE_TTL_MS = "0";
    queryClient = postgres(DATABASE_URL, { max: 2 });
    db = drizzle(queryClient);
    await cleanup();

    const now = new Date();
    await db.insert(organization).values([
      { id: ORG_ID, name: "rpc usage org", slug: ORG_ID, createdAt: now },
      {
        id: OTHER_ORG_ID,
        name: "rpc usage other",
        slug: OTHER_ORG_ID,
        createdAt: now,
      },
    ]);
    await db.insert(chains).values({
      id: `${PREFIX}chain`,
      chainId: NAMED_CHAIN,
      name: "Usage Testnet",
      symbol: "ETH",
      chainType: "evm",
      defaultPrimaryRpc: "http://rpc.test",
    });
    await db.insert(organizationRpcConfigs).values({
      id: CONFIG_ID,
      organizationId: ORG_ID,
      chainId: NAMED_CHAIN,
      name: "Own node",
      encryptedUrls: "unused",
    });
    await db.insert(organizationRpcChainPolicy).values([
      { organizationId: ORG_ID, chainId: NAMED_CHAIN, ownRpcOnly: true },
      { organizationId: ORG_ID, chainId: UNNAMED_CHAIN, ownRpcOnly: false },
    ]);

    await db.insert(organizationRpcUsageHourly).values([
      usageRow(ORG_ID, CONFIG_ID, NAMED_CHAIN, hoursAgo(1), 40, {
        errors: 2,
        failovers: 1,
        latencyMsMax: 300,
      }),
      usageRow(ORG_ID, CONFIG_ID, NAMED_CHAIN, hoursAgo(2), 20),
      usageRow(ORG_ID, null, NAMED_CHAIN, hoursAgo(1), 5, { timeouts: 1 }),
      // No config row: the config was removed after it served traffic.
      usageRow(ORG_ID, REMOVED_CONFIG_ID, UNNAMED_CHAIN, hoursAgo(3), 7),
      // Outside the 24h window.
      usageRow(ORG_ID, CONFIG_ID, NAMED_CHAIN, hoursAgo(30), 1000),
      // Another organization's traffic.
      usageRow(OTHER_ORG_ID, null, NAMED_CHAIN, hoursAgo(1), 500),
    ]);

    ({ getRpcUsage } = await import("@/lib/analytics/rpc-usage"));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
    process.env.ANALYTICS_CACHE_TTL_MS = undefined;
  });

  it("sums the organization's window and splits own from KeeperHub", async () => {
    const usage = await getRpcUsage(ORG_ID, "24h");
    expect(usage.ownRpcOnlyChains).toEqual([
      { chainId: NAMED_CHAIN, chainName: "Usage Testnet", platformRequests: 5 },
    ]);
    expect(usage.summary).toMatchObject({
      requests: 72,
      ownRequests: 67,
      platformRequests: 5,
      errors: 2,
      timeouts: 1,
      failovers: 1,
      avgLatencyMs: 10,
      maxLatencyMs: 300,
    });
  });

  it("breaks down by endpoint and chain, keeping a removed config", async () => {
    const { breakdown } = await getRpcUsage(ORG_ID, "24h");
    expect(
      breakdown.map((row) => ({
        configId: row.configId,
        configName: row.configName,
        configRemoved: row.configRemoved,
        chainName: row.chainName,
        requests: row.requests,
      }))
    ).toEqual([
      {
        configId: CONFIG_ID,
        configName: "Own node",
        configRemoved: false,
        chainName: "Usage Testnet",
        requests: 60,
      },
      {
        configId: REMOVED_CONFIG_ID,
        configName: null,
        configRemoved: true,
        chainName: null,
        requests: 7,
      },
      {
        configId: null,
        configName: null,
        configRemoved: false,
        chainName: "Usage Testnet",
        requests: 5,
      },
    ]);
  });

  it("returns hourly buckets covering the whole window", async () => {
    const { buckets, intervalMs } = await getRpcUsage(ORG_ID, "24h");
    expect(intervalMs).toBe(HOUR_MS);
    expect(buckets.length).toBeGreaterThanOrEqual(24);
    const lastHour = buckets.find(
      (bucket) => bucket.timestamp === hoursAgo(1).toISOString()
    );
    expect(lastHour).toMatchObject({ ownRequests: 40, platformRequests: 5 });
    const total = buckets.reduce(
      (sum, bucket) => sum + bucket.ownRequests + bucket.platformRequests,
      0
    );
    expect(total).toBe(72);
  });

  it("is empty for a window with no usage", async () => {
    const usage = await getRpcUsage(
      OTHER_ORG_ID,
      "custom",
      hoursAgo(10).toISOString(),
      hoursAgo(8).toISOString()
    );
    expect(usage.ownRpcOnlyChains).toEqual([]);
    expect(usage.breakdown).toEqual([]);
    expect(usage.summary.requests).toBe(0);
  });
});
