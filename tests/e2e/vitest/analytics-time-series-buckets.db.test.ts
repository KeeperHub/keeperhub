import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TimeSeriesResponse } from "../../../lib/analytics/types";
import {
  organization,
  users,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally stubs @/lib/db; the behaviour under test is which
// bucket Postgres puts a row in, so this suite needs the real client.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_ts_buckets_";
const ORG_ID = `${PREFIX}org`;
const USER_ID = `${PREFIX}user`;
const WORKFLOW_ID = `${PREFIX}wf`;

// Three hours behind UTC year-round, which is what makes the UTC day and the
// local day disagree for the last three hours of every local day.
const ZONE = "America/Argentina/Buenos_Aires";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const LOCAL_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const LOCAL_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function localDate(value: string | Date): string {
  return LOCAL_DATE.format(new Date(value));
}

function localTime(value: string | Date): string {
  return LOCAL_TIME.format(new Date(value));
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Local midday two days back. Truncating this to the UTC day lands on 21:00 the
 * previous day in ZONE, so a run here was counted against the wrong day - which
 * is what shifted every label on the chart back by one.
 */
function middayInstant(now: Date): Date {
  const instant = new Date(now);
  instant.setUTCDate(instant.getUTCDate() - 2);
  instant.setUTCHours(15, 0, 0, 0);
  return instant;
}

describe.skipIf(SKIP)("time-series buckets", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getTimeSeries: (
    organizationId: string,
    range: "30d",
    customStart?: string,
    customEnd?: string,
    projectId?: string,
    timeZone?: string
  ) => Promise<TimeSeriesResponse>;

  const now = new Date();
  const midday = middayInstant(now);
  const recent = new Date(now.getTime() - 5 * 60 * 1000);

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM member WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
  }

  beforeAll(async () => {
    // The per-process TTL cache would serve one range to every case here.
    process.env.ANALYTICS_CACHE_TTL_MS = "0";

    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    await db.insert(organization).values({
      id: ORG_ID,
      name: "time series org",
      slug: ORG_ID,
      createdAt: now,
    });
    await db.insert(users).values({
      id: USER_ID,
      email: `${USER_ID}@keeperhub.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflows).values({
      id: WORKFLOW_ID,
      name: "time series workflow",
      userId: USER_ID,
      organizationId: ORG_ID,
      enabled: true,
      nodes: [],
      edges: [],
    });

    await db.insert(workflowExecutions).values([
      {
        id: `${PREFIX}exec_midday`,
        workflowId: WORKFLOW_ID,
        userId: USER_ID,
        status: "success",
        startedAt: midday,
        completedAt: midday,
        totalSteps: "1",
        completedSteps: "1",
      },
      {
        id: `${PREFIX}exec_recent`,
        workflowId: WORKFLOW_ID,
        userId: USER_ID,
        status: "success",
        startedAt: recent,
        completedAt: recent,
        totalSteps: "1",
        completedSteps: "1",
      },
    ]);

    ({ getTimeSeries } = await import("@/lib/analytics/queries"));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
    process.env.ANALYTICS_CACHE_TTL_MS = undefined;
  });

  it("starts every daily bucket at local midnight, not UTC midnight", async () => {
    const { buckets, intervalMs } = await getTimeSeries(
      ORG_ID,
      "30d",
      undefined,
      undefined,
      undefined,
      ZONE
    );

    expect(intervalMs).toBe(DAY_MS);
    expect(buckets.length).toBeGreaterThan(0);
    for (const bucket of buckets) {
      expect(localTime(bucket.timestamp)).toBe("00:00:00");
    }
  });

  it("counts a run against the local day it happened on", async () => {
    const { buckets } = await getTimeSeries(
      ORG_ID,
      "30d",
      undefined,
      undefined,
      undefined,
      ZONE
    );

    const on = (instant: Date) =>
      buckets.find((b) => localDate(b.timestamp) === localDate(instant));

    expect(on(midday)?.success).toBe(1);
    // Truncating in UTC parked it here instead.
    const dayBefore = new Date(midday.getTime() - DAY_MS);
    expect(on(dayBefore)?.success).toBe(0);
  });

  it("ends on the viewer's current day", async () => {
    const { buckets } = await getTimeSeries(
      ORG_ID,
      "30d",
      undefined,
      undefined,
      undefined,
      ZONE
    );

    const last = buckets.at(-1);
    expect(last).toBeDefined();
    expect(localDate(last?.timestamp ?? "")).toBe(localDate(now));
  });

  it("returns a day with no runs as zero rather than dropping it", async () => {
    const { buckets } = await getTimeSeries(
      ORG_ID,
      "30d",
      undefined,
      undefined,
      undefined,
      ZONE
    );

    // Nothing was seeded a week back, so that day exists only if the window is
    // filled. Left sparse it would vanish from the axis.
    const quiet = localDate(new Date(now.getTime() - 7 * DAY_MS));
    const bucket = buckets.find((b) => localDate(b.timestamp) === quiet);
    expect(bucket).toBeDefined();
    expect(bucket?.success).toBe(0);
    expect(bucket?.error).toBe(0);
  });

  it("still buckets by UTC day when the caller names no zone", async () => {
    const { buckets } = await getTimeSeries(ORG_ID, "30d");

    const counted = buckets.filter((bucket) => bucket.success > 0);
    const dates = counted.map((bucket) =>
      new Date(bucket.timestamp).toISOString().slice(0, 10)
    );
    expect(dates).toContain(utcDate(midday));
  });
});
