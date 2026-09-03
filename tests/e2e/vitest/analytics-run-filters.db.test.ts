import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  FacetDimension,
  NormalizedStatus,
  RunFacets,
  RunQueryFilters,
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
const OPTIMISM = "10";
// A neighbour whose rows must never appear in the org under test.
const OTHER_ORG_ID = `${PREFIX}org_other`;

type Seed = {
  id: string;
  workflowId: string;
  status: WorkflowExecutionStatus;
  errorType?: ExecutionErrorType;
  durationMs?: number;
  network?: string;
  /** Carries the gas-station marker a web3 step core writes on a sponsored tx. */
  sponsored?: boolean;
  /** Chain recorded only in the step's JSONB, with the column left null. */
  legacyNetwork?: string;
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
    id: `${PREFIX}legacy_chain`,
    workflowId: NIGHTLY_ID,
    status: "success",
    durationMs: 2500,
    // Chain only in the JSONB, as every row written before the denormalised
    // column existed still has it.
    legacyNetwork: OPTIMISM,
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
    range: "7d" | "custom",
    options?: RunQueryFilters & {
      limit?: number;
      customStart?: string;
      customEnd?: string;
    }
  ) => Promise<{ runs: UnifiedRun[]; total: number }>;
  let getRunFacets: (
    organizationId: string,
    range: "7d",
    options?: RunQueryFilters & {
      dimensions?: FacetDimension[];
      customStart?: string;
      customEnd?: string;
    }
  ) => Promise<RunFacets>;

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

    await db.insert(organization).values({
      id: OTHER_ORG_ID,
      name: "other org",
      slug: OTHER_ORG_ID,
      createdAt: now,
    });
    await db.insert(workflows).values({
      id: `${PREFIX}wf_other`,
      name: "Neighbour workflow",
      userId: USER_ID,
      organizationId: OTHER_ORG_ID,
      enabled: true,
      nodes: [],
      edges: [],
    });
    await db.insert(workflowExecutions).values({
      id: `${PREFIX}other_run`,
      workflowId: `${PREFIX}wf_other`,
      userId: USER_ID,
      status: "success",
      duration: "1000",
      startedAt: now,
      completedAt: now,
    });
    await db.insert(workflowExecutionLogs).values({
      id: `${PREFIX}other_log`,
      executionId: `${PREFIX}other_run`,
      nodeId: "n1",
      nodeName: "Step",
      nodeType: "web3/transfer",
      status: "success",
      network: BASE,
      gasUsedWei: "99999",
      startedAt: now,
    });

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
      network: string | null;
      gasUsedWei: string | null;
      outputRaw: { sponsored: boolean } | null;
      input: unknown;
      startedAt: Date;
    }> = [];
    for (const seed of SEEDS) {
      if (seed.network === undefined && seed.legacyNetwork === undefined) {
        continue;
      }
      logRows.push({
        id: `${seed.id}_log`,
        executionId: seed.id,
        nodeId: "n1",
        nodeName: "Step",
        nodeType: "web3/transfer",
        status: "success" as const,
        network: seed.network ?? null,
        input: seed.legacyNetwork
          ? JSON.stringify({ network: seed.legacyNetwork })
          : null,
        gasUsedWei: seed.status === "success" ? "21000" : null,
        outputRaw: seed.sponsored ? { sponsored: true } : null,
        startedAt: now,
      });
    }
    await db.insert(workflowExecutionLogs).values(logRows);

    ({ getUnifiedRuns, getRunFacets } = await import(
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
      [
        `${PREFIX}ok`,
        `${PREFIX}legacy_chain`,
        `${PREFIX}sponsored`,
        `${PREFIX}user_err`,
      ].sort()
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
    expect(await idsFor({ gas: ["wallet"] })).toEqual(
      [`${PREFIX}ok`, `${PREFIX}legacy_chain`].sort()
    );

    const free = await idsFor({ gas: ["free"] });
    expect(free).not.toContain(`${PREFIX}ok`);
    expect(free).toContain(`${PREFIX}user_err`);

    // Every category selected is the same as none: no narrowing at all.
    expect(await idsFor({ gas: ["sponsored", "wallet", "free"] })).toEqual(
      await idsFor({})
    );
  });

  // Results were never wrong here - the outer query is org-scoped, so a
  // neighbour's rows could not appear. What the subqueries lacked was a bound
  // of their own, so they aggregated every tenant's step logs, and paid the
  // JSONB decode on all of them, before the outer filter threw the work away.
  // This guards the half that is observable from the outside.
  it("keeps one organization's runs and counts to itself", async () => {
    for (const filters of [
      { gas: ["wallet"] as const },
      { gas: ["sponsored"] as const },
      { networks: [BASE] },
    ]) {
      const ids = await idsFor(filters as RunQueryFilters);
      // The neighbour's run shares PREFIX - teardown deletes by it - so the
      // prefix alone proves nothing about tenancy. Name the row that would
      // leak.
      expect(ids).not.toContain(`${PREFIX}other_run`);
      expect(ids.every((id) => id.startsWith(PREFIX))).toBe(true);
    }

    // Isolation runs both ways: the neighbour sees only its own run, and its
    // run never inflates this org's counts.
    const neighbour = await getRunFacets(OTHER_ORG_ID, "7d", {
      dimensions: ["network", "gas"],
    });
    expect(neighbour.networkCounts).toEqual({ [BASE]: 1 });
    expect(neighbour.gasCounts.wallet).toBe(1);

    const mine = await getRunFacets(ORG_ID, "7d", { dimensions: ["network"] });
    const myBaseRuns = await idsFor({ networks: [BASE] });
    expect(mine.networkCounts[BASE]).toBe(myBaseRuns.length);
    expect(myBaseRuns).not.toContain(`${PREFIX}other_run`);
  });

  // A gas charge is recorded when it settles, so for a run that started just
  // inside a closed window the ledger row can land after the window's end.
  it("still reads a charge that settled after the window closed", async () => {
    const runStartedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const windowEnd = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const settledAfter = new Date(Date.now() - 30 * 60 * 1000);

    await db.insert(workflowExecutions).values({
      id: `${PREFIX}late_charge`,
      workflowId: NIGHTLY_ID,
      userId: USER_ID,
      status: "success",
      duration: "1000",
      startedAt: runStartedAt,
      completedAt: runStartedAt,
    });
    await db.insert(workflowExecutionLogs).values({
      id: `${PREFIX}late_charge_log`,
      executionId: `${PREFIX}late_charge`,
      nodeId: "n1",
      nodeName: "Step",
      nodeType: "web3/transfer",
      status: "success",
      network: BASE,
      gasUsedWei: "21000",
      startedAt: runStartedAt,
    });
    await queryClient`
      INSERT INTO gas_credit_usage
        (id, organization_id, chain_id, tx_hash, execution_id, gas_used,
         gas_price_wei, gas_cost_wei, gas_cost_micro_usd, eth_price_usd, created_at)
      VALUES (${`${PREFIX}late_credit`}, ${ORG_ID}, 8453, '0xlate',
              ${`${PREFIX}late_charge`}, '21000', '1', '21000', '1', '1',
              ${settledAfter.toISOString()})`;

    const { runs } = await getUnifiedRuns(ORG_ID, "custom", {
      gas: ["sponsored"],
      limit: 50,
      customStart: runStartedAt.toISOString(),
      customEnd: windowEnd.toISOString(),
    });
    expect(runs.map((run) => run.id)).toContain(`${PREFIX}late_charge`);

    // Removed again so the count assertions further down keep their fixture.
    await queryClient`DELETE FROM gas_credit_usage WHERE id = ${`${PREFIX}late_credit`}`;
    await queryClient`DELETE FROM workflow_execution_logs WHERE id = ${`${PREFIX}late_charge_log`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id = ${`${PREFIX}late_charge`}`;
  });

  it("reports the total under the filters, not the unfiltered count", async () => {
    const { total } = await getUnifiedRuns(ORG_ID, "7d", {
      statuses: ["error", "external_error", "system_error"],
      limit: 50,
    });
    expect(total).toBe(3);
  });

  it("offers every chain a run touched, not only the ones that spent gas", async () => {
    const { networkCounts } = await getRunFacets(ORG_ID, "7d", {
      dimensions: ["network"],
    });
    // The seeded runs record a chain on their step but no gas on most of them.
    // Sourcing the options from the gas breakdown dropped exactly those.
    // Optimism is only in the JSONB. Listing options from the denormalised
    // column alone dropped it, while the filter would have matched it.
    expect(Object.keys(networkCounts).sort()).toEqual(
      [ARBITRUM, BASE, OPTIMISM].sort()
    );
    expect(networkCounts[BASE]).toBeGreaterThan(0);
    expect(networkCounts[ARBITRUM]).toBeGreaterThan(0);
    expect(networkCounts[OPTIMISM]).toBe(1);
  });

  // Only the dimension being counted is lifted. Counting chains across every
  // status would label Base with three runs while ticking it returned one, and
  // - because the facets cache key does not name the statuses - would serve
  // that same answer to every other status selection.
  it("counts chains under the status filter, not across all statuses", async () => {
    const { networkCounts } = await getRunFacets(ORG_ID, "7d", {
      dimensions: ["network"],
      statuses: ["success"],
    });
    expect(networkCounts[BASE]).toBe(1);
    expect(networkCounts[ARBITRUM]).toBe(1);
    expect(networkCounts[OPTIMISM]).toBe(1);
  });

  // The dashboard polls facets every ten seconds for every open tab. Network
  // and gas both read the step logs, so a default that included them would put
  // that table back under exactly the load that took prod down.
  it("counts only statuses unless the costly dimensions are asked for", async () => {
    const polled = await getRunFacets(ORG_ID, "7d");
    expect(Object.keys(polled.statusCounts).length).toBeGreaterThan(0);
    expect(polled.networkCounts).toEqual({});
    expect(polled.gasCounts).toEqual({});

    const onDemand = await getRunFacets(ORG_ID, "7d", {
      dimensions: ["network"],
    });
    expect(Object.keys(onDemand.networkCounts).length).toBeGreaterThan(0);
    // And asking for one does not silently drag the others along.
    expect(onDemand.gasCounts).toEqual({});
    expect(onDemand.statusCounts).toEqual({});
  });

  it("counts each gas bucket, including the empty ones", async () => {
    const { gasCounts } = await getRunFacets(ORG_ID, "7d", {
      dimensions: ["gas"],
    });
    expect(gasCounts.sponsored).toBe(1);
    expect(gasCounts.wallet).toBe(2);
    expect(gasCounts.free).toBeGreaterThan(0);
  });

  it("counts each status separately for the filter's counts", async () => {
    const { statusCounts: facets } = await getRunFacets(ORG_ID, "7d", {
      dimensions: ["status"],
    });
    expect(facets.error).toBe(1);
    expect(facets.external_error).toBe(1);
    expect(facets.system_error).toBe(1);
    expect(facets.success).toBe(3);
    expect(facets.skipped).toBe(1);
    expect(facets.running).toBe(1);
  });

  it("counts under the other filters but not under the status filter", async () => {
    const { statusCounts: facets } = await getRunFacets(ORG_ID, "7d", {
      dimensions: ["status"],
      networks: [ARBITRUM],
      statuses: ["success"],
    });
    // Scoped to Arbitrum, and the status selection does not hide the others.
    expect(facets.system_error).toBe(1);
    expect(facets.success).toBe(1);
    expect(facets.error).toBeUndefined();
  });
});
