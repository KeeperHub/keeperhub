import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  NormalizedStatus,
  RunQueryFilters,
  StatusFacets,
  UnifiedRun,
} from "../../../lib/analytics/types";
import {
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";
import { ExecutionErrorType } from "../../../lib/errors/execution-error-type";
import type { WorkflowExecutionStatus } from "../../../lib/errors/execution-status";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally stubs @/lib/db; this suite needs the real query path,
// because what is under test is which rows the generated SQL selects.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_run_filters_";
const ORG_ID = `${PREFIX}org`;
const USER_ID = `${PREFIX}user`;
const NIGHTLY_ID = `${PREFIX}wf_nightly`;
const REBALANCE_ID = `${PREFIX}wf_rebalance`;

const BASE = "8453";
const ARBITRUM = "42161";

type Seed = {
  id: string;
  workflowId: string;
  status: WorkflowExecutionStatus;
  errorType?: ExecutionErrorType;
  durationMs?: number;
  network?: string;
  /** Carries the gas-station marker a web3 step core writes on a sponsored tx. */
  sponsored?: boolean;
};

// One run per interesting combination, so a filter that over- or under-selects
// shows up as a named row rather than a count.
const SEEDS: Seed[] = [
  {
    id: `${PREFIX}user_err`,
    workflowId: NIGHTLY_ID,
    status: "error",
    errorType: ExecutionErrorType.USER,
    durationMs: 1000,
    network: BASE,
  },
  {
    id: `${PREFIX}external_err`,
    workflowId: NIGHTLY_ID,
    status: "error",
    errorType: ExecutionErrorType.EXTERNAL,
    durationMs: 45_000,
    network: BASE,
  },
  {
    id: `${PREFIX}system_err`,
    workflowId: REBALANCE_ID,
    status: "system_error",
    errorType: ExecutionErrorType.SYSTEM,
    durationMs: 60_000,
    network: ARBITRUM,
  },
  {
    id: `${PREFIX}ok`,
    workflowId: REBALANCE_ID,
    status: "success",
    durationMs: 2000,
    network: ARBITRUM,
  },
  {
    id: `${PREFIX}sponsored`,
    workflowId: REBALANCE_ID,
    status: "success",
    durationMs: 3000,
    network: BASE,
    sponsored: true,
  },
  {
    id: `${PREFIX}skipped`,
    workflowId: NIGHTLY_ID,
    status: "skipped",
  },
  {
    id: `${PREFIX}running`,
    workflowId: NIGHTLY_ID,
    status: "running",
  },
];

describe.skipIf(SKIP)("analytics run filters", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getUnifiedRuns: (
    organizationId: string,
    range: "7d",
    options?: RunQueryFilters & { limit?: number }
  ) => Promise<{ runs: UnifiedRun[]; total: number }>;
  let getStatusFacets: (
    organizationId: string,
    range: "7d",
    options?: RunQueryFilters
  ) => Promise<StatusFacets>;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM member WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function idsFor(filters: RunQueryFilters): Promise<string[]> {
    const { runs } = await getUnifiedRuns(ORG_ID, "7d", {
      ...filters,
      limit: 50,
    });
    return runs.map((run) => run.id).sort();
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    const now = new Date();

    await db.insert(organization).values({
      id: ORG_ID,
      name: "filters org",
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
    await db.insert(workflows).values([
      {
        id: NIGHTLY_ID,
        name: "Nightly sync",
        userId: USER_ID,
        organizationId: ORG_ID,
        enabled: true,
        nodes: [],
        edges: [],
      },
      {
        id: REBALANCE_ID,
        name: "Rebalance vault",
        userId: USER_ID,
        organizationId: ORG_ID,
        enabled: true,
        nodes: [],
        edges: [],
      },
    ]);

    await db.insert(workflowExecutions).values(
      SEEDS.map((seed) => ({
        id: seed.id,
        workflowId: seed.workflowId,
        userId: USER_ID,
        status: seed.status,
        errorType: seed.errorType ?? null,
        duration:
          seed.durationMs === undefined ? null : String(seed.durationMs),
        startedAt: now,
        completedAt: seed.durationMs === undefined ? null : now,
      }))
    );

    const logRows: Array<{
      id: string;
      executionId: string;
      nodeId: string;
      nodeName: string;
      nodeType: string;
      status: "success";
      network: string;
      gasUsedWei: string | null;
      outputRaw: { sponsored: boolean } | null;
      startedAt: Date;
    }> = [];
    for (const seed of SEEDS) {
      if (seed.network === undefined) {
        continue;
      }
      logRows.push({
        id: `${seed.id}_log`,
        executionId: seed.id,
        nodeId: "n1",
        nodeName: "Step",
        nodeType: "web3/transfer",
        status: "success" as const,
        network: seed.network,
        gasUsedWei: seed.status === "success" ? "21000" : null,
        outputRaw: seed.sponsored ? { sponsored: true } : null,
        startedAt: now,
      });
    }
    await db.insert(workflowExecutionLogs).values(logRows);

    ({ getUnifiedRuns, getStatusFacets } = await import(
      "@/lib/analytics/queries"
    ));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("returns every error status when all three are selected", async () => {
    const statuses: NormalizedStatus[] = [
      "error",
      "external_error",
      "system_error",
    ];
    expect(await idsFor({ statuses })).toEqual(
      [
        `${PREFIX}user_err`,
        `${PREFIX}external_err`,
        `${PREFIX}system_err`,
      ].sort()
    );
  });

  it("keeps the error subtypes selectable on their own", async () => {
    expect(await idsFor({ statuses: ["error"] })).toEqual([
      `${PREFIX}user_err`,
    ]);
    expect(await idsFor({ statuses: ["external_error"] })).toEqual([
      `${PREFIX}external_err`,
    ]);
    expect(await idsFor({ statuses: ["system_error"] })).toEqual([
      `${PREFIX}system_err`,
    ]);
  });

  it("ANDs across dimensions and ORs inside one", async () => {
    expect(
      await idsFor({
        statuses: ["error", "external_error", "system_error"],
        networks: [BASE],
      })
    ).toEqual([`${PREFIX}external_err`, `${PREFIX}user_err`].sort());
  });

  it("filters on network", async () => {
    expect(await idsFor({ networks: [ARBITRUM] })).toEqual(
      [`${PREFIX}system_err`, `${PREFIX}ok`].sort()
    );
  });

  it("filters on duration, and a run still in flight has none", async () => {
    expect(await idsFor({ durationMinMs: 30_000 })).toEqual(
      [`${PREFIX}external_err`, `${PREFIX}system_err`].sort()
    );
    expect(await idsFor({ durationMaxMs: 5000 })).toEqual(
      [`${PREFIX}ok`, `${PREFIX}sponsored`, `${PREFIX}user_err`].sort()
    );
  });

  it("searches by workflow name and by run id", async () => {
    const byName = await idsFor({ search: "nightly" });
    expect(byName).toContain(`${PREFIX}user_err`);
    expect(byName).not.toContain(`${PREFIX}ok`);

    expect(await idsFor({ search: `${PREFIX}ok` })).toEqual([`${PREFIX}ok`]);
  });

  it("separates runs by who paid the gas", async () => {
    // Only the seeded success row carries gas, and none of the rows carry a
    // sponsorship marker, so the wallet covered all of it.
    // The sponsored run burned gas, but the gas station covered it, so it
    // answers to sponsored and not to wallet.
    expect(await idsFor({ gas: ["sponsored"] })).toEqual([
      `${PREFIX}sponsored`,
    ]);
    expect(await idsFor({ gas: ["wallet"] })).toEqual([`${PREFIX}ok`]);

    const free = await idsFor({ gas: ["free"] });
    expect(free).not.toContain(`${PREFIX}ok`);
    expect(free).toContain(`${PREFIX}user_err`);

    // Every category selected is the same as none: no narrowing at all.
    expect(await idsFor({ gas: ["sponsored", "wallet", "free"] })).toEqual(
      await idsFor({})
    );
  });

  it("reports the total under the filters, not the unfiltered count", async () => {
    const { total } = await getUnifiedRuns(ORG_ID, "7d", {
      statuses: ["error", "external_error", "system_error"],
      limit: 50,
    });
    expect(total).toBe(3);
  });

  it("counts each status separately for the filter's counts", async () => {
    const facets = await getStatusFacets(ORG_ID, "7d");
    expect(facets.error).toBe(1);
    expect(facets.external_error).toBe(1);
    expect(facets.system_error).toBe(1);
    expect(facets.success).toBe(2);
    expect(facets.skipped).toBe(1);
    expect(facets.running).toBe(1);
  });

  it("counts under the other filters but not under the status filter", async () => {
    const facets = await getStatusFacets(ORG_ID, "7d", {
      networks: [ARBITRUM],
      statuses: ["success"],
    });
    // Scoped to Arbitrum, and the status selection does not hide the others.
    expect(facets.system_error).toBe(1);
    expect(facets.success).toBe(1);
    expect(facets.error).toBeUndefined();
  });
});
