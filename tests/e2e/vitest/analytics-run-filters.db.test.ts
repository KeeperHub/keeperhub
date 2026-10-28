import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AnalyticsSummary,
  FacetDimension,
  NormalizedStatus,
  RunFacets,
  RunQueryFilters,
  UnifiedRun,
} from "../../../lib/analytics/types";
import {
  failureAlertDeliveries,
  organization,
  projects,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflowFailureIncidents,
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

/**
 * The gas a seed's run burned: a transfer step that succeeded spent 21000. It
 * goes on the step and on the run row alike, the way the finalizer writes both,
 * and the analytics gas filter reads the run's, which retention never purges.
 */
function seedGasWei(seed: Seed): string | null {
  const hasStep =
    seed.network !== undefined || seed.legacyNetwork !== undefined;
  return hasStep && seed.status === "success" ? "21000" : null;
}

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
    await queryClient`DELETE FROM gas_credit_usage WHERE id LIKE ${`${PREFIX}%`}`;
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
      gasUsedWei: "99999",
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
        gasUsedWei: seedGasWei(seed),
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
        gasUsedWei: seedGasWei(seed),
        outputRaw: seed.sponsored ? { sponsored: true } : null,
        startedAt: now,
      });
    }
    await db.insert(workflowExecutionLogs).values(logRows);

    // Sponsorship is read off the gas-credit ledger, which records what the gas
    // station paid and outlives the step logs. The marker on output_raw stays
    // on the step, for the tests that check a marker alone decides nothing.
    for (const seed of SEEDS.filter((candidate) => candidate.sponsored)) {
      await queryClient`
        INSERT INTO gas_credit_usage
          (id, organization_id, chain_id, tx_hash, execution_id, gas_used,
           gas_price_wei, gas_cost_wei, gas_cost_micro_usd, eth_price_usd, created_at)
        VALUES (${`${seed.id}_credit`}, ${ORG_ID}, 8453, ${`0x${seed.id}`},
                ${seed.id}, '21000', '1', ${seedGasWei(seed)}, '1', '1',
                ${now.toISOString()})`;
    }

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

  // KEEP-1334. Both of these pin behaviour the gas rollup did NOT have before
  // it moved onto the denormalised column, so both fail against the previous
  // implementation. They are seeded per-test rather than added to SEEDS because
  // the count assertions above pin the fixture exactly.
  async function withGasRow(
    id: string,
    row: { gasUsedWei?: string | null; output?: unknown; outputRaw?: unknown },
    assertions: () => Promise<void>
  ): Promise<void> {
    const now = new Date();
    await db.insert(workflowExecutions).values({
      id,
      workflowId: NIGHTLY_ID,
      userId: USER_ID,
      status: "success",
      duration: "1000",
      startedAt: now,
      completedAt: now,
    });
    await db.insert(workflowExecutionLogs).values({
      id: `${id}_log`,
      executionId: id,
      nodeId: "n1",
      nodeName: "Send",
      nodeType: "web3/transfer-funds",
      status: "success",
      network: BASE,
      gasUsedWei: row.gasUsedWei ?? null,
      output: row.output ?? null,
      outputRaw: row.outputRaw ?? null,
      startedAt: now,
    });
    try {
      await assertions();
    } finally {
      await queryClient`DELETE FROM workflow_execution_logs WHERE id = ${`${id}_log`}`;
      await queryClient`DELETE FROM workflow_executions WHERE id = ${id}`;
    }
  }

  // A sponsored transfer that errored before broadcast carries the gas-station
  // marker and no gas, and has no ledger row because nothing was ever charged.
  // On prod on 2026-09-04 nineteen such steps existed in two days. They used to
  // answer to "sponsored" purely on the marker, which put a run that spent
  // nothing in the same bucket as one KeeperHub actually paid for. Now the
  // marker only speaks for a step that reached the chain, so the run reads as
  // free - and free and sponsored stay mutually exclusive.
  it("reads a sponsored step that never spent as free, not as sponsored", async () => {
    const id = `${PREFIX}sponsored_no_gas`;
    await withGasRow(
      id,
      { gasUsedWei: null, outputRaw: { sponsored: true } },
      async () => {
        expect(await idsFor({ gas: ["sponsored"] })).not.toContain(id);
        expect(await idsFor({ gas: ["wallet"] })).not.toContain(id);
        expect(await idsFor({ gas: ["free"] })).toContain(id);
      }
    );
  });

  // The filter reads gas_used_wei and nothing else, so a row the KEEP-857
  // backfill never reached classifies as free however much gas its JSONB names.
  // That is what lets the scan run off idx_exec_logs_gas_started_at instead of
  // de-TOASTing `output` for every step in the window. It is safe because the
  // backfill has run: gas_used_wei is populated back to 2026-02-24 and no row
  // in the last 31 days has gas the column is missing.
  //
  // The runs listing still renders such a row's gas, because that read is
  // already bounded to one page and can afford the JSONB. The asymmetry is the
  // point of this test - it is deliberate, and it is what the backfill closes.
  it("classifies gas from the denormalised column, not from the JSONB", async () => {
    const id = `${PREFIX}jsonb_only_gas`;
    await withGasRow(
      id,
      { gasUsedWei: null, output: { gasUsed: "21000" } },
      async () => {
        expect(await idsFor({ gas: ["wallet"] })).not.toContain(id);
        expect(await idsFor({ gas: ["free"] })).toContain(id);

        const { runs } = await getUnifiedRuns(ORG_ID, "7d", { limit: 50 });
        expect(runs.find((run) => run.id === id)?.gasUsedWei).toBe("21000");
      }
    );
  });
});

