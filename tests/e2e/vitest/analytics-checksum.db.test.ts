import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  organization,
  users,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally stubs @/lib/db; this suite needs the checksum to hit
// Postgres. The run-side MAX is a hand-written lateral rather than a builder
// query, so nothing else in the suite would catch a malformed statement, a
// wrong window bound, or a lateral that only sees one workflow.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_checksum_";
const ORG_ID = `${PREFIX}org`;
const EMPTY_ORG_ID = `${PREFIX}org_empty`;
const USER_ID = `${PREFIX}user`;
// Two workflows, because a lateral evaluates per workflow and a rewrite that
// stopped aggregating across them would still look right with only one.
const WORKFLOW_A = `${PREFIX}wf_a`;
const WORKFLOW_B = `${PREFIX}wf_b`;

const SENTINEL = "1970-01-01 00:00:00";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Truncated to the second: started_at is `timestamp without time zone` and the
// checksum renders it as text, so comparing against a millisecond-bearing Date
// would compare two different string shapes.
function atSecond(date: Date): Date {
  const copy = new Date(date);
  copy.setMilliseconds(0);
  return copy;
}

const OLDEST = atSecond(daysAgo(40));
const NEWEST_IN_WINDOW = atSecond(daysAgo(2));
const MIDDLE = atSecond(daysAgo(20));

function pgText(date: Date): string {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

describe.skipIf(SKIP)("getAnalyticsChecksum", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getAnalyticsChecksum: (
    organizationId: string,
    rangeStart: Date
  ) => Promise<string>;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM alert_deliveries WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM member WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    const now = new Date();

    await db.insert(organization).values([
      { id: ORG_ID, name: "checksum org", slug: ORG_ID, createdAt: now },
      {
        id: EMPTY_ORG_ID,
        name: "checksum empty org",
        slug: EMPTY_ORG_ID,
        createdAt: now,
      },
    ]);
    await db.insert(users).values({
      id: USER_ID,
      email: `${USER_ID}@keeperhub.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflows).values([
      {
        id: WORKFLOW_A,
        name: "checksum workflow a",
        userId: USER_ID,
        organizationId: ORG_ID,
        enabled: true,
        nodes: [],
        edges: [],
      },
      {
        id: WORKFLOW_B,
        name: "checksum workflow b",
        userId: USER_ID,
        organizationId: ORG_ID,
        enabled: true,
        nodes: [],
        edges: [],
      },
    ]);

    await db.insert(workflowExecutions).values([
      // Outside a 30-day window. The newest run the org has overall, if the
      // bound were dropped this would be the answer for every case below.
      {
        id: `${PREFIX}exec_old`,
        workflowId: WORKFLOW_A,
        userId: USER_ID,
        status: "success",
        startedAt: OLDEST,
        completedAt: OLDEST,
        totalSteps: "1",
        completedSteps: "1",
      },
      // Inside the window, on workflow A.
      {
        id: `${PREFIX}exec_mid`,
        workflowId: WORKFLOW_A,
        userId: USER_ID,
        status: "success",
        startedAt: MIDDLE,
        completedAt: MIDDLE,
        totalSteps: "1",
        completedSteps: "1",
      },
      // Inside the window and the newest of all, on the OTHER workflow, so the
      // answer can only be right if the lateral aggregates across workflows.
      {
        id: `${PREFIX}exec_new`,
        workflowId: WORKFLOW_B,
        userId: USER_ID,
        status: "running",
        startedAt: NEWEST_IN_WINDOW,
        completedAt: null,
        totalSteps: "1",
        completedSteps: "0",
      },
    ]);

    ({ getAnalyticsChecksum } = await import("@/lib/analytics/queries"));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("returns the newest run in the window, across every workflow in the org", async () => {
    const checksum = await getAnalyticsChecksum(ORG_ID, daysAgo(30));

    // max started_at | max direct created_at | active runs | newest notification change
    expect(checksum).toBe(
      `${pgText(NEWEST_IN_WINDOW)}|${SENTINEL}|1|${SENTINEL}`
    );
  });

  it("ignores runs that started before the window", async () => {
    // A 25-day window still contains MIDDLE; a 10-day one does not, and the
    // 40-day-old run must not resurface in either.
    const wide = await getAnalyticsChecksum(ORG_ID, daysAgo(25));
    const narrow = await getAnalyticsChecksum(ORG_ID, daysAgo(10));

    expect(wide).toBe(`${pgText(NEWEST_IN_WINDOW)}|${SENTINEL}|1|${SENTINEL}`);
    expect(narrow).toBe(
      `${pgText(NEWEST_IN_WINDOW)}|${SENTINEL}|1|${SENTINEL}`
    );
  });

  it("falls back to the window start excluding everything", async () => {
    const checksum = await getAnalyticsChecksum(ORG_ID, daysAgo(1));

    // Nothing started in the last day, so both timestamps collapse to the
    // sentinel. The active count is deliberately unwindowed and still counts.
    expect(checksum).toBe(`${SENTINEL}|${SENTINEL}|1|${SENTINEL}`);
  });

  it("returns the sentinel for an organization with no runs", async () => {
    const checksum = await getAnalyticsChecksum(EMPTY_ORG_ID, daysAgo(30));

    expect(checksum).toBe(`${SENTINEL}|${SENTINEL}|0|${SENTINEL}`);
  });

  it("changes when a notification in the window is sent or settles", async () => {
    const sent = atSecond(daysAgo(3));
    const settled = atSecond(daysAgo(1));
    await queryClient`
      INSERT INTO alert_deliveries
        (id, dedup_key, organization_id, kind, channel, recipient, state, created_at, updated_at)
      VALUES (${`${PREFIX}delivery`}, ${`${PREFIX}delivery`}, ${ORG_ID}, 'launch_notice',
              'email', 'ops@checksum.test', 'pending', ${pgText(sent)}, ${pgText(sent)})`;
    try {
      expect(await getAnalyticsChecksum(ORG_ID, daysAgo(30))).toBe(
        `${pgText(NEWEST_IN_WINDOW)}|${SENTINEL}|1|${pgText(sent)}`
      );

      await queryClient`
        UPDATE alert_deliveries
           SET state = 'delivered', updated_at = ${pgText(settled)}
         WHERE id = ${`${PREFIX}delivery`}`;
      expect(await getAnalyticsChecksum(ORG_ID, daysAgo(30))).toBe(
        `${pgText(NEWEST_IN_WINDOW)}|${SENTINEL}|1|${pgText(settled)}`
      );

      // Sent before the window: it cannot change what the window lists.
      expect(await getAnalyticsChecksum(ORG_ID, daysAgo(2.5))).toBe(
        `${pgText(NEWEST_IN_WINDOW)}|${SENTINEL}|1|${SENTINEL}`
      );
    } finally {
      await queryClient`DELETE FROM alert_deliveries WHERE id = ${`${PREFIX}delivery`}`;
    }
  });
});