// Failure notifications listed beside runs. Their own organization, so the
// fixture above keeps its exact counts.
describe.skipIf(SKIP)("analytics runs list: system notifications", () => {
  const N = "test_run_notifs_";
  const N_ORG = `${N}org`;
  const N_OTHER_ORG = `${N}org_other`;
  const N_USER = `${N}user`;
  const N_PROJECT = `${N}project`;
  const WF_IN = `${N}wf_in`;
  const WF_OUT = `${N}wf_out`;
  const INC_IN = `${N}inc_in`;
  const INC_OUT = `${N}inc_out`;
  const RUN = `${N}run`;
  const D_ALERT = `${N}d_alert`;
  const D_FAILED = `${N}d_failed`;
  const D_GROUPED = `${N}d_grouped`;
  const D_PAUSED = `${N}d_paused`;
  const D_LAUNCH = `${N}d_launch`;
  const D_OTHER = `${N}d_other`;
  const ALL_DELIVERIES = [D_ALERT, D_FAILED, D_GROUPED, D_PAUSED, D_LAUNCH];
  // What the analytics page asks for when the reader picked no source.
  const PAGE_SOURCES: RunQueryFilters["sources"] = [
    "workflow",
    "direct",
    "notification",
  ];

  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getUnifiedRuns: (
    organizationId: string,
    range: "7d",
    options?: RunQueryFilters & {
      limit?: number;
      cursor?: string;
      page?: number;
      projectId?: string;
    }
  ) => Promise<{
    runs: UnifiedRun[];
    total: number;
    listTotal: number;
    nextCursor: string | null;
  }>;
  let getRunFacets: (
    organizationId: string,
    range: "7d",
    options?: RunQueryFilters & {
      projectId?: string;
      dimensions?: FacetDimension[];
    }
  ) => Promise<RunFacets>;
  let getAnalyticsSummary: (
    organizationId: string,
    range: "custom",
    customStart?: string,
    customEnd?: string
  ) => Promise<AnalyticsSummary>;

  function minutesAgo(minutes: number): Date {
    return new Date(Date.now() - minutes * 60 * 1000);
  }

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM alert_deliveries WHERE id LIKE ${`${N}%`}`;
    await queryClient`DELETE FROM alert_incidents WHERE id LIKE ${`${N}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${N}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${N}%`}`;
    await queryClient`DELETE FROM projects WHERE id LIKE ${`${N}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${N}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${N}%`}`;
  }

  async function ids(
    filters: RunQueryFilters & { projectId?: string } = {}
  ): Promise<string[]> {
    const { runs } = await getUnifiedRuns(N_ORG, "7d", {
      sources: PAGE_SOURCES,
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

    await db.insert(organization).values([
      { id: N_ORG, name: "notifs org", slug: N_ORG, createdAt: now },
      {
        id: N_OTHER_ORG,
        name: "notifs other",
        slug: N_OTHER_ORG,
        createdAt: now,
      },
    ]);
    await db.insert(users).values({
      id: N_USER,
      email: `${N_USER}@keeperhub.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projects).values({
      id: N_PROJECT,
      name: "Treasury",
      organizationId: N_ORG,
      userId: N_USER,
    });
    await db.insert(workflows).values([
      {
        id: WF_IN,
        name: "Treasury sweep",
        userId: N_USER,
        organizationId: N_ORG,
        projectId: N_PROJECT,
        enabled: true,
        nodes: [],
        edges: [],
      },
      {
        id: WF_OUT,
        name: "Oracle watch",
        userId: N_USER,
        organizationId: N_ORG,
        enabled: true,
        nodes: [],
        edges: [],
      },
    ]);
    await db.insert(workflowExecutions).values({
      id: RUN,
      workflowId: WF_IN,
      userId: N_USER,
      status: "success",
      duration: "1000",
      startedAt: minutesAgo(1),
      completedAt: minutesAgo(1),
    });
    await db.insert(workflowFailureIncidents).values(
      [
        { id: INC_IN, workflowId: WF_IN },
        { id: INC_OUT, workflowId: WF_OUT },
      ].map((incident) => ({
        ...incident,
        organizationId: N_ORG,
        openedBy: "count" as const,
        threshold: 3,
        failureCount: 3,
        firstFailedAt: minutesAgo(60),
        lastFailedAt: minutesAgo(30),
        // Resolved, so the open-incident unique index never collides with
        // anything else the database holds for these workflows.
        resolvedAt: minutesAgo(1),
      }))
    );

    const delivery = (
      id: string,
      minutes: number,
      fields: Partial<typeof failureAlertDeliveries.$inferInsert>
    ): typeof failureAlertDeliveries.$inferInsert => ({
      id,
      dedupKey: id,
      organizationId: N_ORG,
      kind: "alert",
      channel: "email",
      recipient: "ops@notifs.test",
      state: "delivered",
      attempts: 1,
      createdAt: minutesAgo(minutes),
      updatedAt: minutesAgo(minutes - 0.5),
      ...fields,
    });
    await db.insert(failureAlertDeliveries).values([
      delivery(D_ALERT, 10, {
        incidentId: INC_IN,
        deliveredAt: minutesAgo(9.5),
      }),
      delivery(D_FAILED, 20, {
        kind: "reminder",
        incidentId: INC_OUT,
        channel: "slack",
        recipient: "#oncall",
        state: "failed",
        attempts: 4,
        lastError: "channel_not_found",
      }),
      delivery(D_GROUPED, 30, {
        context: { incidentIds: [INC_IN, INC_OUT] },
        state: "pending",
        attempts: 0,
      }),
      delivery(D_PAUSED, 40, {
        kind: "channel_paused",
        context: { channelLabel: "Slack #oncall" },
        state: "skipped",
        lastError: "What this message was about no longer exists.",
      }),
      delivery(D_LAUNCH, 50, {
        kind: "launch_notice",
        deliveredAt: minutesAgo(49.5),
      }),
      delivery(D_OTHER, 15, {
        organizationId: N_OTHER_ORG,
        deliveredAt: minutesAgo(14.5),
      }),
    ]);

    ({ getUnifiedRuns, getRunFacets, getAnalyticsSummary } = await import(
      "@/lib/analytics/queries"
    ));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("leaves notifications out when the caller names no source", async () => {
    // API and MCP callers that predate notifications get the listing they had.
    const { runs, total, listTotal } = await getUnifiedRuns(N_ORG, "7d", {
      limit: 50,
    });
    expect(runs.map((run) => run.id)).toEqual([RUN]);
    expect(total).toBe(1);
    expect(listTotal).toBe(1);
  });

  it("lists notifications beside runs when asked for with them", async () => {
    const { runs, total, listTotal } = await getUnifiedRuns(N_ORG, "7d", {
      limit: 50,
      sources: PAGE_SOURCES,
    });

    expect(runs.map((run) => run.id)).toEqual([RUN, ...ALL_DELIVERIES]);
    // Listed, never counted: the total is the one run; paging sees all six.
    expect(total).toBe(1);
    expect(listTotal).toBe(6);
    expect(runs.map((run) => run.id)).not.toContain(D_OTHER);

    const byId = new Map(runs.map((run) => [run.id, run]));
    expect(byId.get(D_ALERT)).toMatchObject({
      source: "notification",
      status: "success",
      workflowId: WF_IN,
      notification: { title: "Alert: Treasury sweep" },
    });
    expect(byId.get(D_FAILED)).toMatchObject({
      status: "error",
      workflowId: WF_OUT,
      notification: {
        title: "Still failing: Oracle watch",
        lastError: "channel_not_found",
        attempts: 4,
      },
    });
    expect(byId.get(D_GROUPED)).toMatchObject({
      status: "pending",
      workflowId: null,
      notification: { title: "Alert: 2 workflows" },
    });
    expect(byId.get(D_PAUSED)).toMatchObject({
      status: "cancelled",
      notification: { title: "Method paused: Slack #oncall" },
    });
    expect(byId.get(D_LAUNCH)?.notification?.title).toBe("Alerts turned on");
  });

  it("narrows to notifications, or away from them, by source", async () => {
    const only = await getUnifiedRuns(N_ORG, "7d", {
      sources: ["notification"],
      limit: 50,
    });
    expect(only.runs.map((run) => run.id).sort()).toEqual(
      [...ALL_DELIVERIES].sort()
    );
    expect(only.total).toBe(0);
    expect(only.listTotal).toBe(5);

    expect(await ids({ sources: ["workflow", "direct"] })).toEqual([RUN]);
  });

  it("filters notifications by status", async () => {
    expect(await ids({ statuses: ["error"] })).toEqual([D_FAILED]);
    expect(await ids({ statuses: ["cancelled"] })).toEqual([D_PAUSED]);
    expect(await ids({ statuses: ["success"] })).toEqual(
      [RUN, D_ALERT, D_LAUNCH].sort()
    );
    expect(await ids({ statuses: ["system_error"] })).toEqual([]);
  });

  it("searches workflow names, grouped ones included, and recipients", async () => {
    expect(await ids({ search: "treasury" })).toEqual(
      [RUN, D_ALERT, D_GROUPED].sort()
    );
    expect(await ids({ search: "oncall" })).toEqual([D_FAILED]);
  });

  it("drops notifications under a network, gas or duration filter", async () => {
    for (const filters of [
      { networks: ["8453"] },
      { gas: ["free"] as RunQueryFilters["gas"] },
      { durationMaxMs: 60_000 },
    ]) {
      const listed = await ids({ ...filters, sources: ["notification"] });
      expect(listed).toEqual([]);
    }
  });

  it("keeps only notifications about the project's workflows", async () => {
    expect(await ids({ projectId: N_PROJECT })).toEqual(
      [RUN, D_ALERT, D_GROUPED].sort()
    );
    const { total, listTotal } = await getUnifiedRuns(N_ORG, "7d", {
      projectId: N_PROJECT,
      limit: 50,
      sources: PAGE_SOURCES,
    });
    expect(total).toBe(1);
    expect(listTotal).toBe(3);
  });

  it("pages by page number over every listed row, notifications included", async () => {
    const first = await getUnifiedRuns(N_ORG, "7d", {
      limit: 2,
      page: 1,
      sources: PAGE_SOURCES,
    });
    expect(first.total).toBe(1);
    const pages = Math.ceil(first.listTotal / 2);
    expect(pages).toBe(3);

    const seen: string[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const result = await getUnifiedRuns(N_ORG, "7d", {
        limit: 2,
        page,
        sources: PAGE_SOURCES,
      });
      seen.push(...result.runs.map((run) => run.id));
    }
    expect(seen).toEqual([RUN, ...ALL_DELIVERIES]);
  });

  it("pages through notifications and runs with the cursor", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await getUnifiedRuns(N_ORG, "7d", {
        limit: 2,
        cursor,
        sources: PAGE_SOURCES,
      });
      seen.push(...result.runs.map((run) => run.id));
      if (!result.nextCursor) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(seen).toEqual([RUN, ...ALL_DELIVERIES]);
  });

  // Every delivery of one message is written in one transaction, so they share
  // created_at to the microsecond. A cursor of time alone (and cut to the
  // millisecond) skipped the rest of such a group at a page boundary.
  it("pages through rows that share one timestamp without skipping any", async () => {
    const tiedAt = `${minutesAgo(5).toISOString().slice(0, 23)}456`;
    const tied = ["t1", "t2", "t3", "t4", "t5"].map(
      (suffix) => `${N}${suffix}`
    );
    const tiedRun = `${N}run_tied`;
    for (const id of tied) {
      await queryClient`
        INSERT INTO alert_deliveries
          (id, dedup_key, organization_id, kind, channel, recipient, state,
           created_at, updated_at)
        VALUES (${id}, ${id}, ${N_ORG}, 'alert', 'email', ${`${id}@notifs.test`},
                'pending', ${tiedAt}::timestamp, ${tiedAt}::timestamp)`;
    }
    // A run at the very same instant, so the tie also spans sources.
    await queryClient`
      INSERT INTO workflow_executions (id, workflow_id, user_id, status, started_at)
      VALUES (${tiedRun}, ${WF_OUT}, ${N_USER}, 'running', ${tiedAt}::timestamp)`;
    try {
      for (const sources of [
        ["notification"] as RunQueryFilters["sources"],
        PAGE_SOURCES,
      ]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page += 1) {
          const result = await getUnifiedRuns(N_ORG, "7d", {
            limit: 2,
            cursor,
            sources,
          });
          seen.push(...result.runs.map((run) => run.id));
          if (!result.nextCursor) {
            break;
          }
          cursor = result.nextCursor;
        }
        const expected =
          sources === PAGE_SOURCES
            ? [RUN, tiedRun, ...tied, ...ALL_DELIVERIES]
            : [...tied, ...ALL_DELIVERIES];
        expect(seen.length, String(sources)).toBe(new Set(seen).size);
        expect([...seen].sort(), String(sources)).toEqual([...expected].sort());

        // Page by page matches one unpaged read, order included.
        const { runs } = await getUnifiedRuns(N_ORG, "7d", {
          limit: 50,
          sources,
        });
        expect(seen).toEqual(runs.map((run) => run.id));
      }
    } finally {
      await queryClient`DELETE FROM alert_deliveries WHERE id IN ${queryClient(tied)}`;
      await queryClient`DELETE FROM workflow_executions WHERE id = ${tiedRun}`;
    }
  });

  it("never counts notifications in the filter counts", async () => {
    // Listed by default, and filterable by status, but the counts beside the
    // options are counts of runs.
    const all = await getRunFacets(N_ORG, "7d", { search: "" });
    expect(all.statusCounts).toEqual({ success: 1 });
    const page = await getRunFacets(N_ORG, "7d", { sources: PAGE_SOURCES });
    expect(page.statusCounts).toEqual({ success: 1 });

    const onlyNotifications = await getRunFacets(N_ORG, "7d", {
      sources: ["notification"],
    });
    expect(onlyNotifications.statusCounts).toEqual({});

    const gas = await getRunFacets(N_ORG, "7d", {
      dimensions: ["gas"],
      sources: ["notification"],
    });
    expect(gas.gasCounts).toEqual({ sponsored: 0, wallet: 0, free: 0 });
  });

  it("keeps notifications out of the summary", async () => {
    const summary = await getAnalyticsSummary(
      N_ORG,
      "custom",
      minutesAgo(120).toISOString(),
      new Date().toISOString()
    );
    expect(summary.totalRuns).toBe(1);
    expect(summary.successCount).toBe(1);
    expect(summary.errorCount).toBe(0);
  });
});
